import { newRecord } from 'ege'
import { Character } from '../components.gen'
import {
  BTN_DIVE_BIT,
  BTN_GRAB_BIT,
  BTN_JUMP_BIT,
  CHAR_AIR_ACCEL,
  CHAR_COYOTE_TICKS,
  CHAR_DIVE_RECOVER_BRAKE,
  CHAR_DIVE_RECOVER_TICKS,
  CHAR_DIVE_SPEED,
  CHAR_DIVE_UP,
  CHAR_GRAB_MAX_TICKS,
  CHAR_GROUND_ACCEL,
  CHAR_GROUND_BRAKE,
  CHAR_JUMP_BUFFER_TICKS,
  CHAR_JUMP_SPEED,
  CHAR_MAX_RUN,
  CHAR_RISE_TICKS,
  CHAR_SLIDE_BANK_GAIN,
  CHAR_SLIDE_ENTER_SPEED,
  CHAR_SLIDE_HAND_PUSH,
  CHAR_SLIDE_MAX_SPEED,
  CHAR_SLIPPERY_SLOPE_NY,
  CHAR_SWIM_DRAG,
  CHAR_SWIM_MAX_SPEED,
  CHAR_SWIM_STROKE_COOLDOWN_TICKS,
  CHAR_SWIM_STROKE_IMPULSE,
  GRAVITY_Y,
  MODE_AIR,
  MODE_DIVE,
  MODE_DIVE_RECOVER,
  MODE_FROZEN,
  MODE_GRABBING,
  MODE_GROUND,
  MODE_SLIDE,
  MODE_STUNNED,
  MODE_SWIM,
  SLIDE_AIR,
  SLIDE_STROKE_DRY_CAP_FACTOR,
  SLIDE_STROKE_IMPULSE,
  SLIDE_STROKE_IMPULSE_TICKS,
  SLIDE_STROKE_STAND_UP_SPEED,
  SURFACE_ICE,
  iceWalkAccel,
  iceWalkBrake,
  iceWalkMaxRun,
  charTurnRate,
  slideFriction,
  slideSteerRad,
  strokeElapsed,
  strokeReadyTicks,
  strokeStartTick,
  strokeTotalTicks,
  surfaceAccel,
  surfaceBounce,
  surfaceBrake,
  surfaceMaxRun
} from './constants.as'
import { Ground } from './ground.as'
import { V3, approach2, turnFacing, v3 } from '../lib/vec.as'

@unmanaged
export class Move {
  vx: f64
  vy: f64
  vz: f64
  mode: u32
  timer: i32
  wasSliding: u32
  slideAir: u32
}

function length2(x: f64, z: f64): f64 {
  return Math.sqrt(x * x + z * z)
}

function setMode(ch: Character, g: Ground, frozen: bool, protectedNow: bool, buttons: u32, vx0: f64, vy0: f64, vz0: f64, out: Move): void {
  const grounded = g.grounded != 0
  const free = grounded ? MODE_GROUND : MODE_AIR
  let mode = ch.mode
  let timer = ch.timer
  if (ch.swim != 0 && !frozen && mode != MODE_FROZEN && mode != MODE_STUNNED) mode = MODE_SWIM
  else if (ch.swim == 0 && mode == MODE_SWIM) mode = MODE_AIR
  if (ch.grab_cooldown > 0) ch.grab_cooldown--
  if (frozen) {
    mode = MODE_FROZEN
    timer = 0
  } else if (mode == MODE_STUNNED || mode == MODE_DIVE_RECOVER) {
    timer--
    if (timer <= 0) {
      timer = mode == MODE_DIVE_RECOVER && free == MODE_GROUND ? CHAR_RISE_TICKS : 0
      mode = free
    }
  } else if (mode == MODE_DIVE) {
    if (grounded && vy0 <= 0) {
      const speed = length2(vx0, vz0)
      if (speed >= CHAR_SLIDE_ENTER_SPEED) {
        ch.slide_speed = Math.min(speed, CHAR_SLIDE_MAX_SPEED)
        ch.facing_0 = vx0 / speed
        ch.facing_1 = vz0 / speed
        mode = MODE_SLIDE
        timer = 0
      } else {
        mode = MODE_DIVE_RECOVER
        timer = CHAR_DIVE_RECOVER_TICKS
      }
    }
  } else if (mode == MODE_GRABBING) {
    if (protectedNow || (buttons & BTN_GRAB_BIT) == 0 || ++ch.grab_ticks >= CHAR_GRAB_MAX_TICKS) mode = free
  } else if (mode == MODE_AIR && timer == SLIDE_AIR && grounded) {
    mode = MODE_SLIDE
    timer = 0
  } else if (mode != MODE_SLIDE && mode != MODE_SWIM) {
    mode = free
  }
  out.mode = mode
  out.timer = timer
}

