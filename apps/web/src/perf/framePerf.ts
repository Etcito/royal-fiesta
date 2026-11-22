// Per-module frame timing behind ?perf=1 (off by default: every call below returns at once when off).
// span(name) ... end(): CPU time of one module call; calls of one name within a frame add up. The frame's
// totals feed a 2 s window (avg / p95 / max per frame); the top 20 show in an overlay, one console line per second
// names the top 5, and window.rfEngine.frameTimings() / window.rfPerf.frameTimings() return the same as JSON.
// GPU pass times need raa to expose timestamp-query pass names; it does not, so they are not reported.

export interface ModuleTiming { readonly name: string; readonly avgMs: number; readonly p95Ms: number; readonly maxMs: number; readonly calls: number }
export interface CanvasTiming {
  readonly label: string; readonly width: number; readonly height: number; readonly cssWidth: number; readonly cssHeight: number
  /** getCurrentTexture calls (one per rendered frame of that canvas) per second, over the last window. */
  readonly renderedPerSec: number
}
export interface FrameTimings {
  readonly enabled: boolean
  readonly fps: number
  readonly frameMs: { readonly avg: number; readonly p95: number; readonly max: number }
  readonly canvas: readonly CanvasTiming[]
  readonly renderScale: number
  /** Pixels presented per second, summed over every canvas. */
  readonly pixelsPerSec: number
  /** Render and compute passes of one frame by label | attachment size | format, with counts (printed once on the console too). */
  readonly passes: Readonly<Record<string, number>>
  /** GPU time per pass from timestamp queries (null supported = no WebGPU adapter seen yet); top 15 by average ms per frame. */
  readonly gpu: { readonly supported: boolean | null; readonly sumMsPerFrame: number; readonly passes: readonly { readonly key: string; readonly avgMs: number; readonly maxMs: number; readonly perFrame: number }[] }
  readonly devicePixelRatio: number
  readonly counters: Readonly<Record<string, number>>
  readonly modules: readonly ModuleTiming[]
}

const WINDOW_MS = 2000
import { renderScale } from './renderScale.ts'
import { raaReportLines } from './raaOverrides.ts'
export const perfEnabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1'

interface Sample { at: number; ms: number; calls: number }
const open = new Map<string, { ms: number; calls: number }>()
const history = new Map<string, Sample[]>()
const frames: { at: number; ms: number }[] = []
const counters: Record<string, number> = {}
let frameStart = 0
const presents: { at: number; canvas: HTMLCanvasElement }[] = []
const passSeen = new Map<string, number>()
let passFrames = 0
let passesPrinted = false
let overlay: HTMLElement | null = null
let lastReport = 0
let last: FrameTimings = emptyTimings()

function emptyTimings(): FrameTimings {
  return { enabled: perfEnabled, fps: 0, frameMs: { avg: 0, p95: 0, max: 0 }, canvas: [], renderScale: renderScale, pixelsPerSec: 0, passes: {}, gpu: { supported: null, sumMsPerFrame: 0, passes: [] }, devicePixelRatio: 1, counters: {}, modules: [] }
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
  noteFrameForPasses()
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
  const now = performance.now()
  while (presents.length > 0 && presents[0].at < now - WINDOW_MS) presents.shift()
  const canvas = [...document.querySelectorAll('canvas')].map(c => ({
    label: c.id || (c.dataset.show ? 'show' : c.dataset.client ? 'lobby' : ''), width: c.width, height: c.height, cssWidth: Math.round(c.clientWidth), cssHeight: Math.round(c.clientHeight),
    renderedPerSec: presents.filter(p => p.canvas === c).length * 1000 / WINDOW_MS,
  }))
  const pixelsPerSec = presents.reduce((a, p) => a + p.canvas.width * p.canvas.height, 0) * 1000 / WINDOW_MS
  const passes: Record<string, number> = {}
  for (const [k, n] of passSeen) passes[k] = Math.round(n / Math.max(1, passFrames) * 10) / 10
  return {
    enabled: true,
    fps: elapsed > 0 ? (frames.length - 1) * 1000 / elapsed : 0,
    frameMs: { avg: ft.reduce((a, b) => a + b, 0) / nFrames, p95: percentile(ft, 0.95), max: ft[ft.length - 1] ?? 0 },
    canvas, renderScale, pixelsPerSec, passes, gpu: gpuPassTimings(frames.length), devicePixelRatio: window.devicePixelRatio || 1, counters: { ...counters }, modules: modules.slice(0, 20),
  }
}

