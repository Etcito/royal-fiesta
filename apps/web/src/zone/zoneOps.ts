// GPU client op of the zone view on game.html: one RAA capture of a zoned match with spread spawns.
// Near seats are the local peer's domains drawn by SceneView; far seats are its FarFeed drawn by
// FarRenderer. The view exposes only frame/render/capture/dispose, so the two counts are observed for
// the duration of this op and restored afterwards.
import { FarFeed } from '@royal-fiesta/game/net/farFeed'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { CorrectionSmoother } from '@gamesaloon/rollback'
import { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'
import { zoneContent } from './zoneContent.ts'
import type { AdapterInfo } from '../nmc/ops.ts'
import { pendingPipelines } from '../render/asyncPipelines.ts'
import { raaStatus } from '../render/raaStatus.ts'
import { mountZoneView } from './zoneView.ts'
import type { ZoneView } from './zoneView.ts'

const WIDTH = 1280
const HEIGHT = 720
const DT = 1 / 60
const MAX_SECONDS = 120
const PIPELINE_WAIT_MS = 10000

export interface ZoneCaptureInput {
  width: typeof WIDTH
  height: typeof HEIGHT
  peers: number
  seatsPerPeer: number
  course: string
  seconds: number
}

interface CaptureOut { name: 'zone-view'; width: number; height: number; mime: 'image/png'; base64: string }
interface ZoneCaptureOutput { renderer: 'raa'; adapter: AdapterInfo; near: number; far: number; captures: CaptureOut[] }
// GPU client protocol: an op answers {json, files}; a plain object is not a result.
interface OpEnvelope<T> { json: T; files: [] }

// ---- input validation -------------------------------------------------------------------------------------

function obj(op: string, path: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) refuse('ops', `${op}.${path}`, 'is not an object; pass the JSON input declared in nmc.gpu.json')
  return v as Record<string, unknown>
}

function onlyKeys(op: string, path: string, o: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(o).filter(k => !keys.includes(k))
  if (extra.length > 0) refuse('ops', `${op}.${path}`, `has unknown fields ${extra.join(', ')}; pass only ${keys.join(', ')}`)
}

function int(op: string, path: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass an integer in ${min}..${max}`)
  return v
}

function num(op: string, path: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass a number in ${min}..${max}`)
  return v
}

