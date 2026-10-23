// GPU client ops (GPU client protocol): page client.html?mode=ops exposes window.nmcGpu.ops.
// Captures are only ever RAA renders: with RAA unavailable the ops refuse instead of using the null port.
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { InPageMatch } from '@royal-fiesta/game/client/inpageMatch'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { CameraPose, QuatT, RenderPort, RenderStats, RenderTarget, Vec3T, Viewport } from '@royal-fiesta/game/render/port'
import type { MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'
import { browserAssetResolver, browserCourses, preloadAssets } from '../client/sources.ts'
import { hudLines } from '../client/hud.ts'
import { createRaaPort } from '../render/raaPort.ts'
import { raaStatus } from '../render/raaStatus.ts'

export interface AdapterInfo { vendor: string; architecture: string; description: string; software: boolean }
export interface RoundCaptureInput { clients: number; profile: string; width: number; height: number; captureAtS: number[] }
export interface CaptureOut { name: string; width: number; height: number; mime: 'image/png'; base64: string }
export interface RoundCaptureOutput { captures: CaptureOut[]; adapter: AdapterInfo; renderer: 'raa' }
export interface FrameTimingInput { frames: number; width: number; height: number }
export interface FrameTimingOutput { p50Ms: number; p95Ms: number; frames: number; adapter: AdapterInfo }

declare global {
  interface Window {
    nmcGpu?: { ops: { roundCapture(input: unknown): Promise<RoundCaptureOutput>; frameTiming(input: unknown): Promise<FrameTimingOutput> } }
  }
}

const WIDTH = 1920
const HEIGHT = 1080
const DT = 1 / 60
const SEED = 7
const WARMUP_FRAMES = 60
// Bounds keep a bad input from hanging the GPU browser.
const MAX_CAPTURE_S = 600
const MAX_FRAMES = 10000
const TIMING_COURSE = 'race-bean-dash'
const TIMING_OBSTACLES = 40

let rapier: Promise<RapierModule> | undefined

function rapierOnce(): Promise<RapierModule> {
  if (!rapier) rapier = initRapier()
  return rapier
}

// Minimal WebGPU shapes: the repo lib list has no @webgpu/types.
interface GpuAdapterInfoLike { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean }
interface GpuAdapterLike { info?: GpuAdapterInfoLike; isFallbackAdapter?: boolean }
interface GpuLike { requestAdapter(): Promise<GpuAdapterLike | null> }

async function adapterInfo(): Promise<AdapterInfo> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) refuse('gpu', 'navigator.gpu', 'WebGPU is not exposed by this browser; run the op in the GPU client browser')
  const adapter = await gpu.requestAdapter()
  if (adapter === null) refuse('gpu', 'navigator.gpu.requestAdapter', 'no WebGPU adapter; run the op in the GPU client browser')
  const info = adapter.info ?? {}
  const vendor = info.vendor ?? ''
  const architecture = info.architecture ?? ''
  const description = info.description ?? ''
  const fallback = info.isFallbackAdapter === true || adapter.isFallbackAdapter === true
  const software = fallback || /swiftshader/i.test(`${vendor} ${architecture} ${description}`)
  return { vendor, architecture, description, software }
}

// Shared prelude: RAA must be live (never fake a capture), then Rapier and the adapter.
async function prelude(): Promise<{ R: RapierModule; adapter: AdapterInfo }> {
  const status = await raaStatus()
  if (!status.available) refuse('render', 'raa', status.reason)
  const R = await rapierOnce()
  return { R, adapter: await adapterInfo() }
}

function field(op: string, input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) refuse('ops', `${op}.input`, 'is not an object; pass the JSON input declared in nmc.gpu.json')
  if (!Object.hasOwn(input, key)) refuse('ops', `${op}.input.${key}`, 'is missing; pass the input declared in nmc.gpu.json')
  return (input as Record<string, unknown>)[key]
}

function exact(op: string, input: unknown, key: string, want: number | string): void {
  const v = field(op, input, key)
  if (v !== want) refuse('ops', `${op}.input.${key}`, `is ${JSON.stringify(v)}; this op only supports ${JSON.stringify(want)}`)
}

