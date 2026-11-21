import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { EgeError } from '@etcito/game-engine/abi'
import { schemaLayout } from '@etcito/game-engine/script'
import type { GroupTransport } from '@gamesaloon/rollback/zones'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { CourseV1 } from '../src/courseV1.ts'
import { createEngineOnlineShow } from '../src/ege/online.ts'
import { engineOnlineStats, onlineMeasurements } from '../src/ege/onlineState.ts'
import type { EngineShowConfig } from '../src/ege/showTypes.ts'
import { onlineRoster } from '../src/net/onlineMatch.ts'
import { ZoneLoopback } from '../src/net/zoneLoopback.ts'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'

const schemaText = readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')
const engine = await loadEngine()
engine.setSchema(schemaText)
const schemaKey = schemaLayout(engine).key

const script = await (async () => {
  const result = await (await rfCompiler()).compile(collectRfScripts(), schemaText)
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
  assert.ok(result.wasm)
  return result.wasm as Uint8Array<ArrayBuffer>
})()

const course = {
  id: 'online-rules',
  sim: { kind: 'race', timeLimitS: 20, checkpoints: [], level: null },
} as unknown as CourseV1
const season = [
  { id: 'A', course: 0, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: false },
  { id: 'B', course: 0, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: false },
  { id: 'C', course: 0, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: false },
  { id: 'Q', course: 0, kind: 'final', finalRule: 'crown', stages: ['final'], team: false, cut: false },
] as const
const roster = onlineRoster(2, 60)
const NEUTRAL = 32639

function config(over: Partial<EngineShowConfig> = {}): EngineShowConfig {
  return {
    engine, schemaText, scriptBytes: script.slice(), seed: 7,
    identity: { backend: 'engine', schemaKey, moduleKey: 'publication' },
    courses: [course], assets: new Map(), zones: new Map(), season, humans: deck(), plan: [60, 2], testMode: true,
    ...over,
  }
}

function deck(): boolean[] {
  return Array.from({ length: 60 }, (_, seat) => seat < 2)
}

function network(localPeer: number, transport: GroupTransport) {
  return { localPeer, roster, transport, measurements: onlineMeasurements(roster) }
}

function refuses(run: () => unknown, path: string): void {
  assert.throws(run, error => error instanceof RefusalError && error.area === 'ege-online' && error.path === path)
}

function broken(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
}

test('invalid script preparation rejects with the factory error and sends nothing', async () => {
  let sends = 0
  const transport: GroupTransport = {
    send: () => { sends++ },
    sendMany: () => { sends++ },
    drain: () => {},
    closed: () => false,
    now: () => 0,
  }
  const gate = { state: 'loading' as 'loading' | 'ready' | 'failed', ready: false, ran: false }
  const preparing = createEngineOnlineShow(config({ scriptBytes: broken() }), network(0, transport))
    .then(value => { gate.state = 'ready'; gate.ready = true; gate.ran = true; return value },
      error => { gate.state = 'failed'; throw error })
  assert.equal(gate.state, 'loading')
  await assert.rejects(preparing, error => error instanceof EgeError)
  assert.equal(gate.state, 'failed')
  assert.equal(gate.ready, false)
  assert.equal(gate.ran, false)
  assert.equal(sends, 0)
})

test('preparation stays pending across a macrotask and exposes no runtime before the factory resolves', async () => {
  const realCompile = WebAssembly.compile
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  Reflect.set(WebAssembly, 'compile', async (source: BufferSource) => { await blocked; return realCompile(source) })
  const gate = { state: 'loading' as 'loading' | 'ready' | 'failed', ready: false, exposed: false }
  let runtime: Awaited<ReturnType<typeof createEngineOnlineShow>> | undefined
  try {
    const preparing = createEngineOnlineShow(config(), network(0, new ZoneLoopback(2, { seed: 1, rttMs: 0, jitterMs: 0, loss: 0 }).transport(0)))
      .then(value => { gate.state = 'ready'; gate.ready = true; gate.exposed = true; return value },
        error => { gate.state = 'failed'; throw error })
    assert.equal(gate.state, 'loading')
    assert.equal(gate.ready, false)
    assert.equal(gate.exposed, false)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(gate.state, 'loading')
    assert.equal(gate.ready, false)
    assert.equal(gate.exposed, false)
    release()
    runtime = await preparing
    assert.equal(gate.state, 'ready')
    assert.equal(gate.ready, true)
    assert.equal(runtime.mode, 'online')
  } finally {
    release()
    Reflect.set(WebAssembly, 'compile', realCompile)
    runtime?.dispose()
  }
})

