// Binds a MatchSim to a RenderPort: bean, obstacle and mechanism instances and the follow camera.
// View side only: reads the sim view API and the smoother, never writes either.
import { courseFrame, roundReady } from './roundLoad.ts'
import type { CorrectionSmoother } from '@gamesaloon/rollback'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { CharacterView, MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { BodyRef } from '@royal-fiesta/sim/mechanismSpec'
import { pose } from '@royal-fiesta/sim/vec'
import { CHAR, CharMode } from '@royal-fiesta/sim/character/constants'
import type { AnimDriver, CharacterObservation, CharacterPose } from '../anim/driver.ts'
import { NO_DRESSING } from '../content.ts'
import type { CourseDressing } from '../content.ts'
import { followCamera } from './camera.ts'
import { PALETTE, seatTint } from './palette.ts'
import type { CameraPose, QuatT, RenderPort, SkinnedAssetT, SkinRigT, Vec3T } from './port.ts'

// Visual IK inputs, read from this tick's sim state only: the capsule's foot contact while grounded, the
// grab reach point in front while grabbing, and a forward look target. Copies, so the sim is never shared.
export function ikInputs(c: CharacterView, grounded: boolean): Pick<CharacterObservation, 'xf' | 'ik'> {
  const pos = { x: c.pos.x, y: c.pos.y, z: c.pos.z }, f = { x: c.facing.x, z: c.facing.z }
  const ahead = (d: number) => ({ x: pos.x + f.x * d, y: pos.y, z: pos.z + f.z * d })
  return {
    xf: { pos, facing: f },
    ik: {
      mode: c.mode,
      ground: grounded ? { point: { x: pos.x, y: pos.y - CHAR.halfHeight - CHAR.radius, z: pos.z }, normal: { x: 0, y: 1, z: 0 } } : null,
      grab: c.mode === CharMode.grabbing ? ahead(CHAR.grabRange) : null,
      look: f.x === 0 && f.z === 0 ? null : ahead(10),
    },
  }
}

// S16 attach points the costumes mount on: the penguin hat, scarf and suit use head, neck and body.
export type CostumeSlot = 'head' | 'neck' | 'body'
// A rigid raa.prims costume. `scale` inflates it about its anchor (default 1) and the asset's anchor of the
// same name places its geometry in the character's rest space.
export interface CostumeSpec { readonly asset: PrimsAsset; readonly scale?: number }
export type CostumeSet = Partial<Record<CostumeSlot, CostumeSpec | null>>

export interface SceneViewOptions {
  port: RenderPort; viewport: number; localPlayer: number; assets: (name: string) => PrimsAsset; bean: PrimsAsset
  // Replaces followCamera while the camera frames the local player (not the podium).
  camera?: (focus: { x: number; y: number; z: number }, frameDtS: number) => CameraPose
  // The content's character asset (GameContent.character()); the bean when absent.
  character?: PrimsAsset
  // Course decor and environment, swapped on every course change. Default NO_DRESSING.
  dressing?: CourseDressing
  // Prepared local scenes build behind the menu, without a loading paint.
  loadingPaint?: boolean
  // The skinned character (S18): its raa-sdfm skin, registered under assetId, and the S19 graph JSON that
  // poses it from the skin's rig and clips. Ports without skinning keep the rigid character.
  skinned?: SkinnedCharacter
  // Costumes worn by every character, by rig attach slot; the wardrobe hook replaces them per character.
  costumes?: CostumeSet
  wardrobe?: (player: number) => CostumeSet | null | undefined
}

export interface SkinnedCharacter { assetId: string; skin: SkinnedAssetT; graph: string }

const UNIT: readonly [number, number, number] = [1, 1, 1]
// registerSkinned uploads the skinned meshes, so each port registers a skinned asset once for all its views.
const skinnedHandles = new WeakMap<RenderPort, Map<string, number>>()

// View-side tick flow: each sim's step is wrapped once, so every tick it runs (several may run before one
// update()) reaches the views observing it right after it completes. Observers only read the sim view API.
type StepObserver = (sim: MatchSim) => void
const stepObservers = new WeakMap<MatchSim, Set<StepObserver>>()
function observeSteps(sim: MatchSim, observer: StepObserver): () => void {
  let observers = stepObservers.get(sim)
  if (observers === undefined) {
    const set = new Set<StepObserver>()
    const step = sim.step.bind(sim)
    sim.step = inputs => {
      step(inputs)
      for (const o of set) o(sim)
    }
    stepObservers.set(sim, set)
    observers = set
  }
  const own = observers
  own.add(observer)
  return () => { own.delete(observer) }
}
// Pose layout in the obstacle buffers: t xyz then r xyzw.
const OB = 7

function interpolatePose(prev: Float64Array, cur: Float64Array, b: number, alpha: number,
  t: [number, number, number], r: [number, number, number, number]): void {
  for (let k = 0; k < 3; k++) t[k] = prev[b + k] + (cur[b + k] - prev[b + k]) * alpha
  // nlerp along the shorter arc.
  const dot = prev[b + 3] * cur[b + 3] + prev[b + 4] * cur[b + 4] + prev[b + 5] * cur[b + 5] + prev[b + 6] * cur[b + 6]
  const sign = dot < 0 ? -1 : 1
  let n = 0
  for (let k = 0; k < 4; k++) {
    const a = prev[b + 3 + k]
    r[k] = a + (cur[b + 3 + k] * sign - a) * alpha
    n += r[k] * r[k]
  }
  n = Math.sqrt(n)
  for (let k = 0; k < 4; k++) r[k] /= n
}

interface MechanismInstance {
  instance: number
  ref: BodyRef
  // Where the whole asset draws at rest: the item's `place` (course items, whose t/r are identity) or its pose.
  placeT: Vec3T
  placeR: QuatT
  // The body rest in world space (item pose * body rest), the frame the sim reports body poses in.
  restT: Vec3T
  restR: QuatT
  restInvR: QuatT
  fixed: boolean
  s: Vec3T
  prev: Float64Array
  cur: Float64Array
}

// ---- costume attachment math ---------------------------------------------------------------------------
// The rig as the SDF Modeler asset carries it: S16 bones with rest TRS and named attach points (in bone space).
interface BoneRestT { readonly t: readonly number[]; readonly r: readonly number[]; readonly s: readonly number[] }
interface RigBoneT { readonly name: string; readonly parent: string | null; readonly rest?: BoneRestT }
interface AttachPointT { readonly bone: string; readonly t: readonly number[]; readonly r: readonly number[] }
interface CostumeRigT { readonly attach?: Readonly<Record<string, AttachPointT>>; readonly bones: readonly RigBoneT[] }
interface AnchorT { readonly t: readonly number[]; readonly r: readonly number[] }
interface LocalCostume { readonly t: readonly [number, number, number]; readonly r: readonly [number, number, number, number]; readonly s: readonly [number, number, number] }
const COSTUME_SLOTS: readonly CostumeSlot[] = ['head', 'neck', 'body']
const UNIT_QUAT: readonly [number, number, number, number] = [0, 0, 0, 1]

function mat4(t: readonly number[], q: readonly number[], s: readonly number[]): Float32Array {
  const [x, y, z, w] = q
  return new Float32Array([
    (1 - 2 * y * y - 2 * z * z) * s[0], (2 * x * y + 2 * z * w) * s[0], (2 * x * z - 2 * y * w) * s[0], 0,
    (2 * x * y - 2 * z * w) * s[1], (1 - 2 * x * x - 2 * z * z) * s[1], (2 * y * z + 2 * x * w) * s[1], 0,
    (2 * x * z + 2 * y * w) * s[2], (2 * y * z - 2 * x * w) * s[2], (1 - 2 * x * x - 2 * y * y) * s[2], 0,
    t[0], t[1], t[2], 1,
  ])
}

// Column-major a * b, matching the S16 model layout the driver reports.
function mul4(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  }
  return out
}

