import { Column, getComponent, isNull, newRecord, readColumn, setComponent, setLinvel } from 'ege'
import { Character, EgeMechGrab, EgeMechLever, EgeTransform, ShowCharacterRef } from '../components.gen'
import { BTN_GRAB_BIT, CHAR_GRABBER_MAX_SPEED, CHAR_GRAB_CONE_DOT, CHAR_GRAB_COOLDOWN_TICKS, CHAR_GRAB_RANGE, CHAR_GRAB_SLOW, CHAR_MASS, GRAVITY_Y, MODE_AIR, MODE_GROUND, MODE_GRABBING, NO_ENTITY } from './constants.as'

/**
 * Handoff: 'Character systems rf.character.pre and rf.character.post with schedule registration'
 * calls startLeverGrab, holdLever, releaseGrab and grabPass. startLeverGrab finds an in-range
 * lever handle; holdLever and releaseGrab write its mech load; grabPass updates player grabs.
 */
export function startLeverGrab(entity: u32, ch: Character, x: f64, y: f64, z: f64): bool {
  const levers = readColumn<EgeMechLever>(EgeMechLever.ID, EgeMechLever.SIZE)
  for (let i: u32 = 0; i < levers.count; i++) {
    const leverEntity = levers.entity(i)
    const lever = levers.at(i)
    const handle = getComponent<EgeTransform>(lever.handle, EgeTransform.ID, EgeTransform.SIZE)
    if (isNull<EgeTransform>(handle)) continue
    const dx = <f64>handle.pos_0 - x
    const dy = <f64>handle.pos_1 - y
    const dz = <f64>handle.pos_2 - z
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > lever.grab_range) continue
    ch.grab_target = -1
    ch.grab_lever = <i32>leverEntity
    ch.grab_ticks = 0
    return true
  }
  return false
}

// The engine mech pass runs before rf.character.pre, so this load takes effect next tick.
export function holdLever(entity: u32, ch: Character): void {
  if (ch.grab_lever < 0) return
  const existing = getComponent<EgeMechGrab>(entity, EgeMechGrab.ID, EgeMechGrab.SIZE)
  const grab = isNull<EgeMechGrab>(existing)
    ? newRecord<EgeMechGrab>(EgeMechGrab.SIZE)
    : existing
  const press = grab.press
  const pending = grab.pending
  grab.lever = <u32>ch.grab_lever
  grab.player = NO_ENTITY
  grab.held = 1
  grab.mass = <f32>CHAR_MASS
  grab.press = press
  grab.pending = pending
  setComponent<EgeMechGrab>(entity, EgeMechGrab.ID, EgeMechGrab.SIZE, grab)
}

export function releaseGrab(entity: u32, ch: Character): void {
  if (ch.grab_lever >= 0) {
    const grab = getComponent<EgeMechGrab>(entity, EgeMechGrab.ID, EgeMechGrab.SIZE)
    if (!isNull<EgeMechGrab>(grab)) {
      grab.held = 0
      setComponent<EgeMechGrab>(entity, EgeMechGrab.ID, EgeMechGrab.SIZE, grab)
    }
  }
  ch.grab_lever = -1
  ch.grab_target = -1
  ch.grab_ticks = 0
  ch.grab_cooldown = CHAR_GRAB_COOLDOWN_TICKS
}

export function grabPass(characters: Column<Character>, now: i32, dt: f64): void {
  for (let i: u32 = 0; i < characters.count; i++) {
    const entity = characters.entity(i)
    const ch = characters.at(i)
    if (ch.parked != 0) continue
    if (now < ch.protected_until) {
      if (ch.grab_target >= 0 || ch.grab_lever >= 0) releaseGrab(entity, ch)
      continue
    }
    let target = ch.grab_target
    if (ch.grab_lever >= 0) {
      scaleHorizontal(entity, ch, CHAR_GRAB_SLOW, dt)
    } else if (target >= 0) {
      const targetRow = characters.find(<u32>target)
      if (targetRow < 0) {
        releaseGrab(entity, ch)
        ch.mode = ch.grounded != 0 ? MODE_GROUND : MODE_AIR
        continue
      }
      const other = characters.at(<u32>targetRow)
      const p = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      const q = getComponent<EgeTransform>(<u32>target, EgeTransform.ID, EgeTransform.SIZE)
      if (other.parked != 0 || now < other.protected_until || isNull<EgeTransform>(p) || isNull<EgeTransform>(q) || distance(p, q) > CHAR_GRAB_RANGE) {
        releaseGrab(entity, ch)
        ch.mode = ch.grounded != 0 ? MODE_GROUND : MODE_AIR
        continue
      }
    } else {
      if ((ch.mode != MODE_GROUND && ch.mode != MODE_AIR) || ch.grab_cooldown > 0 || ch.slid != 0 || ch.carry != 0 || (ch.prev_buttons & BTN_GRAB_BIT) == 0) continue
      target = nearestInCone(characters, i, now)
      if (target < 0) continue
      ch.grab_target = target
      ch.grab_ticks = 0
      ch.mode = MODE_GRABBING
    }
    if (target >= 0) {
      const targetEntity = <u32>target
      const targetRow = characters.find(targetEntity)
      if (targetRow >= 0) scaleHorizontal(targetEntity, characters.at(<u32>targetRow), CHAR_GRAB_SLOW, dt)
    }
    const speed = Math.sqrt(ch.pre_vel_0 * ch.pre_vel_0 + ch.pre_vel_2 * ch.pre_vel_2)
    if (speed > CHAR_GRABBER_MAX_SPEED) scaleHorizontal(entity, ch, CHAR_GRABBER_MAX_SPEED / speed, dt)
  }
}

