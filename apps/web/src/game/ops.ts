// GPU client ops of the player page (game.html?mode=ops): controlsProbe (proofs/m15/controls.json, S17) and
// gameCapture (S10 captures plus events and content.report(), S17). Both refuse when RAA is unavailable:
// captures are only ever RAA renders. Input goes through the real input module (GameInput, controlsToInput,
// the orbit camera); the op only produces the DOM events and the pad a player would.
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { controlsToInput } from '@royal-fiesta/game/client/inputMap'
import type { ContentId, GameContent, LoadProgress } from '@royal-fiesta/game/content'
import { PlayFlow } from '@royal-fiesta/game/hub/flow'
import type { FlowEvent } from '@royal-fiesta/game/hub/flow'
import { HubWorld } from '@royal-fiesta/game/hub/hubWorld'
import type { RemoteView } from '@royal-fiesta/game/hub/remotes'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import { PodiumStage } from '@royal-fiesta/game/render/podiumStage'
import type { CameraPose, RenderPort, RenderStats, Vec3T, Viewport } from '@royal-fiesta/game/render/port'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import { skinnedCharacterOf } from '../content/providers/sdf.ts'
import { DEFAULT_SETTINGS } from '@royal-fiesta/game/screens/settings'
import { CharacterSystem } from '@royal-fiesta/sim/character/system'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { MatchSim, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { ObstacleSystem } from '@royal-fiesta/sim/obstacles/system'
import { refuse } from '@royal-fiesta/sim/refusal'
import { FiestaWorld } from '@royal-fiesta/sim/world'
import type { SimSystem } from '@royal-fiesta/sim/world'
import { planCanvases } from '../client/canvases.ts'
import { mountLoading } from '../content/loading.ts'
import { pickContent } from '../content/source.ts'
import { GameInput } from '../input/input.ts'
import { installNmcOps } from '../nmc/ops.ts'
import type { AdapterInfo } from '../nmc/ops.ts'
import { HubView } from '../play/hubView.ts'
import { InPageHubLoop } from '../play/inpageHub.ts'
import { raaStatus } from '../render/raaStatus.ts'
import { pendingPipelines } from '../render/asyncPipelines.ts'
import { installZoneLobbyOps } from '../zone/zoneLobbyOps.ts'
import { installSplitOps } from '../zone/splitOps.ts'
import { installZoneOps } from '../zone/zoneOps.ts'
import { uiTour } from './uiTour.ts'
import type { BootGame, UiTourOutput } from './uiTour.ts'

export interface ControlCase { name: string; input: 'KeyD' | 'ArrowRight' | 'stickRight' | 'KeyA' | 'ArrowLeft' | 'stickLeft' | 'mouseRight' | 'rightStickRight'; holdMs: number }
export interface ControlsProbeInput { width: 1280; height: 720; content: ContentId; course: string; cases: ControlCase[] }
export interface GameCaptureInput { content: ContentId; course?: string; flow: 'match' | 'hub' | 'podium' | 'tour'; clients: 1 | 2 | 4; width: number; height: number; captureAt: string[]; reload?: boolean; net?: { server: string; party: 2 } }

type ControlInput = ControlCase['input']
interface CaptureRecord { name: string; sha256: string; bytes: number; nonEmpty: boolean }
interface SizedCapture extends CaptureRecord { width: number; height: number }
interface CaseRecord {
  name: string; input: ControlInput; subject: 'character' | 'view'; device: 'keyboard' | 'synthetic-pad' | 'pointer-lock-events'
  beforeX: number; afterX: number; centreX: number; captures: CaptureRecord[]
}
interface ControlsOutput { renderer: 'raa'; adapter: AdapterInfo; software: boolean; pageRef: string; content: ContentId; course: string; cases: CaseRecord[] }
interface GameEvent { t: number; what: string }
type Report = Record<string, number | string | readonly string[]>
interface GameCaptureOutput {
  renderer: 'raa'; adapter: AdapterInfo; software: boolean; pageRef: string; captures: SizedCapture[]; frameTiming: null
  content: ContentId; courses: string[]; events: GameEvent[]; report: Report; reports: Report[]
}
// GPU client protocol: {json, files}; files carry the PNGs.
interface OpFile { name: string; blob: Blob }
interface OpResult<T> { json: T; files: OpFile[] }

const DT = 1 / 60
const CONTROL_INPUTS: readonly ControlInput[] = ['KeyD', 'ArrowRight', 'stickRight', 'KeyA', 'ArrowLeft', 'stickLeft', 'mouseRight', 'rightStickRight']
const CONTENT_IDS: readonly ContentId[] = ['v0', 'v1', 'sdf']

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

function str(op: string, path: string, v: unknown, pattern: RegExp): string {
  if (typeof v !== 'string' || !pattern.test(v)) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass a string matching ${pattern}`)
  return v
}

function contentId(op: string, v: unknown): ContentId {
  if (!CONTENT_IDS.includes(v as ContentId)) refuse('ops', `${op}.input.content`, `is ${JSON.stringify(v)}; choose ${CONTENT_IDS.join(', ')}`)
  return v as ContentId
}

// ---- browser helpers --------------------------------------------------------------------------------------

// Minimal WebGPU shapes: the repo lib list has no @webgpu/types.
interface GpuAdapterInfoLike { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean }
interface GpuAdapterLike { info?: GpuAdapterInfoLike; isFallbackAdapter?: boolean }
interface GpuLike { requestAdapter(opts?: { powerPreference?: string; featureLevel?: string }): Promise<GpuAdapterLike | null> }

// Same detection as the client and play ops (theirs are private).
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

// The GPU client exposes the RTX only at WebGPU's compatibility feature level (see play/ops.ts).
function preferCompatibilityAdapter(): void {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu || typeof gpu.requestAdapter !== 'function') return
  const orig = gpu.requestAdapter.bind(gpu)
  gpu.requestAdapter = (opts?: { powerPreference?: string; featureLevel?: string }) =>
    orig({ ...(opts ?? {}), featureLevel: opts?.featureLevel ?? 'compatibility' })
}

let rapier: Promise<RapierModule> | undefined

async function prelude(): Promise<{ R: RapierModule; adapter: AdapterInfo }> {
  const status = await raaStatus()
  if (!status.available) refuse('render', 'raa', status.reason)
  rapier ??= initRapier()
  return { R: await rapier, adapter: await adapterInfo() }
}

// The page is served under the published revision's sub-path; the runner maps it to its page ref.
function pageRef(): string {
  return window.location.pathname.replace(/[^/]*$/, '')
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.style.cssText = `width: ${width}px; height: ${height}px; display: block;`
  document.body.appendChild(canvas)
  return canvas
}

async function makePort(content: GameContent, canvas: HTMLCanvasElement): Promise<RenderPort> {
  const port = await content.createPort({ canvas, width: canvas.width, height: canvas.height, viewports: [{ x: 0, y: 0, width: canvas.width, height: canvas.height }] })
  if (port.kind !== 'raa') {
    port.dispose()
    refuse('render', 'raa', `content '${content.id}' made a ${port.kind} port; captures need an RAA port`)
  }
  return port
}

async function loadContent(id: ContentId, onProgress: (p: LoadProgress) => void): Promise<GameContent> {
  const content = pickContent(new URLSearchParams({ content: id }))
  await content.load('sprint', onProgress)
  return content
}

function yieldToBrowser(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

async function renderPng(port: RenderPort, what: string): Promise<Uint8Array> {
  port.render()
  const deadline = performance.now() + 10000
  while (pendingPipelines() > 0) {
    if (performance.now() >= deadline) refuse('render', 'raa', `pipeline readiness timed out at ${what}; ${pendingPipelines()} pipelines still pending`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  port.render()
  const png = await port.capture()
  if (png === null || png.length === 0) refuse('render', 'raa', `the capture at ${what} returned no PNG bytes; the RAA port must read the canvas back`)
  return png
}

async function pngBlob(canvas: HTMLCanvasElement, what: string): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) refuse('ops', what, 'canvas.toBlob returned null; the capture could not be encoded')
  return new Uint8Array(await blob.arrayBuffer())
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// "It rendered, it is not empty" (1.10): the decoded image has more than one colour.
async function nonEmpty(png: Uint8Array): Promise<boolean> {
  const image = await createImageBitmap(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (ctx === null) refuse('ops', 'capture', 'no 2D canvas context to check the capture; run the op in a browser with canvas 2D')
  ctx.drawImage(image, 0, 0)
  image.close()
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 4; i < px.length; i += 4) {
    if (px[i] !== px[0] || px[i + 1] !== px[1] || px[i + 2] !== px[2]) return true
  }
  return false
}

async function record(name: string, png: Uint8Array, files: OpFile[]): Promise<CaptureRecord> {
  files.push({ name: `${name}.png`, blob: new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })
  return { name, sha256: await sha256Hex(png), bytes: png.length, nonEmpty: await nonEmpty(png) }
}

// Screen x in pixels of world point p through raa-math look_at_rh (rows s, u, -f) and an RH perspective.
function projectX(cam: CameraPose, p: Vec3T, width: number, height: number): number {
  const fx = cam.target[0] - cam.eye[0]
  const fy = cam.target[1] - cam.eye[1]
  const fz = cam.target[2] - cam.eye[2]
  const fl = Math.hypot(fx, fy, fz)
  // s = normalize(cross(f, up)) with up = +Y.
  const sx = -fz
  const sz = fx
  const sl = Math.hypot(sx, sz)
  if (fl === 0 || sl === 0) refuse('ops', 'projectX', 'the camera looks straight up or down or has eye = target; the probe needs a horizontal view direction')
  const dx = p[0] - cam.eye[0]
  const dy = p[1] - cam.eye[1]
  const dz = p[2] - cam.eye[2]
  const xv = (sx * dx + sz * dz) / sl
  const w = (fx * dx + fy * dy + fz * dz) / fl
  if (!(w > cam.near)) refuse('ops', 'projectX', `the point is ${w.toFixed(3)} m along the view, behind the near plane; shorten holdMs`)
  const ndc = xv / (w * Math.tan((cam.fovYDeg * Math.PI) / 360) * (width / height))
  return ((ndc + 1) / 2) * width
}

// ---- controlsProbe ----------------------------------------------------------------------------------------

const PROBE_WIDTH = 1280
const PROBE_HEIGHT = 720
const SETTLE_FRAMES = 30
const MAX_HOLD_MS = 5000
// Mouse right under pointer lock: one movementX event per frame (2.5 mrad/px at sensitivity 5).
const MOUSE_PX = 8
// Right stick x: half deflection turns 0.75 rad/s at sensitivity 5, so the marker stays in front of the eye.
const RIGHT_STICK_X = 0.5
// The view-case marker sits on the view ray, this far beyond the camera target (screen centre).
const MARKER_BEYOND_M = 4

function subjectOf(input: ControlInput): 'character' | 'view' {
  return input === 'mouseRight' || input === 'rightStickRight' ? 'view' : 'character'
}

function deviceOf(input: ControlInput): CaseRecord['device'] {
  if (input === 'mouseRight') return 'pointer-lock-events'
  return input === 'stickRight' || input === 'stickLeft' || input === 'rightStickRight' ? 'synthetic-pad' : 'keyboard'
}

function validateProbe(raw: unknown): ControlsProbeInput {
  const op = 'controlsProbe'
  const o = obj(op, 'input', raw)
  onlyKeys(op, 'input', o, ['width', 'height', 'content', 'course', 'cases'])
  if (o.width !== PROBE_WIDTH || o.height !== PROBE_HEIGHT) {
    refuse('ops', `${op}.input`, `is ${JSON.stringify(o.width)}x${JSON.stringify(o.height)}; controls-probe captures are ${PROBE_WIDTH}x${PROBE_HEIGHT}`)
  }
  const content = contentId(op, o.content)
  const course = str(op, 'input.course', o.course, /^[a-z0-9-]{1,40}$/)
  if (!Array.isArray(o.cases) || o.cases.length < 1 || o.cases.length > 16) refuse('ops', `${op}.input.cases`, 'is not an array of 1..16 cases')
  const names = new Set<string>()
  const cases = o.cases.map((c: unknown, i: number): ControlCase => {
    const path = `input.cases/${i}`
    const r = obj(op, path, c)
    onlyKeys(op, path, r, ['name', 'input', 'holdMs'])
    const name = str(op, `${path}/name`, r.name, /^[a-z0-9-]{1,40}$/)
    if (names.has(name)) refuse('ops', `${op}.${path}/name`, `'${name}' is repeated; give each case its own name`)
    names.add(name)
    if (!CONTROL_INPUTS.includes(r.input as ControlInput)) refuse('ops', `${op}.${path}/input`, `is ${JSON.stringify(r.input)}; choose ${CONTROL_INPUTS.join(', ')}`)
    return { name, input: r.input as ControlInput, holdMs: int(op, `${path}/holdMs`, r.holdMs, 1, MAX_HOLD_MS) }
  })
  return { width: PROBE_WIDTH, height: PROBE_HEIGHT, content, course, cases }
}

// One character on the probed course, placed at spawn 0 facing +Z (the hub world's systems, any course kind).
class ProbeWorld {
  private readonly world: FiestaWorld<PlayerInput>
  private readonly chars = new CharacterSystem({ playerCount: 1 })
  private readonly inputs: PlayerInput[] = []

  constructor(R: RapierModule, course: ResolvedCourse) {
    const spawn = course.spawns[0]
    if (spawn === undefined) refuse('ops', `${course.id}#/spawns/0`, 'the probed course has no spawn; probe a race or survival course')
    const obstacles = new ObstacleSystem([course])
    this.world = new FiestaWorld<PlayerInput>(R, { playerCount: 1, systems: [obstacles as SimSystem<PlayerInput>, this.chars] })
    obstacles.load(this.world.ctx, 0)
    this.chars.place(this.world.ctx, 0, { t: spawn.t, facing: { x: 0, z: 1 } })
  }

  get tick(): number { return this.world.tick }

  step(input: PlayerInput): void {
    this.inputs[0] = input
    this.world.step(this.inputs)
  }

  state(out: CharState): CharState {
    return this.chars.state(this.world.ctx, 0, out)
  }

  free(): void {
    this.world.free()
  }
}

