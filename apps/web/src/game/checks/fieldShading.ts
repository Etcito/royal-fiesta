// fieldShading (game.html?test=1): the whole SDF candy world loaded through the real content provider and
// rendered by the real RAA port. Every capture waits on the port's field shading report, never on a fixed
// sleep: the GPU client runs the page in an off-screen frame where requestAnimationFrame is unreliable.
// Every capture runs in the one job and the report lists every failure (ok: false, `failures`). For cards that change
// this file, sdf/fieldShading.ts, sdf/fieldAtlas.ts or sdf/sdfPort.ts: a camera is fitted to the bounds of what the
// capture shows (guardFraming measures the captured pose, never a swept arc), fieldShading.test.ts pins each framing
// with guardFraming, and the card is done only after the whole field-build -> field-render chain ran green.
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MechItem } from '@royal-fiesta/sim/mechanismSpec'
import type { Pose } from '@royal-fiesta/sim/vec'
import { add3, quatConj, quatMul, quatRotate, sub3 } from '@royal-fiesta/sim/vec'
import { animationKind, trackPose } from '@royal-fiesta/sim/mechanisms/animation'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { CourseDressing, GameContent } from '@royal-fiesta/game/content'
import { AnimDriver } from '@royal-fiesta/game/anim/driver'
import type { CameraPose } from '@royal-fiesta/game/render/port'
import { WornMounts } from '@royal-fiesta/game/render/wornLook'
import type { WornLook } from '@royal-fiesta/game/render/wornLook'
import { pendingPipelines } from '../../render/asyncPipelines.ts'
import { pickContent } from '../../content/source.ts'
import { assertCompleteFieldCapture, hardShadingFailures } from '../../content/shadingStatus.ts'
import { SdfContent, skinnedCharacterOf } from '../../content/providers/sdf.ts'
import { gameRenderOptions, type PartWorldBounds, type ResizablePort, type ShadingReport } from '../../sdf/sdfPort.ts'
import { nextTask, yieldTask } from './boot.ts'
import { startMounted } from './lobbyUnload.ts'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { FIELD_ATLAS_BYTES } from '../../sdf/fieldAtlas.ts'
import type { TourDeps, TourGame } from '../uiTour.ts'

export const name = 'fieldShading'

const WIDTH = 1920
const HEIGHT = 1080
const WAIT_MS = 180_000
const MECH_COURSE = 'race-hammer-hill'

interface OpFile { name: string; blob: Blob }
interface Captures { files: OpFile[]; names: string[]; observations: unknown[]; failures: string[] }

// Every capture runs even when an earlier one fails: one GPU job names every remaining failure (framing guard,
// pending parts, hard shading failures) instead of one failure per GPU run. The op still fails (ok: false).
async function attempt(captures: Captures, what: string, step: () => Promise<void>): Promise<void> {
  try { await step() } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    captures.failures.push(message.includes(what) ? message : `${what}: ${message}`)
  }
}

function boundCorners(bounds: readonly PartWorldBounds[]): number[][] {
  return bounds.flatMap(b => b.surface ?? Array.from({ length: 8 }, (_, i) => [0, 1, 2].map(a => i & (1 << a) ? b.max[a] : b.min[a])))
}

function projectBounds(camera: CameraPose, bounds: readonly PartWorldBounds[]) {
  const f = camera.target.map((v, a) => v - camera.eye[a])
  const length = Math.hypot(...f)
  for (let a = 0; a < 3; a++) f[a] /= length
  const right = [-f[2], 0, f[0]]
  const rl = Math.hypot(...right)
  for (let a = 0; a < 3; a++) right[a] /= rl
  const up = [right[1]*f[2]-right[2]*f[1], right[2]*f[0]-right[0]*f[2], right[0]*f[1]-right[1]*f[0]]
  const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0)
  const tan = Math.tan(camera.fovYDeg * Math.PI / 360)
  return boundCorners(bounds).map(p => {
    const q = p.map((v, a) => v - camera.eye[a]), z = dot(q, f)
    return [dot(q, right) / (z * tan * WIDTH / HEIGHT), dot(q, up) / (z * tan), z]
  })
}

export function guardFraming(name: string, camera: CameraPose, bounds: readonly PartWorldBounds[]): number {
  const points = projectBounds(camera, bounds)
  if (points.length === 0) throw new Error(`fieldShading.bounds.empty: ${name}`)
  if (points.some(p => !p.every(Number.isFinite) || Math.abs(p[0]) > 0.96 || Math.abs(p[1]) > 0.96 || p[2] <= camera.near || p[2] >= camera.far)) {
    throw new Error(`fieldShading.bounds.outside: ${name}; frame every meshed part with a margin`)
  }
  const area = (Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]))) *
    (Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]))) / 4
  const minimum = name.startsWith('rounded-scenery') ? 0.4 : 0.15
  if (area < minimum) throw new Error(`fieldShading.bounds.small: ${name}; projected area ${area}; minimum ${minimum}`)
  return area
}

export function fitBounds(camera: CameraPose, bounds: readonly PartWorldBounds[]): CameraPose {
  const points = boundCorners(bounds)
  if (points.length === 0) throw new Error('fieldShading.bounds.empty: cannot fit camera')
  const target = [0, 1, 2].map(a => (Math.min(...points.map(p => p[a])) + Math.max(...points.map(p => p[a]))) / 2) as [number, number, number]
  const direction = camera.eye.map((v, a) => v - camera.target[a])
  const length = Math.hypot(...direction)
  const at = (distance: number): CameraPose => ({ ...camera, target, eye: direction.map((v, a) => target[a] + v / length * distance) as [number, number, number] })
  let low = camera.near, high = camera.far * 0.5
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2
    const fits = projectBounds(at(mid), bounds).every(p => p[2] > camera.near && Math.abs(p[0]) <= 0.9 && Math.abs(p[1]) <= 0.9)
    if (fits) high = mid
    else low = mid
  }
  return at(high)
}

