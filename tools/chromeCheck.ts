// Chrome checks. By default every op runs on the GPU client (a real Chrome on a hardware adapter): a
// SwiftShader capture is evidence of nothing. --software keeps the local SwiftShader browser for quick
// structural debugging only; it writes software:true and always fails wardrobe, vote and countdowns.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { publishDist, renderOp } from '../apps/headless/src/gpuClient.ts'
import { buildContentIndex, packContent, profileAssetIds } from './content.ts'
import { MeshBaker } from './meshBake.ts'
import { refuse } from '../packages/sim/src/refusal.ts'

const FIELD_CAPTURES = ['candy-world.png', 'rounded-scenery.png', 'penguin.png', 'mechanisms-a.png', 'mechanisms-b.png'] as const

/** Validate downloaded files as well as the list that will be copied into the proof. */
export function validateFieldCaptures(report: Report, out: string): void {
  const captures = objectOf(report.json).captures
  for (const name of FIELD_CAPTURES) {
    const path = join(out, name)
    if (!Array.isArray(captures) || !captures.includes(name)) {
      refuse('field-render', path, 'capture is not listed in report.json; regenerate all fieldShading captures')
    }
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      refuse('field-render', path, 'capture is missing or empty; regenerate all fieldShading captures')
    }
  }
}

// The GPU client may not have attached when the card starts; NMC_GPU_WAIT_S bounds that wait, with this
// harness default (900 s) when the card sets nothing.
export const DEFAULT_GPU_WAIT_S = 900
// A software adapter may debug these, but it never proves them.
export const SOFTWARE_PROOFS: ReadonlySet<string> = new Set(['wardrobe', 'vote', 'countdowns'])

// report.json keeps the local harness shape; adapter and software are new.
export interface Report {
  json: unknown
  pageErrors: string[]
  consoleErrors: string[]
  failedRequests: string[]
  error: string | undefined
  adapter: unknown
  software: boolean
  progress?: { phase?: unknown; lastAwaitedStep?: unknown; awaitingSteps?: unknown; lastOperation?: unknown; sequence?: unknown; gpuDevices?: unknown; heap?: unknown; heartbeats?: unknown; lifecycle?: unknown; gpuLoss?: unknown; networkAwaiting?: unknown }
}

export type Mode = 'gpu' | 'software'
type Failures = Partial<Pick<Report, 'pageErrors' | 'consoleErrors' | 'failedRequests' | 'error' | 'progress'>>

export function gpuWaitSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_GPU_WAIT_S
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`NMC_GPU_WAIT_S=${JSON.stringify(raw)} is not a positive integer`)
  return seconds
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, ms)))
}

// As tools/zoneGate.ts:54-61: a card may start before the backend supplies the client.
export async function waitForGpuClient(seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  while (!process.env.NMC_GPU_CLIENT || !existsSync(process.env.NMC_GPU_CLIENT)) {
    if (Date.now() >= deadline) throw new Error(`NMC_GPU_CLIENT did not appear within ${seconds} s`)
    await delay(Math.min(250, deadline - Date.now()))
  }
}

const BUNDLE = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*[^>]+>\s*<\/script\s*>/i
const TEST_QUERY_MARK = 'data-nmc-test-query'
const ADAPTER_MARK = 'data-nmc-check-adapter'

function bundleMatch(html: string, what: string): RegExpExecArray {
  const match = BUNDLE.exec(html)
  if (match === null) throw new Error(`apps/web/dist/game.html has no module bundle to ${what}`)
  return match
}