function steerMove(ch: Character, g: Ground, mx: f64, mz: f64, mlen: f64, dt: f64, out: Move, scratch: V3): void {
  const mode = out.mode
  const grounded = g.grounded != 0
  const slideAir = mode == MODE_AIR && out.timer == SLIDE_AIR
  const steer = !slideAir && (mode == MODE_GROUND || mode == MODE_AIR || mode == MODE_GRABBING)
  out.wasSliding = <u32>(mode == MODE_SLIDE)
  out.slideAir = <u32>slideAir
  if (out.wasSliding != 0) ch.slid = 1
  if (steer) {
    const accel = g.surface == SURFACE_ICE ? iceWalkAccel(g.friction) : surfaceAccel(g.surface)
    const brake = g.surface == SURFACE_ICE ? iceWalkBrake(g.friction) : surfaceBrake(g.surface)
    const maxRunTune = g.surface == SURFACE_ICE ? iceWalkMaxRun(g.friction) : surfaceMaxRun(g.surface)
    const rate = !grounded ? CHAR_AIR_ACCEL : mlen > 0 ? CHAR_GROUND_ACCEL * accel : CHAR_GROUND_BRAKE * brake
    const maxRun = CHAR_MAX_RUN * (grounded ? maxRunTune : 1.0)
    approach2(out.vx, out.vz, g.baseX + mx * maxRun, g.baseZ + mz * maxRun, rate * dt, scratch)
    out.vx = scratch.x
    out.vz = scratch.z
    turnFacing(ch.facing_0, ch.facing_1, mx, mz, charTurnRate() * dt, scratch)
    ch.facing_0 = scratch.x
    ch.facing_1 = scratch.z
  } else if (mode == MODE_SWIM) {
    approach2(out.vx, out.vz, mx * CHAR_SWIM_MAX_SPEED, mz * CHAR_SWIM_MAX_SPEED, CHAR_AIR_ACCEL * dt, scratch)
    out.vx = scratch.x
    out.vz = scratch.z
    turnFacing(ch.facing_0, ch.facing_1, mx, mz, charTurnRate() * dt, scratch)
    ch.facing_0 = scratch.x
    ch.facing_1 = scratch.z
  } else if (mode == MODE_DIVE_RECOVER) {
    approach2(out.vx, out.vz, g.baseX, g.baseZ, CHAR_DIVE_RECOVER_BRAKE * dt, scratch)
    out.vx = scratch.x
    out.vz = scratch.z
  }
}

