import { Column, emit, getComponent, isNull, newRecord, readColumn, readResource, setComponent, tick } from 'ege'
import {
  Character, CourseRes, CrownEvent, EgeRender, EgeTransform, Feature, FeatureCrown, FeatureCrownSeat,
  FeatureCrownVisual, Gate, RoundRes, Seat,
} from '../components.gen'
import { BTN_GRAB_BIT, MODE_AIR, MODE_DIVE, MODE_GROUND } from '../character/constants.as'
import { characterColumn, placeSeat, seatColumn } from '../lib/seats.as'
import { respawnSlotX, respawnSlotZ } from '../seat/respawn.as'

// packages/sim/src/match/roundSystem.ts:11: PlayerStatus.alive is 1.
const STATUS_ALIVE: u32 = 1
// E4 tint table: candy.tower base colour and the taken tint (tint 4 is 0x73D966).
const BASE_COLOR: u32 = 0xFFD140
const TAKEN_COLOR: u32 = 0x73D966
// packages/sim/src/features/crown.ts:104: the reset period is never shorter than ten seconds.
const RESET_MIN_TICKS: i32 = 600

function distance2(ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64): f64 {
  const dx = ax - bx
  const dy = ay - by
  const dz = az - bz
  return dx * dx + dy * dy + dz * dz
}

// packages/sim/src/features/seatState.ts: contested feature interactions use ascending room seat.
function orderedRows(seats: Column<Seat>): Array<u32> {
  const rows = new Array<u32>()
  for (let rank: u32 = 0; rank < seats.count; rank++) {
    for (let i: u32 = 0; i < seats.count; i++) {
      if (seats.at(i).seat == rank) {
        rows.push(i)
        break
      }
    }
  }
  return rows
}

function seatStateRow(states: Column<FeatureCrownSeat>, owner: u32, rank: u32): i32 {
  for (let i: u32 = 0; i < states.count; i++) {
    const state = states.at(i)
    if (state.owner == owner && state.seat == rank) return <i32>i
  }
  return -1
}

// packages/sim/src/features/crown.ts:58-61: the crossing fraction is the share of the last step
// that spent inside the grab range, mapped to the u16 sub-tick.
function crossingSub(prev: f64, d: f64, range: f64): i32 {
  if (!(prev > range)) return 0
  const span = prev - d
  if (!(span > 0)) return 0
  return <i32>Math.max(0.0, Math.min(65535.0, Math.round(65535.0 * (prev - range) / span)))
}

// packages/sim/src/character/system.ts:285-300: a teleport keeps the seat's facing and clears the
// grounded state; the transform mirror moves in the same tick so the reset reads back at once.
function teleportSeat(entity: u32, ch: Character, x: f64, y: f64, z: f64, fx: f64, fz: f64, now: i32): void {
  ch.grounded = 0
  ch.ground_obstacle = -1
  ch.ground_item = -1
  ch.ground_body = -1
  ch.coyote = 0
  ch.jump_buffer = 0
  ch.teleport_tick = now
  placeSeat(entity, ch, x, y, z, fx, fz)
  ch.parked = 0
  const at = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
  if (isNull<EgeTransform>(at)) return
  at.pos_0 = <f32>x
  at.pos_1 = <f32>(y + ch.stand + 0.01)
  at.pos_2 = <f32>z
  at.rot_0 = 0
  at.rot_1 = 0
  at.rot_2 = 0
  at.rot_3 = 1
  setComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE, at)
}

// packages/sim/src/features/crown.ts:88-101: at the cap every alive seat returns to the first
// checkpoint respawn, spread over the source respawn slot grid in ascending room seat.
function resetToCheckpoint(
  feature: FeatureCrown, owner: u32, course: CourseRes, gates: Column<Gate>, states: Column<FeatureCrownSeat>,
  seats: Column<Seat>, characters: Column<Character>, now: i32,
): void {
  let bx: f64 = 0
  let by: f64 = 0
  let bz: f64 = 0
  let fx: f64 = 0
  let fz: f64 = 1
  let found = false
  for (let g: u32 = 0; g < gates.count; g++) {
    if (gates.at(g).index != 0) continue
    const gate = gates.at(g)
    bx = gate.respawn_t_0
    by = gate.respawn_t_1
    bz = gate.respawn_t_2
    fx = gate.respawn_facing_0
    fz = gate.respawn_facing_1
    found = true
    break
  }
  if (!found) return
  const order = orderedRows(seats)
  let slot: u32 = 0
  for (let k: u32 = 0; k < <u32>order.length; k++) {
    const row = order[k]
    const seat = seats.at(row)
    if (seat.status != STATUS_ALIVE) continue
    const x = respawnSlotX(bx, bz, fx, fz, slot, course.slots, course.spacing_m)
    const z = respawnSlotZ(bx, bz, fx, fz, slot, course.slots, course.spacing_m)
    slot++
    const entity = seats.entity(row)
    const chRow = characters.find(entity)
    if (chRow >= 0) teleportSeat(entity, characters.at(<u32>chRow), x, by, z, fx, fz, now)
    const stateRow = seatStateRow(states, owner, seat.seat)
    if (stateRow >= 0) {
      states.at(<u32>stateRow).prev_dist = Math.sqrt(
        distance2(x, by, z, feature.t_0, feature.t_1, feature.t_2),
      )
    }
  }
}