// The copied page keeps the local harness' evidence: every page error, console error and failed request.
// This runs before the game bundle, so the boot's own errors count too.
const DIAGNOSTICS = `window.__nmcCheck = { pageErrors: [], consoleErrors: [], failedRequests: [] };
const check = window.__nmcCheck;
const describe = value => String(value?.stack ?? value?.message ?? value);
let progress = window.__nmcGpuProgress;
let phaseAt = Date.now();
const traceGpuCalls = ${JSON.stringify(process.env.RF_TRACE_GPU === '1')};
let lease;
const gpuWaits = new Map();
let nextGpuWait = 0;
const deviceRecords = new WeakMap();
const deviceRefs = [];
window.__nmcDeviceSummary = () => {
  if (!traceGpuCalls) return;
  check.gpuDevices = deviceRefs.map(record => ({ label: record.label, destroyed: record.destroyed, alive: !!record.ref.deref(), lost: record.lost }));
  const memory = performance.memory;
  if (memory) check.heap = { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit };
};
addEventListener('message', event => {
  if (event.source === parent && event.data?.nmcGpu === true) lease = event.data.lease;
}, true);
const sendProgress = () => {
  if (lease) parent.postMessage({ nmcGpuProgress: true, lease, progress: String(check.firstError ?? progress) + '; heartbeat ' + (check.heartbeats ?? 0) + ', quiet ms ' + (Date.now() - phaseAt) + (gpuWaits.size ? '; GPU awaiting: ' + [...gpuWaits.values()].join(', ') : '') + (check.networkAwaiting?.length ? '; network awaiting: ' + check.networkAwaiting.join(', ') : '') + (check.lifecycle?.length ? '; lifecycle: ' + JSON.stringify(check.lifecycle.at(-1)) : '') }, '*');
};
Object.defineProperty(window, '__nmcGpuProgress', {
  configurable: true,
  get: () => check.firstError ?? progress,
  set: value => { progress = value; phaseAt = Date.now(); sendProgress() },
});
if (typeof setInterval === 'function') setInterval(() => { check.heartbeats = (check.heartbeats ?? 0) + 1; window.__nmcDeviceSummary(); sendProgress() }, 1000);
const lifecycle = event => {
  const events = check.lifecycle ??= [];
  events.push({ event: event.type, hidden: document.hidden, at: Date.now() });
  if (events.length > 16) events.shift();
  sendProgress();
};
for (const type of ['freeze', 'resume', 'visibilitychange']) document.addEventListener(type, lifecycle);
for (const type of ['pagehide', 'pageshow', 'beforeunload']) addEventListener(type, lifecycle);
const record = (kind, message) => {
  check[kind].push(message);
  if (!check.firstError) {
    check.firstError = kind + ': ' + message;
    sendProgress();
  }
};
addEventListener("error", event => {
  const target = event.target;
  if (target !== window && target && (target.src || target.href)) record('failedRequests', String(target.src ?? target.href));
  else record('pageErrors', event.error ? describe(event.error) : String(event.message));
}, true);
addEventListener("unhandledrejection", event => record('pageErrors', describe(event.reason)));
const reportError = console.error;
console.error = (...args) => { record('consoleErrors', args.map(describe).join(" ")); reportError.apply(console, args) };
if (traceGpuCalls) {
const NativeFinalizationRegistry = window.FinalizationRegistry;
if (NativeFinalizationRegistry) window.FinalizationRegistry = class extends NativeFinalizationRegistry {
  constructor(callback) {
    super(value => {
      const before = progress;
      check.lastFinalizer = callback.toString().slice(0, 180);
      if (traceGpuCalls) { progress = String(before) + '; finalizer: ' + check.lastFinalizer; sendProgress() }
      try { return callback(value) } finally { if (traceGpuCalls) { progress = before; sendProgress() } }
    });
  }
};
for (const type of ['GPUDevice', 'GPUQueue', 'GPUCanvasContext', 'GPUBuffer', 'GPUTexture', 'GPUCommandEncoder', 'GPURenderPassEncoder']) {
  const prototype = window[type]?.prototype;
  if (!prototype) continue;
  for (const method of Object.getOwnPropertyNames(prototype)) {
    if (method === 'constructor') continue;
    const original = Object.getOwnPropertyDescriptor(prototype, method)?.value;
    if (typeof original !== 'function') continue;
    prototype[method] = function (...args) {
      if (type === 'GPUDevice' && method === 'destroy') { const record = deviceRecords.get(this); if (record) record.destroyed = true }
      check.lastOperation = type + '.' + method + (args[0]?.label ? ' ' + args[0].label : '');
      const before = progress;
      if (traceGpuCalls) { progress = String(before) + '; calling: ' + check.lastOperation; sendProgress() }
      try { return original.apply(this, args) } finally { if (traceGpuCalls) { progress = before; sendProgress() } }
    };
  }
}
for (const [type, methods] of [
  ['GPU', ['requestAdapter']], ['GPUAdapter', ['requestDevice']],
  ['GPUDevice', ['createRenderPipelineAsync', 'createComputePipelineAsync', 'popErrorScope']],
]) {
  const prototype = window[type]?.prototype;
  if (!prototype) continue;
  for (const method of methods) {
    const original = prototype[method];
    if (typeof original !== 'function') continue;
    prototype[method] = function (...args) {
      const ticket = ++nextGpuWait;
      gpuWaits.set(ticket, type + '.' + method + (args[0]?.label ? ' ' + args[0].label : ''));
      check.gpuAwaiting = [...gpuWaits.values()];
      if (traceGpuCalls || type !== 'GPUDevice') sendProgress();
      const done = () => { gpuWaits.delete(ticket); check.gpuAwaiting = [...gpuWaits.values()]; if (traceGpuCalls || type !== 'GPUDevice') sendProgress() };
      let result;
      try { result = original.apply(this, args) } catch (error) { done(); throw error }
      void result.then(value => {
        if (type === 'GPUAdapter' && method === 'requestDevice') {
          const record = { label: args[0]?.label ?? 'UI', destroyed: false, ref: new WeakRef(value) };
          deviceRecords.set(value, record); deviceRefs.push(record);
          void value.lost.then(info => {
            record.lost = { reason: info.reason, message: info.message };
            if (!record.destroyed && info.reason !== 'destroyed') check.gpuLoss = record.lost;
            sendProgress();
          });
        }
        done();
      }, done);
      return result;
    };
  }
}
}
const originalFetch = window.fetch;
const networkWaits = new Map();
let nextNetworkWait = 0;
const networkAwait = async (label, work) => {
  const ticket = ++nextNetworkWait;
  networkWaits.set(ticket, label);
  check.networkAwaiting = [...networkWaits.values()];
  sendProgress();
  try { return await work() } finally {
    networkWaits.delete(ticket);
    check.networkAwaiting = [...networkWaits.values()];
    sendProgress();
  }
};
window.fetch = async (...args) => {
  const url = String(args[0]);
  try {
    const response = await networkAwait('fetch ' + url, () => originalFetch.apply(window, args));
    if (!response.ok) record('failedRequests', response.url + " HTTP " + response.status);
    for (const method of ['text', 'arrayBuffer', 'blob', 'json']) {
      const original = response[method].bind(response);
      response[method] = () => networkAwait(method + ' ' + url, original);
    }
    return response;
  } catch (error) { record('failedRequests', url + " " + describe(error)); throw error }
};
if (typeof XMLHttpRequest !== "undefined") {
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener("loadend", () => {
      if (this.status === 0 || this.status >= 400) record('failedRequests', String(args[1]) + " HTTP " + this.status);
    }, { once: true });
    return open.apply(this, args);
  };
}`

