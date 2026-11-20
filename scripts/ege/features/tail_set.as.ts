import { Column, emit, getComponent, isNull, newRecord, readColumn, readResource, rng, setComponent, tick } from 'ege'
import {
  Character, EgeRender, EgeTransform, Feature, FeatureTailSet, FeatureTailSetSeat, PossessEvent, RoundRes, Seat,
} from '../components.gen'
import {
  BTN_GRAB_BIT, CARRY_NONE, CARRY_TAIL, CHAR_GRAB_RANGE, MODE_AIR, MODE_GROUND, MODE_PARKED,
} from '../character/constants.as'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { ticksOf } from '../lib/units.as'

// packages/sim/src/match/roundSystem.ts:11: PlayerStatus.alive is 1.
const STATUS_ALIVE: u32 = 1
// packages/sim/src/features/tails.ts:137: an unchanged holder re-announces its tail every 60 round ticks.
const REFRESH_TICKS: i32 = 60
// packages/sim/src/features/tails.ts:105: the free pool saturates at the u8 snapshot field's maximum.
const MAX_FREE_TAILS: u32 = 255

function distance2(ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64): f64 {
  const dx = ax - bx
  const dy = ay - by
  const dz = az - bz
  return dx * dx + dy * dy + dz * dz
}

// packages/sim/src/features/seatState.ts: contested interactions use ascending room seat.
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

function seatRowOf(seats: Column<Seat>, rank: u32): i32 {
  for (let i: u32 = 0; i < seats.count; i++) {
    if (seats.at(i).seat == rank) return <i32>i
  }
  return -1
}

function stateOf(states: Column<FeatureTailSetSeat>, owner: u32, rank: u32): i32 {
  for (let i: u32 = 0; i < states.count; i++) {
    const state = states.at(i)
    if (state.owner == owner && state.seat == rank) return <i32>i
  }
  return -1
}

function setCarry(characters: Column<Character>, entity: u32, kind: u32, id: i32): void {
  const row = characters.find(entity)
  if (row < 0) return
  const ch = characters.at(<u32>row)
  ch.carry = kind
  ch.carry_id = id
}

// packages/sim/src/features/tails.ts:53-58: a holder carries the tail mark and emits possess 1.
function hold(states: Column<FeatureTailSetSeat>, characters: Column<Character>, entity: u32,
  owner: u32, rank: u32, now: i32, immunityTicks: i32): void {
  const row = stateOf(states, owner, rank)
  if (row >= 0) {
    const state = states.at(<u32>row)
    state.has_tail = 1
    state.immune_until = now + immunityTicks
  }
  setCarry(characters, entity, CARRY_TAIL, 0)
  const event = newRecord<PossessEvent>(PossessEvent.SIZE)
  event.seat = rank
  event.a = 1
  event.b = 0
  emit<PossessEvent>(PossessEvent.ID, entity, event, PossessEvent.SIZE)
}

function possess(entity: u32, rank: u32, a: i32): void {
  const event = newRecord<PossessEvent>(PossessEvent.SIZE)
  event.seat = rank
  event.a = a
  event.b = 0
  emit<PossessEvent>(PossessEvent.ID, entity, event, PossessEvent.SIZE)
}

