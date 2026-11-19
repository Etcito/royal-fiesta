import { Column, getComponent, pose, readColumn, setAngvel, setLinvel, setPose } from 'ege'
import { Character, EgeTransform, EgeVelocity, Seat } from '../components.gen'

// CHAR.parkOrigin is packages/sim/src/character/constants.ts:9.
const CHAR_PARK_ORIGIN_Y: f64 = -500.0
// CHAR.parkStep is packages/sim/src/character/constants.ts:44.
const CHAR_PARK_STEP: f64 = 5.0

export function seatColumn(): Column<Seat> {
  return readColumn<Seat>(Seat.ID, Seat.SIZE)
}

export function characterColumn(): Column<Character> {
  return readColumn<Character>(Character.ID, Character.SIZE)
}

export function transformOf(entity: u32): EgeTransform {
  return getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
}

export function velocityOf(entity: u32): EgeVelocity {
  return getComponent<EgeVelocity>(entity, EgeVelocity.ID, EgeVelocity.SIZE)
}

// Port of packages/sim/src/character/system.ts:294-300.
export function placeSeat(entity: u32, ch: Character, tx: f64, ty: f64, tz: f64, fx: f64, fz: f64): void {
  setPose(entity, pose(<f32>tx, <f32>(ty + ch.stand + 0.01), <f32>tz))
  setLinvel(entity, 0, 0, 0)
  setAngvel(entity, 0, 0, 0)
  ch.facing_0 = fx
  ch.facing_1 = fz
  ch.mode = 1
  ch.timer = 0
}

// CHAR.parkOrigin and CHAR.parkStep are named and valued in constants.ts:9,44;
// the matching teleport and parked flags are packages/sim/src/character/system.ts:322-326.
export function parkSeat(entity: u32, ch: Character, seat: u32): void {
  setPose(entity, pose(<f32>(<f64>seat * CHAR_PARK_STEP), <f32>CHAR_PARK_ORIGIN_Y, 0.0))
  setLinvel(entity, 0, 0, 0)
  setAngvel(entity, 0, 0, 0)
  ch.mode = 7
  ch.parked = 1
}
