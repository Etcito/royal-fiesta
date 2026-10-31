// Procedural walk cycle for the penguin rig (view-side only: sin/cos, no frame time). Every
// stepWalk call is one sim tick; the pose is a pure function of that state.
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { PoseLayer, PoseLayerInstance } from './layers.ts'
import { GraphMode, graphMode, type CharObservation } from './params.ts'

export const WALK = Object.freeze({
  strideM: 0.9, runStrideM: 1.6, walkSpeed: 3, runSpeed: 8, idleBelow: 0.2,
  restFlipperDownRad: 1.2, flipperSwingRad: 0.7, runFlipperSwingRad: 1.1,
  legSwingRad: 0.55, swayRad: 0.1, bobM: 0.035, breathHz: 0.5,
} as const)

export interface WalkState { metres: number; phase: number; speed: number; ticks: number }

// stepWalk is the only place that sees a phase crossing, so the tick's footDown rides along with
// the state (not part of the public WalkState shape) and walkPose reports it.
type FootState = WalkState & { footDown?: -1 | 0 | 1 }

export interface WalkPose {
  phase: number; idle: number; walk: number; run: number
  flipperL: number; flipperR: number; legL: number; legR: number; sway: number; bob: number
  footDown: -1 | 0 | 1
}

export interface WalkBones { root: number; flipperL: number; flipperR: number; legL: number; legR: number; head: number }

const TAU = Math.PI * 2
const AIR_DECAY = 6
const IDLE_FLIPPER_RAD = 0.06

export function newWalkState(): WalkState {
  return { metres: 0, phase: 0, speed: 0, ticks: 0, footDown: 0 } as WalkState
}

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x)
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const fract = (x: number): number => x - Math.floor(x)

/** One sim tick (dt 1/60). Vel is world planar; air speed decays, ground speed follows the velocity. */
export function stepWalk(s: WalkState, vel: { x: number; y: number; z: number }, grounded: boolean): WalkState {
  const planar = Math.hypot(vel.x, vel.z)
  const speed = grounded ? planar : Math.max(0, s.speed - AIR_DECAY / 60)
  const run = smoothstep(WALK.walkSpeed, WALK.runSpeed, speed)
  const stride = WALK.strideM + (WALK.runStrideM - WALK.strideM) * run
  const total = s.phase + speed / 60 / stride
  let footDown: -1 | 0 | 1 = 0
  if (grounded && speed > WALK.idleBelow) {
    if (total >= 1) footDown = 1
    else if (s.phase < 0.5 && total >= 0.5) footDown = -1
  }
  s.metres += speed / 60
  s.phase = fract(total)
  s.speed = speed
  s.ticks += 1
  ;(s as FootState).footDown = footDown
  return s
}

/** The walk pose for a state. Angles are radians; the flipper fields are swing terms (rest down is applied by applyWalkPose). */
export function walkPose(s: WalkState, out?: WalkPose): WalkPose {
  const p = out ?? ({} as WalkPose)
  const v = s.speed
  const idle = 1 - smoothstep(WALK.idleBelow, WALK.walkSpeed * 0.5, v)
  const run = smoothstep(WALK.walkSpeed, WALK.runSpeed, v)
  const walk = 1 - idle - run
  const loco = walk + run
  const swing = Math.sin(TAU * s.phase)
  const breath = Math.sin(TAU * WALK.breathHz * (s.ticks / 60))
  const amp = WALK.flipperSwingRad + (WALK.runFlipperSwingRad - WALK.flipperSwingRad) * run
  p.phase = s.phase
  p.idle = idle
  p.walk = walk
  p.run = run
  p.flipperL = amp * swing * loco + idle * IDLE_FLIPPER_RAD * breath
  p.flipperR = -amp * swing * loco + idle * IDLE_FLIPPER_RAD * breath
  p.legL = -WALK.legSwingRad * swing * loco
  p.legR = WALK.legSwingRad * swing * loco
  p.sway = WALK.swayRad * swing * loco
  p.bob = WALK.bobM * Math.abs(swing) * loco + idle * WALK.bobM * 0.25 * breath
  p.footDown = (s as FootState).footDown ?? 0
  return p
}

/** Idle at phase 0: flippers are down (applyWalkPose adds restFlipperDownRad), never the T pose. */
export function restPose(out?: WalkPose): WalkPose {
  return walkPose(newWalkState(), out)
}

const WALK_BONE_NAMES = ['root', 'upper.l', 'upper.r', 'upperLeg.l', 'upperLeg.r', 'head'] as const

export function walkBones(boneNames: readonly string[]): WalkBones {
  const index = new Map<string, number>()
  boneNames.forEach((name, i) => { if (!index.has(name)) index.set(name, i) })
  const find = (name: string): number => {
    const i = index.get(name)
    if (i === undefined) refuse('anim', 'walkBones', `bone '${name}' missing; the rig must list all walk bones`)
    return i
  }
  const [root, flipperL, flipperR, legL, legR, head] = WALK_BONE_NAMES.map(find)
  return { root, flipperL, flipperR, legL, legR, head }
}

