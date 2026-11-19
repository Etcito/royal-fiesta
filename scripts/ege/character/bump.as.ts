import { getComponent, readColumn, setComponent, setLinvel } from 'ege'
import { Character, EgeContacts, EgeTransform, EgeVelocity } from '../components.gen'
import {
  CHAR_BUMP_MIN_SPEED,
  CHAR_GROUND_MIN_NY,
  CHAR_KNOCK_GAIN,
  CHAR_KNOCK_NORMAL,
  CHAR_KNOCK_UP,
  CHAR_STUN_TICKS,
  MODE_STUNNED,
} from './constants.as'

function slotU32(record: EgeContacts, slot: u32): u32 {
  switch (slot) {
    case 0: return record.other_0
    case 1: return record.other_1
    case 2: return record.other_2
    default: return record.other_3
  }
}

function slotFloat(record: EgeContacts, offset: u32): f64 {
  switch (offset) {
    case 0: return record.normal_0
    case 1: return record.normal_1
    case 2: return record.normal_2
    case 3: return record.normal_3
    case 4: return record.normal_4
    case 5: return record.normal_5
    case 6: return record.normal_6
    case 7: return record.normal_7
    case 8: return record.normal_8
    case 9: return record.normal_9
    case 10: return record.normal_10
    case 11: return record.normal_11
    case 12: return record.point_0
    case 13: return record.point_1
    case 14: return record.point_2
    case 15: return record.point_3
    case 16: return record.point_4
    case 17: return record.point_5
    case 18: return record.point_6
    case 19: return record.point_7
    case 20: return record.point_8
    case 21: return record.point_9
    case 22: return record.point_10
    default: return record.point_11
  }
}

function writeKnockVelocity(entity: u32, vx: f64, vy: f64, vz: f64): void {
  setLinvel(entity, <f32>vx, <f32>vy, <f32>vz)
  const velocity = getComponent<EgeVelocity>(entity, EgeVelocity.ID, EgeVelocity.SIZE)
  velocity.lin_0 = <f32>vx
  velocity.lin_1 = <f32>vy
  velocity.lin_2 = <f32>vz
  setComponent<EgeVelocity>(entity, EgeVelocity.ID, EgeVelocity.SIZE, velocity)
}

/**
 * Handoff: Character systems rf.character.pre and rf.character.post with schedule registration calls
 * `bumpFromContacts(entity: u32, ch: Character): bool` from `rf_character_post`; it tests the seat's
 * ordered contact records and applies the first qualifying moving-body knock to its state and velocity.
 * Engine contact order is ascending other id, each other contributes only E9's deepest point, and the
 * moving filter requires a non-character `ege.velocity` record because E3 assigns static groups to movers.
 */
export function bumpFromContacts(entity: u32, ch: Character): bool {
  const contacts = getComponent<EgeContacts>(entity, EgeContacts.ID, EgeContacts.SIZE)
  if (changetype<usize>(contacts) == 0) return false
  const characters = readColumn<Character>(Character.ID, Character.SIZE)
  const velocities = readColumn<EgeVelocity>(EgeVelocity.ID, EgeVelocity.SIZE)
  const count = contacts.count < 4 ? contacts.count : 4
  for (let k: u32 = 0; k < count; k++) {
    const other = slotU32(contacts, k)
    if (characters.find(other) >= 0) continue
    const otherRow = velocities.find(other)
    if (otherRow < 0) continue
    // E9 points from this entity to the other; system.ts uses the opposite manifold normal.
    const nx = -slotFloat(contacts, k * 3)
    const ny = -slotFloat(contacts, k * 3 + 1)
    const nz = -slotFloat(contacts, k * 3 + 2)
    if (ny >= CHAR_GROUND_MIN_NY) continue
    const pointOffset = 12 + k * 3
    const px = slotFloat(contacts, pointOffset)
    const py = slotFloat(contacts, pointOffset + 1)
    const pz = slotFloat(contacts, pointOffset + 2)
    const otherVelocity = velocities.at(<u32>otherRow)
    const otherTransform = getComponent<EgeTransform>(other, EgeTransform.ID, EgeTransform.SIZE)
    const rx = px - otherTransform.pos_0
    const ry = py - otherTransform.pos_1
    const rz = pz - otherTransform.pos_2
    const ox = otherVelocity.lin_0 + otherVelocity.ang_1 * rz - otherVelocity.ang_2 * ry
    const oy = otherVelocity.lin_1 + otherVelocity.ang_2 * rx - otherVelocity.ang_0 * rz
    const oz = otherVelocity.lin_2 + otherVelocity.ang_0 * ry - otherVelocity.ang_1 * rx
    const awayRaw = <f64>ch.pre_vel_0 * nx + <f64>ch.pre_vel_1 * ny + <f64>ch.pre_vel_2 * nz
    const away = awayRaw > 0 ? awayRaw : 0
    const rel = ox * nx + oy * ny + oz * nz - away
    if (!(rel > CHAR_BUMP_MIN_SPEED)) continue
    const hl = Math.sqrt(nx * nx + nz * nz)
    const k2 = hl > 0 ? CHAR_KNOCK_NORMAL / hl : 0
    const vx = ox * CHAR_KNOCK_GAIN + nx * k2
    const vy = oy * CHAR_KNOCK_GAIN + CHAR_KNOCK_UP
    const vz = oz * CHAR_KNOCK_GAIN + nz * k2
    writeKnockVelocity(entity, vx, vy, vz)
    ch.mode = MODE_STUNNED
    ch.timer = CHAR_STUN_TICKS
    ch.knockbacks += 1
    return true
  }
  return false
}

export function knockSeat(entity: u32, ch: Character, vx: f64, vy: f64, vz: f64, now: i32): void {
  if (ch.parked != 0 || now < ch.protected_until) return
  writeKnockVelocity(entity, vx, vy, vz)
  ch.mode = MODE_STUNNED
  ch.timer = CHAR_STUN_TICKS
  ch.knockbacks += 1
}