function stepSlide(ch: Character, g: Ground, mx: f64, mz: f64, mlen: f64, pressed: u32, dt: f64, out: Move, scratch: V3): void {
  if (out.mode != MODE_SLIDE || g.grounded == 0) return
  let speed = ch.slide_speed
  let fx = ch.facing_0
  let fz = ch.facing_1
  const mu = Math.min(slideFriction(g.surface), g.friction)
  const gravity = Math.abs(GRAVITY_Y)
  speed -= mu * gravity * dt
  speed += gravity * g.ny * (g.nx * fx + g.nz * fz) * dt
  const rx = fz
  const rz = -fx
  const bank = CHAR_SLIDE_BANK_GAIN * gravity * g.ny * (g.nx * rx + g.nz * rz) * dt
  const bvx = fx * speed + rx * bank
  const bvz = fz * speed + rz * bank
  const blen = length2(bvx, bvz)
  if (blen > 1e-9) {
    fx = bvx / blen
    fz = bvz / blen
    speed = blen
  }
  if (mlen > 0) {
    turnFacing(fx, fz, mx, mz, slideSteerRad() * dt, scratch)
    fx = scratch.x
    fz = scratch.z
  }
  const slippery = g.surface == SURFACE_ICE || g.ny < CHAR_SLIPPERY_SLOPE_NY
  if (slippery) {
    const along = mx * fx + mz * fz
    if (along > 0) speed += CHAR_SLIDE_HAND_PUSH * along * dt
  }
  if ((pressed & BTN_JUMP_BIT) != 0) {
    out.vy = CHAR_JUMP_SPEED + g.baseY
    ch.coyote = 0
    ch.jump_buffer = 0
    out.mode = MODE_AIR
  } else if ((pressed & BTN_DIVE_BIT) != 0 && (ch.stroke_timer == 0 || strokeElapsed(ch.stroke_timer) >= strokeReadyTicks())) {
    ch.stroke_timer = <u32>strokeTotalTicks()
  }
  const elapsed = strokeElapsed(ch.stroke_timer)
  const pushTicks = Math.max(1.0, Math.round(SLIDE_STROKE_IMPULSE_TICKS))
  if (out.mode == MODE_SLIDE && elapsed >= strokeStartTick() && elapsed < strokeStartTick() + <i32>pushTicks) speed += SLIDE_STROKE_IMPULSE / pushTicks
  const cap = slippery ? CHAR_SLIDE_MAX_SPEED : CHAR_MAX_RUN * surfaceMaxRun(g.surface) * SLIDE_STROKE_DRY_CAP_FACTOR
  speed = Math.min(speed, cap)
  out.vx = fx * speed + g.baseX
  out.vz = fz * speed + g.baseZ
  ch.facing_0 = fx
  ch.facing_1 = fz
  ch.slide_speed = speed
  if (out.mode == MODE_SLIDE && speed < SLIDE_STROKE_STAND_UP_SPEED && ch.stroke_timer == 0) {
    out.mode = MODE_GROUND
    out.timer = 12
  }
}

export function newMove(): Move {
  return newRecord<Move>(<u32>sizeof<Move>())
}