// A standard-mapping pad served by navigator.getGamepads while the op runs.
function syntheticPad(): Gamepad {
  return {
    id: 'synthetic-pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: null,
  } as unknown as Gamepad
}

// Replaces an own property of obj for the op, then puts the original (or the prototype's) back.
function override(target: object, key: string, desc: PropertyDescriptor): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, ...desc })
  return () => {
    if (own) Object.defineProperty(target, key, own)
    else Reflect.deleteProperty(target, key)
  }
}

function key(type: 'keydown' | 'keyup', code: string): void {
  const k = code.startsWith('Key') ? code.slice(3).toLowerCase() : code
  window.dispatchEvent(new KeyboardEvent(type, { code, key: k, bubbles: true, cancelable: true }))
}

async function controlsProbe(raw: unknown): Promise<OpResult<ControlsOutput>> {
  const input = validateProbe(raw)
  const { R, adapter } = await prelude()
  const content = await loadContent(input.content, () => {})
  const course = content.course(input.course)
  const s = DEFAULT_SETTINGS
  const files: OpFile[] = []
  const cases: CaseRecord[] = []
  const canvas = makeCanvas(PROBE_WIDTH, PROBE_HEIGHT)
  const overlay = document.createElement('div')
  document.body.appendChild(overlay)
  const restores: (() => void)[] = []
  let port: RenderPort | null = null
  let view: HubView | null = null
  let gameInput: GameInput | null = null
  let world: ProbeWorld | null = null
  let marker = -1
  try {
    port = await makePort(content, canvas)
    const pad = syntheticPad()
    const axes = pad.axes as number[]
    let locked = false
    restores.push(override(navigator, 'getGamepads', { writable: true, value: () => [pad] }))
    // PointerLook only counts movementX while the canvas holds the lock; a headless page cannot take it.
    restores.push(override(document, 'pointerLockElement', { get: () => (locked ? canvas : null) }))
    const orbit = new OrbitCamera()
    const character = content.character()
    view = new HubView(port, 0, name => content.assets(name), character, course, { orbit, character, dressing: content.dressing() })
    gameInput = new GameInput(window, overlay, () => canvas)
    const gi = gameInput
    const hv = view
    const p = port
    const move = neutralInput()
    const st: CharState = {
      pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
      mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
    }
    const markerAsset = p.registerAsset(character.id, character)
    // One page frame as game.html runs it; hold keeps the camera at the case's starting pose.
    const frame = (w: ProbeWorld, hold: CameraPose | null): CameraPose => {
      const look = gi.takeLook()
      orbit.mouse(look.dx, look.dy, s.mouseSensitivity, s.invertY)
      orbit.stick(look.rx, look.ry, DT, s.stickSensitivity, s.invertY)
      gi.takeEvents()
      controlsToInput(gi.controls(s, false), orbit.ground(), move)
      w.step(move)
      hv.update(w.state(st), 0, [], w.tick, DT)
      if (hold !== null) p.setCamera(0, hold)
      const cam = hold ?? hv.camera
      if (cam === null) refuse('ops', 'controlsProbe', 'the hub view set no camera; HubView.update must frame the character')
      return cam
    }
    for (const c of input.cases) {
      const subject = subjectOf(c.input)
      world?.free()
      world = new ProbeWorld(R, course)
      const w = world
      orbit.reset(0)
      axes.fill(0)
      gi.takeEvents()
      gi.takeLook()
      let cam = frame(w, null)
      for (let i = 1; i < SETTLE_FRAMES; i++) cam = frame(w, null)
      // Character cases hold the reset camera (the orbit pose follows the character, which would keep it centred).
      const hold = subject === 'character' ? cam : null
      let point: Vec3T
      if (subject === 'character') {
        const pos = w.state(st).pos
        point = [pos.x, pos.y, pos.z]
      } else {
        const d = Math.hypot(cam.target[0] - cam.eye[0], cam.target[1] - cam.eye[1], cam.target[2] - cam.eye[2])
        const k = (d + MARKER_BEYOND_M) / d
        point = [0, 1, 2].map(i => cam.eye[i] + (cam.target[i] - cam.eye[i]) * k) as unknown as Vec3T
        marker = p.createInstance(markerAsset, PALETTE[2])
        p.setTransform(marker, point, [0, 0, 0, 1], [1, 1, 1])
      }
      const beforeX = projectX(cam, point, PROBE_WIDTH, PROBE_HEIGHT)
      const before = await record(`${c.name}-before`, await renderPng(p, `${c.name}-before`), files)
      const frames = Math.max(1, Math.round(c.holdMs / 1000 / DT))
      if (c.input === 'KeyD' || c.input === 'KeyA' || c.input === 'ArrowRight' || c.input === 'ArrowLeft') key('keydown', c.input)
      else if (c.input === 'stickRight') axes[0] = 1
      else if (c.input === 'stickLeft') axes[0] = -1
      else if (c.input === 'rightStickRight') axes[2] = RIGHT_STICK_X
      else locked = true
      try {
        for (let i = 0; i < frames; i++) {
          if (locked) window.dispatchEvent(new MouseEvent('mousemove', { movementX: MOUSE_PX, movementY: 0, bubbles: true }))
          cam = frame(w, hold)
          if (i % 30 === 29) await yieldToBrowser()
        }
      } finally {
        if (c.input.startsWith('Key') || c.input.startsWith('Arrow')) key('keyup', c.input)
        axes.fill(0)
        locked = false
      }
      if (subject === 'character') {
        const pos = w.state(st).pos
        point = [pos.x, pos.y, pos.z]
      }
      const afterX = projectX(cam, point, PROBE_WIDTH, PROBE_HEIGHT)
      const after = await record(`${c.name}-after`, await renderPng(p, `${c.name}-after`), files)
      if (marker >= 0) {
        p.destroyInstance(marker)
        marker = -1
      }
      cases.push({
        name: c.name, input: c.input, subject, device: deviceOf(c.input),
        beforeX, afterX, centreX: PROBE_WIDTH / 2, captures: [before, after],
      })
    }
    return {
      json: { renderer: 'raa', adapter, software: adapter.software, pageRef: pageRef(), content: content.id, course: course.id, cases },
      files,
    }
  } finally {
    try {
      if (marker >= 0) port?.destroyInstance(marker)
      world?.free()
      gameInput?.dispose()
      view?.dispose()
      port?.dispose()
    } finally {
      for (const restore of restores.reverse()) restore()
      canvas.remove()
      overlay.remove()
    }
  }
}

