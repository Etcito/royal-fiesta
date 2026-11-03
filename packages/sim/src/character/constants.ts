import { degToRad, v3 } from '../vec.ts'
import type { Surface } from '../course.ts'
import type { Vec3 } from '../vec.ts'

// Starting values for the M3 tuning task. Tuning may change them only to make the
// M3 `behaviours` check pass; the thresholds of that check are fixed.
const maxRun = 8
const turnRate: number = degToRad(720)
const parkOrigin: Vec3 = v3(0, -500, 0)

export const CHAR = {
  radius: 0.4,
  halfHeight: 0.45,
  mass: 60,
  maxRun,
  groundAccel: 60,
  groundBrake: 70,
  slipperySlopeNy: 0.98,
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
    enterSpeed: 6,
    exitSpeed: 4,
    maxSpeed: 16,
    steerRadS: degToRad(240),
    bankGain: 0.5,
    handPush: 6,
  },
  swim: {
    maxSpeed: 5,
    drag: 2.5,
    strokeImpulse: 3,
    strokeCooldownTicks: 18,
  },
} as const

/**
 * The belly stroke (a breaststroke): DIVE on the belly starts one stroke animation of animTicks;
 * the push starts at startFrac of it and lasts impulseTicks, a little past the animation's end.
 * A press is accepted only once the animation (and cooldownTicks) has run, so mashing gains
 * nothing; a press during the push tail starts the next stroke and drops the rest of that tail.
 * Below standUpSpeed with no stroke running he stands up. On dry flat ground the slide is capped
 * at dryCapFactor x walking speed; on ice or a slope it is capped at CHAR.slide.maxSpeed.
 * Ticks are sim ticks (60 Hz).
 */
export interface SlideStroke {
  /** m/s added to the slide speed by one whole push. */
  impulse: number
  /** Ticks of the stroke animation; also the earliest next stroke. */
  animTicks: number
  /** 0..1: where in the animation the push starts. */
  startFrac: number
  /** Ticks of the push. */
  impulseTicks: number
  /** Ticks from a press before the next press counts (at least animTicks is enforced). */
  cooldownTicks: number
  /** m/s: below it, with no stroke running, he stands up. */
  standUpSpeed: number
  /** Dry flat cap as a fraction of walking speed (CHAR.maxRun x surface maxRun). */
  dryCapFactor: number
}

/**
 * Defaults. The online rollback sim always uses these: every peer must step the same numbers.
 * Only an offline/local sim may be handed a tuned copy (the ?tune=1 panel).
 */
export const SLIDE_STROKE: Readonly<SlideStroke> = {
  impulse: 7,
  animTicks: 30,
  startFrac: 0.5,
  impulseTicks: 24,
  cooldownTicks: 30,
  standUpSpeed: 1,
  dryCapFactor: 0.9,
}

/** Elapsed tick (from the press) at which the push starts. */
export function strokeStartTick(s: Readonly<SlideStroke>): number {
  return Math.round(s.startFrac * s.animTicks)
}

/** Ticks a stroke runs (animation, cooldown and push), the slide strokeTimer's start value (u8). */
export function strokeTotalTicks(s: Readonly<SlideStroke>): number {
  return Math.max(1, Math.min(255, Math.round(Math.max(s.animTicks, s.cooldownTicks, strokeStartTick(s) + s.impulseTicks))))
}

/** Ticks after a press before the next press counts. */
export function strokeReadyTicks(s: Readonly<SlideStroke>): number {
  return Math.round(Math.max(s.animTicks, s.cooldownTicks))
}

/** Ticks since the press from the slide strokeTimer (counting down from strokeTotalTicks), -1 when none. */
export function strokeElapsed(s: Readonly<SlideStroke>, timer: number): number {
  return timer > 0 ? Math.max(0, strokeTotalTicks(s) - timer) : -1
}

/** Stroke animation phase 0..1 (1 = glide, also with no stroke running). */
export function strokeAnimPhase(s: Readonly<SlideStroke>, timer: number): number {
  const elapsed = strokeElapsed(s, timer)
  return elapsed < 0 ? 1 : Math.min(1, elapsed / Math.max(1, s.animTicks))
}

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
