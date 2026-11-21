import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

type Until = 'round-ended' | 'show-ended'

interface EngineShellState {
  backend: 'engine'; screen: string; ready: boolean; error: string | null; seats: number; humans: number; bots: number
  round: number; tick: number; moduleKey: string; faults: number; completedRounds: number; desyncs: number
  flow: string; lobbyId: string | null; lobbyMembers: number; visibility: 'visible' | 'hidden'; online: boolean
}

interface HarnessOptions {
  clients: number; bots: number; until: Until | null; engine: boolean; lateClient: boolean; backgroundClient: boolean
  seconds: number; url: string; server: string; chrome: string; port: number; boot: number; deadline: number
}

interface RunDeps {
  spawn: (command: string, args: string[], options: { stdio: 'ignore' }) => FakeChild
  fetch: (url: string) => Promise<{ json(): Promise<unknown> }>
  WebSocket: new (url: string) => FakeSocket
  sleep: (ms: number) => Promise<void>
  now: () => number
  tmpdir: () => string
  log: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (timer: unknown) => void
}

interface HarnessModule {
  clientUrl(base: string, params: { server: string; name: string; bots: string; engine: boolean }): string
  parseHarnessArgs(argv: string[]): HarnessOptions
  evaluateCompletion(states: EngineShellState[], signals: string[][], exceptions: number[], until: Until): { ok: boolean; problems: string[] }
  run(options: HarnessOptions, deps: RunDeps): Promise<number>
  engineLaunchPlan(lateClient: boolean): string[]
}

const harness = await import(pathToFileURL(resolve('tools/onlineChromes.mjs')).href) as HarnessModule
const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta']

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  readonly kills: string[] = []
  kill(signal = 'SIGTERM'): boolean {
    this.kills.push(signal)
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal
      queueMicrotask(() => this.emit('exit', null, signal))
    }
    return true
  }
}

interface FakePage {
  name: string
  state: EngineShellState
  signals: string[]
  play(): void
  onRead?: (page: FakePage) => void
}

interface FakeSocket {
  onopen: (() => void) | null
  onerror: ((e: unknown) => void) | null
  onmessage: ((e: { data: string }) => void) | null
  send(data: string): void
}

function baseState(name: string): EngineShellState {
  return {
    backend: 'engine', screen: 'start', ready: true, error: null, seats: 60, humans: 0, bots: 60,
    round: 0, tick: 0, moduleKey: `mod-${name}`, faults: 0, completedRounds: 0, desyncs: 0,
    flow: 'start', lobbyId: null, lobbyMembers: 1, visibility: 'visible', online: true,
  }
}

function makeWorld(options: {
  advance?: (page: FakePage) => void; hideOnBackground?: boolean; failConnect?: string
  /** This page's CDP socket stops answering every call once the page is in the match, like a stuck page. */
  hangInMatch?: string
} = {}) {
  let clock = 0
  const pages = new Map<string, FakePage>()
  const children: FakeChild[] = []
  const spawns: { name: string; alphaReady: boolean }[] = []
  const foreign = new FakeChild()
  const errors: unknown[][] = []
  const events: string[] = []
  let pressedBetaAfterLobbyReady = false
  const page = (name: string): FakePage => {
    let found = pages.get(name)
    if (found === undefined) {
      found = {
        name, state: baseState(name), signals: ['page-ready'],
        onRead: current => options.advance?.(current),
        play: () => {
          events.push(`press ${name}`)
          if (name === 'Beta') pressedBetaAfterLobbyReady = (pages.get('Alpha')?.signals ?? []).includes('lobby-ready')
          found!.state.flow = 'queued'
          found!.state.lobbyId = 'L1'
          found!.signals.push('lobby-ready')
        },
      }
      pages.set(name, found)
    }
    return found
  }
  const target = (name: string) => ({
    id: `page-${name}`, url: `http://localhost/game.html?name=${name}&bots=60&engine=1`, webSocketDebuggerUrl: `ws://cdp/${name}`,
  })
  const evaluate = (p: FakePage, expression: string): unknown => {
    if (expression.includes('.signals')) return p.signals.slice()
    if (expression.includes('.play')) { p.play(); return true }
    if (expression.includes('.state')) { events.push(`read ${p.name}`); p.onRead?.(p); return { ...p.state } }
    if (expression.includes('[innerWidth')) return [960, 540]
    return ''
  }
  class Socket implements FakeSocket {
    onopen: (() => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    private readonly name: string
    constructor(url: string) {
      this.name = url.slice(url.lastIndexOf('/') + 1)
      if (options.failConnect === this.name) {
        queueMicrotask(() => this.onerror?.(new Error(`connect failed for ${this.name}`)))
        return
      }
      queueMicrotask(() => this.onopen?.())
    }
    send(data: string): void {
      const msg = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
      const p = page(this.name)
      if (options.hangInMatch === this.name && p.state.flow === 'match') return
      let result: unknown = {}
      if (msg.method === 'Runtime.evaluate') result = { result: { value: evaluate(p, String(msg.params?.expression ?? '')) } }
      if (msg.method === 'Target.createTarget') result = { targetId: `blank-${this.name}` }
      if (msg.method === 'Target.activateTarget' && options.hideOnBackground !== false) {
        const id = String(msg.params?.targetId ?? '')
        if (id === `blank-${this.name}`) p.state.visibility = 'hidden'
        if (id === `page-${this.name}`) p.state.visibility = 'visible'
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) }))
    }
  }
  let spawnIndex = 0
  const deps: RunDeps = {
    spawn: () => {
      const name = NAMES[spawnIndex++]
      const child = new FakeChild()
      children.push(child)
      spawns.push({ name, alphaReady: (pages.get('Alpha')?.signals ?? []).includes('lobby-ready') })
      page(name)
      return child
    },
    fetch: async () => ({ json: async () => spawns.map(({ name }) => target(name)) }),
    WebSocket: Socket,
    sleep: async ms => { clock += ms },
    now: () => clock,
    tmpdir: () => '/tmp',
    log: () => {},
    error: (...args) => { errors.push(args) },
    // A timer advances the fake clock by its delay when it fires, so a call timeout is visible against the deadline.
    setTimeout: (fn, ms) => setTimeout(() => { clock += ms; fn() }, 0),
    clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
  return { now: () => clock, deps, pages, page, children, spawns, foreign, errors, events, pressedBetaAfterLobbyReady: () => pressedBetaAfterLobbyReady }
}