// Fit the drawn vertices, not the empty near/top corners of a rounded part's box.
export function sceneryCamera(bounds: readonly PartWorldBounds[]): CameraPose {
  return fitBounds({ eye: [0, 1, 6], target: [0, 1, 0], fovYDeg: 45, near: 0.05, far: 200 }, bounds)
}

// Summed projected screen area of every part's box: how large the parts are drawn, not only their union.
function partsArea(camera: CameraPose, bounds: readonly PartWorldBounds[]): number {
  let sum = 0
  for (const b of bounds) {
    const p = projectBounds(camera, [b])
    sum += (Math.max(...p.map(q => q[0])) - Math.min(...p.map(q => q[0]))) * (Math.max(...p.map(q => q[1])) - Math.min(...p.map(q => q[1]))) / 4
  }
  return sum
}

// A whole level is a long thin strip: from one fixed diagonal it fills the frame as a thin line and every part is a
// few pixels (judge: 'so distant ... cannot be confirmed at this scale'). Every candidate direction still fits the
// whole level (fitBounds); the one that draws the parts largest wins.
export function fitWorld(camera: CameraPose, bounds: readonly PartWorldBounds[]): CameraPose {
  let best: CameraPose | null = null, bestArea = -1
  for (let azimuth = 0; azimuth < 360; azimuth += 15) {
    for (const elevation of [35, 45, 55]) {
      const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180
      const eye = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)].map((v, i) => camera.target[i] + v * 50) as [number, number, number]
      const fitted = fitBounds({ ...camera, eye }, bounds)
      const area = partsArea(fitted, bounds)
      if (area > bestArea) { best = fitted; bestArea = area }
    }
  }
  return best!
}

function pageErrors(): string[] {
  const check = (window as { __nmcCheck?: { pageErrors?: unknown } }).__nmcCheck
  return Array.isArray(check?.pageErrors) ? check.pageErrors.filter((e): e is string => typeof e === 'string') : []
}

function assertNoPageErrors(what: string): void {
  const errors = pageErrors()
  if (errors.length > 0) throw new Error(`${what}: page error: ${errors[0]}`)
}

// The report's `failed` counts every named vertex reason, including the fallbacks this check must accept: the
// atlas demotions (QB12) and the field refusals MAMA saved with a part. hardShadingFailures keeps every other reason.
const hardFailures = hardShadingFailures

// A frame is what asks RAA for a new part's pipelines: a freshly created (skinned) instance requests its variants on
// its first visible draw, not at upload. Checking the compile count before that frame saw zero and returned, so the
// next frames (the capture) omitted the draw while its pipeline compiled. Render, yield to the compiler, and report
// ready only when the port has no pending field part and no pipeline is compiling after a drawn frame. The bounded
// wait names the parts still pending instead of guessing a duration.
async function waitShading(port: ResizablePort, what: string): Promise<ShadingReport> {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    port.render()
    await nextTask()
    const report = port.shadingReport()
    if (report.pending === 0 && pendingPipelines() === 0) return report
    if (Date.now() > deadline) {
      // The parts it waited on and the pipelines still compiling come first; the named fallbacks (atlas budget, vertex
      // reasons) are reported states, never the reason of the wait, and follow only as a count.
      throw new Error(`${what}: field shading still pending after ${WAIT_MS / 1000} s: ${report.pending} parts ` +
        `(${report.pendingParts.join(', ')}); ${pendingPipelines()} material pipelines compiling; ${report.errors.length} named fallbacks`)
    }
  }
}

// What a capture must show and how to remove it for the background frame. center/radius are a world-space bounding
// sphere around the subject, projected with the same camera to prove the view is pointed at it.
interface Subject {
  camera: CameraPose
  center: readonly [number, number, number]
  radius: number
  // Hides the subject from the next drawn frame and returns the restore for the next capture.
  hide(): () => void
  expectedParts?: readonly string[]
}

interface ProjectedBox { x0: number; y0: number; x1: number; y1: number; area: number; centerDepth: number }

// The subject's bounding sphere projected through the camera: the viewport-clipped rectangle of its 8 box corners.
// A corner behind the near plane uses the near depth (a box that reaches the camera covers the whole view).
function projectSubject(subject: Subject, width: number, height: number): ProjectedBox | null {
  const { eye, target, fovYDeg, near } = subject.camera
  const forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]
  const length = Math.hypot(forward[0], forward[1], forward[2])
  if (!(length > 1e-9)) return null
  const f = forward.map(v => v / length)
  const rightRaw = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]
  const rightLength = Math.hypot(rightRaw[0], rightRaw[1], rightRaw[2])
  if (!(rightLength > 1e-9)) return null
  const right = rightRaw.map(v => v / rightLength)
  const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]]
  const tanHalf = Math.tan(fovYDeg * Math.PI / 360)
  const aspect = width / height
  const centerDepth = (subject.center[0] - eye[0]) * f[0] + (subject.center[1] - eye[1]) * f[1] + (subject.center[2] - eye[2]) * f[2]
  if (!(centerDepth > near)) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
    const px = subject.center[0] + dx * subject.radius
    const py = subject.center[1] + dy * subject.radius
    const pz = subject.center[2] + dz * subject.radius
    const rel = [px - eye[0], py - eye[1], pz - eye[2]]
    const depth = Math.max(near, rel[0] * f[0] + rel[1] * f[1] + rel[2] * f[2])
    const sx = (rel[0] * right[0] + rel[1] * right[1] + rel[2] * right[2]) / (depth * tanHalf * aspect)
    const sy = (rel[0] * up[0] + rel[1] * up[1] + rel[2] * up[2]) / (depth * tanHalf)
    const vx = (sx + 1) * 0.5 * width
    const vy = (1 - sy) * 0.5 * height
    x0 = Math.min(x0, vx); x1 = Math.max(x1, vx)
    y0 = Math.min(y0, vy); y1 = Math.max(y1, vy)
  }
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(width, x1), cy1 = Math.min(height, y1)
  if (!(cx1 - cx0 >= 2 && cy1 - cy0 >= 2)) return null
  return { x0: cx0, y0: cy0, x1: cx1, y1: cy1, area: (cx1 - cx0) * (cy1 - cy0), centerDepth }
}