// Lines other modules add to the overlay (the live port's shading report): name -> text, read at each report.
const lines = new Map<string, () => string>()
export function perfLine(name: string, text: () => string): void { if (perfEnabled) lines.set(name, text) }

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
    `scale ${last.renderScale}  presented ${(last.pixelsPerSec / 1e6).toFixed(1)} Mpx/s\n` + raaReportLines().map(l => l + '\n').join('') + [...lines.values()].map(t => { try { return t() + '\n' } catch { return '' } }).join('') +
    last.canvas.map((c, i) => `canvas ${i} ${c.label}: ${c.width}x${c.height} (css ${c.cssWidth}x${c.cssHeight}) rendered ${c.renderedPerSec.toFixed(1)}/s`).join('\n') + '\n' +
    Object.entries(last.counters).map(([k, v]) => `${k} ${v}`).join('  ') + '\nmodule                                   avg    p95    max  calls/f\n'
  const gpuHead = last.gpu.supported === false ? 'GPU pass times: unavailable (the adapter has no timestamp-query)\n'
    : last.gpu.supported === null ? '' : `GPU ms per frame (sum of passes) ${f(last.gpu.sumMsPerFrame)}  [timestamp queries add a little overhead]\n  avg    max  n/f  pass (device kind label [target])\n` +
      last.gpu.passes.map(p => `${f(p.avgMs).padStart(6)} ${f(p.maxMs).padStart(6)} ${p.perFrame.toFixed(1).padStart(4)}  ${p.key}`).join('\n') + '\n'
  overlay.textContent = head.split('\nmodule  ')[0] + '\n' + gpuHead + 'module  ' + head.split('\nmodule  ')[1] + last.modules.map(m => `${m.name.padEnd(38).slice(0, 38)} ${f(m.avgMs).padStart(6)} ${f(m.p95Ms).padStart(6)} ${f(m.maxMs).padStart(6)} ${m.calls.toFixed(1).padStart(6)}`).join('\n')
}

export function frameTimings(): FrameTimings { return perfEnabled ? { ...last, modules: last.modules } : emptyTimings() }
if (perfEnabled && typeof window !== 'undefined') (window as unknown as { rfPerf?: unknown }).rfPerf = { frameTimings }

