import { Column, despawn, newRecord, readColumn, setComponent, spawn } from 'ege'
import {
  EgeZoneInbox, ShowPending, ShowPublish, ShowResultA, ShowResultB, ShowTeamContribution,
} from '../components.gen'

// G7.3 cumulative ingestion. The engine hands every outbox entry of a source domain to the rules
// world as an ege.zone.inbox row {source, key, kind, value, tick} (engine
// crates/ege-physics/src/zone.rs:1695). Seat fields use key 65536+roomSeat*32+fieldRank; team
// contributions use 131072+authoredFeatureIndex*32+team. The rules world keeps incomplete batches
// in show_pending, accepted values and their produced tick in show_publish, and cumulative team
// contributions in show_team_contribution; all three are snapshot state.
const SEAT_ZONE_BASE: u32 = 65536
const TEAM_ZONE_BASE: u32 = 131072
const ZONE_STRIDE: u32 = 32
const ROOM_SEAT_LAST: u32 = 59
const TEAM_LAST: u32 = 31
const FIELD_COUNT: u32 = 19
const COMPLETE_MASK: u32 = 0x7ffff

const FIELD_STATUS: u32 = 1
const FIELD_FINISH_TICK: u32 = 2
const FIELD_FINISH_SUB: u32 = 3
const FIELD_LAP: u32 = 4
const FIELD_STAGE: u32 = 5
const FIELD_ROUTE_MM: u32 = 6
const FIELD_FALLS: u32 = 7
const FIELD_SCORE: u32 = 8
const FIELD_LAST_SCORE_TICK: u32 = 9
const FIELD_HOLD_TICKS: u32 = 10
const FIELD_POSSESSING: u32 = 11
const FIELD_LAST_ACQUIRE_TICK: u32 = 12
const FIELD_MATCHES: u32 = 13
const FIELD_CROSS_TICKS: u32 = 14
const FIELD_OUT_TICK: u32 = 15
const FIELD_OUT_SUB: u32 = 16
const FIELD_TEAM: u32 = 17
const FIELD_OPENING_RANK: u32 = 18

function fail(message: string): void {
  abort(message, 'scripts/ege/show/ledger.as.ts', 0, 0)
}

function seatRoom(key: u32): i32 {
  if (key < SEAT_ZONE_BASE) return -1
  const offset = key - SEAT_ZONE_BASE
  if (offset >= (ROOM_SEAT_LAST + 1) * ZONE_STRIDE) return -1
  return <i32>(offset / ZONE_STRIDE)
}

function seatField(key: u32): i32 {
  return <i32>((key - SEAT_ZONE_BASE) % ZONE_STRIDE)
}

class Fragment {
  room: i32 = -1
  field: i32 = -1
  tick: i32 = -1
  value: i32 = 0
  source: u32 = 0
  entry: u32 = 0
  stored: bool = false
}

class Batch {
  room: i32 = -1
  tick: i32 = -1
  mask: u32 = 0
  values: StaticArray<i32> = new StaticArray<i32>(<i32>FIELD_COUNT)
}

class TeamRow {
  feature: u32 = 0
  team: u32 = 0
  value: i32 = 0
  tick: i32 = -1
  entity: u32 = 0
}

function findFragment(rows: Array<Fragment>, key: u32, tick: i32): i32 {
  const room = seatRoom(key)
  const field = seatField(key)
  for (let i: i32 = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.room == room && row.field == field && row.tick == tick) return i
  }
  return -1
}

function findBatch(rows: Array<Batch>, room: i32, at: i32): i32 {
  for (let i: i32 = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.room == room && row.tick == at) return i
  }
  return -1
}

function findTeam(rows: Array<TeamRow>, feature: u32, team: u32): i32 {
  for (let i: i32 = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.feature == feature && row.team == team) return i
  }
  return -1
}