function options(argv: string[]): HarnessOptions {
  return harness.parseHarnessArgs(['--engine', '--until', 'round-ended', ...argv])
}

function successAdvance(p: FakePage): void {
  if (p.state.flow === 'queued') {
    p.state.flow = 'match'
    p.state.humans = 2
    p.state.bots = 58
    return
  }
  if (p.state.flow === 'match' || p.state.flow === 'podium') {
    p.state.tick += 1
    if (p.state.tick >= 2 && !p.signals.includes('round-ended')) {
      p.state.completedRounds = 1
      p.signals.push('round-ended')
      p.state.flow = 'podium'
      p.signals.push('podium-ready')
    }
  }
}

function state(over: Partial<EngineShellState> = {}): EngineShellState {
  return {
    backend: 'engine', screen: 'match', ready: true, error: null, seats: 60, humans: 2, bots: 58, round: 1, tick: 100,
    moduleKey: 'mod', faults: 0, completedRounds: 1, desyncs: 0, flow: 'match', lobbyId: 'L1', lobbyMembers: 2,
    visibility: 'visible', online: true, ...over,
  }
}

test('clientUrl preserves the base query and sets engine, server, name and bots', () => {
  const url = new URL(harness.clientUrl('http://localhost:5191/game.html?course=fiesta&wait=3',
    { server: 'wss://relay.etcito.com/ws', name: 'Alpha', bots: '60', engine: true }))
  assert.equal(url.pathname, '/game.html')
  assert.equal(url.searchParams.get('course'), 'fiesta')
  assert.equal(url.searchParams.get('wait'), '3')
  assert.equal(url.searchParams.get('server'), 'wss://relay.etcito.com/ws')
  assert.equal(url.searchParams.get('name'), 'Alpha')
  assert.equal(url.searchParams.get('bots'), '60')
  assert.equal(url.searchParams.get('engine'), '1')
  const bare = new URL(harness.clientUrl('http://localhost:5191/game.html', { server: 'ws://x', name: 'Beta', bots: '60', engine: false }))
  assert.equal(bare.searchParams.get('engine'), '0')
  assert.equal(bare.searchParams.get('name'), 'Beta')
})

test('parseHarnessArgs accepts only the documented until, clients and total-seat values', () => {
  assert.equal(harness.parseHarnessArgs(['--until', 'round-ended']).until, 'round-ended')
  assert.equal(harness.parseHarnessArgs(['--until', 'show-ended']).until, 'show-ended')
  assert.throws(() => harness.parseHarnessArgs(['--until', 'finished']), /--until/)
  assert.throws(() => harness.parseHarnessArgs(['--clients', '0']), /--clients/)
  assert.throws(() => harness.parseHarnessArgs(['--clients', '5']), /--clients/)
  const defaults = harness.parseHarnessArgs([])
  assert.equal(defaults.clients, 2)
  assert.equal(defaults.bots, 60)
  assert.equal(defaults.until, null)
  assert.equal(harness.parseHarnessArgs(['--bots', '60']).bots, 60)
  assert.equal(harness.parseHarnessArgs(['--late-client', '--background-client']).lateClient, true)
  assert.equal(harness.parseHarnessArgs(['--late-client', '--background-client']).backgroundClient, true)
})

