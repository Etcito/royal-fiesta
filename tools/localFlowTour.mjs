// Whole-flow local run of the M7 tour in managed headless Chrome, outside the GPU card cycle.
// Serves apps/web/dist over HTTP, calls window.nmcGpu.ops.flowTour and writes every page error,
// console error, failed request and op refusal to out/s3/m7/local-flow.json (never stops at the first).
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'

const dist = resolve('apps/web/dist')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.avif': 'image/avif', '.wav': 'audio/wav' }
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const file = join(dist, path.endsWith('/') ? path + 'index.html' : path)
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://localhost:${server.address().port}`

const report = { origin, pageErrors: [], consoleErrors: [], failedRequests: [], steps: [], adapter: null }
const profile = mkdtempSync(join(tmpdir(), 'flowtour-'))
const chrome = spawn(process.env.CHROME_PATH, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' })
const portFile = join(profile, 'DevToolsActivePort')
for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100))
const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n')
const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const pending = new Map()
const urls = new Map()
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return }
  const p = m.params ?? {}
  if (m.method === 'Runtime.exceptionThrown') report.pageErrors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text)
  else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') report.consoleErrors.push(p.args.map(a => a.value ?? a.description).join(' '))
  else if (m.method === 'Log.entryAdded' && p.entry.level === 'error') report.consoleErrors.push(`${p.entry.text} ${p.entry.url ?? ''}`)
  else if (m.method === 'Network.requestWillBeSent') urls.set(p.requestId, p.request.url)
  else if (m.method === 'Network.loadingFailed') report.failedRequests.push(`${urls.get(p.requestId)} ${p.errorText}`)
  else if (m.method === 'Network.responseReceived' && p.response.status >= 400) report.failedRequests.push(`${p.response.url} HTTP ${p.response.status}`)
})
const send = (method, params = {}, sessionId) => new Promise(resolveSend => {
  const id = nextId++
  pending.set(id, resolveSend)
  ws.send(JSON.stringify({ id, method, params, sessionId }))
})
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
const page = (method, params) => send(method, params, sessionId)
ws.addEventListener('message', () => {})
for (const d of ['Runtime', 'Log', 'Network', 'Page']) await page(`${d}.enable`)

async function step(name, fn) {
  const t = Date.now()
  try { const detail = await fn(); report.steps.push({ name, ok: true, ms: Date.now() - t, detail }) }
  catch (error) { report.steps.push({ name, ok: false, ms: Date.now() - t, error: String(error?.stack ?? error) }) }
}
const evaluate = async (expression) => {
  const r = (await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

await step('load game.html', async () => {
  await page('Page.navigate', { url: `${origin}/game.html` })
  for (let i = 0; i < 300; i++) {
    if (await evaluate('Boolean(window.nmcGpu && window.nmcGpu.ops && window.nmcGpu.ops.flowTour)')) return 'nmcGpu ready'
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('window.nmcGpu.ops.flowTour never appeared')
})
await step('flowTour op', async () => {
  const summary = await evaluate(`(async () => {
    const r = await window.nmcGpu.ops.flowTour({ width: 1920, height: 1080 })
    const strip = v => JSON.parse(JSON.stringify(v, (k, x) => typeof x === 'string' && x.length > 300 ? x.slice(0, 40) + '...[' + x.length + ']' : x))
    return strip(r)
  })()`)
  report.opResult = summary
  return 'returned'
})
mkdirSync('out/s3/m7', { recursive: true })
writeFileSync('out/s3/m7/local-flow.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ pageErrors: report.pageErrors.length, consoleErrors: report.consoleErrors.length, failedRequests: report.failedRequests.length, steps: report.steps.map(s => `${s.name}:${s.ok}`) }))
chrome.kill()
server.close()
process.exit(0)