// ---- gameCapture: views and drivers -----------------------------------------------------------------------

type Stage = 'hub' | 'match' | 'podium' | 'back-in-hub' | 'transit'
type Note = (what: string) => void
const SEED = 7
const PLAYERS = 8
// The podium returns to the hub after this, as game.html's PODIUM_HOLD_S.
const PODIUM_HOLD_FRAMES = 360

interface Driver {
  frame(dt: number): Stage
  // Leaves the hub for a match (the local driver; pilots walk onto the pad themselves).
  enqueue(): void
  capture(what: string): Promise<Uint8Array>
  dispose(): void
}

function emptyChar(): CharState {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
}

function emptyCharView(): CharacterView {
  return { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 }, mode: 0, status: 0, parked: false, teleportTick: 0 }
}

function emptyViewState(): MatchViewState {
  return {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: -1, roundKind: null, final: false, courseIndex: -1,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
}

// One client on one port, drawn as game.html draws it: the hub view and the match scene framed by the
// orbit camera, then the podium stage with content.podium().
class SingleView {
  private readonly orbit = new OrbitCamera()
  private readonly port: RenderPort
  private readonly content: GameContent
  private readonly hubView: HubView
  private readonly stage: PodiumStage
  private scene: SceneView | null = null
  private sceneSim: MatchSim | null = null
  private onPodium = false

  constructor(port: RenderPort, content: GameContent) {
    this.port = port
    this.content = content
    const character = content.character()
    this.hubView = new HubView(port, 0, name => content.assets(name), character, content.hub(), { orbit: this.orbit, character, dressing: content.dressing() })
    this.stage = new PodiumStage({ port, viewport: 0, bean: character, block: content.assets('wall-block'), layout: content.podium() })
  }

  hub(local: CharState, remotes: RemoteView[], tick: number, dt: number): void {
    if (this.sceneSim !== null || this.onPodium) {
      this.leaveMatch()
      this.orbit.reset(0)
    }
    this.hubView.setVisible(true)
    this.hubView.update(local, 0, remotes, tick, dt)
  }

  match(sim: MatchSim, smoother: Parameters<SceneView['update']>[1], seat: number, dt: number): void {
    if (sim !== this.sceneSim) {
      this.leaveMatch()
      this.hubView.setVisible(false)
      this.orbit.reset(0)
      const content = this.content
      const orbit = this.orbit
      this.scene = new SceneView({
        port: this.port, viewport: 0, localPlayer: seat, assets: name => content.assets(name), bean: content.character(),
        character: content.character(), dressing: content.dressing(), camera: focus => orbit.pose(focus),
        skinned: skinnedCharacterOf(content),
      })
      this.sceneSim = sim
    }
    this.scene?.update(sim, smoother, 1, dt)
  }

  podium(places: readonly number[], dt: number): void {
    if (!this.onPodium) {
      this.scene?.dispose()
      this.scene = null
      this.hubView.setVisible(false)
      this.stage.show(places.slice(0, 3))
      this.onPodium = true
    }
    this.stage.update(dt)
  }

  dispose(): void {
    this.leaveMatch()
    this.stage.dispose()
    this.hubView.dispose()
  }

  private leaveMatch(): void {
    this.scene?.dispose()
    this.scene = null
    this.sceneSim = null
    this.stage.hide()
    this.onPodium = false
  }
}

// game.html's ?course= setup: that course as round 0, the other kind riding along so MatchSetup is valid.
// Every player is a bot here, so the framed player 0 races.
function botSetup(content: GameContent, course: ResolvedCourse | null): MatchSetup {
  const playlist = content.playlist()
  if (course === null) return { seed: SEED, playerCount: PLAYERS, humans: Array(PLAYERS).fill(false), profile: 'sprint', courses: playlist }
  if (course.kind !== 'race' && course.kind !== 'survival') {
    refuse('ops', 'gameCapture.input.course', `'${course.id}' is a ${course.kind} course; pass a race or survival course of the playlist`)
  }
  const other = course.kind === 'race' ? 'survival' : 'race'
  const courses = [course, ...playlist.filter(c => c.kind === other)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const players = course.kind === 'race' ? PLAYERS : 3
  return { seed: SEED, playerCount: players, humans: Array(players).fill(false), profile: 'sprint', courses }
}

// In-page with bots, on a plain MatchSim, like game.html's local mode.
class LocalDriver implements Driver {
  private readonly R: RapierModule
  private readonly content: GameContent
  private readonly port: RenderPort
  private readonly view: SingleView
  private readonly course: ResolvedCourse | null
  private readonly note: Note
  private readonly local = emptyChar()
  private readonly cv = emptyCharView()
  private readonly vs = emptyViewState()
  private hub: HubWorld | null = null
  private sim: MatchSim | null = null
  private inputs: PlayerInput[] = []
  private order: number[] = []
  private places: readonly number[] | null = null
  private podiumFrames = 0
  private back = false

  constructor(R: RapierModule, content: GameContent, port: RenderPort, course: ResolvedCourse | null, start: 'hub' | 'match' | 'podium', note: Note) {
    this.R = R
    this.content = content
    this.port = port
    this.course = course
    this.note = note
    this.view = new SingleView(port, content)
    if (start === 'hub') this.hub = new HubWorld(R, content.hub(), 0)
    else if (start === 'match') this.enqueue()
    else {
      this.places = [0, 1, 2]
      note('podium shown with places 0, 1, 2')
    }
  }

  enqueue(): void {
    if (this.sim !== null) return
    this.hub?.free()
    this.hub = null
    const setup = botSetup(this.content, this.course)
    this.sim = new MatchSim(this.R, setup)
    this.inputs = Array.from({ length: setup.playerCount }, () => neutralInput())
    this.note(`match started (${setup.playerCount} bots, sprint)`)
  }

  frame(dt: number): Stage {
    if (this.places !== null) return this.framePodium(dt)
    const sim = this.sim
    if (sim !== null) return this.frameMatch(sim, dt)
    const hub = this.hub ?? (this.hub = new HubWorld(this.R, this.content.hub(), 0))
    hub.step(neutralInput())
    this.view.hub(hub.state(this.local), [], hub.tick, dt)
    return this.back ? 'back-in-hub' : 'hub'
  }

  capture(what: string): Promise<Uint8Array> {
    return renderPng(this.port, what)
  }

  dispose(): void {
    this.view.dispose()
    this.sim?.free()
    this.hub?.free()
  }

  private frameMatch(sim: MatchSim, dt: number): Stage {
    const single = this.course !== null && this.course.kind === 'race'
    sim.step(this.inputs)
    const v = sim.phase(this.vs)
    if (single) {
      for (let p = 0; p < this.inputs.length; p++) {
        if (!this.order.includes(p) && sim.character(p, this.cv).status === PlayerStatus.qualified) this.order.push(p)
      }
    }
    // A single ?course= race ends with its round; its podium is the qualification order.
    const podium = single ? (v.phase >= Phase.roundEnd ? this.order : null) : v.phase >= Phase.podium ? v.podium : null
    if (podium !== null) {
      this.places = podium.slice(0, 3)
      this.note(`podium ${this.places.join(', ')} at match tick ${sim.tick}`)
      return this.framePodium(dt)
    }
    this.view.match(sim, null, 0, dt)
    return 'match'
  }

  private framePodium(dt: number): Stage {
    this.view.podium(this.places ?? [], dt)
    if (++this.podiumFrames < PODIUM_HOLD_FRAMES) return 'podium'
    this.sim?.free()
    this.sim = null
    this.places = null
    this.podiumFrames = 0
    this.order = []
    this.back = true
    this.note('back in the hub')
    return 'transit'
  }
}

// One relay client (net.server), piloted to the pad, as game.html's online mode draws it.
class NetDriver implements Driver {
  private readonly port: RenderPort
  private readonly view: SingleView
  private readonly flow: PlayFlow
  private readonly local = emptyChar()
  private readonly vs = emptyViewState()
  private seat = 0
  private matched = false
  private failure: string | null = null

  constructor(R: RapierModule, content: GameContent, port: RenderPort, server: string, note: Note) {
    this.port = port
    this.view = new SingleView(port, content)
    this.flow = new PlayFlow({
      R, relayUrl: server, ws: globalWsFactory(), hubCode: 'new', name: 'Probe', colour: 0,
      courses: content.playlist(), plaza: content.hub(), partySize: 2, now: () => performance.now(), pilot: true,
      log: (ev: FlowEvent) => {
        if (ev.state === 'match' && typeof ev.detail.seat === 'number') this.seat = ev.detail.seat
        if (ev.state === 'failed') this.failure = String(ev.detail.message ?? 'the relay connection failed')
        // The relay URL stays out of the record: only the state is noted.
        note(`relay ${ev.state}`)
      },
    })
    void this.flow.start()
  }

  enqueue(): void {}

  frame(dt: number): Stage {
    const flow = this.flow
    flow.frame(dt, null, 0)
    if (this.failure !== null) refuse('ops', 'gameCapture.net', `${this.failure}; check the relay passed as net.server`)
    const match = flow.match
    if (match !== null) {
      this.matched = true
      const v = match.sim.phase(this.vs)
      if (v.phase >= Phase.podium) {
        this.view.podium(v.podium, dt)
        return 'podium'
      }
      this.view.match(match.sim, match.session.smoother, this.seat, dt)
      return 'match'
    }
    if (flow.state === 'hub' || flow.state === 'queued') {
      this.view.hub(flow.hub.state(this.local), flow.remotes(performance.now()), flow.hub.tick, dt)
      return this.matched ? 'back-in-hub' : 'hub'
    }
    return 'transit'
  }

  capture(what: string): Promise<Uint8Array> {
    return renderPng(this.port, what)
  }

  dispose(): void {
    this.flow.close()
    this.view.dispose()
  }
}

// The hub loop draws only at capture moments: the op renders each real port just before reading it back.
const ZERO_STATS: RenderStats = { frameMs: 0, drawCalls: 0, triangles: 0, instances: 0, visible: 0 }
function gated(port: RenderPort): RenderPort {
  return {
    kind: port.kind,
    init: target => port.init(target),
    registerAsset: (name, asset) => port.registerAsset(name, asset),
    createInstance: (asset, tint) => port.createInstance(asset, tint),
    setTransform: (instance, t, r, s) => port.setTransform(instance, t, r, s),
    setVisible: (instance, visible) => port.setVisible(instance, visible),
    destroyInstance: instance => port.destroyInstance(instance),
    setCamera: (viewport, cam) => port.setCamera(viewport, cam),
    setEnvironment: env => port.setEnvironment(env),
    render: () => ZERO_STATS,
    capture: () => port.capture(),
    dispose: () => port.dispose(),
  }
}

// 2 or 4 piloted clients over a LoopbackRelay (play.html's hub loop), one canvas and port each, tiled into
// one width x height capture: client k at column k % cols, row floor(k / cols).
class MultiDriver implements Driver {
  private readonly loop: InPageHubLoop
  private readonly ports: RenderPort[]
  private readonly tiles: Viewport[]
  private readonly width: number
  private readonly height: number
  private readonly now: () => number

  constructor(R: RapierModule, content: GameContent, ports: RenderPort[], tiles: Viewport[], width: number, height: number, now: () => number) {
    this.ports = ports
    this.tiles = tiles
    this.width = width
    this.height = height
    this.now = now
    const clients = ports.length
    this.loop = new InPageHubLoop(R, clients, new LoopbackRelay({ seed: 8 }), {
      R, courses: content.playlist(), plaza: content.hub(), partySize: clients as 2 | 4, now, pilot: true,
    }, ports.map(gated), { assets: name => content.assets(name), bean: content.character(), character: content.character(), dressing: content.dressing(), skinned: skinnedCharacterOf(content) })
  }

  get events(): readonly FlowEvent[] {
    return this.loop.events
  }

  enqueue(): void {}

  frame(dt: number): Stage {
    const loop = this.loop
    loop.frame(dt)
    const flows = loop.flows
    const failed = loop.events.find(e => e.state === 'failed')
    if (failed !== undefined) refuse('ops', 'gameCapture', `${String(failed.detail.message ?? `${failed.client} failed`)}; inspect the hub flow`)
    if (loop.done) return 'back-in-hub'
    if (flows.length < this.ports.length) return 'transit'
    if (flows.every(f => f.state === 'match')) return 'match'
    if (flows.every(f => f.state === 'podium')) return 'podium'
    const n = this.ports.length - 1
    if (flows.every(f => f.state === 'hub' && f.remotes(this.now()).length === n)) return 'hub'
    return 'transit'
  }

  async capture(what: string): Promise<Uint8Array> {
    const canvas = document.createElement('canvas')
    canvas.width = this.width
    canvas.height = this.height
    const ctx = canvas.getContext('2d')
    if (ctx === null) refuse('ops', 'gameCapture', 'no 2D canvas context to tile the client captures; run the op in a browser with canvas 2D')
    for (let k = 0; k < this.ports.length; k++) {
      const png = await renderPng(this.ports[k], `${what} (client ${k})`)
      const image = await createImageBitmap(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
      const t = this.tiles[k]
      ctx.drawImage(image, t.x, t.y, t.width, t.height)
      image.close()
    }
    return pngBlob(canvas, `gameCapture.${what}`)
  }

  dispose(): void {
    this.loop.dispose()
  }
}

// ---- gameCapture: the op ----------------------------------------------------------------------------------

type MomentKind = 'loading' | 'hub' | 'match' | 'podium' | 'back-in-hub'
interface Moment { name: string; kind: MomentKind; frames: number }
const RANK: Record<MomentKind, number> = { loading: 0, hub: 1, match: 2, podium: 3, 'back-in-hub': 4 }
const FLOW_MOMENTS: Record<GameCaptureInput['flow'], readonly MomentKind[]> = {
  hub: ['loading', 'hub'],
  match: ['loading', 'match', 'podium'],
  podium: ['loading', 'podium'],
  tour: ['loading', 'hub', 'match', 'podium', 'back-in-hub'],
}
// Frames a stage is shown before its capture: hub (with every remote), podium, back in the hub.
const SETTLE: Record<'hub' | 'podium' | 'back-in-hub', number> = { hub: 120, podium: 60, 'back-in-hub': 120 }
const MAX_MATCH_S = 600
const MAX_FRAMES = 60 * 900
// The original clock: the multi-client run replaces performance.now with its virtual clock.
const realNow = performance.now.bind(performance)

function validateCapture(raw: unknown): { input: GameCaptureInput; moments: Moment[] } {
  const op = 'gameCapture'
  const o = obj(op, 'input', raw)
  onlyKeys(op, 'input', o, ['content', 'course', 'flow', 'clients', 'width', 'height', 'captureAt', 'reload', 'net'])
  const content = contentId(op, o.content)
  const course = o.course === undefined ? undefined : str(op, 'input.course', o.course, /^[a-z0-9-]{1,40}$/)
  const flow = o.flow as GameCaptureInput['flow']
  if (!Object.hasOwn(FLOW_MOMENTS, String(flow))) refuse('ops', `${op}.input.flow`, `is ${JSON.stringify(o.flow)}; choose match, hub, podium or tour`)
  const clients = o.clients as 1 | 2 | 4
  if (clients !== 1 && clients !== 2 && clients !== 4) refuse('ops', `${op}.input.clients`, `is ${JSON.stringify(o.clients)}; choose 1, 2 or 4`)
  const width = int(op, 'input.width', o.width, 64, 3840)
  const height = int(op, 'input.height', o.height, 64, 2160)
  if (o.reload !== undefined && typeof o.reload !== 'boolean') refuse('ops', `${op}.input.reload`, `is ${JSON.stringify(o.reload)}; pass true or false`)
  let net: GameCaptureInput['net']
  if (o.net !== undefined) {
    const n = obj(op, 'input.net', o.net)
    onlyKeys(op, 'input.net', n, ['server', 'party'])
    if (n.party !== 2) refuse('ops', `${op}.input.net.party`, `is ${JSON.stringify(n.party)}; this op queues parties of 2`)
    net = { server: str(op, 'input.net.server', n.server, /^wss?:\/\/\S+$/), party: 2 }
  }
  if (clients > 1 && (course !== undefined || net !== undefined)) refuse('ops', `${op}.input.clients`, `${clients} clients play the in-page hub loop; drop course and net`)
  if (net !== undefined && course !== undefined) refuse('ops', `${op}.input.course`, 'plays in-page with bots; drop net or course')
  if (flow === 'podium' && (clients > 1 || net !== undefined)) refuse('ops', `${op}.input.flow`, 'podium shows content.podium() on one in-page client; use clients 1 without net')
  if (!Array.isArray(o.captureAt) || o.captureAt.length < 1 || o.captureAt.length > 16) refuse('ops', `${op}.input.captureAt`, 'is not an array of 1..16 moment names')
  const allowed = FLOW_MOMENTS[flow]
  const moments: Moment[] = []
  for (let i = 0; i < o.captureAt.length; i++) {
    const name: unknown = o.captureAt[i]
    const s = typeof name === 'string' ? /^match-(\d+(?:\.\d+)?)s$/.exec(name) : null
    const kind = (s !== null ? 'match' : name) as MomentKind
    const seconds = s !== null ? Number(s[1]) : 0
    const where = `${op}.input.captureAt/${i}`
    if (typeof name !== 'string' || !allowed.includes(kind)) {
      refuse('ops', where, `${JSON.stringify(name)} is not a moment of flow ${flow}; choose from ${allowed.map(k => (k === 'match' ? 'match-<s>s' : k)).join(', ')}`)
    }
    if (seconds > MAX_MATCH_S) refuse('ops', where, `${name} is past ${MAX_MATCH_S} s of match`)
    const frames = Math.round(seconds / DT)
    const prev = moments[moments.length - 1]
    if (prev !== undefined && (RANK[kind] < RANK[prev.kind] || (RANK[kind] === RANK[prev.kind] && (kind !== 'match' || frames <= prev.frames)))) {
      refuse('ops', where, `${name} is repeated or out of order; list moments in flow order (${allowed.join(', ')}), match seconds ascending`)
    }
    moments.push({ name, kind, frames })
  }
  return { input: { content, course, flow, clients, width, height, captureAt: o.captureAt as string[], reload: o.reload === true, net }, moments }
}

// The loading screen is DOM and cannot be read back, so its capture is a 2D drawing of the same progress.
function drawLoading(p: LoadProgress, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) refuse('ops', 'gameCapture.loading', 'no 2D canvas context to draw the loading capture; run the op in a browser with canvas 2D')
  ctx.fillStyle = '#1b0f2e'
  ctx.fillRect(0, 0, width, height)
  const bw = Math.round(width * 0.6)
  const bx = Math.round((width - bw) / 2)
  const by = Math.round(height * 0.55)
  const bh = Math.max(8, Math.round(height * 0.03))
  ctx.fillStyle = '#3a2560'
  ctx.fillRect(bx, by, bw, bh)
  ctx.fillStyle = '#ff6b9e'
  ctx.fillRect(bx, by, p.total > 0 ? Math.round((bw * Math.min(p.done, p.total)) / p.total) : 0, bh)
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.max(12, Math.round(height * 0.04))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(`Loading ${p.phase} ${p.done}/${p.total}`, width / 2, by - bh * 2)
  ctx.fillText(p.label, width / 2, by + bh * 3)
  return canvas
}

interface Run { R: RapierModule; input: GameCaptureInput; moments: Moment[]; prefix: string; note: Note; captures: SizedCapture[]; files: OpFile[] }

async function capture(run: Run, name: string, png: Uint8Array): Promise<void> {
  const rec = await record(run.prefix + name, png, run.files)
  run.captures.push({ ...rec, width: run.input.width, height: run.input.height })
  run.note(`captured ${run.prefix + name}`)
}

// One load (with the loading capture) and one pass of the flow on a fresh content instance.
async function runOnce(run: Run): Promise<{ content: GameContent; report: Report }> {
  const { input, moments, note } = run
  const loading = mountLoading(document.body)
  let shot: Promise<Uint8Array> | null = null
  let phase = ''
  note(`${run.prefix}load started (content ${input.content})`)
  let content: GameContent
  try {
    content = await loadContent(input.content, p => {
      loading.update(p)
      if (p.phase !== phase) note(`${run.prefix}load ${p.phase} ${p.done}/${p.total}`)
      phase = p.phase
      shot ??= pngBlob(drawLoading(p, input.width, input.height), 'gameCapture.loading')
    })
  } catch (e) {
    loading.fail(e instanceof Error ? e.message : String(e))
    throw e
  }
  loading.close()
  const report = content.report()
  note(`${run.prefix}load done`)
  if (moments[0]?.kind === 'loading') {
    if (shot === null) refuse('content', `${input.content}.load`, 'reported no progress; a content load reports at least one LoadProgress step')
    await capture(run, 'loading', await shot)
  }
  if (moments.every(m => m.kind === 'loading')) return { content, report }
  const course = input.course === undefined ? null : content.course(input.course)
  await playFlow(run, content, course)
  return { content, report }
}

async function playFlow(run: Run, content: GameContent, course: ResolvedCourse | null): Promise<void> {
  const { R, input, note } = run
  const pending = run.moments.filter(m => m.kind !== 'loading')
  const plan = planCanvases(input.width, input.height, input.clients)
  const canvases: HTMLCanvasElement[] = []
  const ports: RenderPort[] = []
  let driver: Driver | null = null
  let frame = 0
  const virtualNow = () => frame * DT * 1000
  const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
  let clockInstalled = false
  try {
    for (const cell of plan.cells) {
      const canvas = makeCanvas(cell.canvasWidth, cell.canvasHeight)
      canvases.push(canvas)
      ports.push(await makePort(content, canvas))
    }
    if (input.clients > 1) {
      // LoopbackRelay rate-limits on performance.now, so it shares the loop's virtual clock.
      Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: virtualNow })
      clockInstalled = true
      const tiles = plan.cells.map(c => ({ x: c.col * c.canvasWidth, y: c.row * c.canvasHeight, width: c.canvasWidth, height: c.canvasHeight }))
      driver = new MultiDriver(R, content, ports, tiles, input.width, input.height, virtualNow)
    } else if (input.net !== undefined) {
      driver = new NetDriver(R, content, ports[0], input.net.server, note)
    } else {
      const start = input.flow === 'tour' ? 'hub' : input.flow
      driver = new LocalDriver(R, content, ports[0], course, start, note)
    }
    // The relay runs on wall time; the in-page flows step a fixed 1/60 s per frame.
    const realTime = input.net !== undefined
    let last = realNow()
    let stage: Stage | null = null
    let stageFrames = 0
    let matchFrames = -1
    let index = 0
    while (index < pending.length) {
      if (++frame > MAX_FRAMES) refuse('ops', 'gameCapture', `did not reach ${run.prefix}${pending[index].name} within ${MAX_FRAMES} frames; inspect the flow events`)
      let dt = DT
      if (realTime) {
        await new Promise<void>(resolve => setTimeout(resolve, 16))
        const now = realNow()
        dt = Math.min(0.1, Math.max(0, now - last) / 1000)
        last = now
      } else if (frame % 60 === 0) await yieldToBrowser()
      const next = driver.frame(dt)
      if (next !== stage) {
        note(`${run.prefix}stage ${next}`)
        stage = next
        stageFrames = 0
      } else stageFrames++
      if (matchFrames >= 0) matchFrames++
      else if (stage === 'match') matchFrames = 0
      const m = pending[index]
      let hit = false
      if (m.kind === 'match') {
        if (stage === 'podium' || stage === 'back-in-hub') refuse('ops', `gameCapture.${m.name}`, `the match reached its podium after ${matchFrames} frames, before ${m.name}; pick an earlier second`)
        hit = stage === 'match' && matchFrames >= m.frames
      } else if (m.kind !== 'loading') hit = stage === m.kind && stageFrames >= SETTLE[m.kind]
      if (hit) {
        await capture(run, m.name, await driver.capture(run.prefix + m.name))
        index++
      }
      // The local hub queues once its moment (if any) is taken, as Enter does on game.html.
      const wants = pending[index]
      if (stage === 'hub' && stageFrames >= SETTLE.hub && wants !== undefined && wants.kind !== 'hub') driver.enqueue()
    }
    if (driver instanceof MultiDriver) for (const ev of driver.events) note(`${run.prefix}${ev.client} ${ev.state}`)
  } finally {
    try {
      driver?.dispose()
      for (const port of ports) port.dispose()
    } finally {
      for (const canvas of canvases) canvas.remove()
      if (clockInstalled) {
        if (originalNow) Object.defineProperty(performance, 'now', originalNow)
        else Reflect.deleteProperty(performance, 'now')
      }
    }
  }
}

