import { Column, despawn, newRecord, readColumn, setComponent, spawn, tick } from 'ege'
import {
  EgeZoneInbox, ShowClock, ShowOpeningRank, ShowPending, ShowPublish, ShowResultA, ShowResultB,
  ShowResultPending, ShowResultSeat, ShowResultTeam, ShowRoundResult, ShowSeasonCursor,
  ShowTeamContribution,
} from '../components.gen'
import { resolveShowRound, showRoundPoints } from './qualification.as'
import { advanceCursor, nextSlotForPlan, readCatalog, readPlan, readUsedMaps } from './scheduler.as'
import { resolveShowTeamTie } from './teams.as'

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
  ingest()
  closeRound()
}

function ingest(): void {
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

// Round closure (G7.2). Reason rank: target=0,timeCap=1,lastStanding=2,allFell=3,overtime=4,teamWin=5,
// score=6,crown=7,playoff=8. Kind rank: race=0..logic=5,final=6; final-rule rank none=0,crown=1,lastStanding=2.
const REASON_TARGET: u32 = 0
const REASON_TIME_CAP: u32 = 1
const REASON_LAST_STANDING: u32 = 2
const REASON_ALL_FELL: u32 = 3
const REASON_OVERTIME: u32 = 4
const REASON_TEAM_WIN: u32 = 5
const REASON_SCORE: u32 = 6
const REASON_CROWN: u32 = 7
const REASON_PLAYOFF: u32 = 8
const KIND_TEAM_RANK: i32 = 2
const KIND_FINAL_RANK: i32 = 6
const BASELINE: u32 = 0xffffffff
const LIST_RANKING: u32 = 0
const LIST_QUALIFIED: u32 = 1
const LIST_ELIMINATED: u32 = 2
const LIST_PLAYOFF: u32 = 3

function containsSeat(values: StaticArray<i32>, value: i32): bool {
  for (let i: i32 = 0; i < values.length; i++) if (values[i] == value) return true
  return false
}

function writeSeatRow(owner: u32, result: u32, list: u32, position: i32, seat: i32, points: i32): void {
  const row = newRecord<ShowResultSeat>(ShowResultSeat.SIZE)
  row.owner = owner
  row.result = result
  row.list = list
  row.position = <u32>position
  row.seat = <u32>seat
  row.points = points
  setComponent<ShowResultSeat>(spawn(), ShowResultSeat.ID, ShowResultSeat.SIZE, row)
}

function writeSeatList(owner: u32, result: u32, list: u32, seats: StaticArray<i32>): void {
  for (let i: i32 = 0; i < seats.length; i++) writeSeatRow(owner, result, list, i, seats[i], 0)
}

/** Seat list of one stored result, in position order. */
function storedList(owner: u32, result: u32, list: u32): StaticArray<i32> {
  const rows = readColumn<ShowResultSeat>(ShowResultSeat.ID, ShowResultSeat.SIZE)
  let count: i32 = 0
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner == owner && row.result == result && row.list == list) count++
  }
  const out = new StaticArray<i32>(count)
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner != owner || row.result != result || row.list != list) continue
    if (<i32>row.position < count) out[<i32>row.position] = <i32>row.seat
  }
  return out
}

/** Sums the cumulative per-publisher contributions into one score per contiguous team id. */
function teamScoresOf(count: i32): StaticArray<i32> {
  const scores = new StaticArray<i32>(count)
  const rows = readColumn<ShowTeamContribution>(ShowTeamContribution.ID, ShowTeamContribution.SIZE)
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.team < <u32>count) scores[<i32>row.team] += row.value
  }
  return scores
}

function clearBaseline(): void {
  const rows = readColumn<ShowResultTeam>(ShowResultTeam.ID, ShowResultTeam.SIZE)
  for (let i: u32 = 0; i < rows.count; i++) {
    if (rows.at(i).result == BASELINE) despawn(rows.entity(i))
  }
}

function baselineCount(): i32 {
  const rows = readColumn<ShowResultTeam>(ShowResultTeam.ID, ShowResultTeam.SIZE)
  let count: i32 = 0
  for (let i: u32 = 0; i < rows.count; i++) if (rows.at(i).result == BASELINE) count++
  return count
}

function baselineScore(team: i32): i32 {
  const rows = readColumn<ShowResultTeam>(ShowResultTeam.ID, ShowResultTeam.SIZE)
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.result == BASELINE && row.team == <u32>team) return row.score
  }
  return 0
}