function conjugate(q: readonly number[]): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]]
}

function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

function quatRotate(q: readonly number[], v: readonly number[]): [number, number, number] {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0])
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ]
}

// The closest rigid rotation of a matrix (polar decomposition): clips squash the root, and a rigid hat
// follows the head's rotation and position instead of inheriting a non-uniform scale it cannot represent.
function rigidRotation(m: ArrayLike<number>): [number, number, number, number] {
  let a00 = m[0], a10 = m[1], a20 = m[2]
  let a01 = m[4], a11 = m[5], a21 = m[6]
  let a02 = m[8], a12 = m[9], a22 = m[10]
  for (let i = 0; i < 8; i++) {
    const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20)
    if (!(Math.abs(det) > 1e-12)) break
    const d = 1 / det
    const b00 = (a11 * a22 - a12 * a21) * d, b01 = (a02 * a21 - a01 * a22) * d, b02 = (a01 * a12 - a02 * a11) * d
    const b10 = (a12 * a20 - a10 * a22) * d, b11 = (a00 * a22 - a02 * a20) * d, b12 = (a02 * a10 - a00 * a12) * d
    const b20 = (a10 * a21 - a11 * a20) * d, b21 = (a01 * a20 - a00 * a21) * d, b22 = (a00 * a11 - a01 * a10) * d
    a00 = 0.5 * (a00 + b00); a10 = 0.5 * (a10 + b01); a20 = 0.5 * (a20 + b02)
    a01 = 0.5 * (a01 + b10); a11 = 0.5 * (a11 + b11); a21 = 0.5 * (a21 + b12)
    a02 = 0.5 * (a02 + b20); a12 = 0.5 * (a12 + b21); a22 = 0.5 * (a22 + b22)
  }
  const sx = Math.hypot(a00, a10, a20) || 1
  const sy = Math.hypot(a01, a11, a21) || 1
  const sz = Math.hypot(a02, a12, a22) || 1
  const m00 = a00 / sx, m10 = a10 / sx, m20 = a20 / sx
  const m01 = a01 / sy, m11 = a11 / sy, m21 = a21 / sy
  const m02 = a02 / sz, m12 = a12 / sz, m22 = a22 / sz
  const trace = m00 + m11 + m22
  let x: number, y: number, z: number, w: number
  if (trace > 0) {
    const k = Math.sqrt(trace + 1) * 2
    w = 0.25 * k; x = (m21 - m12) / k; y = (m02 - m20) / k; z = (m10 - m01) / k
  } else if (m00 > m11 && m00 > m22) {
    const k = Math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / k; x = 0.25 * k; y = (m01 + m10) / k; z = (m02 + m20) / k
  } else if (m11 > m22) {
    const k = Math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / k; x = (m01 + m10) / k; y = 0.25 * k; z = (m12 + m21) / k
  } else {
    const k = Math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / k; x = (m02 + m20) / k; y = (m12 + m21) / k; z = 0.25 * k
  }
  const n = Math.hypot(x, y, z, w) || 1
  return [x / n, y / n, z / n, w / n]
}