// The GPU client serves the declared page without the check's query, and ?test=1 shortens every show
// timer. Module scripts execute in document order, so this one runs before the game bundle.
export function injectTestQuery(html: string): string {
  if (html.includes(TEST_QUERY_MARK)) return html
  const match = bundleMatch(html, 'run the test query before')
  const script = `${DIAGNOSTICS}\nwindow.__nmcCheckTest = true;`
  return html.slice(0, match.index)
    + `<script type="module" ${TEST_QUERY_MARK}>${script}</script>`
    + html.slice(match.index)
}

// Diagnostics alone leave the plain URL and the production inventory branch intact.
function injectPlainDiagnostics(html: string): string {
  const match = bundleMatch(html, 'install plain diagnostics before')
  return html.slice(0, match.index) + `<script type="module" data-nmc-plain>${DIAGNOSTICS}</script>` + html.slice(match.index)
}

// The check ops do not report their adapter, so the copied page wraps the selected op and adds the facts
// to its json. The wrapper runs after the bundle registers the ops, before the GPU client calls one.
// A wrapped entry placeholder stays marked pending: the game's check install replaces it, not a duplicate.
function adapterScript(op: string): string {
  return `<script type="module" ${ADAPTER_MARK}>
const opName = ${JSON.stringify(op)}
const install = () => {
  const ops = window.nmcGpu?.ops
  if (!ops || typeof ops[opName] !== 'function' || ops[opName].nmcCheckAdapter === true) return false
  const original = ops[opName]
  ops[opName] = Object.assign(async (input, files) => {
    const check = window.__nmcCheck ??= {}
    check.phase = opName + ': adapter probe'
    check.lastAwaitedStep = 'adapter probe'
    window.__nmcGpuProgress = check.phase
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) throw new Error('chromeCheck: no WebGPU adapter')
    const info = adapter.info ?? {}
    const software = adapter.isFallbackAdapter === true || info.isFallbackAdapter === true || /swiftshader/i.test([info.vendor, info.architecture, info.description].join(' '))
    const facts = { vendor: info.vendor ?? '', architecture: info.architecture ?? '', description: info.description ?? '', software }
    const result = await original(input, files)
    window.__nmcDeviceSummary?.()
    const json = result && typeof result.json === 'object' && result.json !== null ? result.json : {}
    const chromeCheck = window.__nmcCheck ?? { pageErrors: [], consoleErrors: [], failedRequests: [] }
    return { ...result, json: { ...json, adapter: json.adapter ?? facts, software: typeof json.software === 'boolean' ? json.software : software, chromeCheck } }
  }, { nmcCheckAdapter: true, pending: original.pending === true })
  return true
}
// The lightweight entry publishes placeholders and the game later replaces the whole object.
// Wrap both synchronously so a client call cannot race the real registration.
let gpu = window.nmcGpu
Object.defineProperty(window, 'nmcGpu', {
  configurable: true,
  get: () => gpu,
  set: value => {
    if (value?.ops) value.ops = new Proxy(value.ops, {
      set: (target, key, next) => {
        Reflect.set(target, key, next);
        if (key === opName) install();
        return true;
      },
    });
    gpu = value;
    install();
  },
})
if (!install()) { const timer = setInterval(() => { if (install()) clearInterval(timer) }, 50) }
</script>`
}

