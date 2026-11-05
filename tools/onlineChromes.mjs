// Online check on one machine: N headless Chromes open the game, press Play inside the same lobby window, and the
// net diagnostics line of each is printed every few seconds (tick, pred, rb/s, stall/s, rtt, sync, fps, mesh peers).
// Plain Node (no dependencies) so it runs where Chrome runs (Windows). The script owns its browsers: it starts
// them and kills them on every exit (end, error, Ctrl-C, deadline); a browser left open keeps rendering the game.
//
//   node tools/onlineChromes.mjs [--clients 2] [--bots 60] [--seconds 60] [--url http://localhost:5191/game.html]
//                                [--server wss://relay.etcito.com/ws] [--chrome <chrome.exe>] [--port 9341]
//
// The page must be served from an origin the relay admits (production: http://localhost:5191, see docs/network.md);
// a localhost page gets a dev lobby that starts 10 s after the first player.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: o } = parseArgs({ options: {
  clients: { type: 'string', default: '2' }, bots: { type: 'string', default: '60' }, seconds: { type: 'string', default: '60' },
  url: { type: 'string', default: 'http://localhost:5191/game.html' }, server: { type: 'string', default: 'wss://relay.etcito.com/ws' },
  chrome: { type: 'string', default: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
  port: { type: 'string', default: '9341' }, boot: { type: 'string', default: '30' },
} })
const clients = Number(o.clients), seconds = Number(o.seconds), basePort = Number(o.port)
const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta']
if (!(clients >= 1 && clients <= NAMES.length)) throw new Error(`--clients must be 1..${NAMES.length}`)

const browsers = []
function closeAll() {
  for (const b of browsers) { try { b.kill() } catch { /* already gone */ } }
  browsers.length = 0
}
process.on('exit', closeAll)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(1))
process.on('uncaughtException', e => { console.error(e); process.exit(1) })
// Boot, lobby wait and the run itself, plus a margin: past it the browsers are closed whatever happens.
setTimeout(() => { console.error('deadline: closing the browsers'); process.exit(1) }, (Number(o.boot) + 60 + seconds) * 1000).unref()

const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = []
for (let i = 0; i < clients; i++) {
  const port = basePort + i, name = NAMES[i]
  // One profile per debugging port, reused by every run: nothing piles up and nothing must be deleted at exit.
  const dir = join(tmpdir(), `rf-online-chrome-${port}`)
  const url = `${o.url}?server=${encodeURIComponent(o.server)}&name=${name}&bots=${o.bots}`
  browsers.push(spawn(o.chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu', '--window-size=960,540', url],
  { stdio: 'ignore' }))
  pages.push({ name, port })
}

for (const p of pages) {
  let target
  for (let k = 0; k < 120 && !target; k++) {
    try { target = (await (await fetch(`http://127.0.0.1:${p.port}/json/list`)).json()).find(t => t.url.includes('name=')) } catch { /* not up yet */ }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error(`${p.name}: Chrome on port ${p.port} did not open the game page`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const waiting = new Map()
  p.call = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
      if (!/vertex colour/.test(text)) console.log(`[${p.name}] ${m.params.type}: ${text.slice(0, 400)}`)
    }
    if (m.method === 'Runtime.exceptionThrown') console.log(`[${p.name}] exception: ${JSON.stringify(m.params.exceptionDetails).slice(0, 400)}`)
  }
  await p.call('Runtime.enable')
}

// A page that does not answer in 4 s has a blocked main thread: that is a finding, not a harness error.
const evaluate = (p, expression) => Promise.race([
  p.call('Runtime.evaluate', { expression, returnByValue: true }).then(r => r?.result?.value),
  sleep(4000).then(() => 'HUNG (main thread did not answer in 4 s)'),
])
const DIAG = "[...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /net tick|relay /.test(e.textContent)).map(e => e.textContent).join(' || ')"

await sleep(Number(o.boot) * 1000)
// Play sits at the same place of the start screen in every page; all presses land inside one lobby window.
for (const p of pages) {
  const size = await evaluate(p, '[innerWidth, innerHeight]')
  if (!Array.isArray(size)) throw new Error(`${p.name}: ${size}`)
  const x = Math.round(size[0] * 0.58), y = Math.round(size[1] * 0.923)
  await p.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (const type of ['mousePressed', 'mouseReleased']) await p.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
}
for (let k = 0; k < 40; k++) {
  await sleep(2000)
  if (String(await evaluate(pages[0], DIAG)).includes('net tick')) break
}
const t0 = Date.now()
while (Date.now() - t0 < seconds * 1000) {
  await sleep(5000)
  for (const p of pages) console.log(`[${p.name}] t=${Math.round((Date.now() - t0) / 1000)}s ${String(await evaluate(p, DIAG)).slice(0, 320)}`)
}
process.exit(0)