// Character-space placement of a rigid costume: the attachment's position, the bone's rigid rotation and the
// costume's own scale (S16 bone squash never stretches a rigid prop).
function decompose(m: ArrayLike<number>): LocalCostume {
  return { t: [m[12], m[13], m[14]], r: rigidRotation(m), s: [1, 1, 1] }
}

// Rest bone models in rig space, before any clip poses them (S16 model = parent model * TRS(rest)).
function restBoneModels(bones: readonly RigBoneT[]): { models: Float32Array<ArrayBuffer>; index: Map<string, number> } {
  const index = new Map<string, number>()
  bones.forEach((bone, i) => index.set(bone.name, i))
  const models = new Float32Array(bones.length * 16)
  bones.forEach((bone, i) => {
    const rest = bone.rest ?? { t: [0, 0, 0], r: UNIT_QUAT, s: [1, 1, 1] }
    const local = mat4(rest.t, rest.r, rest.s)
    const parent = bone.parent === null ? -1 : index.get(bone.parent) ?? -1
    models.set(parent < 0 ? local : mul4(models.subarray(parent * 16, parent * 16 + 16), local), i * 16)
  })
  return { models, index }
}

// The costume's transform in character space: posed bone model * attach frame * costume scale * inverse
// costume anchor. The attachment offset is the rig's, never a skin matrix (skin already maps rest geometry);
// scaling in the anchor frame keeps the costume seated while it clears the body mesh.
function costumeLocal(model: ArrayLike<number>, attach: AttachPointT | undefined, anchor: AnchorT | undefined, scale: number): LocalCostume {
  const t = attach?.t ?? anchor?.t ?? [0, 0, 0]
  const r = attach?.r ?? anchor?.r ?? UNIT_QUAT
  const ax = anchor?.t ?? [0, 0, 0]
  const ar = anchor?.r ?? UNIT_QUAT
  const fitted = mul4(mat4([0, 0, 0], UNIT_QUAT, [scale, scale, scale]), mat4([-ax[0], -ax[1], -ax[2]], conjugate(ar), [1, 1, 1]))
  return decompose(mul4(mul4(model, mat4(t, r, [1, 1, 1])), fitted))
}

