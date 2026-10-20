import { degToRad, v3 } from '../vec.ts'
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
} as const

export type CharModeValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