function str(op: string, path: string, v: unknown, pattern: RegExp): string {
  if (typeof v !== 'string' || !pattern.test(v)) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass a string matching ${pattern}`)
  return v
}

function validate(raw: unknown): ZoneCaptureInput {
  const op = 'zoneCapture'
  const o = obj(op, 'input', raw)
  onlyKeys(op, 'input', o, ['width', 'height', 'peers', 'seatsPerPeer', 'course', 'seconds'])
  if (o.width !== WIDTH || o.height !== HEIGHT) {
    refuse('ops', `${op}.input`, `is ${JSON.stringify(o.width)}x${JSON.stringify(o.height)}; zone captures are ${WIDTH}x${HEIGHT}`)
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    peers: int(op, 'input.peers', o.peers, 2, 8),
    seatsPerPeer: int(op, 'input.seatsPerPeer', o.seatsPerPeer, 1, 2),
    course: str(op, 'input.course', o.course, /^[a-z0-9-]{1,40}$/),
    seconds: num(op, 'input.seconds', o.seconds, 0, MAX_SECONDS),
  }
}

// ---- browser helpers --------------------------------------------------------------------------------------

// Minimal WebGPU shapes: the repo lib list has no @webgpu/types.
interface GpuAdapterInfoLike { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean }
interface GpuAdapterLike { info?: GpuAdapterInfoLike; isFallbackAdapter?: boolean }
interface GpuLike { requestAdapter(opts?: { powerPreference?: string }): Promise<GpuAdapterLike | null> }

// Same detection as the other ops (theirs are private).
async function adapterInfo(): Promise<AdapterInfo> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) refuse('gpu', 'navigator.gpu', 'WebGPU is not exposed by this browser; run the op in the GPU client browser')
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (adapter === null) refuse('gpu', 'navigator.gpu.requestAdapter', 'no WebGPU adapter; run the op in the GPU client browser')
  const info = adapter.info ?? {}
  const vendor = info.vendor ?? ''
  const architecture = info.architecture ?? ''
  const description = info.description ?? ''
  const fallback = info.isFallbackAdapter === true || adapter.isFallbackAdapter === true
  const software = fallback || /swiftshader/i.test(`${vendor} ${architecture} ${description}`)
  return { vendor, architecture, description, software }
}

async function prelude(): Promise<AdapterInfo> {
  const status = await raaStatus()
  if (!status.available) refuse('render', 'raa', status.reason)
  // mountZoneView builds its port with createRaaPort, which refuses instead of falling back to the null port.
  return adapterInfo()
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.style.cssText = `width: ${width}px; height: ${height}px; display: block;`
  document.body.appendChild(canvas)
  return canvas
}

function base64Of(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function yieldTask(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

// ---- draw counts ------------------------------------------------------------------------------------------

interface DrawCounts { near: number; far: number }

// The view keeps its SceneView and FarFeed private, so this op observes them: SceneView.update runs on
// the local domain adapter (every non-parked seat is a near character) and FarFeed.read is the exact
// list FarRenderer draws. Both are restored in the op's finally.
function observeDraws(seatCount: number): { counts: DrawCounts; restore: () => void } {
  const counts: DrawCounts = { near: 0, far: 0 }
  const sceneUpdate = SceneView.prototype.update
  const feedRead = FarFeed.prototype.read
  const state: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: true, teleportTick: -1,
  }
  SceneView.prototype.update = function (this: SceneView, sim: MatchSim, smoother: CorrectionSmoother | null, alpha: number, frameDtS: number): void {
    sceneUpdate.call(this, sim, smoother, alpha, frameDtS)
    // The zone adapter is MatchSim-shaped but not a MatchSim; skip the page's own views.
    if ((sim as unknown) instanceof MatchSim) return
    let near = 0
    for (let seat = 0; seat < seatCount; seat++) if (!sim.character(seat, state).parked) near++
    counts.near = near
  }
  FarFeed.prototype.read = function (this: FarFeed, displayTick: number, holdsLocalSeat: (seat: number) => boolean) {
    const shown = feedRead.call(this, displayTick, holdsLocalSeat)
    counts.far = shown.length
    return shown
  }
  return {
    counts,
    restore() {
      SceneView.prototype.update = sceneUpdate
      FarFeed.prototype.read = feedRead
    },
  }
}

// ---- zoneCapture ------------------------------------------------------------------------------------------

async function zoneCapture(raw: unknown): Promise<OpEnvelope<ZoneCaptureOutput>> {
  const input = validate(raw)
  const adapter = await prelude()
  const content = await zoneContent('sprint')
  const canvas = makeCanvas(input.width, input.height)
  const realNow = performance.now.bind(performance)
  const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
  let zone: ZoneView | null = null
  let observed: { counts: DrawCounts; restore: () => void } | null = null
  let clockInstalled = false
  try {
    zone = await mountZoneView({
      canvas,
      peers: input.peers,
      seatsPerPeer: input.seatsPerPeer,
      courseId: input.course,
      spreadSpawns: true,
      width: input.width,
      height: input.height,
      ...content,
    })
    const view = zone
    const observer = observeDraws(input.peers * input.seatsPerPeer)
    observed = observer
    // A virtual 1/60 s clock: one page frame per step, never requestAnimationFrame (it fires rarely in
    // the GPU client browser). The real clock still times the pipeline wait. At least one frame so the
    // scene has drawn before the capture.
    const frames = Math.max(1, Math.round(input.seconds / DT))
    let frame = 0
    Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => frame * DT * 1000 })
    clockInstalled = true
    for (frame = 1; frame <= frames; frame++) {
      view.frame(DT)
      // The first frame creates the near characters and starts their animation load: without it the
      // capture shows them in the rig's rest pose.
      if (frame === 1) await view.ready()
      if (frame % 60 === 0) await yieldTask()
    }
    view.render()
    const deadline = realNow() + PIPELINE_WAIT_MS
    while (pendingPipelines() > 0) {
      if (realNow() >= deadline) refuse('render', 'raa', `pipeline readiness timed out at zone-view; ${pendingPipelines()} pipelines still pending`)
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    view.render()
    const png = await view.capture()
    if (png === null || png.length === 0) refuse('render', 'raa', 'the zone view capture returned no PNG bytes; the RAA port must read the canvas back')
    return {
      json: {
        renderer: 'raa',
        adapter,
        near: observer.counts.near,
        far: observer.counts.far,
        captures: [{ name: 'zone-view', width: input.width, height: input.height, mime: 'image/png', base64: base64Of(png) }],
      },
      files: [],
    }
  } finally {
    observed?.restore()
    if (clockInstalled) {
      if (originalNow) Object.defineProperty(performance, 'now', originalNow)
      else Reflect.deleteProperty(performance, 'now')
    }
    zone?.dispose()
    canvas.remove()
  }
}

type ZoneOps = { zoneCapture(input: unknown): Promise<OpEnvelope<ZoneCaptureOutput>> }

// window.nmcGpu.ops.zoneCapture, next to the game page's ops. Registering has no side effect.
export function installZoneOps(): void {
  const gpu = window.nmcGpu
  if (gpu === undefined) refuse('ops', 'installZoneOps', 'window.nmcGpu is missing; install the base GPU ops first')
  const ops = gpu.ops as unknown as ZoneOps
  ops.zoneCapture = zoneCapture
}