async function gameCapture(raw: unknown): Promise<OpResult<GameCaptureOutput>> {
  const { input, moments } = validateCapture(raw)
  const { R, adapter } = await prelude()
  const t0 = realNow()
  const events: GameEvent[] = []
  const note: Note = what => events.push({ t: Math.round(realNow() - t0) / 1000, what })
  const captures: SizedCapture[] = []
  const files: OpFile[] = []
  const reports: Report[] = []
  let content: GameContent | null = null
  // reload: a second load in the same page, so the cache layers of the first one answer it.
  for (const prefix of input.reload === true ? ['', 'reload-'] : ['']) {
    const out = await runOnce({ R, input, moments, prefix, note, captures, files })
    content = out.content
    reports.push(out.report)
  }
  if (content === null) return refuse('ops', 'gameCapture', 'no run happened')
  return {
    json: {
      renderer: 'raa', adapter, software: adapter.software, pageRef: pageRef(), captures, frameTiming: null,
      content: content.id, courses: content.playlist().map(c => c.id), events, report: reports[reports.length - 1], reports,
    },
    files,
  }
}

type GameOps = {
  controlsProbe(input: unknown): Promise<OpResult<ControlsOutput>>
  gameCapture(input: unknown): Promise<OpResult<GameCaptureOutput>>
  uiTour(input: unknown): Promise<OpResult<UiTourOutput>>
}