const IDENTITY4 = mat4([0, 0, 0], UNIT_QUAT, [1, 1, 1])

interface WornCostume { spec: CostumeSpec; instance: number }

export class SceneView {
  private readonly opts: SceneViewOptions
  private readonly port: RenderPort
  private readonly beanAsset: number
  private readonly dressing: CourseDressing
  // Course id whose dressing is entered, so leave() pairs with exactly one enter().
  private dressed: string | null = null
  // registerAsset is idempotent, but the handle is cached so each name is registered once.
  private readonly handles = new Map<string, number>()
  private beans: number[] = []
  private beanShown: boolean[] = []
  private obstacles: number[] = []
  private mechanisms: MechanismInstance[] = []
  private course: ResolvedCourse | null = null
  private ci = -1
  private tick = -1
  private obPrev = new Float64Array(0)
  private obCur = new Float64Array(0)
  private chPrev = new Float64Array(0)
  private chCur = new Float64Array(0)
  private facing = new Float64Array(0)
  private cam: CameraPose | null = null
  private readonly state: MatchViewState = {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null, final: false, courseIndex: -1,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
  private readonly view: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: -1,
  }
  private readonly pose = pose()
  private readonly shown = new Float64Array(3)
  // One graph per character, owned with the character instances; null until its brick has loaded.
  private readonly skinned: SkinnedCharacter | null = null
  // Rig attach points and rest bone models; costumes draw at rest until the graph has a pose.
  private attach: Readonly<Record<string, AttachPointT>> = {}
  private restModels = new Float32Array(0)
  private boneIndex = new Map<string, number>()
  // Per character costume selection; setCostume writes one slot, createBeans materialises the instances.
  private readonly costumeOverrides = new Map<number, CostumeSet | null>()
  private worn: Partial<Record<CostumeSlot, WornCostume>>[] = []
  private anim: AnimDriver | null = null
  // Bumped whenever the instances go, so a driver that resolves late is disposed instead of adopted.
  private animGen = 0
  private animError: unknown = null
  private animLoading: Promise<void> = Promise.resolve()
  // Per character: the pose last submitted to the port, so a frame never resubmits an unchanged tick.
  private posed: (CharacterPose | undefined)[] = []
  private readonly observed: CharacterObservation[] = []
  // The sim whose steps feed the graphs, and how to stop observing it.
  private stepSim: MatchSim | null = null
  private unobserve: (() => void) | null = null
  private readonly onStep: StepObserver = sim => this.observeTick(sim)

  constructor(opts: SceneViewOptions) {
    this.opts = opts
    this.port = opts.port
    this.dressing = opts.dressing ?? NO_DRESSING
    const skinned = opts.skinned
    const handle = skinned === undefined ? undefined : this.skinnedAsset(skinned)
    if (handle !== undefined) {
      this.beanAsset = handle
      this.skinned = skinned!
      this.readRig(skinned!.skin.rig)
    } else {
      const character = opts.character ?? opts.bean
      this.beanAsset = this.asset(character.id, character)
    }
  }

  // The port's handle of the skinned character, or undefined when the port cannot skin or refuses this skin.
  private skinnedAsset(skinned: SkinnedCharacter): number | undefined {
    const port = this.port
    if (port.registerSkinned === undefined || port.setPose === undefined) return undefined
    let handles = skinnedHandles.get(port)
    if (handles === undefined) skinnedHandles.set(port, handles = new Map())
    let h = handles.get(skinned.assetId)
    if (h === undefined) {
      try {
        h = port.registerSkinned(skinned.assetId, skinned.skin)
      } catch (error) {
        this.animError = error
        console.error(`[scene] ${skinned.assetId} cannot be skinned; characters keep the rigid asset`, error)
        return undefined
      }
      handles.set(skinned.assetId, h)
    }
    return h
  }

  private readRig(rig: SkinRigT): void {
    const full = rig as CostumeRigT
    this.attach = full.attach ?? {}
    const rest = restBoneModels(full.bones)
    this.restModels = rest.models
    this.boneIndex = rest.index
  }

  // Why the characters draw at rest: the animation brick or graph failed to load (null otherwise).
  get animationError(): unknown {
    return this.animError
  }

  /** Settles once the last requested animation load finished (loaded, failed or superseded). */
  animationReady(): Promise<void> {
    return this.animLoading
  }

