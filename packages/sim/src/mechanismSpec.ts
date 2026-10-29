import type { ColliderSpec, Surface } from './course.ts'
import type { Pose, Quat, Vec3 } from './vec.ts'

// Converted sim form of S12/S13. Units are radians, metres, kg/m3 and ticks;
// references use indices instead of ids and each id-sorted group keeps its
// order. The game/courseV1 loader produces this from course and asset JSON.

export type BodyType = 'dynamic' | 'kinematic' | 'fixed'
export type JointKind = 'fixed' | 'hinge' | 'slider' | 'ball' | 'spring' | 'rope'

export interface BodySpec {
  id: string
  type: BodyType
  colliders: ColliderSpec[]
  rest: Pose
  density: number
  friction: number
  restitution: number
  linearDamping: number
  angularDamping: number
  gravityScale: number
  ccd: boolean
  surface: Surface
}

export interface MotorSpec {
  mode: 'speed' | 'target'
  speed: number
  target: number
  stiffness: number
  damping: number
  maxForce: number
  enabled: boolean
}

// item -1 = the world.
export interface BodyRef { item: number; body: number }

export interface JointSpec {
  id: string
  kind: JointKind
  a: BodyRef
  b: BodyRef
  anchorA: Vec3
  anchorB: Vec3
  axis: Vec3
  limits: [number, number] | null
  stiffness: number
  damping: number
  length: number
  motor: MotorSpec | null
}

export interface MechItem {
  id: string
  asset: string
  t: Vec3
  r: Quat
  s: Vec3
  bodies: BodySpec[]
  joints: JointSpec[]
}

export interface SwitchSpec {
  id: string
  plate: BodyRef
  mode: 'weight' | 'travel'
  onKg: number
  offKg: number
  joint: number
  onM: number
  offM: number
}

export interface LeverSpec {
  id: string
  handle: BodyRef
  joint: number
  onAngle: number
  offAngle: number
  grabRange: number
}

export type LogicOp = 'and' | 'or' | 'not' | 'toggle' | 'timer' | 'delay' | 'counter'

export interface LogicSpec {
  id: string
  op: LogicOp
  inputs: number[]
  ticks: number
  count: number
}

export type LinkTarget =
  | { kind: 'motor'; joint: number; on: MotorSpec; off: MotorSpec }
  | { kind: 'door'; joint: number; openAngle: number; closedAngle: number }
  | { kind: 'spring'; joint: number; stiffnessOn: number; stiffnessOff: number }
  | { kind: 'animation'; animation: number; on: 'play' | 'reverse'; off: 'pause' | 'reverse' | 'stop' }

export interface LinkSpec { id: string; from: number; to: LinkTarget }

export interface KeyframeSpec { tick: number; t: Vec3; r: Quat }

export interface AnimationSpec {
  id: string
  target: BodyRef
  keys: KeyframeSpec[]
  easing: 'linear' | 'smooth'
  loop: 'loop' | 'pingpong' | 'once'
  autostart: boolean
}

export interface MechanismBudget { dynamicBodies: number; joints: number }

export interface MechanismSpec {
  items: MechItem[]
  joints: JointSpec[]
  switches: SwitchSpec[]
  levers: LeverSpec[]
  logic: LogicSpec[]
  links: LinkSpec[]
  animations: AnimationSpec[]
  signals: string[]
  budget: MechanismBudget
}

export type MechEventKind =
  | 'switchOn' | 'switchOff' | 'leverOn' | 'leverOff'
  | 'motorStart' | 'motorStop' | 'animStart' | 'animEnd' | 'impact'

export interface MechEvent {
  tick: number
  kind: MechEventKind
  source: number
  x: number
  y: number
  z: number
  strength: number
}

export interface SoundSpec {
  id: string
  patch: string
  item: number
  t: Vec3
  event: MechEventKind | null
  signal: number
  gain: number
  ref: number
  max: number
  loop: boolean
}

export interface MechanismView {
  mechanismEvents(fromTick: number, out: MechEvent[]): number
  mechanismBodyPose(ref: BodyRef, out: Pose): boolean
  signal(id: string): boolean
}

export const MECH_EVENT_RING = 64
export const MECH_CAPS = {
  maxItems: 48,
  maxBodiesPerItem: 16,
  maxJoints: 64,
  maxSignals: 64,
  maxKeys: 32,
  maxSounds: 32,
} as const

export const DEFAULT_BUDGET: MechanismBudget = { dynamicBodies: 24, joints: 32 }

export function isMechanismView(sim: unknown): sim is MechanismView {
  if (typeof sim !== 'object' || sim === null) return false
  const view = sim as Partial<MechanismView>
  return typeof view.mechanismEvents === 'function' &&
    typeof view.mechanismBodyPose === 'function' &&
    typeof view.signal === 'function'
}

export function emptyMechanisms(): MechanismSpec {
  return {
    items: [],
    joints: [],
    switches: [],
    levers: [],
    logic: [],
    links: [],
    animations: [],
    signals: [],
    budget: { ...DEFAULT_BUDGET },
  }
}

export function countBudget(m: MechanismSpec): MechanismBudget {
  let dynamicBodies = 0
  let joints = m.joints.length
  for (const item of m.items) {
    joints += item.joints.length
    for (const body of item.bodies) {
      if (body.type === 'dynamic') dynamicBodies++
    }
  }
  return { dynamicBodies, joints }
}