// window.nmcGpu.ops.controlsProbe / gameCapture / uiTour, next to the client page's ops. Registering has no
// side effect: the first op call runs teardown (the page's App) first; every op but uiTour (the real App,
// on the core adapter) also prefers the compatibility adapter. bootGame starts the App for uiTour.
export function installGameOps(teardown: () => void, bootGame: BootGame): void {
  installNmcOps()
  const gpu = window.nmcGpu as NonNullable<Window['nmcGpu']> & { ops: GameOps }
  let taken = false
  const take = (): void => {
    if (taken) return
    taken = true
    teardown()
  }
  let prepared = false
  const prepare = (): void => {
    if (!prepared) preferCompatibilityAdapter()
    prepared = true
    take()
  }
  const { roundCapture, frameTiming } = gpu.ops
  gpu.ops.roundCapture = input => (prepare(), roundCapture(input))
  gpu.ops.frameTiming = input => (prepare(), frameTiming(input))
  gpu.ops.controlsProbe = input => (prepare(), controlsProbe(input))
  gpu.ops.gameCapture = input => (prepare(), gameCapture(input))
  gpu.ops.uiTour = input => (take(), uiTour(input, { boot: bootGame, adapter: adapterInfo }))
  installZoneOps()
  installZoneLobbyOps()
  installSplitOps()
}