// A drawn subject changes a solid patch of the frame; a background-only capture (the penguin card's empty tan gradient)
// only drifts, so the guard needs a nearly fully changed cell inside the projected box, not just a diffuse share.
const MIN_SUBJECT_SHARE = 0.005
const MIN_BOX_SHARE = 0.02
const MIN_CELL_SHARE = 0.5
const MIN_VIEWPORT_SHARE = 0.02
const COVERAGE_CELLS = 10
const CHANNEL_DELTA = 16
// A skinned instance requests its pipeline on its first visible draw and RAA compiles it asynchronously; re-render and
// re-measure instead of committing the background-only frame that was in flight.
const SUBJECT_WAIT_MS = 45_000
const SUBJECT_RETRY_MS = 100

async function pixelsOf(bytes: Uint8Array): Promise<ImageData> {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) throw new Error('fieldShading: no 2D canvas to read a capture')
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, canvas.width, canvas.height)
  } finally { bitmap.close() }
}

interface Coverage { drawn: boolean; detail: string }

// The subject is in the viewport and its removal changes the pixels inside its projected box. Measured on two frames
// taken back to back, so a drifting sky cannot pass as a subject: a solid cell of the box must change.
async function subjectCoverage(subject: Subject, drawn: Uint8Array, background: Uint8Array): Promise<Coverage> {
  const a = await pixelsOf(drawn)
  const b = await pixelsOf(background)
  const width = a.width, height = a.height
  const projected = projectSubject(subject, width, height)
  let changed = 0, inBox = 0, solidCell = 0
  if (b.width === width && b.height === height) {
    const pa = a.data, pb = b.data
    const cells = new Uint32Array(COVERAGE_CELLS * COVERAGE_CELLS)
    const cellW = projected === null ? 1 : Math.max(1, (projected.x1 - projected.x0) / COVERAGE_CELLS)
    const cellH = projected === null ? 1 : Math.max(1, (projected.y1 - projected.y0) / COVERAGE_CELLS)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        if (Math.abs(pa[i] - pb[i]) <= CHANNEL_DELTA && Math.abs(pa[i + 1] - pb[i + 1]) <= CHANNEL_DELTA &&
          Math.abs(pa[i + 2] - pb[i + 2]) <= CHANNEL_DELTA) continue
        changed++
        if (projected !== null && x >= projected.x0 && x < projected.x1 && y >= projected.y0 && y < projected.y1) {
          inBox++
          const cx = Math.min(COVERAGE_CELLS - 1, Math.floor((x - projected.x0) / cellW))
          const cy = Math.min(COVERAGE_CELLS - 1, Math.floor((y - projected.y0) / cellH))
          cells[cy * COVERAGE_CELLS + cx]++
        }
      }
    }
    const cellArea = cellW * cellH
    for (const count of cells) solidCell = Math.max(solidCell, count / cellArea)
  }
  const share = changed / Math.max(1, width * height)
  const boxShare = projected === null ? 0 : inBox / Math.max(1, projected.area)
  const viewportShare = projected === null ? 0 : projected.area / Math.max(1, width * height)
  const ok = projected !== null && viewportShare >= MIN_VIEWPORT_SHARE && share >= MIN_SUBJECT_SHARE &&
    boxShare >= MIN_BOX_SHARE && solidCell >= MIN_CELL_SHARE
  return {
    drawn: ok,
    detail: `subject ${projected === null ? 'off screen' : `covers ${(viewportShare * 100).toFixed(1)}% of the viewport`}; ` +
      `${(share * 100).toFixed(2)}% of the pixels differ from the background, ${(boxShare * 100).toFixed(2)}% inside it, ` +
      `solid cell ${(solidCell * 100).toFixed(1)}%`,
  }
}

function drawFrames(port: ResizablePort): Promise<void> {
  port.render()
  return nextTask().then(() => { port.render() })
}