function validateRoundCapture(input: unknown): RoundCaptureInput {
  const op = 'roundCapture'
  exact(op, input, 'clients', 4)
  exact(op, input, 'profile', 'sprint')
  exact(op, input, 'width', WIDTH)
  exact(op, input, 'height', HEIGHT)
  const at = field(op, input, 'captureAtS')
  if (!Array.isArray(at) || at.length === 0) refuse('ops', `${op}.input.captureAtS`, 'is not a non-empty array; pass capture times in sim seconds')
  for (let i = 0; i < at.length; i++) {
    const t = at[i]
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > MAX_CAPTURE_S) {
      refuse('ops', `${op}.input.captureAtS/${i}`, `${JSON.stringify(t)} is not a time in 0..${MAX_CAPTURE_S} s; pass sim seconds`)
    }
    if (i > 0 && t <= at[i - 1]) refuse('ops', `${op}.input.captureAtS/${i}`, `${t} is not after ${at[i - 1]}; list capture times in ascending order`)
  }
  return { clients: 4, profile: 'sprint', width: WIDTH, height: HEIGHT, captureAtS: at as number[] }
}

function validateFrameTiming(input: unknown): FrameTimingInput {
  const op = 'frameTiming'
  exact(op, input, 'width', WIDTH)
  exact(op, input, 'height', HEIGHT)
  const frames = field(op, input, 'frames')
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) {
    refuse('ops', `${op}.input.frames`, `${JSON.stringify(frames)} is not an integer in 1..${MAX_FRAMES}; pass 600 for the QB2 measurement`)
  }
  return { frames, width: WIDTH, height: HEIGHT }
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.style.cssText = `width: ${width}px; height: ${height}px; display: block;`
  document.body.appendChild(canvas)
  return canvas
}

// Forwards to the RAA port and keeps the stats of the last render(), which InPageMatch discards.
class StatsPort implements RenderPort {
  readonly kind: 'null' | 'raa'
  last: RenderStats | null = null
  private readonly inner: RenderPort
  constructor(inner: RenderPort) {
    this.inner = inner
    this.kind = inner.kind
  }
  init(target: RenderTarget): Promise<void> { return this.inner.init(target) }
  registerAsset(name: string, asset: PrimsAsset): number { return this.inner.registerAsset(name, asset) }
  createInstance(asset: number, tint: Vec3T | null): number { return this.inner.createInstance(asset, tint) }
  setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void { this.inner.setTransform(instance, t, r, s) }
  setVisible(instance: number, visible: boolean): void { this.inner.setVisible(instance, visible) }
  destroyInstance(instance: number): void { this.inner.destroyInstance(instance) }
  setCamera(viewport: number, cam: CameraPose): void { this.inner.setCamera(viewport, cam) }
  setEnvironment(env: Readonly<Record<string, unknown>> | null): void { this.inner.setEnvironment(env) }
  render(): RenderStats {
    this.last = this.inner.render()
    return this.last
  }
  capture(): Promise<Uint8Array | null> { return this.inner.capture() }
  dispose(): void { this.inner.dispose() }
}

