import { degToRad } from '../lib/units.as'

// CHAR.mass is packages/sim/src/character/constants.ts:13.
export const CHAR_MASS: f64 = 60.0
// CHAR.maxRun is packages/sim/src/character/constants.ts:7,14.
export const CHAR_MAX_RUN: f64 = 8.0
// CHAR.groundAccel is packages/sim/src/character/constants.ts:15.
export const CHAR_GROUND_ACCEL: f64 = 60.0
// CHAR.groundBrake is packages/sim/src/character/constants.ts:16.
export const CHAR_GROUND_BRAKE: f64 = 70.0
// CHAR.slipperySlopeNy is packages/sim/src/character/constants.ts:17.
export const CHAR_SLIPPERY_SLOPE_NY: f64 = 0.98
// CHAR.airAccel is packages/sim/src/character/constants.ts:18.
export const CHAR_AIR_ACCEL: f64 = 18.0
// CHAR.turnRate is packages/sim/src/character/constants.ts:8.
export const CHAR_TURN_RATE_DEG: f64 = 720.0
// CHAR.jumpSpeed is packages/sim/src/character/constants.ts:20.
export const CHAR_JUMP_SPEED: f64 = 7.5
// CHAR.diveSpeed is packages/sim/src/character/constants.ts:23.
export const CHAR_DIVE_SPEED: f64 = 10.5
// CHAR.diveUp is packages/sim/src/character/constants.ts:24.
export const CHAR_DIVE_UP: f64 = 3.5
// CHAR.diveRecoverBrake is packages/sim/src/character/constants.ts:26.
export const CHAR_DIVE_RECOVER_BRAKE: f64 = 30.0
// CHAR.grabRange is packages/sim/src/character/constants.ts:30.
export const CHAR_GRAB_RANGE: f64 = 1.0
// CHAR.grabConeDot is packages/sim/src/character/constants.ts:31.
export const CHAR_GRAB_CONE_DOT: f64 = 0.5
// CHAR.grabSlow is packages/sim/src/character/constants.ts:32.
export const CHAR_GRAB_SLOW: f64 = 0.6
// CHAR.grabberMaxSpeed is packages/sim/src/character/constants.ts:35.
export const CHAR_GRABBER_MAX_SPEED: f64 = 3.0
// CHAR.bumpMinSpeed is packages/sim/src/character/constants.ts:36.
export const CHAR_BUMP_MIN_SPEED: f64 = 2.0
// CHAR.knockGain is packages/sim/src/character/constants.ts:38.
export const CHAR_KNOCK_GAIN: f64 = 1.2
// CHAR.knockNormal is packages/sim/src/character/constants.ts:39.
export const CHAR_KNOCK_NORMAL: f64 = 4.0
// CHAR.knockUp is packages/sim/src/character/constants.ts:40.
export const CHAR_KNOCK_UP: f64 = 4.0
// CHAR.groundProbe is packages/sim/src/character/constants.ts:41.
export const CHAR_GROUND_PROBE: f64 = 0.08
// CHAR.groundMinNy is packages/sim/src/character/constants.ts:42.
export const CHAR_GROUND_MIN_NY: f64 = 0.6
// CHAR.parkOrigin is packages/sim/src/character/constants.ts:9.
export const CHAR_PARK_ORIGIN_X: f64 = 0.0
// CHAR.parkOrigin is packages/sim/src/character/constants.ts:9.
export const CHAR_PARK_ORIGIN_Y: f64 = -500.0
// CHAR.parkOrigin is packages/sim/src/character/constants.ts:9.
export const CHAR_PARK_ORIGIN_Z: f64 = 0.0
// CHAR.parkStep is packages/sim/src/character/constants.ts:44.
export const CHAR_PARK_STEP: f64 = 5.0
// CHAR.slide.friction.normal is packages/sim/src/character/constants.ts:46.
export const CHAR_SLIDE_FRICTION_NORMAL: f64 = 0.35
// CHAR.slide.friction.ice is packages/sim/src/character/constants.ts:46.
export const CHAR_SLIDE_FRICTION_ICE: f64 = 0.02
// CHAR.slide.friction.mud is packages/sim/src/character/constants.ts:46.
export const CHAR_SLIDE_FRICTION_MUD: f64 = 1.2
// CHAR.slide.friction.rubber is packages/sim/src/character/constants.ts:46.
export const CHAR_SLIDE_FRICTION_RUBBER: f64 = 0.35
// CHAR.slide.enterSpeed is packages/sim/src/character/constants.ts:47.
export const CHAR_SLIDE_ENTER_SPEED: f64 = 6.0
// CHAR.slide.exitSpeed is packages/sim/src/character/constants.ts:48.
export const CHAR_SLIDE_EXIT_SPEED: f64 = 4.0
// CHAR.slide.maxSpeed is packages/sim/src/character/constants.ts:49.
export const CHAR_SLIDE_MAX_SPEED: f64 = 16.0
// CHAR.slide.steerRadS is packages/sim/src/character/constants.ts:50.
export const CHAR_SLIDE_STEER_DEG: f64 = 240.0
// CHAR.slide.bankGain is packages/sim/src/character/constants.ts:51.
export const CHAR_SLIDE_BANK_GAIN: f64 = 0.5
// CHAR.slide.handPush is packages/sim/src/character/constants.ts:52.
export const CHAR_SLIDE_HAND_PUSH: f64 = 6.0
// CHAR.swim.maxSpeed is packages/sim/src/character/constants.ts:55.
export const CHAR_SWIM_MAX_SPEED: f64 = 5.0
// CHAR.swim.drag is packages/sim/src/character/constants.ts:56.
export const CHAR_SWIM_DRAG: f64 = 2.5
// CHAR.swim.strokeImpulse is packages/sim/src/character/constants.ts:57.
export const CHAR_SWIM_STROKE_IMPULSE: f64 = 3.0
// SLIDE_STROKE.impulse is packages/sim/src/character/constants.ts:93.
export const SLIDE_STROKE_IMPULSE: f64 = 7.0
// SLIDE_STROKE.animTicks is packages/sim/src/character/constants.ts:94.
export const SLIDE_STROKE_ANIM_TICKS: f64 = 30.0
// SLIDE_STROKE.startFrac is packages/sim/src/character/constants.ts:95.
export const SLIDE_STROKE_START_FRAC: f64 = 0.5
// SLIDE_STROKE.impulseTicks is packages/sim/src/character/constants.ts:96.
export const SLIDE_STROKE_IMPULSE_TICKS: f64 = 24.0
// SLIDE_STROKE.cooldownTicks is packages/sim/src/character/constants.ts:97.
export const SLIDE_STROKE_COOLDOWN_TICKS: f64 = 30.0
// SLIDE_STROKE.standUpSpeed is packages/sim/src/character/constants.ts:98.
export const SLIDE_STROKE_STAND_UP_SPEED: f64 = 1.0
// SLIDE_STROKE.dryCapFactor is packages/sim/src/character/constants.ts:99.
export const SLIDE_STROKE_DRY_CAP_FACTOR: f64 = 0.9
// GLARE_ICE.mu, accel, brake, maxRun and bounce are packages/sim/src/character/constants.ts:169.
export const GLARE_ICE_MU: f64 = 0.02
export const GLARE_ICE_ACCEL: f64 = 0.05
export const GLARE_ICE_BRAKE: f64 = 0.04
export const GLARE_ICE_MAX_RUN: f64 = 0.75
export const GLARE_ICE_BOUNCE: f64 = 0.0
// ICE_GRIP_MU is packages/sim/src/character/constants.ts:170.
export const ICE_GRIP_MU: f64 = 0.06
// Gravity is packages/sim/src/world.ts:11.
export const GRAVITY_Y: f64 = -20.0

