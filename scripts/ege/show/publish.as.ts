import { newRecord, readColumn, setComponent, spawn, tick } from 'ege'
import {
  EgeZoneId, EgeZoneOutbox, ShowResultA, ShowResultB, ShowSeatIdentity, ShowTeamContribution,
} from '../components.gen'

// G7.3 cumulative publication. Every seat field is a nonphysical zone child whose stable id is
// 65536 + roomSeat*32 + fieldRank and whose owner is the seat's round seat; the engine's outbox
// writes {key: zone id, kind: fieldRank, value, tick} (engine crates/ege-physics/src/zone.rs:1371).
// Team contributions use the separate range beginning 131072, indexed by authored feature index
// and team with the same 32-wide stride.
const SEAT_ZONE_BASE: u32 = 65536
const TEAM_ZONE_BASE: u32 = 131072
const ZONE_STRIDE: u32 = 32
const ROOM_SEAT_LAST: u32 = 59
const FIELD_COUNT: u32 = 19

function seatZoneId(roomSeat: u32, field: u32): u32 {
  return SEAT_ZONE_BASE + roomSeat * ZONE_STRIDE + field
}

function teamZoneId(feature: u32, team: u32): u32 {
  return TEAM_ZONE_BASE + feature * ZONE_STRIDE + team
}

function valuesOf(roomSeat: u32, a: ShowResultA, b: ShowResultB): StaticArray<i32> {
  const values = new StaticArray<i32>(<i32>FIELD_COUNT)
  values[0] = <i32>roomSeat
  values[1] = a.status
  values[2] = a.finish_tick
  values[3] = a.finish_sub
  values[4] = a.lap
  values[5] = a.stage
  values[6] = a.route_mm
  values[7] = a.falls
  values[8] = a.score
  values[9] = a.last_score_tick
  values[10] = b.hold_ticks
  values[11] = <i32>b.possessing
  values[12] = b.last_acquire_tick
  values[13] = b.matches
  values[14] = b.cross_ticks
  values[15] = b.out_tick
  values[16] = b.out_sub
  values[17] = b.team
  values[18] = b.opening_rank
  return values
}

function writeSeatField(
  entity: u32, fresh: bool, id: u32, owner: u32, group: u32, field: u32, value: i32, now: i32,
): void {
  if (fresh) {
    const zone = newRecord<EgeZoneId>(EgeZoneId.SIZE)
    zone.id = id
    zone.owner = owner
    zone.group = group
    setComponent<EgeZoneId>(entity, EgeZoneId.ID, EgeZoneId.SIZE, zone)
  }
  const out = newRecord<EgeZoneOutbox>(EgeZoneOutbox.SIZE)
  out.kind = field
  out.value = <u32>value
  out.tick = <i32>now
  setComponent<EgeZoneOutbox>(entity, EgeZoneOutbox.ID, EgeZoneOutbox.SIZE, out)
}

function writeTeamField(entity: u32, fresh: bool, id: u32, kind: u32, value: i32, now: i32): void {
  if (fresh) {
    const zone = newRecord<EgeZoneId>(EgeZoneId.SIZE)
    zone.id = id
    zone.owner = 0
    zone.group = 1
    setComponent<EgeZoneId>(entity, EgeZoneId.ID, EgeZoneId.SIZE, zone)
  }
  const out = newRecord<EgeZoneOutbox>(EgeZoneOutbox.SIZE)
  out.kind = kind
  out.value = <u32>value
  out.tick = <i32>now
  setComponent<EgeZoneOutbox>(entity, EgeZoneOutbox.ID, EgeZoneOutbox.SIZE, out)
}

/**
 * Publishes every changed cumulative seat record and team contribution as engine outbox children.
 * A seat is republished as a complete nineteen-field batch (all fields share the produced tick), so
 * the ledger can assemble it by stable identity; unchanged seats are not touched. Existing children
 * are found by their stable zone id, matching what scene construction emits.
 */