interface TexDesc { size: unknown; sampleCount?: number; mipLevelCount?: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gpu = globalThis as any
// WebGPU hook (perf only): upload bytes per frame, resources created, queue.submit CPU time, pipelines created.
const perFrame: Record<string, number> = {}
function bump(name: string, by: number): void { perFrame[name] = (perFrame[name] ?? 0) + by }
const live = { tex: 0, buf: 0 }
const sizes = new WeakMap<object, number>()
const total: Record<string, number> = { texBytesAlive: 0, bufBytesAlive: 0 }
export function flushFrameCounters(): void {
  if (!perfEnabled) return
  for (const k of Object.keys(perFrame)) { counters[k] = perFrame[k]; perFrame[k] = 0 }
  counters['gpu tex MB created (total)'] = Math.round(total.texBytesAlive / 1048576)
  counters['gpu buf MB created (total)'] = Math.round(total.bufBytesAlive / 1048576)
  counters['gpu tex MB live'] = Math.round(live.tex / 1048576)
  counters['gpu buf MB live'] = Math.round(live.buf / 1048576)
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

if (perfEnabled && gpu.GPUCanvasContext !== undefined) {
  const gc = gpu.GPUCanvasContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const gct = gc['getCurrentTexture']
  gc['getCurrentTexture'] = function (this: { canvas: HTMLCanvasElement }, ...a: unknown[]) {
    presents.push({ at: performance.now(), canvas: this.canvas })
    return gct.apply(this, a)
  }
}
export function noteFrameForPasses(): void {
  if (!perfEnabled) return
  passFrames++
  if (!passesPrinted && passFrames === 30) {
    passesPrinted = true
    console.log('[perf] passes per frame (label, count):\n' + [...passSeen].map(([k, n]) => `  ${(n / passFrames).toFixed(1)}  ${k}`).join('\n'))
  }
}

// Live (not created) GPU memory: a resource counts from createTexture/createBuffer until its destroy() (a dropped, never
// destroyed resource stays counted: the browser frees it only at garbage collection, which a resize loop shows as growth).
if (perfEnabled && gpu.GPUDevice !== undefined) {
  const d2 = gpu.GPUDevice.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const track = (m: string, key: 'tex' | 'buf', bytes: (a: unknown[]) => number, proto: string): void => {
    const orig = d2[m]
    d2[m] = function (this: unknown, ...a: unknown[]) {
      const r = orig.apply(this, a) as object
      const b = bytes(a); sizes.set(r, b); live[key] += b
      return r
    }
    const target = gpu[proto]?.prototype as Record<string, (...a: unknown[]) => unknown> | undefined
    const od = target?.['destroy']
    if (target !== undefined && od !== undefined) {
      target['destroy'] = function (this: object, ...a: unknown[]) {
        const b = sizes.get(this)
        if (b !== undefined) { live[key] -= b; sizes.delete(this) }
        return od.apply(this, a)
      }
    }
  }
  track('createTexture', 'tex', a => texBytes(a[0] as TexDesc), 'GPUTexture')
  track('createBuffer', 'buf', a => (a[0] as { size: number }).size, 'GPUBuffer')
}

// GPU time per pass (perf only; it perturbs timing slightly: one query set, a resolve and a small readback per command
// encoder, read back with mapAsync after the submit and never awaited by a frame). Needs the adapter's 'timestamp-query'
// feature, which requestDevice below asks for; without it nothing is injected and the overlay says so.
// A pass is keyed by device number (d0 = first device created: the first raa engine or the uaa host, in creation order),
// kind, its label (raa and uaa label none) and its first colour attachment's texture label, size and format.
interface GpuPassStat { readonly key: string; readonly avgMs: number; readonly maxMs: number; readonly perFrame: number }
const gpuSamples: { at: number; key: string; ms: number }[] = []
let gpuSupported: boolean | null = null
export function gpuPassTimings(nFrames: number): { supported: boolean | null; sumMsPerFrame: number; passes: GpuPassStat[] } {
  const now = performance.now()
  while (gpuSamples.length > 0 && gpuSamples[0].at < now - WINDOW_MS) gpuSamples.shift()
  const by = new Map<string, { sum: number; max: number; n: number }>()
  for (const s of gpuSamples) {
    const e = by.get(s.key) ?? { sum: 0, max: 0, n: 0 }
    e.sum += s.ms; e.n++; if (s.ms > e.max) e.max = s.ms
    by.set(s.key, e)
  }
  const n = Math.max(1, nFrames)
  const passes = [...by].map(([key, e]) => ({ key, avgMs: e.sum / n, maxMs: e.max, perFrame: e.n / n })).sort((a, b) => b.avgMs - a.avgMs)
  return { supported: gpuSupported, sumMsPerFrame: passes.reduce((a, p) => a + p.avgMs, 0), passes: passes.slice(0, 15) }
}
if (perfEnabled && gpu.GPUAdapter !== undefined && gpu.GPUDevice !== undefined && gpu.GPUCommandEncoder !== undefined) {
  interface TexInfo { label: string; w: number; h: number; format: string; samples: number }
  const texInfo = new WeakMap<object, TexInfo>()
  const viewTex = new WeakMap<object, object>()
  const devNo = new WeakMap<object, number>()
  const encDev = new WeakMap<object, object>()
  interface Slot { resolve: { destroy(): void }; read: { mapAsync(m: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void } }
  interface DevState { querySet: object; cursor: number; pool: Slot[] }
  const devState = new WeakMap<object, DevState>()
  interface EncState { dev: object; st: DevState; first: number; keys: string[] }
  const encState = new WeakMap<object, EncState>()
  const pending = new WeakMap<object, { slot: Slot; keys: string[]; st: DevState }>()
  let deviceCount = 0
  const CAP = 512, PER_ENCODER = 128

  const ad = gpu.GPUAdapter.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const reqDev = ad['requestDevice']
  ad['requestDevice'] = function (this: { features: { has(f: string): boolean } }, ...a: unknown[]) {
    const supported = this.features.has('timestamp-query')
    gpuSupported = (gpuSupported ?? false) || supported
    if (supported) {
      const d = { ...((a[0] as object | undefined) ?? {}) } as { requiredFeatures?: Iterable<string> }
      d.requiredFeatures = [...(d.requiredFeatures ?? []), 'timestamp-query']
      a[0] = d
    }
    return (reqDev.apply(this, a) as Promise<object>).then(dev => { devNo.set(dev, deviceCount++); return dev })
  }
  const dev = gpu.GPUDevice.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const cte = dev['createTexture']
  dev['createTexture'] = function (this: unknown, ...a: unknown[]) {
    const r = cte.apply(this, a) as object
    const d = a[0] as { label?: string; size: number[] | { width: number; height?: number }; format: string; sampleCount?: number }
    const size = d.size
    texInfo.set(r, { label: d.label ?? '', w: Array.isArray(size) ? size[0] : size.width, h: Array.isArray(size) ? (size[1] ?? 1) : (size.height ?? 1), format: d.format, samples: d.sampleCount ?? 1 })
    return r
  }
  const tex = gpu.GPUTexture.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const cv = tex['createView']
  tex['createView'] = function (this: object, ...a: unknown[]) { const v = cv.apply(this, a) as object; viewTex.set(v, this); return v }
  const cce = dev['createCommandEncoder']
  dev['createCommandEncoder'] = function (this: object, ...a: unknown[]) { const e = cce.apply(this, a) as object; encDev.set(e, this); return e }

  const stateOf = (d: { features: { has(f: string): boolean }; createQuerySet(x: unknown): object }): DevState | null => {
    let st = devState.get(d)
    if (st !== undefined) return st
    if (!d.features.has('timestamp-query')) return null
    st = { querySet: d.createQuerySet({ type: 'timestamp', count: CAP }), cursor: 0, pool: [] }
    devState.set(d, st)
    return st
  }
  const describe = (kind: string, d: { label?: string; colorAttachments?: Iterable<{ view?: object } | null>; depthStencilAttachment?: { view?: object } } | undefined, device: object): string => {
    const first = d?.colorAttachments !== undefined ? [...d.colorAttachments][0] : undefined
    const view = first?.view ?? d?.depthStencilAttachment?.view
    const info = view !== undefined ? texInfo.get(viewTex.get(view) ?? {}) : undefined
    const target = info === undefined ? '' : ` [${info.label !== '' ? info.label + ' ' : ''}${info.w}x${info.h} ${info.format}${info.samples > 1 ? ' x' + info.samples : ''}]`
    return `d${devNo.get(device) ?? '?'} ${kind} ${d?.label ?? ''}${target}`
  }
  const enc = gpu.GPUCommandEncoder.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const inject = (method: 'beginRenderPass' | 'beginComputePass', kind: string): void => {
    const orig = enc[method]
    enc[method] = function (this: object, ...a: unknown[]) {
      const d = a[0] as { timestampWrites?: unknown; label?: string } | undefined
      const device = encDev.get(this)
      const st = device === undefined ? null : stateOf(device as never)
      if (device !== undefined && st !== null && (d?.timestampWrites === undefined)) {
        let es = encState.get(this)
        if (es === undefined) {
          if (st.cursor + 2 > CAP - 2 * PER_ENCODER) st.cursor = 0
          es = { dev: device, st, first: st.cursor, keys: [] }
          encState.set(this, es)
        }
        if (es.keys.length < PER_ENCODER) {
          const i = es.first + es.keys.length * 2
          const key = describe(kind, d as never, device)
          es.keys.push(key)
          passSeen.set(key, (passSeen.get(key) ?? 0) + 1)
          a[0] = { ...(d ?? {}), timestampWrites: { querySet: st.querySet, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } }
          st.cursor = i + 2
        }
      }
      return orig.apply(this, a)
    }
  }
  inject('beginRenderPass', 'render')
  inject('beginComputePass', 'compute')
  const fin = enc['finish']
  enc['finish'] = function (this: { resolveQuerySet(...a: unknown[]): void; copyBufferToBuffer(...a: unknown[]): void }, ...a: unknown[]) {
    const es = encState.get(this)
    if (es !== undefined && es.keys.length > 0) {
      const d = es.dev as { createBuffer(x: unknown): Slot['resolve'] & Slot['read'] }
      const bytes = es.keys.length * 16
      const slot = es.st.pool.pop() ?? { resolve: d.createBuffer({ size: PER_ENCODER * 16, usage: 0x200 | 0x4 /* QUERY_RESOLVE | COPY_SRC */ }), read: d.createBuffer({ size: PER_ENCODER * 16, usage: 0x1 | 0x8 /* MAP_READ | COPY_DST */ }) } as Slot
      this.resolveQuerySet(es.st.querySet, es.first, es.keys.length * 2, slot.resolve, 0)
      this.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, bytes)
      const cb = fin.apply(this, a) as object
      pending.set(cb, { slot, keys: es.keys, st: es.st })
      encState.delete(this)
      return cb
    }
    return fin.apply(this, a)
  }
  const q = gpu.GPUQueue.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const sub = q['submit']
  q['submit'] = function (this: unknown, ...a: unknown[]) {
    const r = sub.apply(this, a)
    for (const cb of (a[0] as Iterable<object>)) {
      const p = pending.get(cb)
      if (p === undefined) continue
      pending.delete(cb)
      void p.slot.read.mapAsync(1).then(() => {
        const t = new BigUint64Array(p.slot.read.getMappedRange().slice(0))
        p.slot.read.unmap()
        p.st.pool.push(p.slot)
        const at = performance.now()
        for (let k = 0; k < p.keys.length; k++) gpuSamples.push({ at, key: p.keys[k], ms: Number(t[2 * k + 1] - t[2 * k]) / 1e6 })
      }, () => { p.st.pool.push(p.slot) })
    }
    return r
  }
}