function writeBaseline(owner: u32, scores: StaticArray<i32>): void {
  for (let i: i32 = 0; i < scores.length; i++) {
    const row = newRecord<ShowResultTeam>(ShowResultTeam.SIZE)
    row.owner = owner
    row.result = BASELINE
    row.team = <u32>i
    row.score = scores[i]
    setComponent<ShowResultTeam>(spawn(), ShowResultTeam.ID, ShowResultTeam.SIZE, row)
  }
}

function scoresDiffer(scores: StaticArray<i32>): bool {
  for (let i: i32 = 1; i < scores.length; i++) if (scores[i] != scores[0]) return true
  return false
}

function closeRound(): void {
  const cursors = readColumn<ShowSeasonCursor>(ShowSeasonCursor.ID, ShowSeasonCursor.SIZE)
  if (cursors.count != 1) return
  const clocks = readColumn<ShowClock>(ShowClock.ID, ShowClock.SIZE)
  if (clocks.count != 1) return
  const owner = cursors.entity(0)
  const cursor = cursors.at(0)
  const roundIndex = <i32>cursor.round_index
  const results = readColumn<ShowRoundResult>(ShowRoundResult.ID, ShowRoundResult.SIZE)
  let previousReason: i32 = -1
  for (let i: u32 = 0; i < results.count; i++) {
    const row = results.at(i)
    if (row.owner != owner) continue
    if (<i32>row.index == roundIndex) return
    if (<i32>row.index == roundIndex - 1) previousReason = <i32>row.reason
  }
  const used = readUsedMaps(owner)
  if (used.length <= roundIndex) return
  const plan = readPlan(owner)
  const slot = nextSlotForPlan(plan, <i32>cursor.step, <i32>cursor.alive, <i32>cursor.team_rounds)
  if (slot == null) return
  const catalog = readCatalog(owner)
  let mapRow: i32 = -1
  for (let i: i32 = 0; i < catalog.length; i++) if (catalog[i].index == used[roundIndex]) mapRow = i
  if (mapRow < 0) fail('the played map is missing from show_catalog_entry')
  const entry = catalog[mapRow]

  const playoffRound = previousReason == <i32>REASON_PLAYOFF
  let kind = entry.kind
  const finalRule = entry.finalRule
  const isFinal = slot.final || kind == KIND_FINAL_RANK
  if (isFinal && finalRule != 0) kind = KIND_FINAL_RANK
  else if (kind == KIND_FINAL_RANK) kind = 0
  if (kind == KIND_FINAL_RANK && finalRule == 0) fail('a final requires crown or lastStanding')

  // Seats of this round: the disputed seats of a playoff round, otherwise every cumulative record.
  const aRows = readColumn<ShowResultA>(ShowResultA.ID, ShowResultA.SIZE)
  const bRows = readColumn<ShowResultB>(ShowResultB.ID, ShowResultB.SIZE)
  let disputed = new StaticArray<i32>(0)
  if (playoffRound) disputed = storedList(owner, <u32>(roundIndex - 1), LIST_PLAYOFF)
  const seats = new StaticArray<u32>(<i32>aRows.count)
  let count: i32 = 0
  for (let i: u32 = 0; i < aRows.count; i++) {
    const room = aRows.at(i).seat
    if (playoffRound && !containsSeat(disputed, room)) continue
    seats[count++] = aRows.entity(i)
  }
  if (count == 0) return
  const live = new StaticArray<u32>(count)
  for (let i: i32 = 0; i < count; i++) live[i] = seats[i]

  let alive: i32 = 0
  let finished: i32 = 0
  let teamCount: i32 = 0
  for (let i: i32 = 0; i < count; i++) {
    const a = aRows.at(<u32>aRows.find(live[i]))
    const b = bRows.at(<u32>bRows.find(live[i]))
    if (a.status == 1) alive++
    if (a.finish_tick >= 0) finished++
    if (b.team + 1 > teamCount) teamCount = b.team + 1
  }
  let teamScores = new StaticArray<i32>(0)
  if (kind == KIND_TEAM_RANK) teamScores = teamScoresOf(teamCount)

  // Target: the slot target, minus seats already qualified by earlier disputed rounds of this step.
  let target = slot.target
  if (playoffRound) {
    let back = roundIndex - 1
    while (back >= 0) {
      let reason: i32 = -1
      let qualifiedCount: i32 = 0
      for (let i: u32 = 0; i < results.count; i++) {
        const row = results.at(i)
        if (row.owner == owner && <i32>row.index == back) {
          reason = <i32>row.reason
          qualifiedCount = <i32>row.qualified_count
        }
      }
      if (reason != <i32>REASON_PLAYOFF) break
      target -= qualifiedCount
      back--
    }
  }
  if (target > count) target = count
  if (target < 1) target = 1

  const clock = clocks.at(0)
  const now = <i32>tick()
  const rel = now - clock.start_tick
  const intro = <i32>clock.intro_ticks
  const capTick = intro + <i32>clock.round_ticks
  const overtimeEnd = capTick + <i32>clock.overtime_ticks
  if (rel < intro) return
  const atCap = rel >= capTick
  const atOvertimeEnd = rel >= overtimeEnd

  let reason: i32 = -1
  if (kind == 0) {
    if (finished >= target) reason = <i32>REASON_TARGET
    else if (atCap) reason = <i32>REASON_TIME_CAP
  } else if (kind == 1) {
    if (alive <= target) reason = alive == 0 ? <i32>REASON_ALL_FELL : <i32>REASON_TARGET
    else if (atOvertimeEnd) reason = <i32>REASON_OVERTIME
  } else if (kind == KIND_TEAM_RANK) {
    if (atCap) {
      if (baselineCount() == 0) {
        if (scoresDiffer(teamScores)) reason = <i32>REASON_TEAM_WIN
        else writeBaseline(owner, teamScores)
      } else {
        for (let t: i32 = 0; t < teamScores.length; t++) {
          if (teamScores[t] != baselineScore(t)) reason = <i32>REASON_TEAM_WIN
        }
        if (reason < 0 && atOvertimeEnd) reason = <i32>REASON_OVERTIME
      }
    }
  } else if (kind == KIND_FINAL_RANK) {
    if (finalRule == 1) {
      if (finished > 0) reason = <i32>REASON_CROWN
    } else if (alive <= 1) {
      reason = <i32>REASON_LAST_STANDING
    }
    if (reason < 0 && atOvertimeEnd) reason = <i32>REASON_OVERTIME
  } else if (atCap) {
    reason = <i32>REASON_SCORE
  }
  if (reason < 0) return

  const seed = cursor.rng_state
  // A tied top team is settled by the team tie boundary; the winner gets a unit bonus only in the
  // copy handed to qualification, never in the stored scores.
  let adjusted = teamScores
  if (kind == KIND_TEAM_RANK && teamScores.length > 0) {
    let best = teamScores[0]
    let tied: i32 = 0
    for (let t: i32 = 0; t < teamScores.length; t++) if (teamScores[t] > best) best = teamScores[t]
    for (let t: i32 = 0; t < teamScores.length; t++) if (teamScores[t] == best) tied++
    if (tied > 1) {
      const sums = new StaticArray<i32>(teamScores.length)
      for (let i: i32 = 0; i < count; i++) {
        const b = bRows.at(<u32>bRows.find(live[i]))
        if (b.team >= 0) sums[b.team] += b.opening_rank
      }
      let leader: i32 = -1
      let leaderGain: i32 = 0
      let leaderTied = false
      if (baselineCount() > 0) {
        for (let t: i32 = 0; t < teamScores.length; t++) {
          const gain = teamScores[t] - baselineScore(t)
          if (gain > leaderGain) { leader = t; leaderGain = gain; leaderTied = false }
          else if (gain == leaderGain && gain > 0) leaderTied = true
        }
        if (leaderTied) leader = -1
      }
      const winner = resolveShowTeamTie(teamScores, leader, sums, seed, roundIndex)
      adjusted = new StaticArray<i32>(teamScores.length)
      for (let t: i32 = 0; t < teamScores.length; t++) adjusted[t] = teamScores[t]
      adjusted[winner] += 1
    }
  }
  const outcome = resolveShowRound(kind, finalRule, target, live, adjusted, seed, roundIndex, playoffRound)
  const disputedNow = outcome.playoff
  const finalReason = disputedNow == null ? <u32>reason : REASON_PLAYOFF

  const result = newRecord<ShowRoundResult>(ShowRoundResult.SIZE)
  result.owner = owner
  result.index = <u32>roundIndex
  result.map = <u32>entry.index
  result.course = entry.course
  result.kind = <u32>kind
  result.final = <u32>(isFinal ? 1 : 0)
  result.playoff = <u32>(playoffRound ? 1 : 0)
  result.end_tick = now
  result.reason = finalReason
  let champion = outcome.champion
  if (isFinal && disputedNow == null && outcome.qualified.length == 1) champion = outcome.qualified[0]
  result.champion = champion
  result.ranking_count = <u32>outcome.ranking.length
  result.qualified_count = <u32>outcome.qualified.length
  result.eliminated_count = <u32>outcome.eliminated.length
  result.team_count = <u32>teamScores.length
  setComponent<ShowRoundResult>(spawn(), ShowRoundResult.ID, ShowRoundResult.SIZE, result)
  const id = <u32>roundIndex
  for (let i: i32 = 0; i < outcome.ranking.length; i++) {
    const room = outcome.ranking[i]
    let rank = i + 1
    if (kind == KIND_TEAM_RANK) {
      for (let k: i32 = 0; k < count; k++) {
        const a = aRows.at(<u32>aRows.find(live[k]))
        if (a.seat == room && bRows.at(<u32>bRows.find(live[k])).team == outcome.teamWinner) rank = 1
      }
    }
    const points = showRoundPoints(rank, count, containsSeat(outcome.qualified, room))
    writeSeatRow(owner, id, LIST_RANKING, i, room, points)
  }
  writeSeatList(owner, id, LIST_QUALIFIED, outcome.qualified)
  writeSeatList(owner, id, LIST_ELIMINATED, outcome.eliminated)
  if (disputedNow != null) writeSeatList(owner, id, LIST_PLAYOFF, disputedNow)
  for (let t: i32 = 0; t < teamScores.length; t++) {
    const row = newRecord<ShowResultTeam>(ShowResultTeam.SIZE)
    row.owner = owner
    row.result = id
    row.team = <u32>t
    row.score = teamScores[t]
    setComponent<ShowResultTeam>(spawn(), ShowResultTeam.ID, ShowResultTeam.SIZE, row)
  }
  const pending = newRecord<ShowResultPending>(ShowResultPending.SIZE)
  pending.owner = owner
  pending.index = id
  pending.end_tick = now
  pending.reason = finalReason
  pending.confirmed = 0
  setComponent<ShowResultPending>(spawn(), ShowResultPending.ID, ShowResultPending.SIZE, pending)
  clearBaseline()

  // Opening race ranks are recorded once and preserved across rounds.
  const openings = readColumn<ShowOpeningRank>(ShowOpeningRank.ID, ShowOpeningRank.SIZE)
  if (kind == 0 && openings.count == 0) {
    for (let i: i32 = 0; i < outcome.ranking.length; i++) {
      const row = newRecord<ShowOpeningRank>(ShowOpeningRank.SIZE)
      row.owner = owner
      row.seat = <u32>outcome.ranking[i]
      row.rank = i + 1
      setComponent<ShowOpeningRank>(spawn(), ShowOpeningRank.ID, ShowOpeningRank.SIZE, row)
    }
  }

  if (disputedNow != null) {
    cursor.round_index = <u32>(roundIndex + 1)
  } else {
    let qualifiedTotal = outcome.qualified.length
    let back = roundIndex - 1
    while (playoffRound && back >= 0) {
      let reasonBack: i32 = -1
      let qualifiedBack: i32 = 0
      for (let i: u32 = 0; i < results.count; i++) {
        const row = results.at(i)
        if (row.owner == owner && <i32>row.index == back) {
          reasonBack = <i32>row.reason
          qualifiedBack = <i32>row.qualified_count
        }
      }
      if (reasonBack != <i32>REASON_PLAYOFF) break
      qualifiedTotal += qualifiedBack
      back--
    }
    slot.playoff = playoffRound
    const advance = advanceCursor(
      <i32>cursor.step, <i32>cursor.team_rounds, roundIndex, slot, qualifiedTotal, kind == KIND_TEAM_RANK,
    )
    cursor.step = <u32>advance.step
    cursor.alive = <u32>advance.alive
    cursor.team_rounds = <u32>advance.teamRounds
    cursor.round_index = <u32>advance.roundIndex
  }
  cursors.write()
}