type Quat = [number, number, number, number]

const qAxis = (x: number, y: number, z: number, angle: number): Quat => {
  const h = angle / 2, s = Math.sin(h)
  return [x * s, y * s, z * s, Math.cos(h)]
}
const qMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
const qNorm = (q: Quat): Quat => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}
const DOWN_L = qAxis(0, 0, 1, -WALK.restFlipperDownRad)
const DOWN_R = qAxis(0, 0, 1, WALK.restFlipperDownRad)

/** Writes the walk pose into S17 local TRS (10 floats per bone: t xyz, r xyzw, s xyz). */
export function applyWalkPose(local: Float32Array, bones: WalkBones, pose: WalkPose): void {
  const write = (bone: number, q: Quat): void => {
    const n = qNorm(q), o = bone * 10 + 3
    local[o] = n[0]; local[o + 1] = n[1]; local[o + 2] = n[2]; local[o + 3] = n[3]
  }
  const r = bones.root * 10 + 3
  write(bones.root, qMul(qAxis(0, 0, 1, pose.sway), [local[r], local[r + 1], local[r + 2], local[r + 3]]))
  local[bones.root * 10 + 1] += pose.bob
  write(bones.flipperL, qMul(qAxis(1, 0, 0, pose.flipperL), DOWN_L))
  write(bones.flipperR, qMul(qAxis(1, 0, 0, pose.flipperR), DOWN_R))
  write(bones.legL, qAxis(1, 0, 0, pose.legL))
  write(bones.legR, qAxis(1, 0, 0, pose.legR))
}

// --- WALK_LAYER: the locomotion pose layer (registration card 1.13) ---

const WEIGHT_TICKS = 6

// Shortest-arc nlerp: the graph clip's rotation blends toward the walk rotation.
const qNlerp = (a: Quat, b: Quat, t: number): Quat => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const s = dot < 0 ? -1 : 1
  return qNorm([
    a[0] + (s * b[0] - a[0]) * t,
    a[1] + (s * b[1] - a[1]) * t,
    a[2] + (s * b[2] - a[2]) * t,
    a[3] + (s * b[3] - a[3]) * t,
  ])
}

export interface WalkLayerInstance extends PoseLayerInstance {
  readonly footDown: -1 | 0 | 1
  readonly state: WalkState
}

interface WalkLayerFactory extends PoseLayer {
  create(boneNames: readonly string[]): WalkLayerInstance
}

class WalkLayer implements WalkLayerInstance {
  private walk: WalkState = newWalkState()
  private ramp = 0
  private contact: -1 | 0 | 1 = 0
  private readonly bones: WalkBones

  constructor(bones: WalkBones) { this.bones = bones }

  get state(): WalkState { return this.walk }
  get footDown(): -1 | 0 | 1 { return this.contact }

  observe(obs: CharObservation): void {
    stepWalk(this.walk, obs.vel, obs.grounded)
    this.contact = walkPose(this.walk).footDown
    const locomotion = graphMode(obs.mode) === GraphMode.locomotion && obs.grounded
      && obs.mode !== CharMode.swim && (obs.carry ?? 0) === 0
    this.ramp = Math.max(0, Math.min(WEIGHT_TICKS, this.ramp + (locomotion ? 1 : -1)))
  }

  apply(local: Float32Array, _obs: CharObservation): void {
    const w = this.ramp / WEIGHT_TICKS
    if (w <= 0) return // graph clips (jump/dive/slide) stay untouched
    const pose = walkPose(this.walk)
    const read = (bone: number): Quat => {
      const o = bone * 10 + 3
      return [local[o], local[o + 1], local[o + 2], local[o + 3]]
    }
    const write = (bone: number, q: Quat): void => {
      const n = qNorm(q), o = bone * 10 + 3
      local[o] = n[0]; local[o + 1] = n[1]; local[o + 2] = n[2]; local[o + 3] = n[3]
    }
    const { root, flipperL, flipperR, legL, legR } = this.bones
    write(root, qMul(qAxis(0, 0, 1, pose.sway * w), read(root)))
    local[root * 10 + 1] += pose.bob * w
    write(flipperL, qNlerp(read(flipperL), qMul(qAxis(1, 0, 0, pose.flipperL), DOWN_L), w))
    write(flipperR, qNlerp(read(flipperR), qMul(qAxis(1, 0, 0, pose.flipperR), DOWN_R), w))
    write(legL, qNlerp(read(legL), qAxis(1, 0, 0, pose.legL), w))
    write(legR, qNlerp(read(legR), qAxis(1, 0, 0, pose.legR), w))
  }

  reset(): void {
    this.walk = newWalkState()
    this.ramp = 0
    this.contact = 0
  }
}

export const WALK_LAYER: WalkLayerFactory = {
  name: 'walk',
  create(boneNames) { return new WalkLayer(walkBones(boneNames)) },
}