  get camera(): CameraPose | null {
    return this.cam
  }

  get instanceCount(): number {
    return this.beans.length + this.obstacles.length + this.mechanisms.length
  }

  get mechanismInstanceCount(): number {
    return this.mechanisms.length
  }

  get courseIndex(): number {
    return this.ci
  }

  update(sim: MatchSim, smoother: CorrectionSmoother | null, alpha: number, frameDtS: number): void {
    const port = this.port
    this.ci = sim.phase(this.state).courseIndex
    const course = sim.course()
    let reset = false
    if (course !== this.course) {
      if (this.opts.loadingPaint !== false && !roundReady(port, course?.id ?? 'round')) return
      courseFrame(sim, port, course?.id ?? 'round', () => {
        this.loadObstacles(sim, course)
        this.dress(course)
        if (this.beans.length === 0) this.createBeans(sim.setup.playerCount)
      })
      reset = true
    }
    const players = sim.setup.playerCount
    if (this.beans.length === 0) this.createBeans(players)
    if (this.skinned !== null && sim !== this.stepSim) this.follow(sim, this.skinned)

    const tick = sim.tick
    const advanced = tick !== this.tick
    if (advanced || reset) {
      this.readObstacles(sim, advanced && !reset)
      this.readCharacters(sim, advanced && !reset, tick)
      this.tick = tick
    }
    this.observeTick(sim)

    const t: [number, number, number] = [0, 0, 0]
    const r: [number, number, number, number] = [0, 0, 0, 1]
    const prev = this.obPrev
    const cur = this.obCur
    for (let i = 0; i < this.obstacles.length; i++) {
      const b = i * OB
      interpolatePose(prev, cur, b, alpha, t, r)
      const s = this.course!.obstacles[i].s
      port.setTransform(this.obstacles[i], t, r, [s.x, s.y, s.z])
    }
    for (const body of this.mechanisms) {
      if (body.fixed) {
        port.setTransform(body.instance, body.placeT, body.placeR, body.s)
        continue
      }
      interpolatePose(body.prev, body.cur, 0, alpha, t, r)
      // The placement carries the asset; the body's motion since rest (pose * inverse world rest) moves it.
      const motion = quatMul(r, body.restInvR)
      const arm = quatRotate(motion, [body.placeT[0] - body.restT[0], body.placeT[1] - body.restT[1], body.placeT[2] - body.restT[2]])
      port.setTransform(body.instance, [t[0] + arm[0], t[1] + arm[1], t[2] + arm[2]], quatMul(motion, body.placeR), body.s)
    }

    const c = this.view
    const d = this.shown
    const local = this.opts.localPlayer
    let camPos: { x: number; y: number; z: number } | null = null
    let camFacing = { x: 0, z: 1 }
    let onLocal = false
    for (let p = 0; p < players; p++) {
      sim.character(p, c)
      if (c.parked) {
        this.show(p, false)
        continue
      }
      this.show(p, true)
      const b = p * 3
      for (let k = 0; k < 3; k++) d[k] = this.chPrev[b + k] + (this.chCur[b + k] - this.chPrev[b + k]) * alpha
      if (smoother !== null) smoother.applyEntity(p, d)
      const fx = this.facing[p * 2]
      const fz = this.facing[p * 2 + 1]
      const half = Math.atan2(fx, fz) / 2
      port.setTransform(this.beans[p], [d[0], d[1], d[2]], [0, Math.sin(half), 0, Math.cos(half)], UNIT)
      // Submits the pose retained for the last observed tick; reading it never steps the graph.
      const posed = this.anim?.pose(p)
      if (posed !== undefined && posed !== this.posed[p]) {
        port.setPose!(this.beans[p], posed.skin)
        this.posed[p] = posed
      }
      this.placeCostumes(p, d, fx, fz, posed)
      if (p === local) {
        camPos = { x: d[0], y: d[1], z: d[2] }
        camFacing = { x: fx, z: fz }
        onLocal = true
      }
    }
    // The podium freezes the winners and parks the rest, so the local player may have no camera:
    // frame the podium itself or the capture is the void.
    if (this.state.phase === Phase.podium && this.state.podium.length > 0) {
      let px = 0
      let py = 0
      let pz = 0
      for (let i = 0; i < this.state.podium.length; i++) {
        const b = this.state.podium[i] * 3
        px += this.chCur[b]
        py += this.chCur[b + 1]
        pz += this.chCur[b + 2]
      }
      const n = this.state.podium.length
      camPos = { x: px / n, y: py / n, z: pz / n }
      camFacing = { x: 0, z: 1 }
      onLocal = false
    }
    if (camPos !== null) {
      const hook = this.opts.camera
      this.cam = hook !== undefined && onLocal ? hook(camPos, frameDtS) : followCamera(this.cam, camPos, camFacing, frameDtS)
      port.setCamera(this.opts.viewport, this.cam)
    }
  }

