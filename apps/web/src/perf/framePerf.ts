// Per-module frame timing behind ?perf=1 (off by default: every call below returns at once when off).
// span(name) ... end(): CPU time of one module call; calls of one name within a frame add up. The frame's
// totals feed a 2 s window (avg / p95 / max per frame); the top 20 show in an overlay, one console line per second
// names the top 5, and window.rfEngine.frameTimings() / window.rfPerf.frameTimings() return the same as JSON.
// GPU pass times need raa to expose timestamp-query pass names; it does not, so they are not reported.

export interface ModuleTiming { readonly name: string; readonly avgMs: number; readonly p95Ms: number; readonly maxMs: number; readonly calls: number }
export interface FrameTimings {
  readonly enabled: boolean
  readonly fps: number
  readonly frameMs: { readonly avg: number; readonly p95: number; readonly max: number }
  readonly canvas: readonly { readonly width: number; readonly height: number; readonly cssWidth: number; readonly cssHeight: number }[]
  readonly devicePixelRatio: number
  readonly counters: Readonly<Record<string, number>>
  readonly modules: readonly ModuleTiming[]
}

const WINDOW_MS = 2000
export const perfEnabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1'

interface Sample { at: number; ms: number; calls: number }
const open = new Map<string, { ms: number; calls: number }>()
const history = new Map<string, Sample[]>()
const frames: { at: number; ms: number }[] = []
const counters: Record<string, number> = {}
let frameStart = 0
let overlay: HTMLElement | null = null
let lastReport = 0
let last: FrameTimings = emptyTimings()

function emptyTimings(): FrameTimings {
  return { enabled: perfEnabled, fps: 0, frameMs: { avg: 0, p95: 0, max: 0 }, canvas: [], devicePixelRatio: 1, counters: {}, modules: [] }
}

/** Starts a span; the returned token is passed to end(). 0 when perf is off. */
export function span(): number { return perfEnabled ? performance.now() : 0 }
export function end(name: string, token: number): void {
  if (!perfEnabled) return
  const ms = performance.now() - token
  const cur = open.get(name)
  if (cur === undefined) open.set(name, { ms, calls: 1 })
  else { cur.ms += ms; cur.calls++ }
}
/** Runs fn inside a span. */
export function timed<T>(name: string, fn: () => T): T {
  if (!perfEnabled) return fn()
  const t = performance.now()
  try { return fn() } finally { end(name, t) }
}
/** A per-frame count (draw calls, uploaded bytes ...): the last value of the frame is kept. */
export function count(name: string, value: number): void { if (perfEnabled) counters[name] = value }

function percentile(sorted: number[], p: number): number { return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] }

/** Call at the start of every rendered frame; closes the previous frame's totals. */
export function frameBegin(): void {
  if (!perfEnabled) return
  const now = performance.now()
  flushFrameCounters()
  if (frameStart !== 0) closeFrame(now)
  frameStart = now
}

function closeFrame(now: number): void {
  frames.push({ at: now, ms: now - frameStart })
  for (const [name, v] of open) {
    let list = history.get(name)
    if (list === undefined) { list = []; history.set(name, list) }
    list.push({ at: now, ms: v.ms, calls: v.calls })
  }
  open.clear()
  const cutoff = now - WINDOW_MS
  while (frames.length > 0 && frames[0].at < cutoff) frames.shift()
  for (const list of history.values()) while (list.length > 0 && list[0].at < cutoff) list.shift()
  if (now - lastReport >= 1000) { lastReport = now; report(now) }
}

function build(): FrameTimings {
  const nFrames = Math.max(1, frames.length)
  const ft = frames.map(f => f.ms).sort((a, b) => a - b)
  const elapsed = frames.length > 1 ? frames[frames.length - 1].at - frames[0].at : 0
  const modules: ModuleTiming[] = []
  for (const [name, list] of history) {
    // Frames where the module did not run count as 0 ms, so avg is the cost per frame.
    const ms = list.map(s => s.ms).sort((a, b) => a - b)
    const padded = ms.length >= nFrames ? ms : [...new Array<number>(nFrames - ms.length).fill(0), ...ms]
    const sum = ms.reduce((a, b) => a + b, 0)
    modules.push({ name, avgMs: sum / nFrames, p95Ms: percentile(padded, 0.95), maxMs: ms[ms.length - 1] ?? 0, calls: list.reduce((a, s) => a + s.calls, 0) / nFrames })
  }
  modules.sort((a, b) => b.avgMs - a.avgMs)
  const canvas = [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height, cssWidth: Math.round(c.clientWidth), cssHeight: Math.round(c.clientHeight) }))
  return {
    enabled: true,
    fps: elapsed > 0 ? (frames.length - 1) * 1000 / elapsed : 0,
    frameMs: { avg: ft.reduce((a, b) => a + b, 0) / nFrames, p95: percentile(ft, 0.95), max: ft[ft.length - 1] ?? 0 },
    canvas, devicePixelRatio: window.devicePixelRatio || 1, counters: { ...counters }, modules: modules.slice(0, 20),
  }
}

