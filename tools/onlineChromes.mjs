// Online check on one machine: N headless Chromes open the game in one lobby. Without --engine the old
// duration/diagnostics run stays; with --engine the harness drives window.rfEngine's state/signals and only
// succeeds when the state-driven --until condition holds (two humans, 58 bots, a finished round, no desync).
// Plain Node (no dependencies) so it runs where Chrome runs (Windows). It owns its browsers: it starts them
// and closes exactly those on every exit (success, failure, signal, deadline), waiting for their exit.
//
//   node tools/onlineChromes.mjs [--engine] [--late-client] [--background-client]
//     [--until round-ended|show-ended] [--deadline 900] [--clients 2] [--bots 60] [--seconds 60]
//     [--url http://localhost:5191/game.html] [--server wss://relay.etcito.com/ws] [--chrome <chrome.exe>]
//     [--port 9341] [--boot 30]
import { spawn as nodeSpawn } from 'node:child_process'
import { tmpdir as nodeTmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta']
const POLL_MS = 500
const STALL_MS = 30000
const EXIT_WAIT_MS = 5000
const STATE = 'window.rfEngine && window.rfEngine.state ? window.rfEngine.state() : null'
const SIGNALS = 'window.rfEngine && window.rfEngine.signals ? window.rfEngine.signals() : []'
const PLAY = 'window.rfEngine && window.rfEngine.play ? window.rfEngine.play() : false'
const DIAG = "[...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /net tick|relay /.test(e.textContent)).map(e => e.textContent).join(' || ')"

/** Builds the page URL with URLSearchParams so every existing query value survives; engine=1 opts the shell in. */
export function clientUrl(base, params) {
  const url = new URL(base)
  url.searchParams.set('server', params.server)
  url.searchParams.set('name', params.name)
  url.searchParams.set('bots', params.bots)
  url.searchParams.set('engine', params.engine ? '1' : '0')
  return url.href
}

const ARG_OPTIONS = {
  clients: { type: 'string', default: '2' }, bots: { type: 'string', default: '60' }, seconds: { type: 'string', default: '60' },
  url: { type: 'string', default: 'http://localhost:5191/game.html' }, server: { type: 'string', default: 'wss://relay.etcito.com/ws' },
  chrome: { type: 'string', default: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
  port: { type: 'string', default: '9341' }, boot: { type: 'string', default: '30' }, engine: { type: 'boolean', default: false },
  'late-client': { type: 'boolean', default: false }, 'background-client': { type: 'boolean', default: false },
  until: { type: 'string' }, deadline: { type: 'string', default: '900' },
}

/** Parses the CLI flags; --until keeps only round-ended/show-ended, --clients 1..4, --bots is the total seats. */
export function parseHarnessArgs(argv) {
  const { values: o } = parseArgs({ args: argv, options: ARG_OPTIONS })
  const clients = Number(o.clients)
  if (!Number.isInteger(clients) || clients < 1 || clients > NAMES.length) throw new Error(`--clients must be 1..${NAMES.length}`)
  const bots = Number(o.bots)
  if (!Number.isInteger(bots) || bots < 1) throw new Error('--bots is the total number of seats (for example 60)')
  const until = o.until ?? null
  if (until !== null && until !== 'round-ended' && until !== 'show-ended') throw new Error('--until must be round-ended or show-ended')
  const number = (value, name) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number`)
    return n
  }
  return {
    clients, bots, until, engine: o.engine, lateClient: o['late-client'], backgroundClient: o['background-client'],
    seconds: number(o.seconds, 'seconds'), url: o.url, server: o.server, chrome: o.chrome, port: number(o.port, 'port'),
    boot: number(o.boot, 'boot'), deadline: number(o.deadline, 'deadline'),
  }
}

/** The acceptance verdict: every client is admitted in one lobby with two humans and 58 bots, a confirmed round and no faults. */
export function evaluateCompletion(states, signals, exceptions, until) {
  const problems = []
  const lists = signals ?? []
  const has = signal => lists.length === states.length && lists.every(list => list.includes(signal))
  if (states.length === 0) problems.push('no client reported a state')
  const lobbyIds = new Set()
  states.forEach((s, i) => {
    const name = `client ${i + 1} (${s?.flow ?? 'unknown'})`
    if (!s) { problems.push(`${name}: no state`); return }
    if (s.humans !== states.length) problems.push(`${name}: humans ${s.humans}, expected ${states.length}`)
    if (s.bots !== s.seats - s.humans) problems.push(`${name}: bots ${s.bots} != seats ${s.seats} - humans ${s.humans}`)
    if (s.desyncs !== 0) problems.push(`${name}: desyncs ${s.desyncs}`)
    if (s.faults !== 0) problems.push(`${name}: faults ${s.faults}`)
    if (s.error !== null) problems.push(`${name}: error ${s.error}`)
    if (s.lobbyId === null || s.lobbyId === undefined) problems.push(`${name}: no lobby id`)
    else lobbyIds.add(s.lobbyId)
  })
  if (lobbyIds.size > 1) problems.push(`lobby ids differ: ${[...lobbyIds].join(', ')}`)
  if ((exceptions ?? []).some(n => n > 0)) problems.push('a Runtime.exceptionThrown was reported')
  if (until === 'round-ended') {
    if (!has('round-ended')) problems.push("missing 'round-ended' signal")
    states.forEach((s, i) => { if (s && !(s.completedRounds >= 1)) problems.push(`client ${i + 1}: completedRounds ${s.completedRounds}`) })
  } else {
    if (!has('podium-ready')) problems.push("missing 'podium-ready' signal")
    if (!has('hub-returned')) problems.push("missing 'hub-returned' signal")
  }
  return { ok: problems.length === 0, problems }
}

let active = null
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const messageOf = e => (e instanceof Error ? e.message : String(e))
const shown = state => (state === null || state === undefined ? 'none' : JSON.stringify(state))

function withDefaults(deps) {
  return {
    spawn: deps.spawn ?? nodeSpawn, fetch: deps.fetch ?? globalThis.fetch, WebSocket: deps.WebSocket ?? globalThis.WebSocket,
    sleep: deps.sleep ?? sleep, now: deps.now ?? (() => Date.now()), tmpdir: deps.tmpdir ?? nodeTmpdir,
    log: deps.log ?? ((...args) => console.log(...args)), error: deps.error ?? ((...args) => console.error(...args)),
  }
}

function waitExit(d, child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = value => { if (!settled) { settled = true; resolve(value) } }
    if (typeof child.once === 'function') child.once('exit', () => finish(true))
    d.sleep(ms).then(() => finish(false))
  })
}

async function cleanup(d, owned) {
  let closed = 0
  for (const child of owned) {
    if (child.exitCode !== null || child.signalCode !== null) { closed += 1; continue }
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    if (!(await waitExit(d, child, EXIT_WAIT_MS))) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      await waitExit(d, child, EXIT_WAIT_MS)
    }
    closed += 1
  }
  return closed
}

async function openPage(options, d, index, owned) {
  const name = NAMES[index]
  const port = options.port + index
  const url = clientUrl(options.url, { server: options.server, name, bots: String(options.bots), engine: options.engine })
  // No throttling-disabling flags: a genuinely hidden page must stay throttled (the background-client case).
  const child = d.spawn(options.chrome, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(d.tmpdir(), `rf-online-chrome-${port}`)}`, '--no-first-run', '--enable-unsafe-webgpu',
    '--window-size=960,540', url], { stdio: 'ignore' })
  owned.push(child)
  let target = null
  const until = d.now() + options.boot * 1000 + STALL_MS
  while (target === null) {
    if (d.now() > until) throw new Error(`${name}: Chrome on port ${port} did not open the game page`)
    try {
      const list = await (await d.fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find(t => typeof t.url === 'string' && t.url.includes(`name=${name}`)) ?? null
    } catch { /* browser not up yet */ }
    if (target === null) await d.sleep(POLL_MS)
  }
  const ws = new d.WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const page = { name, port, targetId: target.id ?? null, child, exceptions: 0, state: null, signals: [] }
  const waiting = new Map()
  let id = 0
  page.call = (method, params = {}) => new Promise(resolve => {
    const i = ++id
    waiting.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') page.exceptions += 1
  }
  await page.call('Runtime.enable')
  page.evaluate = async expression => (await page.call('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value
  page.read = async () => {
    page.state = await page.evaluate(STATE)
    page.signals = (await page.evaluate(SIGNALS)) ?? []
    return page
  }
  return page
}

async function pollPage(d, page, deadlineAt, label, check) {
  for (;;) {
    if (d.now() > deadlineAt) throw new Error(`${page.name}: deadline before ${label}; last state ${shown(page.state)}`)
    await page.read()
    const state = page.state
    if (state && state.error !== null && state.error !== undefined) throw new Error(`${page.name}: ${state.error}; last state ${shown(state)}`)
    if (check(state, page.signals)) return state
    await d.sleep(POLL_MS)
  }
}

async function playPage(page) {
  const played = await page.evaluate(PLAY)
  if (played !== true) throw new Error(`${page.name}: rfEngine.play() returned ${shown(played)}`)
}

/**
 * Ordered launch steps of the engine scenario. A late client's page is opened and start-ready, and left unpressed,
 * before client 1 presses Play: a localhost page gets a dev lobby that starts shortly after the first player
 * (docs/network.md), so the engine page cannot load inside that window. Client 2 presses Play only after client 1
 * reports lobby-ready, so the late press lands inside the open lobby window.
 */
export function engineLaunchPlan(lateClient) {
  return lateClient
    ? ['open 1', 'open 2', 'start-ready 1', 'start-ready 2', 'press 1', 'lobby-ready 1', 'press 2', 'same-lobby 2']
    : ['open 1', 'open 2', 'start-ready 1', 'press 1', 'lobby-ready 1', 'start-ready 2', 'press 2', 'same-lobby 2']
}

async function runEngine(options, d, owned) {
  const until = options.until ?? 'round-ended'
  const deadlineAt = d.now() + options.deadline * 1000
  const pages = []
  const ready = s => s?.ready === true && s.screen === 'start'
  let first = null, second = null, lobbyId = null
  for (const step of engineLaunchPlan(options.lateClient)) {
    if (step === 'open 1') { first = await openPage(options, d, 0, owned); pages.push(first) }
    else if (step === 'open 2') { second = await openPage(options, d, 1, owned); pages.push(second) }
    else if (step === 'start-ready 1') await pollPage(d, first, deadlineAt, 'client 1 start ready', ready)
    else if (step === 'start-ready 2') await pollPage(d, second, deadlineAt, 'client 2 start ready', ready)
    else if (step === 'press 1') await playPage(first)
    else if (step === 'lobby-ready 1') {
      await pollPage(d, first, deadlineAt, 'client 1 lobby-ready', (s, sig) => sig.includes('lobby-ready') && s?.lobbyId !== null)
      lobbyId = first.state.lobbyId
    } else if (step === 'press 2') await playPage(second)
    else if (step === 'same-lobby 2') await pollPage(d, second, deadlineAt, 'client 2 same lobby', s => s?.lobbyId === lobbyId)
  }
  d.log(`[harness] client 2 joined lobby ${lobbyId}`)
  for (const page of pages) {
    await pollPage(d, page, deadlineAt, 'flow match', s => s?.flow === 'match' && s.humans === options.clients)
  }

  let background = null
  if (options.backgroundClient) {
    const created = await first.call('Target.createTarget', { url: 'about:blank' })
    background = created?.targetId ?? null
    await first.call('Target.activateTarget', { targetId: background })
    const hidden = await pollPage(d, first, d.now() + STALL_MS, 'background visibility hidden', s => s?.visibility === 'hidden')
    await pollPage(d, first, d.now() + STALL_MS, 'background tick advances',
      s => s?.visibility === 'hidden' && s.tick > hidden.tick)
  }

  const lastTick = new Map(pages.map(page => [page, page.state?.tick ?? 0]))
  const lastChange = new Map(pages.map(page => [page, d.now()]))
  for (;;) {
    if (d.now() > deadlineAt) {
      throw new Error(`deadline before ${until}; ${pages.map(page => `${page.name} ${shown(page.state)}`).join(' | ')}`)
    }
    for (const page of pages) await page.read()
    const verdict = evaluateCompletion(pages.map(page => page.state), pages.map(page => page.signals),
      pages.map(page => page.exceptions), until)
    if (verdict.ok) break
    for (const page of pages) {
      const tick = page.state?.tick ?? 0
      if (tick !== lastTick.get(page)) { lastTick.set(page, tick); lastChange.set(page, d.now()) }
      if (d.now() - lastChange.get(page) > STALL_MS) {
        throw new Error(`${page.name}: stalled at tick ${tick}; last state ${shown(page.state)}`)
      }
    }
    const required = until === 'round-ended' ? ['round-ended'] : ['podium-ready', 'hub-returned']
    if (pages.every(page => required.every(signal => page.signals.includes(signal)))) {
      throw new Error(`completion failed: ${verdict.problems.join('; ')}`)
    }
    await d.sleep(POLL_MS)
  }
  if (background !== null) await first.call('Target.activateTarget', { targetId: first.targetId })
  d.log(`[harness] ${until} reached: ${pages.map(page => `${page.name} tick ${page.state?.tick} humans ${page.state?.humans}`).join(', ')}`)
  return 0
}

async function runLegacy(options, d, owned) {
  const pages = []
  for (let i = 0; i < options.clients; i++) pages.push(await openPage(options, d, i, owned))
  await d.sleep(options.boot * 1000)
  // Play sits at the same place of the start screen in every page; all presses land inside one lobby window.
  for (const page of pages) {
    const size = await page.evaluate('[innerWidth, innerHeight]')
    if (!Array.isArray(size)) throw new Error(`${page.name}: ${shown(size)}`)
    const x = Math.round(size[0] * 0.58), y = Math.round(size[1] * 0.923)
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
  }
  const t0 = d.now()
  while (d.now() - t0 < options.seconds * 1000) {
    await d.sleep(5000)
    for (const page of pages) d.log(`[${page.name}] t=${Math.round((d.now() - t0) / 1000)}s ${String(await page.evaluate(DIAG)).slice(0, 320)}`)
  }
  return 0
}

/**
 * Handoff: Online harness: host launch documentation and online command registration (card 9207) runs this file
 * as a process. The CLI parses process.argv and calls run(options: HarnessOptions, deps?: RunDeps): Promise<number>,
 * exported by tools/onlineChromes.mjs; the exposing side attaches only the spawned Chrome processes and reads the
 * process exit code. State/keys: the parsed HarnessOptions flags (--engine, --late-client, --background-client,
 * --until, --deadline, --clients, --bots, --seconds, --url, --server, --chrome, --port, --boot); no shared registry.
 */
export async function run(options, deps = {}) {
  const d = withDefaults(deps)
  const owned = []
  let closePromise = null
  const close = () => (closePromise ??= cleanup(d, owned))
  active = { close }
  let code = 1
  try {
    code = options.engine ? await runEngine(options, d, owned) : await runLegacy(options, d, owned)
  } catch (e) {
    d.error(`[harness] ${messageOf(e)}`)
    code = 1
  } finally {
    const closed = await close()
    d.log(`[harness] closed ${closed} owned Chrome${closed === 1 ? '' : 's'}`)
    active = null
  }
  return code
}

async function main() {
  let options
  try {
    options = parseHarnessArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`[harness] ${messageOf(e)}`)
    process.exitCode = 2
    return
  }
  const stop = () => {
    const running = active
    if (running === null) { process.exit(1); return }
    void running.close().then(closed => console.log(`[harness] closed ${closed} owned Chrome${closed === 1 ? '' : 's'}`))
      .finally(() => process.exit(1))
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
  process.on('uncaughtException', e => { console.error(e); stop() })
  process.exitCode = await run(options)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