  /**
   * Steps every character graph once with the sim's current tick. The view calls it after each step of
   * the sim it updates from, and update() observes the latest tick itself; a tick already observed is
   * ignored (rendering never steps), and ticks run before the graphs loaded are not replayed.
   */
  observeTick(sim: MatchSim): void {
    const anim = this.anim
    const tick = sim.tick
    if (anim === null || tick <= anim.observedTick) return
    const c = this.view
    const out = this.observed
    out.length = 0
    for (let p = 0; p < this.beans.length; p++) {
      sim.character(p, c)
      // A parked character leaves: the driver frees its graph and a return starts a fresh one.
      if (c.parked) continue
      // Matches carry no S9 emote; grounded is every mode but the airborne ones.
      const grounded = c.mode !== CharMode.air && c.mode !== CharMode.dive
      out.push({ id: p, mode: c.mode, vel: { x: c.vel.x, y: c.vel.y, z: c.vel.z }, grounded, emote: 0, ...ikInputs(c, grounded) })
    }
    anim.observeTick(tick, out)
  }

  dispose(): void {
    this.unobserve?.()
    this.unobserve = null
    this.stepSim = null
    this.animGen++
    this.anim?.dispose()
    this.anim = null
    this.posed = []
    for (const worn of this.worn) {
      for (const slot of COSTUME_SLOTS) {
        const w = worn[slot]
        if (w !== undefined) this.port.destroyInstance(w.instance)
      }
    }
    this.worn = []
    for (let i = 0; i < this.beans.length; i++) this.port.destroyInstance(this.beans[i])
    for (let i = 0; i < this.obstacles.length; i++) this.port.destroyInstance(this.obstacles[i])
    this.destroyMechanisms()
    this.beans = []
    this.beanShown = []
    this.obstacles = []
    this.dress(null)
    this.course = null
    this.tick = -1
  }

  private asset(name: string, a: PrimsAsset): number {
    let h = this.handles.get(name)
    if (h === undefined) {
      h = this.port.registerAsset(name, a)
      this.handles.set(name, h)
    }
    return h
  }

  private loadObstacles(sim: MatchSim, course: ResolvedCourse | null): void {
    for (let i = 0; i < this.obstacles.length; i++) this.port.destroyInstance(this.obstacles[i])
    this.destroyMechanisms()
    this.obstacles = []
    this.course = course
    const n = course === null ? 0 : sim.obstacleCount()
    for (let i = 0; i < n; i++) {
      const spec = sim.obstacleSpec(i)
      this.obstacles.push(this.port.createInstance(this.asset(spec.asset, this.opts.assets(spec.asset)), null))
    }
    this.obPrev = new Float64Array(n * OB)
    this.obCur = new Float64Array(n * OB)
    const port = this.port as RenderPort & { setPartFilter?: (instance: number, parts: readonly string[] | null) => void }
    for (let i = 0; i < sim.mechanismItemCount(); i++) {
      const item = sim.mechanismItem(i)
      const asset = this.asset(item.asset, this.opts.assets(item.asset))
      for (let b = 0; b < item.bodies.length; b++) {
        const body = item.bodies[b]
        const instance = port.createInstance(asset, null)
        const itemR: QuatT = [item.r.x, item.r.y, item.r.z, item.r.w]
        const local = quatRotate(itemR, [body.rest.t.x, body.rest.t.y, body.rest.t.z])
        const restR = quatMul(itemR, [body.rest.r.x, body.rest.r.y, body.rest.r.z, body.rest.r.w])
        const place = item.place ?? item
        this.mechanisms.push({
          instance, ref: { item: i, body: b },
          placeT: [place.t.x, place.t.y, place.t.z], placeR: [place.r.x, place.r.y, place.r.z, place.r.w],
          restT: [item.t.x + local[0], item.t.y + local[1], item.t.z + local[2]], restR, restInvR: conjugate(restR),
          fixed: body.type === 'fixed',
          s: [item.s.x, item.s.y, item.s.z], prev: new Float64Array(OB), cur: new Float64Array(OB),
        })
        if (typeof port.setPartFilter === 'function') port.setPartFilter(instance, body.parts ?? null)
        else if (b > 0) port.setVisible(instance, false)
      }
    }
  }