// show_character_ref child records own the entity-typed grab target and lever of their character
// (owner). Engine transfer remaps those fields; the numeric character fields mirror them for
// this tick. NO_ENTITY stands for "no reference", which the character stores as -1.
function entityOrNone(entity: u32): i32 {
  return entity == NO_ENTITY ? -1 : <i32>entity
}

export function pullGrabRefs(characters: Column<Character>, refs: Column<ShowCharacterRef>): void {
  for (let r: u32 = 0; r < refs.count; r++) {
    const ref = refs.at(r)
    const row = characters.find(ref.owner)
    if (row < 0) continue
    const ch = characters.at(<u32>row)
    ch.grab_target = entityOrNone(ref.target)
    ch.grab_lever = entityOrNone(ref.lever)
  }
}

// carry belongs to the feature owners that synchronize it; this pass leaves it unchanged.
export function pushGrabRefs(characters: Column<Character>, refs: Column<ShowCharacterRef>): void {
  for (let r: u32 = 0; r < refs.count; r++) {
    const ref = refs.at(r)
    const row = characters.find(ref.owner)
    if (row < 0) continue
    const ch = characters.at(<u32>row)
    ref.target = ch.grab_target >= 0 ? <u32>ch.grab_target : NO_ENTITY
    ref.lever = ch.grab_lever >= 0 ? <u32>ch.grab_lever : NO_ENTITY
  }
}

function nearestInCone(characters: Column<Character>, pRow: u32, now: i32): i32 {
  const pEntity = characters.entity(pRow)
  const p = getComponent<EgeTransform>(pEntity, EgeTransform.ID, EgeTransform.SIZE)
  if (isNull<EgeTransform>(p)) return -1
  let best: i32 = -1
  let bestDistance = CHAR_GRAB_RANGE
  for (let qRow: u32 = 0; qRow < characters.count; qRow++) {
    if (qRow == pRow) continue
    const qEntity = characters.entity(qRow)
    const qch = characters.at(qRow)
    if (qch.parked != 0 || now < qch.protected_until) continue
    const q = getComponent<EgeTransform>(qEntity, EgeTransform.ID, EgeTransform.SIZE)
    if (isNull<EgeTransform>(q)) continue
    const d = distance(p, q)
    if (d > bestDistance || (best >= 0 && d == bestDistance)) continue
    const dx = <f64>q.pos_0 - p.pos_0
    const dz = <f64>q.pos_2 - p.pos_2
    const horizontal = Math.sqrt(dx * dx + dz * dz)
    const facing = characters.at(pRow)
    if (horizontal == 0 || (facing.facing_0 * dx + facing.facing_1 * dz) / horizontal < CHAR_GRAB_CONE_DOT) continue
    best = <i32>qEntity
    bestDistance = d
  }
  return best
}

function distance(a: EgeTransform, b: EgeTransform): f64 {
  const dx = <f64>b.pos_0 - a.pos_0
  const dy = <f64>b.pos_1 - a.pos_1
  const dz = <f64>b.pos_2 - a.pos_2
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function scaleHorizontal(entity: u32, ch: Character, k: f64, dt: f64): void {
  ch.pre_vel_0 *= k
  ch.pre_vel_2 *= k
  setLinvel(entity, <f32>ch.pre_vel_0, <f32>(ch.pre_vel_1 + GRAVITY_Y * dt), <f32>ch.pre_vel_2)
}