async function capture(port: ResizablePort, what: string, captures: Captures, subject: Subject): Promise<void> {
  const bounds = port.worldBounds(what.startsWith('rounded-scenery'))
  const area = guardFraming(what, subject.camera, bounds)
  const report = port.shadingReport()
  const drawn = port.drawnParts()
  if (what.startsWith('rounded-scenery')) {
    for (const part of drawn) console.info(`[fieldShading] ${what}: ${JSON.stringify(part)}`)
  }
  if (what.startsWith('rounded-scenery') && what !== 'rounded-scenery-vertex') {
    if (drawn.length === 0) throw new Error('rounded-scenery: no drawn field parts')
    const fallback = drawn.filter(p => p.mode !== 'field' || p.reason || p.resampled)
    if (fallback.length) throw new Error(`rounded-scenery: field shading required: ${fallback.map(p => `${p.key}: ${p.reason ?? (p.resampled ? 'uniform grid resampling' : p.mode)}`).join('; ')}`)
  }
  if (subject.expectedParts !== undefined) {
    console.info(`[fieldShading] ${what}: expected ${subject.expectedParts.length}, drawn ${drawn.length}, ` +
      `field ${drawn.filter(p => p.mode === 'field').length}, fallback ${drawn.filter(p => p.mode !== 'field').length}; ` +
      `atlas demoted ${report.demoted}, saved refusals ${report.refused.length}; ` +
      drawn.filter(p => p.mode !== 'field').map(p => `${p.key}: ${p.reason ?? 'UNNAMED'}`).join('; '))
    assertCompleteFieldCapture(subject.expectedParts, drawn)
  }
  captures.observations.push({ name: what, camera: subject.camera, bounds: bounds.map(({ surface, ...box }) => box), area, drawn, normals: report })
  if (report.pending > 0) throw new Error(`${what}: ${report.pending} parts still pending at capture time`)
  if (report.atlasFull > 0) throw new Error(`${what}: ${report.atlasFull} texture.atlas_full errors`)
  const failures = hardFailures(report)
  if (failures.length > 0) throw new Error(`${what}: ${failures.join('; ')}`)
  assertNoPageErrors(what)
  const deadline = Date.now() + SUBJECT_WAIT_MS
  let last = 'not measured'
  for (;;) {
    await drawFrames(port)
    // The skinned body's lit variants are not part of shadingReport's pending parts (it is an atlas demotion): keep
    // drawing until the compiler settles before paying for a capture.
    if (pendingPipelines() > 0) {
      if (Date.now() > deadline) throw new Error(`${what}: ${pendingPipelines()} material pipelines still compiling after ${SUBJECT_WAIT_MS / 1000} s`)
      await new Promise(resolve => setTimeout(resolve, SUBJECT_RETRY_MS))
      continue
    }
    const png = await port.capture()
    if (png === null || png.length === 0) throw new Error(`${what}: the capture is empty`)
    // The same camera with the subject hidden: the pixels that change are the subject's own draw.
    const restore = subject.hide()
    let background: Uint8Array | null = null
    try {
      await drawFrames(port)
      background = await port.capture()
    } finally { restore() }
    if (background === null || background.length === 0) throw new Error(`${what}: the background capture is empty`)
    const coverage = await subjectCoverage(subject, png, background)
    if (coverage.drawn) {
      captures.files.push({ name: `${what}.png`, blob: new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })
      captures.names.push(`${what}.png`)
      return
    }
    last = coverage.detail
    if (Date.now() > deadline) throw new Error(`${what}: subject not in frame after ${SUBJECT_WAIT_MS / 1000} s: ${last}`)
    await new Promise(resolve => setTimeout(resolve, SUBJECT_RETRY_MS))
  }
}

interface StageOptions {
  // Decor stays only in the wide overview where the camera frames the whole plaza.
  decor: boolean
  obstacles?: readonly number[]
  mechanisms?: readonly number[]
}