// no handoff: Emit tail sets and per-seat state supplies the feature_tail_set and
// feature_tail_set_seat records this system reads; the tailSet emitter has no callable entry point
// for the behaviour. It also leaves the seat visuals invisible, so this card owns show/hide.
// no handoff: Emit carry items and their persistent records takes nothing from this card.
export function rf_feature_tail_set_pre(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const features = readColumn<FeatureTailSet>(FeatureTailSet.ID, FeatureTailSet.SIZE)
  const states = readColumn<FeatureTailSetSeat>(FeatureTailSetSeat.ID, FeatureTailSetSeat.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick()
  const playing = now >= <i32>round.intro_ticks
  const roundTick = now - <i32>round.intro_ticks

  for (let f: u32 = 0; f < features.count; f++) {
    const feature = features.at(f)
    const root = getComponent<Feature>(features.entity(f), Feature.ID, Feature.SIZE)
    const owner = root.index
    const immunityTicks = ticksOf(feature.immunity_s)
    const order = orderedRows(seats)
    const seatCount = <u32>order.length

    // packages/sim/src/features/tails.ts:70-90: half (floor of the seat count) or the clamped count
    // is handed out once on the first round tick by a partial Fisher-Yates over ascending room seat.
    if (feature.assigned == 0 && playing) {
      feature.assigned = 1
      const picks = order.slice(0)
      const n = feature.count < 0 ? seats.count / 2 :
        (<u32>feature.count < seats.count ? <u32>feature.count : seats.count)
      for (let i: u32 = 0; i < n; i++) {
        const j = i + rng(root.salt) % (picks.length - i)
        const swap = picks[i]
        picks[i] = picks[j]
        picks[j] = swap
        const slot = picks[i]
        const rank = seats.at(slot).seat
        const row = stateOf(states, owner, rank)
        if (row < 0) continue
        states.at(<u32>row).has_tail = 1
        const entity = seats.entity(slot)
        setCarry(characters, entity, CARRY_TAIL, 0)
        possess(entity, rank, 1)
      }
    }

    // packages/sim/src/features/tails.ts:92-103: a dead or parked holder drops its tail to the pile.
    for (let k: u32 = 0; k < seatCount; k++) {
      const slot = order[k]
      const rank = seats.at(slot).seat
      const row = stateOf(states, owner, rank)
      if (row < 0) continue
      const state = states.at(<u32>row)
      if (state.has_tail == 0) continue
      const entity = seats.entity(slot)
      const chRow = characters.find(entity)
      if (chRow >= 0) {
        const ch = characters.at(<u32>chRow)
        if (seats.at(slot).status == STATUS_ALIVE && ch.mode != MODE_PARKED) continue
      }
      state.has_tail = 0
      state.immune_until = 0
      if (feature.free_tails < MAX_FREE_TAILS) feature.free_tails++
      setCarry(characters, entity, CARRY_NONE, -1)
      possess(entity, rank, 0)
    }

    // packages/sim/src/features/tails.ts:104-137: one theft per holder per tick; an immune holder is
    // skipped and a transferred holder cannot be picked again in the same tick.
    const taken = new Array<u32>()
    for (let k: u32 = 0; k < seatCount; k++) {
      const slot = order[k]
      const rank = seats.at(slot).seat
      const row = stateOf(states, owner, rank)
      if (row < 0) continue
      const state = states.at(<u32>row)
      const entity = seats.entity(slot)
      const chRow = characters.find(entity)
      if (chRow < 0) continue
      const ch = characters.at(<u32>chRow)
      const grab = (ch.prev_buttons & BTN_GRAB_BIT) != 0
      const pressed = grab && state.prev_grab == 0
      state.prev_grab = grab ? 1 : 0
      if (!pressed || state.has_tail != 0 || ch.carry != CARRY_NONE) continue
      if (seats.at(slot).status != STATUS_ALIVE) continue
      if (ch.protected_until >= 0 && now < ch.protected_until) continue
      if (ch.mode != MODE_GROUND && ch.mode != MODE_AIR) continue
      const at = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      if (isNull<EgeTransform>(at)) continue
      const px = <f64>at.pos_0
      const py = <f64>at.pos_1
      const pz = <f64>at.pos_2
      let best: i32 = -1
      let bestSlot: u32 = 0
      let bestD = CHAR_GRAB_RANGE * CHAR_GRAB_RANGE
      for (let j: u32 = 0; j < seatCount; j++) {
        const holderSlot = order[j]
        const holderRank = seats.at(holderSlot).seat
        const holderRow = stateOf(states, owner, holderRank)
        if (holderRow < 0) continue
        const holder = states.at(<u32>holderRow)
        if (holder.has_tail == 0 || holder.immune_until > now) continue
        let already = false
        for (let t: u32 = 0; t < <u32>taken.length; t++) if (taken[t] == holderSlot) { already = true; break }
        if (already) continue
        const other = getComponent<EgeTransform>(seats.entity(holderSlot), EgeTransform.ID, EgeTransform.SIZE)
        if (isNull<EgeTransform>(other)) continue
        const d = distance2(px, py, pz, other.pos_0, other.pos_1, other.pos_2)
        // The tie rule keeps the first holder in ascending room seat.
        if (d <= bestD && (best < 0 || d < bestD)) {
          best = holderRow
          bestSlot = holderSlot
          bestD = d
        }
      }
      if (best >= 0) {
        const bestState = states.at(<u32>best)
        const holderRank = bestState.seat
        bestState.has_tail = 0
        bestState.immune_until = 0
        taken.push(bestSlot)
        setCarry(characters, seats.entity(bestSlot), CARRY_NONE, -1)
        possess(seats.entity(bestSlot), holderRank, 0)
        hold(states, characters, entity, owner, rank, now, immunityTicks)
        continue
      }
      if (feature.free_tails > 0 &&
        distance2(px, py, pz, feature.spawn_0, feature.spawn_1, feature.spawn_2) <= CHAR_GRAB_RANGE * CHAR_GRAB_RANGE) {
        feature.free_tails--
        hold(states, characters, entity, owner, rank, now, immunityTicks)
      }
    }

    // packages/sim/src/features/tails.ts:138-143: every held tail is re-announced each 60 round ticks.
    if (roundTick > 0 && roundTick % REFRESH_TICKS == 0) {
      for (let k: u32 = 0; k < seatCount; k++) {
        const slot = order[k]
        const rank = seats.at(slot).seat
        const row = stateOf(states, owner, rank)
        if (row < 0) continue
        if (states.at(<u32>row).has_tail == 0) continue
        possess(seats.entity(slot), rank, 1)
      }
    }
  }
  features.write()
  states.write()
  characters.write()
}

// packages/sim/src/features/tails.ts:203-224: the source draws one floor disc at each holder's seat
// after the step; this post system keeps that timing with the seat child visuals the emitter hides.
export function rf_feature_tail_set_post(): void {
  const features = readColumn<FeatureTailSet>(FeatureTailSet.ID, FeatureTailSet.SIZE)
  const states = readColumn<FeatureTailSetSeat>(FeatureTailSetSeat.ID, FeatureTailSetSeat.SIZE)
  const seats = seatColumn()
  for (let f: u32 = 0; f < features.count; f++) {
    const root = getComponent<Feature>(features.entity(f), Feature.ID, Feature.SIZE)
    const owner = root.index
    for (let s: u32 = 0; s < states.count; s++) {
      const state = states.at(s)
      if (state.owner != owner) continue
      const entity = states.entity(s)
      const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
      if (isNull<EgeRender>(render)) continue
      const visible = state.has_tail != 0 ? 1 : 0
      if (render.visible != visible) {
        render.visible = visible
        setComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE, render)
      }
      if (visible == 0) continue
      const row = seatRowOf(seats, state.seat)
      if (row < 0) continue
      const seatAt = getComponent<EgeTransform>(seats.entity(<u32>row), EgeTransform.ID, EgeTransform.SIZE)
      if (isNull<EgeTransform>(seatAt)) continue
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      if (isNull<EgeTransform>(transform)) continue
      transform.pos_0 = seatAt.pos_0
      transform.pos_1 = seatAt.pos_1
      transform.pos_2 = seatAt.pos_2
      setComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
    }
  }
}