function base64Of(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function emptyViewState(): MatchViewState {
  return {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: -1, roundKind: null, final: false, courseIndex: -1,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
}

function nextFrame(): Promise<number> {
  return new Promise(resolve => requestAnimationFrame(resolve))
}

function yieldTask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function viewportsOf(clients: number): Viewport[] {
  const w = WIDTH / 2
  const h = HEIGHT / 2
  const out: Viewport[] = []
  for (let k = 0; k < clients; k++) out.push({ x: (k % 2) * w, y: Math.floor(k / 2) * h, width: w, height: h })
  return out
}

// The RAA canvas capture has no DOM, so the HUD text is drawn here from the same hudLines.
function drawHud(ctx: CanvasRenderingContext2D, vp: Viewport, lines: string[]): void {
  ctx.save()
  ctx.font = '900 28px "Baloo 2", "Fredoka", "Arial Rounded MT Bold", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  let y = vp.y + 18
  for (let i = 0; i < lines.length; i++) {
    const w = ctx.measureText(lines[i]).width + 32
    ctx.fillStyle = i === 0 ? '#8a4dff' : i === 1 ? '#ffb72b' : i === 2 ? '#3fcf6a' : '#2a1240'
    ctx.strokeStyle = '#2a1240'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.roundRect(vp.x + 16, y, w, 40, 18)
    ctx.fill()
    ctx.stroke()
    ctx.lineWidth = 5
    ctx.strokeText(lines[i], vp.x + 32, y + 21)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(lines[i], vp.x + 32, y + 21)
    y += 48
  }
  ctx.restore()
}

async function composite(png: Uint8Array, match: InPageMatch, viewports: Viewport[]): Promise<string> {
  const image = await createImageBitmap(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (ctx === null) refuse('ops', 'roundCapture', 'no 2D canvas context for the HUD overlay; run the op in a browser with canvas 2D')
  ctx.drawImage(image, 0, 0, WIDTH, HEIGHT)
  image.close()
  const state = emptyViewState()
  for (let k = 0; k < viewports.length; k++) drawHud(ctx, viewports[k], hudLines(match.matches[k].sim.phase(state), [], k))
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) refuse('ops', 'roundCapture', 'canvas.toBlob returned null; the composited capture could not be encoded')
  return base64Of(new Uint8Array(await blob.arrayBuffer()))
}

async function roundCapture(raw: unknown): Promise<RoundCaptureOutput> {
  const input = validateRoundCapture(raw)
  const { R, adapter } = await prelude()
  const courses = await browserCourses('sprint')
  const resolver = browserAssetResolver()
  const assets = await preloadAssets(courses, resolver)
  const viewports = viewportsOf(input.clients)
  const canvas = makeCanvas(WIDTH, HEIGHT)
  const port = await createRaaPort()
  let match: InPageMatch | null = null
  try {
    await port.init({ canvas, width: WIDTH, height: HEIGHT, viewports })
    match = new InPageMatch({
      R, clients: input.clients, seed: SEED, profile: 'sprint', courses, ports: [port], assets, bean: assets('bean'),
      net: { rttMs: 100, jitterMs: 10, loss: 0.02 }, pilots: [true, true, true, true],
    })
    const captures: CaptureOut[] = []
    let frames = 0
    for (let i = 0; i < input.captureAtS.length; i++) {
      const t = input.captureAtS[i]
      while (frames * DT < t && !match.done) {
        match.frame(DT)
        frames++
        // Yield now and then so the GPU browser stays responsive during long runs.
        if (frames % 60 === 0) await yieldTask()
      }
      const png = await port.capture()
      if (png === null || png.length === 0) refuse('render', 'raa', `capture at ${t} s returned no PNG bytes; the RAA port must read the canvas back`)
      captures.push({ name: `round-${t}s`, width: WIDTH, height: HEIGHT, mime: 'image/png', base64: await composite(png, match, viewports) })
    }
    return { captures, adapter, renderer: 'raa' }
  } finally {
    match?.dispose()
    port.dispose()
    canvas.remove()
  }
}

function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

async function frameTiming(raw: unknown): Promise<FrameTimingOutput> {
  const input = validateFrameTiming(raw)
  const { R, adapter } = await prelude()
  // Only race-bean-dash in the race pool, so round 1 is the 40-obstacle standard course; survival keeps the setup valid.
  const courses = (await browserCourses('standard')).filter(c => c.id === TIMING_COURSE || c.kind === 'survival')
  const course = courses.find(c => c.id === TIMING_COURSE)
  if (!course) refuse('ops', `frameTiming.course`, `'${TIMING_COURSE}' is not a standard race course; restore fixtures/courses/${TIMING_COURSE}.course.json`)
  if (course.obstacles.length !== TIMING_OBSTACLES) {
    refuse('ops', `fixtures/courses/${TIMING_COURSE}.course.json#/obstacles`, `has ${course.obstacles.length} obstacles; QB2 measures ${TIMING_OBSTACLES}`)
  }
  const assets = await preloadAssets(courses, browserAssetResolver())
  const canvas = makeCanvas(WIDTH, HEIGHT)
  const port = new StatsPort(await createRaaPort())
  let match: InPageMatch | null = null
  try {
    await port.init({ canvas, width: WIDTH, height: HEIGHT, viewports: [{ x: 0, y: 0, width: WIDTH, height: HEIGHT }] })
    // 1 human client with a pilot; the match fills the other 7 characters with bots.
    match = new InPageMatch({
      R, clients: 1, seed: SEED, profile: 'standard', courses, ports: [port], assets, bean: assets('bean'),
      net: { rttMs: 0, jitterMs: 0, loss: 0 }, pilots: [true],
    })
    // Warm up until the course is on screen and at least 60 frames have rendered.
    let warm = 0
    while (warm < WARMUP_FRAMES || match.matches[0].sim.course()?.id !== TIMING_COURSE) {
      if (warm > 20 * WARMUP_FRAMES) refuse('ops', 'frameTiming', `'${TIMING_COURSE}' was not loaded after ${warm} frames; check the match course pick`)
      await nextFrame()
      match.frame(DT)
      warm++
    }
    const samples: number[] = []
    for (let i = 0; i < input.frames; i++) {
      await nextFrame()
      match.frame(DT)
      const ms = port.last?.frameMs
      if (ms === undefined || !Number.isFinite(ms)) refuse('render', 'raa', `render() returned no finite frameMs at frame ${i}`)
      samples.push(ms)
    }
    samples.sort((a, b) => a - b)
    return { p50Ms: nearestRank(samples, 0.5), p95Ms: nearestRank(samples, 0.95), frames: samples.length, adapter }
  } finally {
    match?.dispose()
    port.dispose()
    canvas.remove()
  }
}

export function installNmcOps(): void {
  window.nmcGpu = { ops: { roundCapture, frameTiming } }
}