/** Handoff: 'Character systems rf.character.pre and rf.character.post with schedule registration' calls stepMoves, newMove and settleTimer; stepMoves updates movement state and returns velocity, mode and timer. It uses surface tuning documented at constants.as.ts:177 `surfaceAccel`. */
export function stepMoves(ch: Character, g: Ground, frozen: bool, protectedNow: bool, mx: f64, mz: f64, mlen: f64, buttons: u32, pressed: u32, wasGrounded: bool, vx0: f64, vy0: f64, vz0: f64, dt: f64, out: Move): Move {
  const scratch = v3(0.0, 0.0, 0.0)
  if (ch.stroke_timer > 0) ch.stroke_timer--
  out.vx = vx0
  out.vy = vy0
  out.vz = vz0
  setMode(ch, g, frozen, protectedNow, buttons, vx0, vy0, vz0, out)
  if (frozen) {
    out.vx = 0
    out.vz = 0
  } else {
    steerMove(ch, g, mx, mz, mlen, dt, out, scratch)
  }
  const grounded = g.grounded != 0
  const steer = out.slideAir == 0 && (out.mode == MODE_GROUND || out.mode == MODE_AIR || out.mode == MODE_GRABBING)
  if (grounded) ch.coyote = CHAR_COYOTE_TICKS
  if ((pressed & BTN_JUMP_BIT) != 0) ch.jump_buffer = CHAR_JUMP_BUFFER_TICKS
  else if (ch.jump_buffer > 0) ch.jump_buffer--
  if (steer && (grounded || ch.coyote > 0) && ch.jump_buffer > 0) {
    out.vy = CHAR_JUMP_SPEED + g.baseY
    ch.coyote = 0
    ch.jump_buffer = 0
    if (out.mode != MODE_GRABBING) out.mode = MODE_AIR
  } else {
    if (!grounded && ch.coyote > 0) ch.coyote--
    if (g.riding != 0 && steer && out.vy > g.baseY) out.vy = g.baseY
  }
  const swimming = out.mode == MODE_SWIM
  if (swimming && (pressed & BTN_JUMP_BIT) != 0) {
    if (ch.stroke_timer == 0) {
      out.vx += ch.facing_0 * CHAR_SWIM_STROKE_IMPULSE
      out.vz += ch.facing_1 * CHAR_SWIM_STROKE_IMPULSE
      ch.stroke_timer = CHAR_SWIM_STROKE_COOLDOWN_TICKS
    }
    ch.jump_buffer = 0
  }
  if (swimming) {
    const speed = length2(out.vx, out.vz)
    const cap = CHAR_SWIM_MAX_SPEED + CHAR_SWIM_STROKE_IMPULSE
    if (speed > cap) {
      out.vx *= cap / speed
      out.vz *= cap / speed
    }
  }
  stepSlide(ch, g, mx, mz, mlen, pressed, dt, out, scratch)
  if (out.mode == MODE_SLIDE && !grounded && ch.coyote == 0) {
    out.mode = MODE_AIR
    out.timer = SLIDE_AIR
  }
  if ((pressed & BTN_DIVE_BIT) != 0 && (out.mode == MODE_DIVE_RECOVER || (out.mode == MODE_GROUND && grounded && out.timer > 0))) {
    ch.slide_speed = length2(out.vx - g.baseX, out.vz - g.baseZ)
    ch.stroke_timer = <u32>strokeTotalTicks()
    out.mode = MODE_SLIDE
    out.timer = 0
  }
  if (out.wasSliding == 0 && out.slideAir == 0 && (out.mode == MODE_GROUND || out.mode == MODE_AIR) && (pressed & BTN_DIVE_BIT) != 0 && ch.dive_used == 0) {
    const speed = Math.max(length2(out.vx, out.vz), CHAR_DIVE_SPEED)
    out.vx = ch.facing_0 * speed
    out.vz = ch.facing_1 * speed
    out.vy = grounded ? CHAR_DIVE_UP : Math.max(out.vy, 0.6 * CHAR_DIVE_UP)
    out.mode = MODE_DIVE
    ch.dive_used = 1
  }
  if (grounded && out.mode != MODE_DIVE) ch.dive_used = 0
  if (!wasGrounded && grounded && vy0 < -3 && surfaceBounce(g.surface) > 0 && !frozen && out.mode != MODE_STUNNED) {
    out.vy = surfaceBounce(g.surface) * -vy0
    out.mode = MODE_AIR
    out.timer = 0
  }
  if (g.pad != 0 && g.touching != 0 && !frozen && out.mode != MODE_STUNNED) {
    out.vy = g.padSpeed
    out.mode = MODE_AIR
    out.timer = 0
  }
  if (out.mode == MODE_STUNNED) {
    out.vx = vx0
    out.vy = vy0
    out.vz = vz0
  }
  if (out.mode == MODE_SWIM) {
    const drag = ch.swim_drag > 0 ? ch.swim_drag : CHAR_SWIM_DRAG
    const k = Math.max(0.0, 1.0 - drag * dt)
    out.vx *= k
    out.vz *= k
    out.vy += ch.swim_buoyancy * dt
  }
  if (out.mode == MODE_SLIDE) ch.slid = 1
  return out
}

export function settleTimer(mode: u32, timer: i32): i32 {
  if (timer == SLIDE_AIR && mode != MODE_AIR) return 0
  if (timer > 0 && mode != MODE_STUNNED && mode != MODE_DIVE_RECOVER) return mode == MODE_GROUND ? timer - 1 : 0
  return timer
}