function writePending(source: u32, key: u32, kind: u32, value: i32, at: i32): u32 {
  const entity = spawn()
  const row = newRecord<ShowPending>(ShowPending.SIZE)
  row.owner = 0
  row.source = source
  row.key = key
  row.kind = kind
  row.value = value
  row.tick = at
  setComponent<ShowPending>(entity, ShowPending.ID, ShowPending.SIZE, row)
  return entity
}

function applyBatch(
  batch: Batch, canonical: StaticArray<u32>, aRows: Column<ShowResultA>,
  pubEntities: StaticArray<u32>, acceptedValues: StaticArray<i32>, acceptedTicks: StaticArray<i32>,
): void {
  const room = batch.room
  const values = batch.values
  let entity = canonical[<i32>room]
  const aRow = entity != 0 ? aRows.find(entity) : -1
  if (entity == 0) {
    entity = spawn()
    canonical[<i32>room] = entity
  }
  const a = newRecord<ShowResultA>(ShowResultA.SIZE)
  if (aRow >= 0) {
    const source = aRows.at(<u32>aRow)
    a.status = source.status
    a.finish_tick = source.finish_tick
    a.finish_sub = source.finish_sub
    a.lap = source.lap
    a.stage = source.stage
    a.route_mm = source.route_mm
    a.falls = source.falls
    a.score = source.score
    a.last_score_tick = source.last_score_tick
  }
  a.seat = <i32>room
  a.status = values[<i32>FIELD_STATUS]
  a.finish_tick = values[<i32>FIELD_FINISH_TICK]
  a.finish_sub = values[<i32>FIELD_FINISH_SUB]
  a.lap = values[<i32>FIELD_LAP]
  a.stage = values[<i32>FIELD_STAGE]
  a.route_mm = values[<i32>FIELD_ROUTE_MM]
  a.falls = values[<i32>FIELD_FALLS]
  a.score = values[<i32>FIELD_SCORE]
  a.last_score_tick = values[<i32>FIELD_LAST_SCORE_TICK]
  setComponent<ShowResultA>(entity, ShowResultA.ID, ShowResultA.SIZE, a)

  const b = newRecord<ShowResultB>(ShowResultB.SIZE)
  b.hold_ticks = values[<i32>FIELD_HOLD_TICKS]
  b.possessing = <u32>values[<i32>FIELD_POSSESSING]
  b.last_acquire_tick = values[<i32>FIELD_LAST_ACQUIRE_TICK]
  b.matches = values[<i32>FIELD_MATCHES]
  b.cross_ticks = values[<i32>FIELD_CROSS_TICKS]
  b.out_tick = values[<i32>FIELD_OUT_TICK]
  b.out_sub = values[<i32>FIELD_OUT_SUB]
  b.team = values[<i32>FIELD_TEAM]
  b.opening_rank = values[<i32>FIELD_OPENING_RANK]
  setComponent<ShowResultB>(entity, ShowResultB.ID, ShowResultB.SIZE, b)

  for (let field: i32 = 0; field < <i32>FIELD_COUNT; field++) {
    const offset = <i32>(room * <i32>ZONE_STRIDE + field)
    let pubEntity = pubEntities[offset]
    if (pubEntity == 0) {
      pubEntity = spawn()
      pubEntities[offset] = pubEntity
    }
    const row = newRecord<ShowPublish>(ShowPublish.SIZE)
    row.owner = entity
    row.seat = <u32>room
    row.field = <u32>field
    row.value = values[field]
    row.tick = batch.tick
    setComponent<ShowPublish>(pubEntity, ShowPublish.ID, ShowPublish.SIZE, row)
    acceptedValues[offset] = values[field]
  }
  acceptedTicks[<i32>room] = batch.tick
}

/**
 * Consumes ege.zone.inbox fragments into complete cumulative seat records and team contributions.
 * A complete record newer than the accepted one replaces it; an older or repeated complete record
 * changes nothing; fragments of an incomplete batch stay in show_pending without partial
 * application; a conflicting value for the same key and produced tick aborts the system.
 *
 * Handoff: G7.2 Rules, season and results: close every round kind (#9079) extends this ledger with
 * round closure and season scheduling; rf_show_ledger currently stops after ingesting accepted
 * cumulative records into show_result_a, show_result_b, show_publish and show_team_contribution.
 */