  private destroyMechanisms(): void {
    for (let i = this.mechanisms.length - 1; i >= 0; i--) this.port.destroyInstance(this.mechanisms[i].instance)
    this.mechanisms = []
  }

  private dress(course: ResolvedCourse | null): void {
    if (this.dressed !== null) this.dressing.leave(this.port)
    this.dressed = null
    if (course === null) return
    this.dressing.enter(this.port, course.id)
    this.dressed = course.id
  }

  private createBeans(players: number): void {
    for (let p = 0; p < players; p++) {
      this.beans.push(this.port.createInstance(this.beanAsset, seatTint(p)))
      this.beanShown.push(true)
    }
    this.chPrev = new Float64Array(players * 3)
    this.chCur = new Float64Array(players * 3)
    this.facing = new Float64Array(players * 2)
    this.worn = Array.from({ length: players }, () => ({}))
    for (let p = 0; p < players; p++) this.syncCostumes(p, true)
    if (this.skinned !== null) this.loadAnim(this.skinned)
  }

  // The brick loads asynchronously (and only for skinned scenes); characters draw at rest meanwhile.
  private loadAnim(skinned: SkinnedCharacter): void {
    const gen = ++this.animGen
    // The SDF Modeler rig extension (bindings, smooth) is not part of the S16 rig the graph reads.
    const { bindings: _b, smooth: _s, ...rig } = skinned.skin.rig as SkinnedAssetT['rig'] & { bindings?: unknown; smooth?: unknown }
    const clips = (skinned.skin.clips ?? []).map(clip => JSON.stringify(clip))
    this.animLoading = import('../anim/driver.ts').then(m => m.AnimDriver.load(skinned.graph, JSON.stringify(rig), clips)).then(driver => {
      if (gen === this.animGen) this.anim = driver
      else driver.dispose()
    }, (error: unknown) => {
      if (gen !== this.animGen) return
      this.animError = error
      console.error(`[scene] ${skinned.assetId} animation unavailable; characters draw at rest`, error)
    })
  }

  // Observes every step of sim from now on. A different sim is a new timeline: its graphs start fresh.
  private follow(sim: MatchSim, skinned: SkinnedCharacter): void {
    if (this.stepSim !== null) {
      this.anim?.dispose()
      this.anim = null
      this.posed = []
      this.loadAnim(skinned)
    }
    this.unobserve?.()
    this.unobserve = observeSteps(sim, this.onStep)
    this.stepSim = sim
  }

  // keep = false after a course change: prev = cur, so nothing is interpolated across the reset.
  private readObstacles(sim: MatchSim, keep: boolean): void {
    if (keep) {
      // The old cur becomes prev; the old prev buffer is reused for the new cur.
      const t = this.obPrev
      this.obPrev = this.obCur
      this.obCur = t
    }
    const prev = this.obPrev
    const cur = this.obCur
    const q = this.pose
    for (let i = 0; i < this.obstacles.length; i++) {
      const b = i * OB
      sim.obstaclePose(i, q)
      cur[b] = q.t.x
      cur[b + 1] = q.t.y
      cur[b + 2] = q.t.z
      cur[b + 3] = q.r.x
      cur[b + 4] = q.r.y
      cur[b + 5] = q.r.z
      cur[b + 6] = q.r.w
      if (!keep) for (let k = 0; k < OB; k++) prev[b + k] = cur[b + k]
    }
    for (const body of this.mechanisms) {
      if (keep) [body.prev, body.cur] = [body.cur, body.prev]
      if (sim.mechanismBodyPose(body.ref, q)) body.cur.set([q.t.x, q.t.y, q.t.z, q.r.x, q.r.y, q.r.z, q.r.w])
      else body.cur.set([body.restT[0], body.restT[1], body.restT[2], body.restR[0], body.restR[1], body.restR[2], body.restR[3]])
      if (!keep) body.prev.set(body.cur)
    }
  }