// Draws only the chosen course instances: an off-screen instance never requests its field pipeline, and the
// port's pending count includes every live instance, so a close-up must not keep the rest of the world alive.
class Stage {
  private readonly port: ResizablePort
  private readonly course: ResolvedCourse
  private readonly dressing: CourseDressing
  private readonly assets: (name: string) => PrimsAsset
  private readonly handles = new Map<string, number>()
  private readonly obstacleSpecs: ObstacleSpec[] = []
  private readonly obstacleInst: number[] = []
  private readonly mechanismSpecs: { item: MechItem; at: number }[] = []
  private readonly mechanismInst: number[] = []
  private readonly withDecor: boolean
  private disposed = false
  private readonly rest: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }
  private readonly q: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }

  constructor(port: ResizablePort, content: GameContent, course: ResolvedCourse, options: StageOptions) {
    this.port = port
    this.course = course
    this.assets = name => content.assets(name)
    this.dressing = content.dressing()
    this.withDecor = options.decor
    // enter sets the course environment; a close-up enters without decor: its port meshed only its own subjects, so
    // registering the course decor would refuse ('not meshed') and decor instances would stay pending.
    this.dressing.enter(port, course.id, { decor: options.decor })
    if (!options.decor) this.dressing.leave(port)
    for (const index of options.obstacles ?? course.obstacles.map((_, i) => i)) {
      const spec = course.obstacles[index]
      if (spec === undefined) continue
      this.obstacleSpecs.push(spec)
      this.obstacleInst.push(port.createInstance(this.handle(spec.asset), null))
    }
    const items = course.mechanisms?.items ?? []
    for (const index of options.mechanisms ?? items.map((_, i) => i)) {
      const item = items[index]
      if (item === undefined) continue
      this.mechanismSpecs.push({ item, at: index })
      this.mechanismInst.push(port.createInstance(this.handle(item.asset), null))
    }
    this.update(0)
  }

  private handle(name: string): number {
    let handle = this.handles.get(name)
    if (handle === undefined) {
      handle = this.port.registerAsset(name, this.assets(name))
      this.handles.set(name, handle)
    }
    return handle
  }

  update(tick: number): void {
    for (let i = 0; i < this.obstacleSpecs.length; i++) {
      const spec = this.obstacleSpecs[i]
      motionPose(spec, tick, 0, this.q)
      const { t, r } = this.q
      this.port.setTransform(this.obstacleInst[i], [t.x, t.y, t.z], [r.x, r.y, r.z, r.w], [spec.s.x, spec.s.y, spec.s.z])
    }
    const mechanisms = this.course.mechanisms
    if (mechanisms === null || mechanisms === undefined) return
    for (let k = 0; k < this.mechanismSpecs.length; k++) {
      const { item, at } = this.mechanismSpecs[k]
      const place = item.place ?? item
      let t = place.t
      let r = place.r
      for (let a = 0; a < mechanisms.animations.length; a++) {
        const animation = mechanisms.animations[a]
        if (animation.target.item !== at || animationKind(mechanisms, a) !== 'tick') continue
        const body = item.bodies[animation.target.body]
        quatRotate(item.r, body.rest.t, this.rest.t)
        add3(item.t, this.rest.t, this.rest.t)
        quatMul(item.r, body.rest.r, this.rest.r)
        trackPose(animation, tick, this.q)
        add3(this.rest.t, this.q.t, this.q.t)
        quatMul(this.q.r, this.rest.r, this.q.r)
        sub3(place.t, this.rest.t, this.rest.t)
        quatConj(this.rest.r, this.rest.r)
        quatMul(this.q.r, this.rest.r, this.q.r)
        quatRotate(this.q.r, this.rest.t, this.rest.t)
        add3(this.q.t, this.rest.t, this.q.t)
        quatMul(this.q.r, place.r, this.q.r)
        t = this.q.t
        r = this.q.r
        break
      }
      this.port.setTransform(this.mechanismInst[k], [t.x, t.y, t.z], [r.x, r.y, r.z, r.w], [item.s.x, item.s.y, item.s.z])
    }
  }

  // The guard's background frame: every instance this stage drew leaves the view; the caller restores them.
  hide(): () => void {
    if (this.withDecor) this.dressing.leave(this.port)
    const instances = [...this.obstacleInst, ...this.mechanismInst]
    for (const instance of instances) this.port.setVisible(instance, false)
    // leave destroys the decor instances, so the restore recreates them: a capture may be measured more than once.
    return () => {
      for (const instance of instances) this.port.setVisible(instance, true)
      if (this.withDecor) this.dressing.enter(this.port, this.course.id)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.withDecor) this.dressing.leave(this.port)
    for (const instance of [...this.obstacleInst, ...this.mechanismInst]) this.port.destroyInstance(instance)
  }
}

function obstacleOf(course: ResolvedCourse, asset: string): number {
  const index = course.obstacles.findIndex(spec => spec.asset === asset)
  if (index < 0) throw new Error(`course '${course.id}' has no '${asset}' obstacle`)
  return index
}

function mechanismOf(course: ResolvedCourse, asset: string): number {
  const items = course.mechanisms?.items ?? []
  const index = items.findIndex(item => item.asset === asset)
  if (index < 0) throw new Error(`course '${course.id}' has no '${asset}' mechanism`)
  return index
}

function walkObservation() {
  return { id: 0, mode: 0, vel: { x: 0, y: 0, z: 3 }, grounded: true, surface: 'normal' as const, emote: 0,
    xf: { pos: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } },
    ik: { mode: 0, look: { x: 0, y: 0, z: 10 }, ground: { point: { x: 0, y: -0.7, z: 0 }, normal: { x: 0, y: 1, z: 0 } } } }
}

