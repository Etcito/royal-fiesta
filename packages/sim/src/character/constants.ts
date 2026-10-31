import { degToRad, v3 } from '../vec.ts'
import type { Surface } from '../course.ts'
import type { Vec3 } from '../vec.ts'

// Starting values for the M3 tuning task. Tuning may change them only to make the
// M3 `behaviours` check pass; the thresholds of that check are fixed.
const turnRate: number = degToRad(720)
const parkOrigin: Vec3 = v3(0, -500, 0)

export const CHAR = {
  radius: 0.4,
  halfHeight: 0.45,
  mass: 60,
  maxRun: 8,
  groundAccel: 60,
  groundBrake: 70,
  airAccel: 18,
  turnRate,
  jumpSpeed: 7.5,
  coyoteTicks: 6,
  jumpBufferTicks: 6,
  diveSpeed: 10.5,
  diveUp: 3.5,
  diveRecoverTicks: 24,
  diveRecoverBrake: 30,
  grabRange: 1.0,
  grabConeDot: 0.5,
  grabSlow: 0.6,
  grabMaxTicks: 120,
  grabCooldownTicks: 60,
  grabberMaxSpeed: 3,
  bumpMinSpeed: 2,
  stunTicks: 30,
  knockGain: 1.2,
  knockNormal: 4,
  knockUp: 4,
  groundProbe: 0.08,
  groundMinNy: 0.6,
  parkOrigin,
  parkStep: 5,
  slide: {
    friction: { normal: 0.35, ice: 0.02, mud: 1.2, rubber: 0.35 } as Readonly<Record<Surface, number>>,
    enterSpeed: 11,
    exitSpeed: 4,
    maxSpeed: 16,
    steerRadS: degToRad(120),
    bankGain: 0.5,
    handPush: 6,
    strokeImpulse: 3,
    strokeCooldownTicks: 18,
  },
  swim: {
    maxSpeed: 5,
    drag: 2.5,
    strokeImpulse: 3,
    strokeCooldownTicks: 18,
  },
} as const

export const CharMode = {
  ground: 0,
  air: 1,
  dive: 2,
  diveRecover: 3,
  stunned: 4,
  grabbing: 5,
  frozen: 6,
  parked: 7,
  slide: 8,
  swim: 9,
} as const

export type CharModeValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export const CarryKind = {
  none: 0,
  object: 1,
  player: 2,
  tail: 3,
  crown: 4,
} as const

export type CarryKindValue = 0 | 1 | 2 | 3 | 4

export const SURFACE_TUNING: Readonly<Record<Surface, { accel: number; brake: number; maxRun: number; bounce: number }>> = {
  normal: { accel: 1, brake: 1, maxRun: 1, bounce: 0 },
  ice: { accel: 0.25, brake: 0.15, maxRun: 1.1, bounce: 0 },
  mud: { accel: 0.7, brake: 1.2, maxRun: 0.6, bounce: 0 },
  rubber: { accel: 1, brake: 1, maxRun: 1, bounce: 0.6 },
}
