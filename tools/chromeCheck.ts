// Local, managed Chrome checks. No GPU service slot is used.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { packContent, profileAssetIds } from './content.ts'
import { MeshBaker } from './meshBake.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, input: { type: 'string' } } })
const [op] = positionals
if (!op || positionals.length !== 1 || !values.out) throw new Error('Usage: chromeCheck.ts <op> --out <dir> [--input <file.json>]')
const out = resolve(values.out)
mkdirSync(out, { recursive: true })
const report = { json: null as unknown, pageErrors: [] as string[], consoleErrors: [] as string[], failedRequests: [] as string[], error: undefined as string | undefined }
const dist = resolve('apps/web/dist')
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.avif': 'image/avif', '.wav': 'audio/wav' }
const server = createServer((req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    // Match tools/play.ts: local builds have no deployment stamp.
    if (path === '/rf-build.json' && !existsSync(join(dist, path))) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ commit: null, builtAt: 'dev' }))
      return
    }
    const file = resolve(dist, '.' + (path.endsWith('/') ? path + 'index.html' : path))
    if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  } catch { res.writeHead(400); res.end() }
})
let chrome: ChildProcess | undefined
let ws: WebSocket | undefined
let profile: string | undefined
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function cleanup(): void {
  ws?.close()
  chrome?.kill('SIGKILL')
  server.closeAllConnections()
  server.close()
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { cleanup(); process.exit(1) })
try {
  if (!existsSync(join(dist, 'game.html'))) throw new Error('apps/web/dist/game.html missing; run npm run build')
  if (!process.env.CHROME_PATH) throw new Error('CHROME_PATH is unset')
  const input: unknown = values.input ? JSON.parse(readFileSync(values.input, 'utf8')) : {}
  const cpus = Math.max(1, Math.floor(Number(process.env.NMC_CPUS) || 1))
  process.env.RF_MESH_JOBS = String(Math.min(cpus, Math.max(1, Math.floor(Number(process.env.RF_MESH_JOBS) || cpus))))
  const catalog = JSON.parse(readFileSync('economy/catalog.season1.json', 'utf8')) as { items: { asset: string }[] }
  const baker = new MeshBaker(undefined, undefined, new Set([...await profileAssetIds('sprint'), ...catalog.items.map(item => item.asset)]))
  await baker.scan()
  packContent(join(dist, 'content'), undefined, baker.keys)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No HTTP listener')
  profile = mkdtempSync(join(tmpdir(), 'chrome-check-'))
  chrome = spawn(process.env.CHROME_PATH, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' })
  let launchError: Error | undefined
  chrome.on('error', error => { launchError = error })
  const portFile = join(profile, 'DevToolsActivePort')
  const launchDeadline = Date.now() + 10_000
  while (!existsSync(portFile)) {
    if (launchError) throw launchError
    if (chrome.exitCode !== null || Date.now() >= launchDeadline) throw new Error('Chrome did not expose DevTools')
    await delay(50)
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n')
  const socket = ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('DevTools websocket failed')) })
  let nextId = 0
  // CDP is a dynamic wire protocol; errors are checked before handing results to callers.
  type Params = Record<string, any>
  const pending = new Map<number, { resolve: (value: Params) => void; reject: (error: Error) => void }>()
  const urls = new Map<string, string>()
  socket.onmessage = event => {
    const m = JSON.parse(String(event.data))
    if (m.id) {
      const call = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) call?.reject(new Error(JSON.stringify(m.error)))
      else call?.resolve(m.result)
      return
    }
    const p = m.params ?? {}
    if (m.method === 'Runtime.exceptionThrown') report.pageErrors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text)
    else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') report.consoleErrors.push(p.args.map((a: Params) => a.value ?? a.description).join(' '))
    else if (m.method === 'Log.entryAdded' && p.entry.level === 'error') report.consoleErrors.push(`${p.entry.text} ${p.entry.url ?? ''}`)
    else if (m.method === 'Network.requestWillBeSent') urls.set(p.requestId, p.request.url)
    else if (m.method === 'Network.loadingFailed') report.failedRequests.push(`${urls.get(p.requestId)} ${p.errorText}`)
    else if (m.method === 'Network.responseReceived' && p.response.status >= 400) report.failedRequests.push(`${p.response.url} HTTP ${p.response.status}`)
  }
  socket.onclose = () => { for (const call of pending.values()) call.reject(new Error('DevTools disconnected')); pending.clear() }
  const send = (method: string, params = {}, sessionId?: string): Promise<Params> => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, method === 'Runtime.evaluate' ? 300_000 : 30_000)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const page = (method: string, params = {}) => send(method, params, sessionId)
  for (const domain of ['Runtime', 'Log', 'Network', 'Page']) await page(`${domain}.enable`)
  const evaluate = async (expression: string): Promise<any> => {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  // Smallest probe: verify the blank target before navigating to the real App.
  if (await evaluate('1 + 1') !== 2) throw new Error('Blank page CDP probe failed')
  await page('Page.navigate', { url: `http://127.0.0.1:${address.port}/game.html?test=1` })
  const deadline = Date.now() + 30_000
  while (!await evaluate(`typeof window.nmcGpu?.ops?.[${JSON.stringify(op)}] === 'function'`)) {
    if (Date.now() >= deadline) throw new Error(`window.nmcGpu.ops.${op} did not appear within 30 s`)
    await delay(100)
  }
  const result = await evaluate(`(async () => {
    const result = await window.nmcGpu.ops[${JSON.stringify(op)}](${JSON.stringify(input)})
    const files = await Promise.all((result.files ?? []).map(async file => {
      if (!file.blob) return file
      const bytes = new Uint8Array(await file.blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
      return { name: file.name, base64: btoa(binary) }
    }))
    return { json: result.json, files }
  })()`)
  report.json = result.json
  for (const file of result.files) {
    const path = resolve(out, file.name)
    if (!path.startsWith(out + sep) || path === join(out, 'report.json')) throw new Error(`Invalid output filename: ${file.name}`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(file.base64, 'base64'))
  }
  if (!result.json || result.json.ok === false || result.json.refusal || result.json.error || ['refused', 'error'].includes(result.json.status)) process.exitCode = 1
} catch (error) {
  report.error = String(error instanceof Error ? error.stack : error)
  process.exitCode = 1
} finally {
  cleanup()
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) await new Promise<void>(resolve => chrome!.once('exit', () => resolve()))
  if (profile) rmSync(profile, { recursive: true, force: true })
  if (report.pageErrors.length || report.failedRequests.length) process.exitCode = 1
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