async function shootPenguin(port: ResizablePort, content: GameContent, captures: Captures): Promise<void> {
  const worn: WornLook = {
    colour: 7,
    items: [
      { asset: content.assets('costume.propeller-hat'), mount: [0, 0, 0], tint: null },
      { asset: content.assets('costume.fish-scarf'), mount: [0, 0, 0], tint: null },
    ],
  }
  const skin = skinnedCharacterOf(content)
  const mounts = new WornMounts(port)
  // An empty stage keeps the hub environment (sky, light) for the portrait without any decor instance.
  const backdrop = new Stage(port, content, content.hub(), { decor: false, obstacles: [], mechanisms: [] })
  let driver: AnimDriver | null = null
  let bean = -1
  try {
    if (skin === undefined) {
      bean = port.createInstance(port.registerAsset('penguin.body', content.character()), null)
      port.setTransform(bean, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
      mounts.sync(worn)
      mounts.draw([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
    } else {
      // A near-black plumage reads as the penguin's black back; the belly, beak and feet keep their own colours.
      bean = port.createInstance(port.registerSkinned(skin.assetId, skin.skin), [0.08, 0.09, 0.12])
      port.setTransform(bean, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
      const { bindings: _b, smooth: _s, ...rig } = skin.skin.rig as unknown as Record<string, unknown>
      driver = await AnimDriver.load(skin.graph, JSON.stringify(rig), (skin.skin.clips ?? []).map(clip => JSON.stringify(clip)))
      // A walking, not resting, pose: step the graph's own walk clip through a full second of ticks.
      for (let tick = 0; tick <= 60; tick++) driver.observeTick(tick, [walkObservation()])
      const pose = driver.pose(0)?.skin
      if (pose === undefined) throw new Error('penguin: the walk clip produced no pose')
      port.setPose(bean, pose)
      mounts.sync(worn)
      mounts.draw([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
      mounts.setPose(pose, { dtS: 1 / 60 })
    }
    // A close portrait of the whole penguin, cosmetics included: the walking pose and the hat stay inside the frame.
    const initial: CameraPose = { eye: [0, 0.9, 3.4], target: [0, 0.25, 0], fovYDeg: 52, near: 0.05, far: 100 }
    const cam = fitBounds(initial, port.worldBounds())
    const subject: Subject = {
      camera: cam, center: [0, 0.2, 0], radius: 1.9,
      hide: () => {
        port.setVisible(bean, false)
        mounts.setVisible(false)
        return () => { port.setVisible(bean, true); mounts.setVisible(true) }
      },
    }
    port.setCamera(0, cam)
    await attempt(captures, 'penguin', async () => {
      await waitShading(port, 'penguin')
      await capture(port, 'penguin', captures, subject)
    })
    port.setShading('vertex')
    await attempt(captures, 'penguin-vertex', async () => {
      await waitShading(port, 'penguin-vertex')
      await capture(port, 'penguin-vertex', captures, subject)
    })
    port.setShading('field')
  } finally {
    driver?.dispose()
    mounts.destroy()
    if (bean >= 0) port.destroyInstance(bean)
    backdrop.dispose()
  }
}

async function shootWorld(port: ResizablePort, content: SdfContent, captures: Captures): Promise<void> {
  const level = content.captureLevel(MECH_COURSE)
  const stage = new Stage(port, content, content.course(MECH_COURSE), { decor: true })
  try {
    const initial: CameraPose = { eye: [38, 26, 42], target: [0, 1.5, 0], fovYDeg: 45, near: 0.1, far: 500 }
    const cam = fitWorld(initial, port.worldBounds())
    port.setCamera(0, cam)
    await waitShading(port, 'candy-world')
    await capture(port, 'candy-world', captures, { camera: cam, center: cam.target, radius: 100,
      expectedParts: level.parts, hide: () => stage.hide() })
  } finally { stage.dispose() }
}

async function shootScenery(port: ResizablePort, content: GameContent, captures: Captures, what = 'rounded-scenery'): Promise<void> {
  const hub = content.hub()
  const stage = new Stage(port, content, hub, { decor: false, obstacles: [obstacleOf(hub, 'candy.plaza-fountain')], mechanisms: [] })
  try {
    const cam = sceneryCamera(port.worldBounds(true))
    port.setCamera(0, cam)
    await waitShading(port, 'rounded-scenery')
    await capture(port, what, captures, { camera: cam, center: [0, 1, 0], radius: 2.6, hide: () => stage.hide() })
  } finally { stage.dispose() }
}

async function shootMechanisms(port: ResizablePort, content: GameContent, captures: Captures): Promise<void> {
  const course = content.course(MECH_COURSE)
  const at = mechanismOf(course, 'candy.pendulum-hammer')
  const item = course.mechanisms!.items[at]
  const place = item.place ?? item
  const target: [number, number, number] = [place.t.x, place.t.y + 1.35, place.t.z]
  const initial: CameraPose = { eye: [target[0] + 4, target[1] + 1.8, target[2] + 4], target, fovYDeg: 65, near: 0.1, far: 300 }
  const other = course.mechanisms!.items.findIndex((_, i) => i !== at)
  if (other < 0) throw new Error('mechanisms: missing second moving part')
  const stage = new Stage(port, content, course, { decor: false, obstacles: [], mechanisms: [at, other] })
  try {
    // One camera for both captures, fitted to the two captured poses only. The whole swing arc (+-60 degrees, both
    // hammers) is about twice as wide as a pose: framing it left each captured pose at 0.09..0.12 of the view, under
    // the capture guard's 0.15 (run 12108).
    const poses = [['mechanisms-a', 0], ['mechanisms-b', 30]] as const
    const posed = poses.flatMap(([, tick]) => { stage.update(tick); return port.worldBounds() })
    const cam = fitBounds(initial, posed)
    for (const [name, tick] of poses) {
      await attempt(captures, name, async () => {
        stage.update(tick)
        port.setCamera(0, cam)
        await waitShading(port, name)
        const failures = port.shadingReport().errors.filter(e => e.startsWith('candy.pendulum-hammer#') && !e.endsWith(': vertex mode'))
        if (failures.length) throw new Error(`mechanisms.field: ${failures.join('; ')}`)
        await capture(port, name, captures, { camera: cam, center: cam.target, radius: 8, hide: () => stage.hide() })
      })
    }
  } finally { stage.dispose() }
}

// Resident requests are deliberately small: ordered actions, real standard-pad input, no sim mutation.
const ACTIONS = ['start', 'run', 'turn', 'jump', 'dive'] as const
export function validateGameplay(raw: unknown): { search: string; sequence: string[]; atlasBytes?: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('fieldShading: expected a gameplay request object')
  const o = raw as Record<string, unknown>, q = new URLSearchParams(String(o.search ?? ''))
  if (Object.keys(o).some(k => !['search', 'sequence', 'atlasBytes'].includes(k)) || typeof o.search !== 'string' || q.get('test') !== '1') throw new Error('fieldShading: gameplay controls require search with test=1 and known request fields')
  if (!Array.isArray(o.sequence) || !o.sequence.length || o.sequence.length > ACTIONS.length || o.sequence.some((v, i) => v !== ACTIONS[i])) throw new Error('fieldShading: sequence must be a nonempty prefix of start, run, turn, jump, dive')
  if (o.atlasBytes !== undefined && (!Number.isInteger(o.atlasBytes) || Number(o.atlasBytes) <= 0 || Number(o.atlasBytes) > FIELD_ATLAS_BYTES)) throw new Error(`fieldShading: atlasBytes must be an integer in 1..${FIELD_ATLAS_BYTES}`)
  return { search: o.search, sequence: o.sequence as string[], atlasBytes: o.atlasBytes as number | undefined }
}
interface ResidentState {
  local: { characters: { pos: { x: number; y: number; z: number }; vel: { y: number }; mode: number }[]; cameras: CameraPose[] } | null
  camera: { yaw: number }; field: { normals: ShadingReport; bounds: PartWorldBounds[]; graphics: Record<string, unknown> }
}
async function gameplay(raw: unknown, deps: TourDeps) {
  const request = validateGameplay(raw), q = new URLSearchParams(request.search)
  for (const key of ['server', 'community', 'clients', 'players', 'bots']) if (q.has(key)) throw new Error(`fieldShading: resident gameplay does not accept ${key}`)
  q.set('content', 'sdf'); q.set('course', MECH_COURSE)
  const errors: string[] = [], events = new AbortController()
  window.addEventListener('error', e => errors.push(String(e.error ?? e.message)), { signal: events.signal })
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)), { signal: events.signal })
  const roots = ['#views', '#screens'].map(id => document.querySelector<HTMLElement>(id)!), styles = roots.map(r => r.style.cssText)
  for (const root of roots) { root.style.width = `${WIDTH}px`; root.style.height = `${HEIGHT}px` }
  const original = Object.getOwnPropertyDescriptor(navigator, 'getGamepads')
  const axes = [0, 0, 0, 0], buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }))
  const pad = { index: 0, id: 'field-gameplay', connected: true, mapping: 'standard', axes, buttons, timestamp: 0 }
  let connected = false, game: TourGame | undefined
  const files: OpFile[] = [], observations: unknown[] = []
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => connected ? [pad] : [] })
  try {
    const options = { search: `?${q}`, fieldGameplay: true, atlasBytes: request.atlasBytes,
      saved: { 'rf.wardrobe': JSON.stringify({ version: 2, colour: 0, worn: { head: 'costume.propeller-hat', bottom: 'costume.fish-scarf' } }) } }
    game = await deps.boot(() => {}, options)
    const live = game, state = () => live.inventory() as ResidentState
    const until = async (what: string, ready: () => boolean, dt = 1 / 60) => {
      const end = Date.now() + WAIT_MS
      do {
        const screen = live.host.currentScreen()
        if (screen === 'error' || Date.now() > end) throw new Error(`fieldShading: ${what} failed on ${screen}`)
        live.step(dt); await yieldTask(screen)
      } while (!ready())
    }
    const shoot = async (action: string) => {
      // Freeze simulation while compilation completes; preserve the action pose and its actual camera.
      await until(`${action} readiness`, () => state().field.normals.pending === 0 && pendingPipelines() === 0, 0)
      if (errors.length) throw new Error(`fieldShading page errors: ${errors.join('; ')}`)
      const report = state().field.normals
      if (report.atlasFull || hardFailures(report).length || (state().field.graphics.shading === 'field' && q.get('normals') !== 'vertex' && report.field === 0)) throw new Error(`fieldShading: ${action}: ${JSON.stringify(report)}`)
      live.step(0)
      const s = state(), cam = s.local?.cameras[0], bounds = s.field.bounds
      if (action !== 'start' && (!cam || !bounds.some(b => projectBounds(cam, [b]).some(p => p[2] > cam.near && Math.abs(p[0]) < 1 && Math.abs(p[1]) < 1)))) throw new Error(`${action}: no gameplay subject in frame`)
      if (cam) {
        const visible = bounds.filter(b => projectBounds(cam, [b]).some(p => p[2] > cam.near && Math.abs(p[0]) < 1 && Math.abs(p[1]) < 1))
        for (const subject of ['penguin', 'costume.propeller-hat', 'candy.', 'pendulum-hammer']) if (!visible.some(b => b.key.includes(subject))) throw new Error(`${action}: ${subject} is outside the gameplay view`)
        const visibleCharacters = s.local!.characters.filter(c => projectBounds(cam, [{ key: 'character', min: [c.pos.x, c.pos.y, c.pos.z], max: [c.pos.x, c.pos.y, c.pos.z] }]).some(p => p[2] > cam.near && Math.abs(p[0]) < 1 && Math.abs(p[1]) < 1)).length
        if (visibleCharacters < 2) throw new Error(`${action}: several characters must be visible`)
      }
      const subjects = [...new Map(bounds.filter(b => /costume.propeller-hat|pendulum-hammer/.test(b.key)).map(b => [b.key, b])).values()]
      const uiShot = createImageBitmap(live.ui)
      const canvases = [...live.views.querySelectorAll('canvas')].filter(c => getComputedStyle(c).display !== 'none')
      const box = live.ui.getBoundingClientRect()
      const snapshots = canvases.map(c => ({ rect: c.getBoundingClientRect(), image: createImageBitmap(c) }))
      snapshots.push({ rect: box, image: uiShot })
      const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT
      const ctx = canvas.getContext('2d')!
      for (const shot of snapshots) { const image = await shot.image; ctx.drawImage(image, (shot.rect.x - box.x) * WIDTH / box.width, (shot.rect.y - box.y) * HEIGHT / box.height, shot.rect.width * WIDTH / box.width, shot.rect.height * HEIGHT / box.height); image.close() }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Empty gameplay capture')), 'image/png'))
      files.push({ name: `${action}.png`, blob }); observations.push({ action, local: s.local, camera: s.camera, graphics: s.field.graphics, normals: report, subjects })
    }
    await until('start', () => live.host.currentScreen() === 'start')
    await startMounted(live, () => live.host.currentScreen())
    await shoot('start')
    if (request.sequence.length > 1) {
      for (let i = 0; i < 5; i++) { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowDown', bubbles: true })) }
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }))
      await until('round', () => live.host.currentScreen() === 'round' && state().local !== null)
      connected = true; axes[1] = -1
      for (const action of request.sequence.slice(1)) {
        const before = state(), c = before.local!.characters[0]
        if (action === 'turn') axes[2] = 0.7
        if (action === 'jump' || action === 'dive') { axes[2] = 0; buttons[action === 'jump' ? 0 : 1].pressed = true }
        await until(action, () => {
          const s = state(), now = s.local!.characters[0]
          return action === 'run' ? Math.hypot(now.pos.x - c.pos.x, now.pos.z - c.pos.z) >= 2 : action === 'turn' ? Math.abs(s.camera.yaw - before.camera.yaw) >= 0.25 : action === 'jump' ? now.vel.y > 0 && now.pos.y > c.pos.y + 0.5 : now.mode === CharMode.dive && now.vel.y <= 0
        })
        await shoot(action)
        buttons[0].pressed = buttons[1].pressed = false
      }
    }
    const report = state().field.normals
    if (request.atlasBytes !== undefined && request.sequence.length > 1 && report.demoted === 0) throw new Error('Constrained atlas did not exercise fallback')
    assertNoPageErrors('resident gameplay')
    return { json: { ok: true, captures: files.map(f => f.name), observations, adapter: await deps.adapter() }, files }
  } finally {
    game?.dispose(); events.abort()
    roots.forEach((root, i) => { root.style.cssText = styles[i] })
    if (original) Object.defineProperty(navigator, 'getGamepads', original); else Reflect.deleteProperty(navigator, 'getGamepads')
  }
}