// CHAR.coyoteTicks is packages/sim/src/character/constants.ts:21.
export const CHAR_COYOTE_TICKS: u32 = 6
// CHAR.jumpBufferTicks is packages/sim/src/character/constants.ts:22.
export const CHAR_JUMP_BUFFER_TICKS: u32 = 6
// CHAR.grabMaxTicks is packages/sim/src/character/constants.ts:33.
export const CHAR_GRAB_MAX_TICKS: u32 = 120
// CHAR.grabCooldownTicks is packages/sim/src/character/constants.ts:34.
export const CHAR_GRAB_COOLDOWN_TICKS: u32 = 60
// CHAR.swim.strokeCooldownTicks is packages/sim/src/character/constants.ts:58.
export const CHAR_SWIM_STROKE_COOLDOWN_TICKS: u32 = 18
// CHAR.diveRecoverTicks is packages/sim/src/character/constants.ts:25.
export const CHAR_DIVE_RECOVER_TICKS: i32 = 24
// CHAR.riseTicks is packages/sim/src/character/constants.ts:29.
export const CHAR_RISE_TICKS: i32 = 12
// CHAR.stunTicks is packages/sim/src/character/constants.ts:37.
export const CHAR_STUN_TICKS: i32 = 30
// SLIDE_AIR is packages/sim/src/character/system.ts:96.
export const SLIDE_AIR: i32 = -1