test('evaluateCompletion fails each missing transition and passes the full acceptance state', () => {
  const good = [state(), state()]
  const sig = [['page-ready', 'round-ended'], ['page-ready', 'round-ended']]
  assert.deepEqual(harness.evaluateCompletion(good, sig, [0, 0], 'round-ended'), { ok: true, problems: [] })
  assert.equal(harness.evaluateCompletion(good, [['round-ended'], ['round-ended']], [0, 0], 'round-ended').ok, true)
  const fails: [string, EngineShellState[], string[][], number[], Until][] = [
    ['missing round-ended', good, [[], ['round-ended']], [0, 0], 'round-ended'],
    ['humans 1', [state(), state({ humans: 1 })], sig, [0, 0], 'round-ended'],
    ['bots 59', [state(), state({ bots: 59 })], sig, [0, 0], 'round-ended'],
    ['desyncs 1', [state({ desyncs: 1 }), state()], sig, [0, 0], 'round-ended'],
    ['faults 1', [state(), state({ faults: 1 })], sig, [0, 0], 'round-ended'],
    ['error set', [state(), state({ error: 'boom' })], sig, [0, 0], 'round-ended'],
    ['lobby ids differ', [state(), state({ lobbyId: 'L2' })], sig, [0, 0], 'round-ended'],
    ['exception', good, sig, [0, 1], 'round-ended'],
    ['show-ended signals', good, sig, [0, 0], 'show-ended'],
  ]
  for (const [label, states, signals, exceptions, until] of fails) {
    assert.equal(harness.evaluateCompletion(states, signals, exceptions, until).ok, false, label)
  }
  assert.equal(harness.evaluateCompletion(good, [['podium-ready', 'hub-returned'], ['podium-ready', 'hub-returned']], [0, 0], 'show-ended').ok, true)
})

test('the late client page opens and is start-ready before client A presses Play, and presses after lobby-ready', async () => {
  const plan = harness.engineLaunchPlan(true)
  const at = (step: string) => plan.indexOf(step)
  assert.ok(at('open 2') < at('press 1'))
  assert.ok(at('start-ready 2') < at('press 1'))
  assert.ok(at('lobby-ready 1') < at('press 2'))
  assert.ok(at('press 2') < at('same-lobby 2'))

  const world = makeWorld({ advance: successAdvance })
  const code = await harness.run(options(['--late-client']), world.deps)
  assert.equal(code, 0)
  assert.deepEqual(world.spawns.map(s => s.name), ['Alpha', 'Beta'])
  assert.equal(world.spawns[1].alphaReady, false)
  const events = world.events
  assert.ok(events.indexOf('read Beta') < events.indexOf('press Alpha'), events.join(','))
  assert.ok(events.indexOf('press Alpha') < events.indexOf('press Beta'), events.join(','))
  assert.equal(world.pressedBetaAfterLobbyReady(), true)
})

test('the background step fails while visibility stays visible and passes hidden with a moving tick', async () => {
  const failing = makeWorld({ advance: successAdvance, hideOnBackground: false })
  const failed = await harness.run(options(['--background-client']), failing.deps)
  assert.notEqual(failed, 0)
  assert.match(String(failing.errors[0]?.[0]), /visibility hidden/)

  const passing = makeWorld({ advance: successAdvance })
  const passed = await harness.run(options(['--background-client']), passing.deps)
  assert.equal(passed, 0)
  assert.equal(passing.page('Alpha').state.visibility, 'visible')
})

test('cleanup closes exactly the owned Chromes on success, thrown failure and deadline', async () => {
  const success = makeWorld({ advance: successAdvance })
  assert.equal(await harness.run(options([]), success.deps), 0)
  assert.equal(success.children.length, 2)
  for (const child of success.children) assert.deepEqual(child.kills, ['SIGTERM'])
  assert.equal(success.foreign.kills.length, 0)

  const thrown = makeWorld({ advance: successAdvance, failConnect: 'Beta' })
  assert.notEqual(await harness.run(options(['--late-client']), thrown.deps), 0)
  assert.equal(thrown.children.length, 2)
  for (const child of thrown.children) assert.deepEqual(child.kills, ['SIGTERM'])
  assert.equal(thrown.foreign.kills.length, 0)

  const stalled = makeWorld({ advance: p => { if (p.state.flow === 'queued') { p.state.flow = 'match'; p.state.humans = 2; p.state.bots = 58 } } })
  assert.notEqual(await harness.run(harness.parseHarnessArgs(['--engine', '--until', 'round-ended', '--deadline', '2']), stalled.deps), 0)
  assert.equal(stalled.children.length, 2)
  for (const child of stalled.children) assert.deepEqual(child.kills, ['SIGTERM'])
  assert.equal(stalled.foreign.kills.length, 0)
})

test('a client whose CDP calls never answer fails the run with its name and last state before the deadline, with cleanup', async () => {
  const world = makeWorld({ advance: successAdvance, hangInMatch: 'Beta' })
  const code = await harness.run(options(['--late-client', '--deadline', '900']), world.deps)
  assert.notEqual(code, 0)
  const message = String(world.errors[0]?.[0])
  assert.match(message, /Beta: CDP Runtime\.evaluate .* got no answer within \d+ ms; last state flow match screen start tick \d+/)
  assert.ok(world.now() < 900_000, `failed at ${world.now()} ms, before the 900 s deadline`)
  assert.equal(world.children.length, 2)
  for (const child of world.children) assert.deepEqual(child.kills, ['SIGTERM'])
  assert.equal(world.foreign.kills.length, 0)
})