export async function run(input: unknown, deps: TourDeps): Promise<{ json: Record<string, unknown>; files: OpFile[] }> {
  if (input && typeof input === 'object' && ('sequence' in input || 'atlasBytes' in input)) return gameplay(input, deps)
  const captures: Captures = { files: [], names: [], observations: [], failures: [] }
  const search = typeof input === 'object' && input !== null && 'search' in input ? String(input.search) : ''
  const options = gameRenderOptions(search)
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  document.body.appendChild(canvas)
  const content = pickContent(new URLSearchParams({ content: 'sdf' }))
  const target = { canvas, width: WIDTH, height: HEIGHT, viewports: [{ x: 0, y: 0, width: WIDTH, height: HEIGHT }] }
  try {
    await content.load('sprint', () => {})
    assertNoPageErrors('content load')
    if (!(content instanceof SdfContent)) throw new Error('fieldShading: SDF content required')
    const sdf = content
    // Each scene owns its port; a failed scene disposes it and the next scene still runs (attempt).
    const scene = async (what: string, renderOptions: Parameters<SdfContent['createPort']>[1], assets: readonly string[],
      shoot: (port: ResizablePort) => Promise<void>): Promise<void> => attempt(captures, what, async () => {
      const port = await sdf.createPort(target, renderOptions, [...assets]) as ResizablePort
      try { await shoot(port) } finally { port.dispose() }
    })
    let normals: ShadingReport | null = null
    if (!search) {
      await scene('candy-world', { shading: 'field' }, content.captureLevel(MECH_COURSE).assets, async port => {
        try { await shootWorld(port, content, captures) } finally { normals = port.shadingReport() }
      })
      // Close views retain their own subjects and do not consume the race level's atlas.
      const portraitAssets = [...content.captureLevel(content.hub().id).assets,
        'penguin.body', 'costume.propeller-hat', 'costume.fish-scarf']
      await scene('portraits (rounded-scenery, penguin)', { shading: 'field' }, portraitAssets, async port => {
        await attempt(captures, 'rounded-scenery', () => shootScenery(port, content, captures))
        await shootPenguin(port, content, captures)
      })
      for (const [suffix, query] of [['normals', '?normalsDebug'], ['vertex', '?normals=vertex']] as const) {
        await scene(`rounded-scenery-${suffix}`, gameRenderOptions(query), ['candy.plaza-fountain'], port =>
          shootScenery(port, content, captures, `rounded-scenery-${suffix}`))
      }
    }
    // A close-up is its own scene: unrelated worlds must not consume this scene's atlas.
    const ids = [...new Set(content.course(MECH_COURSE).mechanisms!.items.map(item => item.asset))]
    await scene('mechanisms', options, ids, async port => {
      try { await shootMechanisms(port, content, captures) } finally { normals ??= port.shadingReport() }
    })
    await attempt(captures, 'captures', async () => assertNoPageErrors('captures'))
    const reported = content.report()
    const world = normals as ShadingReport | null
    if (world !== null && options.shading !== 'vertex' && world.field === 0) captures.failures.push('the whole world drew no field-shaded part')
    const failures = world === null ? [] : hardFailures(world)
    if (failures.length > 0) captures.failures.push(`field shading failed: ${failures.join('; ')}`)
    return {
      json: {
        ok: captures.failures.length === 0,
        ...(captures.failures.length === 0 ? {} : { failures: captures.failures }),
        content: content.id,
        shading: options.shading,
        adapter: await deps.adapter(),
        assets: reported.assets,
        failedAssets: reported.failed,
        normals: world,
        hardFailures: failures,
        captures: captures.names,
        observations: captures.observations,
      },
      files: captures.files,
    }
  } finally {
    canvas.remove()
  }
}