export function rf_show_ledger(): void {
  const inbox = readColumn<EgeZoneInbox>(EgeZoneInbox.ID, EgeZoneInbox.SIZE)
  if (inbox.count == 0) return
  const aRows = readColumn<ShowResultA>(ShowResultA.ID, ShowResultA.SIZE)
  const pubs = readColumn<ShowPublish>(ShowPublish.ID, ShowPublish.SIZE)
  const pending = readColumn<ShowPending>(ShowPending.ID, ShowPending.SIZE)

  const acceptedTicks = new StaticArray<i32>(<i32>(ROOM_SEAT_LAST + 1))
  const acceptedValues = new StaticArray<i32>(<i32>((ROOM_SEAT_LAST + 1) * ZONE_STRIDE))
  const pubEntities = new StaticArray<u32>(<i32>((ROOM_SEAT_LAST + 1) * ZONE_STRIDE))
  const canonical = new StaticArray<u32>(<i32>(ROOM_SEAT_LAST + 1))
  for (let i: i32 = 0; i < <i32>(ROOM_SEAT_LAST + 1); i++) acceptedTicks[i] = -1
  for (let i: u32 = 0; i < aRows.count; i++) {
    const seat = aRows.at(i).seat
    if (seat < 0 || seat > <i32>ROOM_SEAT_LAST) continue
    canonical[seat] = aRows.entity(i)
  }
  for (let i: u32 = 0; i < pubs.count; i++) {
    const row = pubs.at(i)
    const room = <i32>row.seat
    const field = <i32>row.field
    if (room < 0 || room > <i32>ROOM_SEAT_LAST || field < 0 || field >= <i32>FIELD_COUNT) continue
    const offset = room * <i32>ZONE_STRIDE + field
    acceptedValues[offset] = row.value
    pubEntities[offset] = pubs.entity(i)
    if (row.tick > acceptedTicks[room]) acceptedTicks[room] = row.tick
  }

  const fragments = new Array<Fragment>()
  for (let i: u32 = 0; i < pending.count; i++) {
    const row = pending.at(i)
    const room = seatRoom(row.key)
    if (room < 0 || seatField(row.key) < 0 || seatField(row.key) >= <i32>FIELD_COUNT) continue
    if (row.tick <= acceptedTicks[room]) {
      despawn(pending.entity(i))
      continue
    }
    const fragment = new Fragment()
    fragment.room = room
    fragment.field = seatField(row.key)
    fragment.tick = row.tick
    fragment.value = row.value
    fragment.source = row.source
    fragment.entry = pending.entity(i)
    fragment.stored = true
    fragments.push(fragment)
  }

  const teams = readColumn<ShowTeamContribution>(ShowTeamContribution.ID, ShowTeamContribution.SIZE)
  const teamRows = new Array<TeamRow>()
  for (let i: u32 = 0; i < teams.count; i++) {
    const row = teams.at(i)
    const entry = new TeamRow()
    entry.feature = row.feature
    entry.team = row.team
    entry.value = row.value
    entry.tick = row.tick
    entry.entity = teams.entity(i)
    teamRows.push(entry)
  }

  for (let i: u32 = 0; i < inbox.count; i++) {
    const row = inbox.at(i)
    const key = row.key
    if (key >= TEAM_ZONE_BASE) {
      const offset = key - TEAM_ZONE_BASE
      const feature = offset / ZONE_STRIDE
      const team = offset % ZONE_STRIDE
      if (team > TEAM_LAST) continue
      const at = findTeam(teamRows, feature, team)
      if (at >= 0) {
        const entry = teamRows[at]
        if (row.tick < <u32>entry.tick) continue
        if (row.tick == <u32>entry.tick) {
          if (row.value != <u32>entry.value) fail('conflicting team contribution for one key and tick')
          continue
        }
        entry.value = <i32>row.value
        entry.tick = <i32>row.tick
        const record = newRecord<ShowTeamContribution>(ShowTeamContribution.SIZE)
        record.owner = 0
        record.feature = feature
        record.team = team
        record.value = entry.value
        record.tick = entry.tick
        setComponent<ShowTeamContribution>(entry.entity, ShowTeamContribution.ID, ShowTeamContribution.SIZE, record)
      } else {
        const entry = new TeamRow()
        entry.feature = feature
        entry.team = team
        entry.value = <i32>row.value
        entry.tick = <i32>row.tick
        entry.entity = spawn()
        teamRows.push(entry)
        const record = newRecord<ShowTeamContribution>(ShowTeamContribution.SIZE)
        record.owner = 0
        record.feature = feature
        record.team = team
        record.value = entry.value
        record.tick = entry.tick
        setComponent<ShowTeamContribution>(entry.entity, ShowTeamContribution.ID, ShowTeamContribution.SIZE, record)
      }
      continue
    }
    const room = seatRoom(key)
    if (room < 0) continue
    const field = seatField(key)
    if (field < 0 || field >= <i32>FIELD_COUNT) continue
    const at = <i32>row.tick
    if (at < acceptedTicks[room]) continue
    if (at == acceptedTicks[room]) {
      if (<i32>row.value != acceptedValues[<i32>(room * <i32>ZONE_STRIDE + field)]) {
        fail('conflicting complete value for one key and tick')
      }
      continue
    }
    const found = findFragment(fragments, key, at)
    if (found >= 0) {
      if (fragments[found].value != <i32>row.value) fail('conflicting fragment for one key and tick')
      continue
    }
    const fragment = new Fragment()
    fragment.room = room
    fragment.field = field
    fragment.tick = at
    fragment.value = <i32>row.value
    fragment.source = row.source
    fragments.push(fragment)
  }

  const batches = new Array<Batch>()
  for (let i: i32 = 0; i < fragments.length; i++) {
    const fragment = fragments[i]
    if (fragment.tick <= acceptedTicks[fragment.room]) continue
    let at = findBatch(batches, fragment.room, fragment.tick)
    if (at < 0) {
      const batch = new Batch()
      batch.room = fragment.room
      batch.tick = fragment.tick
      batches.push(batch)
      at = batches.length - 1
    }
    const batch = batches[at]
    batch.mask = batch.mask | <u32>(<i32>1 << fragment.field)
    batch.values[fragment.field] = fragment.value
  }
  for (let i: i32 = 0; i < batches.length; i++) {
    const batch = batches[i]
    if (batch.mask != COMPLETE_MASK) continue
    if (batch.tick <= acceptedTicks[batch.room]) continue
    applyBatch(batch, canonical, aRows, pubEntities, acceptedValues, acceptedTicks)
    for (let f: i32 = 0; f < fragments.length; f++) {
      const fragment = fragments[f]
      if (!fragment.stored || fragment.entry == 0) continue
      if (fragment.room != batch.room || fragment.tick != batch.tick) continue
      despawn(fragment.entry)
      fragment.entry = 0
      fragment.stored = false
    }
  }
  for (let f: i32 = 0; f < fragments.length; f++) {
    const fragment = fragments[f]
    if (fragment.stored || fragment.tick <= acceptedTicks[fragment.room]) continue
    const at = findBatch(batches, fragment.room, fragment.tick)
    if (at < 0 || batches[at].mask == COMPLETE_MASK) continue
    const key = SEAT_ZONE_BASE + <u32>(fragment.room * <i32>ZONE_STRIDE + fragment.field)
    fragment.entry = writePending(fragment.source, key, <u32>fragment.field, fragment.value, fragment.tick)
    fragment.stored = true
  }
}
