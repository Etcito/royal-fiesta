import { bodyType, boxShape, despawn, getComponent, isNull, newRecord, overlap, pose, readColumn, readResource, setComponent, spawn, tick } from 'ege'
import { Character, EgeTransform, FeatureBank, FeatureBankInside, RoundRes, Seat, TeamScoreEvent } from '../components.gen'
import { inBox } from '../lib/boxes.as'
import { recordShowEvent } from '../lib/show_events.as'

// packages/sim/src/features/bank.ts:60-65: carried objects are excluded near the hand.
const HAND_FORWARD: f64 = 0.55
const HAND_UP: f64 = 0.25
const HAND_RADIUS2: f64 = 0.2 * 0.2
const DEBRIS: u32 = 8

function distance2(x: f64, y: f64, z: f64, a: f64, b: f64, c: f64): f64 {
  const dx = x - a
  const dy = y - b
  const dz = z - c
  return dx * dx + dy * dy + dz * dz
}

// The G6 team_score payload is unchanged; recordShowEvent also folds the delta into this bank's
// cumulative ShowTeamContribution row for the team (one row per owner and team, never a second one).
function score(owner: u32, team: i32, delta: i32): void {
  recordShowEvent(TeamScoreEvent.ID, owner, <u32>team, delta, 0)
}

export function rf_feature_bank_post(): void {
  const banks = readColumn<FeatureBank>(FeatureBank.ID, FeatureBank.SIZE)
  const inside = readColumn<FeatureBankInside>(FeatureBankInside.ID, FeatureBankInside.SIZE)
  const seats = readColumn<Seat>(Seat.ID, Seat.SIZE)
  const characters = readColumn<Character>(Character.ID, Character.SIZE)
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const playing = tick() >= round.intro_ticks

  for (let b: u32 = 0; b < banks.count; b++) {
    const bank = banks.at(b)
    const owner = banks.entity(b)
    const shape = boxShape(<f32>bank.half_0, <f32>bank.half_1, <f32>bank.half_2)
    const at = pose(<f32>bank.center_0, <f32>bank.center_1, <f32>bank.center_2)
    let hits = overlap(shape, at, DEBRIS, 16)
    if (!isNull(hits) && hits.total > hits.count) hits = overlap(shape, at, DEBRIS, hits.total)
    const found = new Array<u32>()
    if (!isNull(hits)) {
      for (let h: u32 = 0; h < hits.count; h++) {
        const item = hits.at(h)
        if (h > 0 && item == hits.at(h - 1)) continue
        if (bodyType(item) != 1) continue
        const t = getComponent<EgeTransform>(item, EgeTransform.ID, EgeTransform.SIZE)
        if (isNull(t) || !inBox(bank.center_0, bank.center_1, bank.center_2,
          bank.half_0, bank.half_1, bank.half_2, t.pos_0, t.pos_1, t.pos_2)) continue
        let carried = false
        let nearest: i32 = -1
        let best: f64 = Infinity
        let bestSeat: u32 = 0xffffffff
        for (let s: u32 = 0; s < seats.count; s++) {
          const seat = seats.at(s)
          const entity = seats.entity(s)
          const st = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
          if (isNull(st)) continue
          const chRow = characters.find(entity)
          if (chRow >= 0) {
            const ch = characters.at(<u32>chRow)
            if (ch.carry == 1 && distance2(t.pos_0, t.pos_1, t.pos_2,
              st.pos_0 + ch.facing_0 * HAND_FORWARD, st.pos_1 + HAND_UP,
              st.pos_2 + ch.facing_1 * HAND_FORWARD) <= HAND_RADIUS2) carried = true
          }
          if (seat.status != 1) continue
          const d = distance2(t.pos_0, t.pos_1, t.pos_2, st.pos_0, st.pos_1, st.pos_2)
          if (d < best || (d == best && seat.seat < bestSeat)) {
            best = d
            bestSeat = seat.seat
            nearest = <i32>seat.team
          }
        }
        if (carried) continue
        found.push(item)
        let previous = false
        for (let i: u32 = 0; i < inside.count; i++) {
          const record = inside.at(i)
          if (record.owner == owner && record.item == item) { previous = true; break }
        }
        if (previous) continue
        const team = bank.team >= 0 ? bank.team : nearest
        const record = newRecord<FeatureBankInside>(FeatureBankInside.SIZE)
        record.owner = owner
        record.item = item
        record.team = team
        setComponent<FeatureBankInside>(spawn(), FeatureBankInside.ID, FeatureBankInside.SIZE, record)
        if (playing && team >= 0) score(owner, team, 1)
      }
    }
    for (let i: u32 = 0; i < inside.count; i++) {
      const record = inside.at(i)
      if (record.owner != owner) continue
      let present = false
      for (let j = 0; j < found.length; j++) if (found[j] == record.item) { present = true; break }
      if (present) continue
      if (playing && record.team >= 0) score(owner, record.team, -1)
      despawn(inside.entity(i))
    }
  }
}