// CharMode values are packages/sim/src/character/constants.ts:128-139.
export const MODE_GROUND: u32 = 0
export const MODE_AIR: u32 = 1
export const MODE_DIVE: u32 = 2
export const MODE_DIVE_RECOVER: u32 = 3
export const MODE_STUNNED: u32 = 4
export const MODE_GRABBING: u32 = 5
export const MODE_FROZEN: u32 = 6
export const MODE_PARKED: u32 = 7
export const MODE_SLIDE: u32 = 8
export const MODE_SWIM: u32 = 9
// CarryKind values are packages/sim/src/character/constants.ts:143-149.
export const CARRY_NONE: u32 = 0
export const CARRY_OBJECT: u32 = 1
export const CARRY_PLAYER: u32 = 2
export const CARRY_TAIL: u32 = 3
export const CARRY_CROWN: u32 = 4
// E3 surface.kind values.
export const SURFACE_NORMAL: u32 = 0
export const SURFACE_ICE: u32 = 1
export const SURFACE_MUD: u32 = 2
export const SURFACE_RUBBER: u32 = 3
// BTN bit positions follow packages/sim/src/character/system.ts:71-73,490.
export const BTN_JUMP_BIT: u32 = 1
export const BTN_DIVE_BIT: u32 = 2
export const BTN_GRAB_BIT: u32 = 4
// Group words use packages/sim/src/groups.ts and system.ts:65-68.
export const CHAR_MEMBERSHIPS: u32 = 4
export const CHAR_FILTER: u32 = 7
export const PROTECTED_FILTER: u32 = 3
export const PROBE_GROUPS: u32 = 3
// Engine mover kinds.
export const MOVER_CONVEYOR: u32 = 5
export const MOVER_BOUNCE_PAD: u32 = 6
export const NO_ENTITY: u32 = 0xFFFFFFFF

export function charTurnRate(): f64 {
  return degToRad(CHAR_TURN_RATE_DEG)
}

export function slideSteerRad(): f64 {
  return degToRad(CHAR_SLIDE_STEER_DEG)
}

/** Handoff: 'Ground probe, surfaces and riding (ground.as.ts)' calls slideFriction for E3 surface kinds; it returns the CHAR.slide.friction value, with normal friction for unknown kinds. */
export function slideFriction(kind: u32): f64 {
  switch (kind) {
    case SURFACE_ICE: return CHAR_SLIDE_FRICTION_ICE
    case SURFACE_MUD: return CHAR_SLIDE_FRICTION_MUD
    case SURFACE_RUBBER: return CHAR_SLIDE_FRICTION_RUBBER
    default: return CHAR_SLIDE_FRICTION_NORMAL
  }
}

/** Handoff: 'Mode machine and moves (moves.as.ts)' calls surfaceAccel, surfaceBrake, surfaceMaxRun, surfaceBounce, iceWalkAccel, iceWalkBrake, iceWalkMaxRun, charTurnRate, slideSteerRad, strokeStartTick, strokeTotalTicks, strokeReadyTicks and strokeElapsed in stepMoves; they map surface kinds or friction mu to tuning, convert angles to radians, and derive stroke ticks. */
export function surfaceAccel(kind: u32): f64 {
  switch (kind) {
    case SURFACE_ICE: return 0.25
    case SURFACE_MUD: return 0.7
    default: return 1.0
  }
}

export function surfaceBrake(kind: u32): f64 {
  switch (kind) {
    case SURFACE_ICE: return 0.15
    case SURFACE_MUD: return 1.2
    default: return 1.0
  }
}

export function surfaceMaxRun(kind: u32): f64 {
  switch (kind) {
    case SURFACE_ICE: return 1.1
    case SURFACE_MUD: return 0.6
    default: return 1.0
  }
}

export function surfaceBounce(kind: u32): f64 {
  if (kind == SURFACE_RUBBER) return 0.6
  return 0.0
}

export function iceWalkAccel(mu: f64): f64 {
  const k = Math.max(0.0, Math.min(1.0, (mu - GLARE_ICE_MU) / (ICE_GRIP_MU - GLARE_ICE_MU)))
  return GLARE_ICE_ACCEL + (0.25 - GLARE_ICE_ACCEL) * k
}

export function iceWalkBrake(mu: f64): f64 {
  const k = Math.max(0.0, Math.min(1.0, (mu - GLARE_ICE_MU) / (ICE_GRIP_MU - GLARE_ICE_MU)))
  return GLARE_ICE_BRAKE + (0.15 - GLARE_ICE_BRAKE) * k
}

export function iceWalkMaxRun(mu: f64): f64 {
  const k = Math.max(0.0, Math.min(1.0, (mu - GLARE_ICE_MU) / (ICE_GRIP_MU - GLARE_ICE_MU)))
  return GLARE_ICE_MAX_RUN + (1.1 - GLARE_ICE_MAX_RUN) * k
}

export function strokeStartTick(): i32 {
  return <i32>Math.round(SLIDE_STROKE_START_FRAC * SLIDE_STROKE_ANIM_TICKS)
}

export function strokeTotalTicks(): i32 {
  return <i32>Math.max(1.0, Math.min(255.0, Math.round(Math.max(SLIDE_STROKE_ANIM_TICKS, Math.max(SLIDE_STROKE_COOLDOWN_TICKS, <f64>strokeStartTick() + SLIDE_STROKE_IMPULSE_TICKS)))))
}

export function strokeReadyTicks(): i32 {
  return <i32>Math.round(Math.max(SLIDE_STROKE_ANIM_TICKS, SLIDE_STROKE_COOLDOWN_TICKS))
}

export function strokeElapsed(timer: i32): i32 {
  return timer > 0 ? <i32>Math.max(0.0, <f64>strokeTotalTicks() - <f64>timer) : -1
}