function report(now: number): void {
  void now
  last = build()
  const f = (n: number): string => n.toFixed(2)
  console.log(`[perf] ${last.fps.toFixed(1)} fps, frame avg ${f(last.frameMs.avg)} p95 ${f(last.frameMs.p95)} max ${f(last.frameMs.max)} ms | ` +
    last.modules.slice(0, 5).map(m => `${m.name} ${f(m.avgMs)}`).join(', '))
  if (overlay === null) {
    overlay = document.createElement('pre')
    overlay.id = 'rf-perf'
    overlay.style.cssText = 'position:fixed;left:4px;top:4px;z-index:2147483647;margin:0;padding:6px 8px;background:rgba(0,0,0,.78);color:#9f9;font:11px/1.25 monospace;pointer-events:none;white-space:pre;max-height:96vh;overflow:hidden'
    document.body.appendChild(overlay)
  }
  const head = `${last.fps.toFixed(1)} fps  frame avg ${f(last.frameMs.avg)} p95 ${f(last.frameMs.p95)} max ${f(last.frameMs.max)} ms  dpr ${last.devicePixelRatio}\n` +
    last.canvas.map((c, i) => `canvas ${i}: ${c.width}x${c.height} (css ${c.cssWidth}x${c.cssHeight})`).join('\n') + '\n' +
    Object.entries(last.counters).map(([k, v]) => `${k} ${v}`).join('  ') + '\nmodule                                   avg    p95    max  calls/f\n'
  overlay.textContent = head + last.modules.map(m => `${m.name.padEnd(38).slice(0, 38)} ${f(m.avgMs).padStart(6)} ${f(m.p95Ms).padStart(6)} ${f(m.maxMs).padStart(6)} ${m.calls.toFixed(1).padStart(6)}`).join('\n')
}

export function frameTimings(): FrameTimings { return perfEnabled ? { ...last, modules: last.modules } : emptyTimings() }
if (perfEnabled && typeof window !== 'undefined') (window as unknown as { rfPerf?: unknown }).rfPerf = { frameTimings }

interface TexDesc { size: unknown; sampleCount?: number; mipLevelCount?: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gpu = globalThis as any
// WebGPU hook (perf only): upload bytes per frame, resources created, queue.submit CPU time, pipelines created.
const perFrame: Record<string, number> = {}
function bump(name: string, by: number): void { perFrame[name] = (perFrame[name] ?? 0) + by }
const total: Record<string, number> = { texBytesAlive: 0, bufBytesAlive: 0 }
export function flushFrameCounters(): void {
  if (!perfEnabled) return
  for (const k of Object.keys(perFrame)) { counters[k] = perFrame[k]; perFrame[k] = 0 }
  counters['gpu tex MB created (total)'] = Math.round(total.texBytesAlive / 1048576)
  counters['gpu buf MB created (total)'] = Math.round(total.bufBytesAlive / 1048576)
}
function texBytes(d: TexDesc): number {
  const size = d.size as number[] | { width: number; height?: number; depthOrArrayLayers?: number } | number[]
  const w = Array.isArray(size) ? size[0] : size.width
  const h = Array.isArray(size) ? (size[1] ?? 1) : (size.height ?? 1)
  const l = Array.isArray(size) ? (size[2] ?? 1) : (size.depthOrArrayLayers ?? 1)
  return w * h * l * 4 * (d.sampleCount ?? 1) * (d.mipLevelCount !== undefined && d.mipLevelCount > 1 ? 1.34 : 1)
}
if (perfEnabled && gpu.GPUQueue !== undefined) {
  const q = gpu.GPUQueue.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const wrapQ = (m: string, bytes: (a: unknown[]) => number, label: string): void => {
    const orig = q[m]
    q[m] = function (this: unknown, ...a: unknown[]) { bump(label, bytes(a)); bump(label + ' calls', 1); return orig.apply(this, a) }
  }
  const sizeOf = (x: unknown): number => (x as { byteLength?: number } | null)?.byteLength ?? 0
  wrapQ('writeBuffer', a => (typeof a[4] === 'number' ? (a[4] as number) * ((a[2] as { BYTES_PER_ELEMENT?: number })?.BYTES_PER_ELEMENT ?? 1) : sizeOf(a[2]) - ((a[3] as number) ?? 0)), 'upload bytes writeBuffer')
  wrapQ('writeTexture', a => sizeOf(a[1]), 'upload bytes writeTexture')
  const submit = q['submit']
  q['submit'] = function (this: unknown, ...a: unknown[]) { const t = performance.now(); try { return submit.apply(this, a) } finally { end('GPUQueue.submit', t) } }
  const dev = gpu.GPUDevice.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const wrapD = (m: string, f: (a: unknown[]) => void): void => { const orig = dev[m]; dev[m] = function (this: unknown, ...a: unknown[]) { f(a); return orig.apply(this, a) } }
  wrapD('createTexture', a => { const b = texBytes(a[0] as TexDesc); total.texBytesAlive += b; bump('textures created', 1) })
  wrapD('createBuffer', a => { const b = (a[0] as { size: number }).size; total.bufBytesAlive += b; bump('buffers created', 1) })
  wrapD('createRenderPipeline', () => bump('pipelines created', 1))
  wrapD('createComputePipeline', () => bump('pipelines created', 1))
  wrapD('createRenderPipelineAsync', () => bump('pipelines created', 1))
  wrapD('createComputePipelineAsync', () => bump('pipelines created', 1))
  const enc = gpu.GPUCommandEncoder !== undefined ? gpu.GPUCommandEncoder.prototype as unknown as Record<string, (...a: unknown[]) => unknown> : null
  if (enc !== null) {
    const bp = enc['beginRenderPass']; enc['beginRenderPass'] = function (this: unknown, ...a: unknown[]) { bump('render passes', 1); return bp.apply(this, a) }
    const cp = enc['beginComputePass']; enc['beginComputePass'] = function (this: unknown, ...a: unknown[]) { bump('compute passes', 1); return cp.apply(this, a) }
  }
}