export function rf_show_publish(): void {
  const results = readColumn<ShowResultA>(ShowResultA.ID, ShowResultA.SIZE)
  if (results.count == 0) return
  const bRows = readColumn<ShowResultB>(ShowResultB.ID, ShowResultB.SIZE)
  const identities = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)
  const zones = readColumn<EgeZoneId>(EgeZoneId.ID, EgeZoneId.SIZE)
  const outs = readColumn<EgeZoneOutbox>(EgeZoneOutbox.ID, EgeZoneOutbox.SIZE)
  const children = new StaticArray<u32>(<i32>(ROOM_SEAT_LAST + 1) * <i32>ZONE_STRIDE)
  for (let z: u32 = 0; z < zones.count; z++) {
    const id = zones.at(z).id
    if (id < SEAT_ZONE_BASE) continue
    const offset = id - SEAT_ZONE_BASE
    if (offset >= (ROOM_SEAT_LAST + 1) * ZONE_STRIDE) continue
    children[<i32>offset] = zones.entity(z)
  }
  const now = <i32>tick()
  for (let i: u32 = 0; i < results.count; i++) {
    const a = results.at(i)
    const entity = results.entity(i)
    let roomSeat = <u32>a.seat
    let roundSeat = i
    const identityRow = identities.find(entity)
    if (identityRow >= 0) {
      const identity = identities.at(<u32>identityRow)
      roomSeat = identity.room_seat
      roundSeat = identity.round_seat
    }
    if (roomSeat > ROOM_SEAT_LAST) continue
    const bRow = bRows.find(entity)
    const b = newRecord<ShowResultB>(ShowResultB.SIZE)
    if (bRow >= 0) {
      const source = bRows.at(<u32>bRow)
      b.hold_ticks = source.hold_ticks
      b.possessing = source.possessing
      b.last_acquire_tick = source.last_acquire_tick
      b.matches = source.matches
      b.cross_ticks = source.cross_ticks
      b.out_tick = source.out_tick
      b.out_sub = source.out_sub
      b.team = source.team
      b.opening_rank = source.opening_rank
    }
    const values = valuesOf(roomSeat, a, b)
    let changed = false
    for (let field: u32 = 0; field < FIELD_COUNT; field++) {
      const child = children[<i32>(roomSeat * ZONE_STRIDE + field)]
      if (child == 0) {
        changed = true
        break
      }
      const outRow = outs.find(child)
      if (outRow < 0 || outs.at(<u32>outRow).value != <u32>values[<i32>field]) {
        changed = true
        break
      }
    }
    if (!changed) continue
    for (let field: u32 = 0; field < FIELD_COUNT; field++) {
      const offset = <i32>(roomSeat * ZONE_STRIDE + field)
      let child = children[offset]
      const fresh = child == 0
      if (fresh) {
        child = spawn()
        children[offset] = child
      }
      writeSeatField(child, fresh, seatZoneId(roomSeat, field), roundSeat, roomSeat + 1, field, values[<i32>field], now)
    }
  }

  const teams = readColumn<ShowTeamContribution>(ShowTeamContribution.ID, ShowTeamContribution.SIZE)
  if (teams.count == 0) return
  const capacity = <i32>(zones.count + teams.count)
  const teamChildren = new StaticArray<u32>(capacity)
  const teamKeys = new StaticArray<u32>(capacity)
  let teamCount = 0
  for (let z: u32 = 0; z < zones.count; z++) {
    const id = zones.at(z).id
    if (id < TEAM_ZONE_BASE) continue
    teamKeys[teamCount] = id
    teamChildren[teamCount] = zones.entity(z)
    teamCount++
  }
  for (let t: u32 = 0; t < teams.count; t++) {
    const row = teams.at(t)
    if (row.team >= ZONE_STRIDE) continue
    const id = teamZoneId(row.feature, row.team)
    let child = 0
    for (let k: i32 = 0; k < teamCount; k++) {
      if (teamKeys[k] == id) {
        child = teamChildren[k]
        break
      }
    }
    let fresh = false
    if (child != 0) {
      const outRow = outs.find(child)
      if (outRow >= 0 && outs.at(<u32>outRow).value == <u32>row.value) continue
    } else {
      child = spawn()
      fresh = true
      if (teamCount < capacity) {
        teamKeys[teamCount] = id
        teamChildren[teamCount] = child
        teamCount++
      }
    }
    writeTeamField(child, fresh, id, row.team, row.value, now)
  }
}