test('network validation refuses a roster mismatch before preparation starts', async () => {
  const transport: GroupTransport = { send: () => {}, drain: () => {}, closed: () => false, now: () => 0 }
  const humans = new Array<boolean>(59).fill(false)
  await assert.rejects(
    createEngineOnlineShow(config({ scriptBytes: broken(), humans }), network(0, transport)),
    error => error instanceof RefusalError && error.area === 'ege-online' && error.path === 'network.roster.seatCount',
  )
  const missing = { 0: onlineMeasurements(roster)[0]! }
  await assert.rejects(
    createEngineOnlineShow(config(), { localPeer: 0, roster, transport, measurements: missing }),
    error => error instanceof RefusalError && error.area === 'ege-online' && error.path === 'network.measurements/1',
  )
})

test('two peers reach the same loading snapshot after one vote and one abstention', async () => {
  const net = new ZoneLoopback(2, { seed: 1, rttMs: 20, jitterMs: 0, loss: 0 })
  const runtimes: Awaited<ReturnType<typeof createEngineOnlineShow>>[] = []
  try {
    for (let peer = 0; peer < 2; peer++) {
      runtimes.push(await createEngineOnlineShow(config(), network(peer, net.transport(peer))))
    }
    let voted = false
    for (let frame = 0; frame < 40; frame++) {
      if (runtimes.every(runtime => runtime.snapshot().screen === 'loading')) break
      if (!voted) {
        const state = runtimes[0]!.snapshot()
        if (state.screen === 'vote' && state.candidates.length > 1) {
          runtimes[0]!.vote(0, 1)
          voted = true
        }
      }
      net.advance(1000 / 60)
      for (const runtime of runtimes) {
        if (runtime.snapshot().screen !== 'loading') runtime.frame(1 / 60, () => NEUTRAL)
      }
    }
    const states = runtimes.map(runtime => runtime.snapshot())
    for (const state of states) assert.equal(state.screen, 'loading')
    assert.equal(states[0]!.round, 0)
    assert.deepEqual(states[0]!.seatOf, states[1]!.seatOf)
    assert.deepEqual(states[0]!.candidates, states[1]!.candidates)
    assert.equal(states[0]!.candidates.length, 3)
    assert.equal(states[0]!.tick, states[1]!.tick)
    for (const runtime of runtimes) {
      const stats = engineOnlineStats(runtime)
      assert.ok(stats)
      assert.equal(stats.desyncs, 0)
      assert.equal(stats.peers, 2)
      assert.equal(stats.spectator, false)
    }
  } finally {
    for (const runtime of runtimes) runtime.dispose()
  }
})

test('a bot seat and a remote human seat both refuse local votes', async () => {
  const runtime = await createEngineOnlineShow(config(), network(0, new ZoneLoopback(2, { seed: 1, rttMs: 0, jitterMs: 0, loss: 0 }).transport(0)))
  try {
    refuses(() => runtime.vote(5, 0), 'vote.roomSeat')
    refuses(() => runtime.vote(1, 0), 'vote.roomSeat')
  } finally {
    runtime.dispose()
  }
})

test('dispose is idempotent and releases the rules world without closing the transport', async () => {
  let freed = 0
  const proxied = new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      if (prop === 'freeWorld') return (...args: [world: number]) => { freed++; return target.freeWorld(...args) }
      return value.bind(target)
    },
  })
  let closed = 0
  const net = new ZoneLoopback(2, { seed: 1, rttMs: 0, jitterMs: 0, loss: 0 })
  const base = net.transport(0)
  const transport: GroupTransport = { ...base, close: () => { closed++ } } as GroupTransport
  const runtime = await createEngineOnlineShow(config({ engine: proxied }), network(0, transport))
  const ref = runtime.worlds()[0]!
  const before = freed
  runtime.dispose()
  assert.equal(freed, before + 1)
  runtime.dispose()
  assert.equal(freed, before + 1)
  assert.equal(closed, 0)
  assert.throws(() => engine.tick(ref.world))
})