function injectAdapter(html: string, op: string): string {
  if (html.includes(ADAPTER_MARK)) return html
  // The page's bundle is a deferred module (usually in head): before </body> it has already registered
  // the ops, so the wrapper is installed before the GPU client calls one.
  const at = html.lastIndexOf('</body>')
  if (at < 0) {
    const match = bundleMatch(html, 'inject the adapter check after')
    const after = match.index + match[0].length
    return html.slice(0, after) + adapterScript(op) + html.slice(after)
  }
  return html.slice(0, at) + adapterScript(op) + html.slice(at)
}

// Copy the built page to scratch: only there the op is declared and ?test=1 is applied. The source
// manifest (apps/web/public/nmc.gpu.json) and the build's own game.html are never edited.
export function prepareGpuCopy(source: string, op: string, target: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(op)) throw new Error(`invalid op name ${JSON.stringify(op)}`)
  cpSync(source, target, { recursive: true })
  const manifestFile = join(target, 'nmc.gpu.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { page?: unknown; ops?: unknown }
  if (manifest.page !== 'game.html' || !Array.isArray(manifest.ops) || !manifest.ops.every(name => typeof name === 'string')) {
    throw new Error('apps/web/dist/nmc.gpu.json must declare page game.html and an ops array of names; run npm run build')
  }
  const ops = [...new Set([...(manifest.ops as string[]), op])]
  writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, ops }, null, 2)}\n`)
  if (op === 'cosmeticThumbs' || op === 'screensPreview') rmSync(join(target, 'audio'), { recursive: true, force: true })
  const page = join(target, 'game.html')
  const html = readFileSync(page, 'utf8')
  writeFileSync(page, injectAdapter(op === 'startPlain' ? injectPlainDiagnostics(html) : injectTestQuery(html), op))
  // tools/play.ts serves the same fallback: a local build has no deployment stamp.
  const buildFile = join(target, 'rf-build.json')
  if (!existsSync(buildFile)) writeFileSync(buildFile, `${JSON.stringify({ commit: null, builtAt: 'dev' })}\n`)
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

// adapter and software are read from the op's json (the copied page adds them to every check op).
export function makeReport(json: unknown, mode: Mode, failures: Failures = {}): Report {
  const out = objectOf(json)
  const adapter = out.adapter ?? null
  const software = mode === 'software' ? true : typeof out.software === 'boolean' ? out.software : objectOf(adapter).software === true
  return {
    json,
    progress: failures.progress,
    pageErrors: failures.pageErrors ?? [],
    consoleErrors: failures.consoleErrors ?? [],
    failedRequests: failures.failedRequests ?? [],
    error: failures.error,
    adapter: mode === 'software' ? null : adapter,
    software,
  }
}

// The copied page appends its diagnostics to the op json; report.json keeps them as its own fields.
export function takeCheckDiagnostics(json: unknown): { json: unknown; failures: Failures } {
  const out = objectOf(json)
  if (!('chromeCheck' in out)) return { json, failures: {} }
  const found = objectOf(out.chromeCheck)
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const { chromeCheck: _diagnostics, ...rest } = out
  return {
    json: rest,
    failures: { pageErrors: list(found.pageErrors), consoleErrors: list(found.consoleErrors), failedRequests: list(found.failedRequests), progress: { phase: found.phase, lastAwaitedStep: found.lastAwaitedStep, awaitingSteps: found.awaitingSteps, lastOperation: found.lastOperation, sequence: found.sequence, gpuDevices: found.gpuDevices, heap: found.heap, heartbeats: found.heartbeats, lifecycle: found.lifecycle, gpuLoss: found.gpuLoss, networkAwaiting: found.networkAwaiting } },
  }
}

export function exitCode(op: string, report: Report, mode: Mode): number {
  const out = objectOf(report.json)
  if (report.json === null || report.json === undefined || out.ok === false || out.refusal || out.error
    || out.status === 'refused' || out.status === 'error' || report.error !== undefined) return 1
  if (report.pageErrors.length > 0 || report.failedRequests.length > 0) return 1
  // A GPU run must prove a hardware adapter; a missing adapter cannot prove it either.
  if (mode === 'gpu' && (report.adapter === null || report.software)) return 1
  if (mode === 'software' && SOFTWARE_PROOFS.has(op)) return 1
  return 0
}

// Bake the meshes the game page meshes (sprint profile plus every catalog cosmetic) and pack this load's
// keys into dist/content, exactly as the local route did before the GPU route took over.
async function bakeAndPack(op?: string): Promise<string> {
  const dist = resolve('apps/web/dist')
  if (!existsSync(join(dist, 'game.html'))) throw new Error('apps/web/dist/game.html missing; run npm run build')
  const cpus = Math.max(1, Math.floor(Number(process.env.NMC_CPUS) || 1))
  process.env.RF_MESH_JOBS = String(Math.min(cpus, Math.max(1, Math.floor(Number(process.env.RF_MESH_JOBS) || cpus))))
  const catalog = JSON.parse(readFileSync('economy/catalog.season1.json', 'utf8')) as { items: { asset: string }[] }
  const needed = new Set([...await profileAssetIds('sprint'), ...catalog.items.map(item => item.asset)])
  // Every page loads its shipped saved meshes, just as the served page does; baking them again adds a second
  // full server-mesh cache that exceeds the GPU upload size limit (lobbyUnload: 277.9 MB > 268.4 MB).
  {
    const assets = buildContentIndex().assets
    if ([...needed].every(id => assets.some(asset => asset.id === id && asset.mesh !== undefined))) {
      packContent(join(dist, 'content'), undefined, new Set())
      return dist
    }
  }
  const baker = new MeshBaker(undefined, undefined, needed)
  await baker.scan()
  packContent(join(dist, 'content'), undefined, baker.keys)
  return dist
}

async function gpu(op: string, input: unknown, out: string): Promise<Report> {
  const seconds = gpuWaitSeconds(process.env.NMC_GPU_WAIT_S)
  // gpuClient.ts reads the same variable for its own publish/render calls.
  process.env.NMC_GPU_WAIT_S = String(seconds)
  await waitForGpuClient(seconds)
  const dist = await bakeAndPack(op)
  const scratch = mkdtempSync(join(tmpdir(), 'chrome-check-gpu-'))
  try {
    prepareGpuCopy(dist, op, scratch)
    const pageRef = await publishDist(scratch)
    const result = await renderOp(op, input, out, op, pageRef)
    const checked = takeCheckDiagnostics(result.json)
    return makeReport(checked.json, 'gpu', checked.failures)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// Local SwiftShader route (--software): structural debugging only. Its report says software:true and
// exitCode() always fails the wardrobe, vote and countdowns proofs.
async function software(op: string, input: unknown, out: string): Promise<Report> {
  if (!process.env.CHROME_PATH) throw new Error('CHROME_PATH is unset')
  const dist = await bakeAndPack(op)
  const report = makeReport(null, 'software')
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
  // One Runtime.evaluate runs a whole op; on SwiftShader a full test-mode show can outlast five minutes.
  const EVALUATE_MS = 1_500_000
  const cleanup = (): void => {
    ws?.close()
    chrome?.kill('SIGKILL')
    server.closeAllConnections()
    server.close()
  }
  const onSignal = (): void => { cleanup(); process.exit(1) }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, onSignal)
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No HTTP listener')
    profile = mkdtempSync(join(tmpdir(), 'chrome-check-'))
    // WebGPU on Vulkan SwiftShader: ANGLE on GL SwiftShader destroys each GPUDevice at its first present.
    chrome = spawn(process.env.CHROME_PATH, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' })
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
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, method === 'Runtime.evaluate' ? EVALUATE_MS : 30_000)
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
    // mode=ops: the op boots the one App, so it never shares the wasm engine with a page App.
    await page('Page.navigate', { url: `http://127.0.0.1:${address.port}/game.html?mode=ops&test=1` })
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
  } catch (error) {
    report.error = String(error instanceof Error ? error.stack : error)
  } finally {
    cleanup()
    if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) await new Promise<void>(resolve => chrome!.once('exit', () => resolve()))
    if (profile) rmSync(profile, { recursive: true, force: true })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, onSignal)
  }
  return report
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    out: { type: 'string' }, input: { type: 'string' }, software: { type: 'boolean' },
  } })
  const [op] = positionals
  if (!op || positionals.length !== 1 || !values.out || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(op)) {
    throw new Error('Usage: chromeCheck.ts <op> --out <dir> [--input <file.json>] [--software]')
  }
  const out = resolve(values.out)
  mkdirSync(out, { recursive: true })
  const mode: Mode = values.software === true ? 'software' : 'gpu'
  const input: unknown = values.input ? JSON.parse(readFileSync(values.input, 'utf8')) : {}
  let report: Report
  // An earlier run must not supply a file the current GPU job forgot to return.
  if (op === 'fieldShading') {
    for (const name of [...FIELD_CAPTURES, 'report.json']) rmSync(join(out, name), { force: true })
  }
  try {
    report = mode === 'gpu' ? await gpu(op, input, out) : await software(op, input, out)
  } catch (error) {
    report = makeReport(null, mode, { error: String(error instanceof Error ? error.stack : error) })
  }
  if (op === 'fieldShading' && exitCode(op, report, mode) === 0) {
    try { validateFieldCaptures(report, out) }
    catch (error) { report.error = String(error) }
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  process.exitCode = exitCode(op, report, mode)
  console.log(JSON.stringify(report))
  // The condition goes on the header line itself: a reader that keeps only the first error line still sees it.
  if (report.error !== undefined) console.error(`HARNESS ERROR (full): ${report.error}`)
  // fieldShading runs every capture in one job and lists every failure (ok: false): print all, not the first.
  const opFailures = objectOf(report.json).failures
  if (op === 'fieldShading' && Array.isArray(opFailures) && opFailures.length > 0) {
    console.error(`FIELD SHADING FAILURES (${opFailures.length}, all in this run):\n${opFailures.map(f => `- ${String(f)}`).join('\n')}`)
  }
  if (report.pageErrors.length > 0) console.error(`FIRST PAGE ERROR (full):\n${report.pageErrors[0]}`)
  else if (report.consoleErrors.length > 0) console.error(`FIRST CONSOLE ERROR (full):\n${report.consoleErrors[0]}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  }
}