// no handoff: Emit the crown and contender distance state supplies the feature_crown,
// feature_crown_seat and feature_crown_visual records this system reads; its crown module has no
// callable entry point for the behaviour.
// no handoff: Emit carry items and their persistent records takes nothing from this card.
export function rf_feature_crown_post(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const course = readResource<CourseRes>(CourseRes.ID, CourseRes.SIZE)
  const features = readColumn<FeatureCrown>(FeatureCrown.ID, FeatureCrown.SIZE)
  const states = readColumn<FeatureCrownSeat>(FeatureCrownSeat.ID, FeatureCrownSeat.SIZE)
  const visuals = readColumn<FeatureCrownVisual>(FeatureCrownVisual.ID, FeatureCrownVisual.SIZE)
  const gates = readColumn<Gate>(Gate.ID, Gate.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick()
  const capEnd = <i32>round.round_ticks + <i32>round.overtime_ticks

  for (let f: u32 = 0; f < features.count; f++) {
    const feature = features.at(f)
    const entity = features.entity(f)
    const owner = getComponent<Feature>(entity, Feature.ID, Feature.SIZE).index
    const order = orderedRows(seats)

    // Script initialization: the source sets the reset tick and every contender's previous distance
    // before its first post step (crown.ts:33-40), so the first tick can already report a crossing.
    if (feature.placed == 0) {
      feature.placed = 1
      feature.next_reset_tick = capEnd
      for (let k: u32 = 0; k < <u32>order.length; k++) {
        const row = order[k]
        const stateRow = seatStateRow(states, owner, seats.at(row).seat)
        if (stateRow < 0) continue
        const at = getComponent<EgeTransform>(seats.entity(row), EgeTransform.ID, EgeTransform.SIZE)
        if (isNull<EgeTransform>(at)) continue
        states.at(<u32>stateRow).prev_dist = Math.sqrt(
          distance2(at.pos_0, at.pos_1, at.pos_2, feature.t_0, feature.t_1, feature.t_2),
        )
      }
    }

    // packages/sim/src/features/crown.ts:44-73: every qualifying contender emits on the first grab
    // tick; taken only flips after the loop so simultaneous grabs are all reported.
    let grabbed = false
    for (let k: u32 = 0; k < <u32>order.length; k++) {
      const row = order[k]
      const seat = seats.at(row)
      const entity = seats.entity(row)
      const stateRow = seatStateRow(states, owner, seat.seat)
      const chRow = characters.find(entity)
      const at = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      if (stateRow < 0 || chRow < 0 || isNull<EgeTransform>(at)) continue
      const ch = characters.at(<u32>chRow)
      const state = states.at(<u32>stateRow)
      const d = Math.sqrt(distance2(at.pos_0, at.pos_1, at.pos_2, feature.t_0, feature.t_1, feature.t_2))
      const grabbing = (ch.prev_buttons & BTN_GRAB_BIT) != 0
      const protectedNow = ch.protected_until >= 0 && now < ch.protected_until
      const mode = ch.mode
      if (now >= 0 && feature.taken == 0 && seat.status == STATUS_ALIVE &&
        (mode == MODE_GROUND || mode == MODE_AIR || mode == MODE_DIVE) &&
        !protectedNow && grabbing && d <= feature.grab_range_m) {
        const event = newRecord<CrownEvent>(CrownEvent.SIZE)
        event.seat = seat.seat
        event.a = crossingSub(state.prev_dist, d, feature.grab_range_m)
        event.b = 0
        emit<CrownEvent>(CrownEvent.ID, entity, event, CrownEvent.SIZE)
        grabbed = true
      }
      state.prev_dist = d
    }
    if (grabbed) feature.taken = 1

    // packages/sim/src/features/crown.ts:86-101: an untaken crown returns every alive seat to CP1
    // once the cap passes, then again every max(600, overtime) ticks.
    if (feature.taken == 0 && now >= 0 && now >= capEnd && now >= feature.next_reset_tick) {
      resetToCheckpoint(feature, owner, course, gates, states, seats, characters, now)
      const interval = <i32>Math.max(<f64>RESET_MIN_TICKS, <f64>round.overtime_ticks)
      feature.next_reset_tick = capEnd + (<i32>Math.floor(<f64>(now - capEnd) / <f64>interval) + 1) * interval
    }

    // packages/sim/src/features/crown.ts:114: the source draws the taken crown in tint 4.
    const color = feature.taken != 0 ? TAKEN_COLOR : BASE_COLOR
    for (let v: u32 = 0; v < visuals.count; v++) {
      const visual = visuals.at(v)
      if (visual.owner != owner) continue
      const visualEntity = visuals.entity(v)
      const render = getComponent<EgeRender>(visualEntity, EgeRender.ID, EgeRender.SIZE)
      if (isNull<EgeRender>(render)) continue
      if (render.color == color) continue
      render.color = color
      setComponent<EgeRender>(visualEntity, EgeRender.ID, EgeRender.SIZE, render)
    }
  }
  features.write()
  states.write()
}