  private readCharacters(sim: MatchSim, keep: boolean, tick: number): void {
    const c = this.view
    for (let p = 0; p < this.beans.length; p++) {
      sim.character(p, c)
      const b = p * 3
      const fresh = !keep || c.teleportTick >= tick - 2
      if (!fresh) {
        this.chPrev[b] = this.chCur[b]
        this.chPrev[b + 1] = this.chCur[b + 1]
        this.chPrev[b + 2] = this.chCur[b + 2]
      }
      this.chCur[b] = c.pos.x
      this.chCur[b + 1] = c.pos.y
      this.chCur[b + 2] = c.pos.z
      if (fresh) {
        this.chPrev[b] = c.pos.x
        this.chPrev[b + 1] = c.pos.y
        this.chPrev[b + 2] = c.pos.z
      }
      this.facing[p * 2] = c.facing.x
      this.facing[p * 2 + 1] = c.facing.z
    }
  }

  private show(p: number, visible: boolean): void {
    if (this.beanShown[p] === visible) return
    this.port.setVisible(this.beans[p], visible)
    this.beanShown[p] = visible
    const worn = this.worn[p]
    if (worn !== undefined) {
      for (const slot of COSTUME_SLOTS) {
        const w = worn[slot]
        if (w !== undefined) this.port.setVisible(w.instance, visible)
      }
    }
  }

  /** Selects the costume in one rig slot for a character, or removes it with null. */
  setCostume(player: number, slot: CostumeSlot, costume: CostumeSpec | null): void {
    const base = this.selectionFor(player) ?? {}
    const next: CostumeSet = { ...base }
    if (costume === null) delete next[slot]
    else next[slot] = costume
    this.costumeOverrides.set(player, next)
    if (player >= 0 && player < this.beans.length) this.syncCostumes(player, this.beanShown[player] === true)
  }

  /** Takes the costume off one rig slot, keeping the others. */
  removeCostume(player: number, slot: CostumeSlot): void {
    this.setCostume(player, slot, null)
  }

  private selectionFor(p: number): CostumeSet | null {
    if (this.costumeOverrides.has(p)) return this.costumeOverrides.get(p)!
    const hook = this.opts.wardrobe
    return (hook !== undefined ? hook(p) : this.opts.costumes) ?? null
  }

  // One port instance per worn costume; a replaced or removed slot gives its instance back.
  private syncCostumes(p: number, visible: boolean): void {
    const set = this.selectionFor(p)
    const worn = this.worn[p] ?? (this.worn[p] = {})
    for (const slot of COSTUME_SLOTS) {
      const spec = set?.[slot] ?? null
      const old = worn[slot]
      if (old !== undefined && (spec === null || old.spec.asset.id !== spec.asset.id)) {
        this.port.destroyInstance(old.instance)
        delete worn[slot]
      }
      if (spec === null) continue
      const live = worn[slot]
      if (live === undefined) {
        const instance = this.port.createInstance(this.asset(spec.asset.id, spec.asset), null)
        this.port.setVisible(instance, visible)
        worn[slot] = { spec, instance }
      } else {
        live.spec = spec
      }
    }
  }

  // Character placement * posed bone model * attach frame * inverse costume anchor, then the costume scale.
  private placeCostumes(p: number, d: Float64Array, fx: number, fz: number, posed: CharacterPose | undefined): void {
    const worn = this.worn[p]
    if (worn === undefined) return
    const half = Math.atan2(fx, fz) / 2
    const yaw: [number, number, number, number] = [0, Math.sin(half), 0, Math.cos(half)]
    for (const slot of COSTUME_SLOTS) {
      const w = worn[slot]
      if (w === undefined) continue
      const anchor = w.spec.asset.anchors[slot]
      const attach = this.attach[slot]
      const bone = attach === undefined ? undefined : this.boneIndex.get(attach.bone)
      const model = posed !== undefined && bone !== undefined && bone * 16 + 16 <= posed.model.length
        ? posed.model.subarray(bone * 16, bone * 16 + 16)
        : bone === undefined ? IDENTITY4 : this.restModels.subarray(bone * 16, bone * 16 + 16)
      const local = costumeLocal(model, attach, anchor as AnchorT | undefined, w.spec.scale ?? 1)
      const t = quatRotate(yaw, local.t)
      this.port.setTransform(w.instance,
        [d[0] + t[0], d[1] + t[1], d[2] + t[2]],
        quatMul(yaw, local.r),
        [local.s[0], local.s[1], local.s[2]])
    }
  }
}
