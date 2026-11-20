import { Column, emit, getComponent, isNull, newRecord, readColumn, setComponent, spawn, tick } from 'ege'
import {
  CrownEvent, EliminateEvent, FallEvent, Feature, FinishEvent, GateEvent, MatchEvent, PossessEvent,
  ProgressEvent, ScoreEvent, ShowResultA, ShowResultB, ShowTeamContribution, TeamScoreEvent,
} from '../components.gen'

// The cumulative counters mirror packages/sim/src/zones/ledger.ts:156-194, the rules behavior
// specification: finish/fall/eliminate/gate/progress and the score/possess/match/crown event deltas.
// The event payloads keep the G6 field meanings (E3 of ARCHITECTURE.md).

function emitFinish(entity: u32, seat: u32, a: i32, b: i32): void {
  const payload = newRecord<FinishEvent>(FinishEvent.SIZE)
  payload.seat = seat
  payload.crossing = <u32>a
  payload.lap = <u32>b
  emit<FinishEvent>(FinishEvent.ID, entity, payload, FinishEvent.SIZE)
}

function emitFall<T>(eventId: u32, entity: u32, seat: u32, a: i32): void {
  const payload = newRecord<T>(8)
  payload.seat = seat
  payload.crossing = <u32>a
  emit<T>(eventId, entity, payload, 8)
}

function emitGate(entity: u32, seat: u32, a: i32, b: i32): void {
  const payload = newRecord<GateEvent>(GateEvent.SIZE)
  payload.seat = seat
  payload.stage = a
  payload.lap = <u32>b
  emit<GateEvent>(GateEvent.ID, entity, payload, GateEvent.SIZE)
}

function emitProgress(entity: u32, seat: u32, a: i32): void {
  const payload = newRecord<ProgressEvent>(ProgressEvent.SIZE)
  payload.seat = seat
  payload.distance_mm = a
  emit<ProgressEvent>(ProgressEvent.ID, entity, payload, ProgressEvent.SIZE)
}

function emitSeatAB<T>(eventId: u32, entity: u32, seat: u32, a: i32, b: i32): void {
  const payload = newRecord<T>(12)
  payload.seat = seat
  payload.a = a
  payload.b = b
  emit<T>(eventId, entity, payload, 12)
}

function emitOriginal(kind: u32, entity: u32, seat: u32, a: i32, b: i32): void {
  if (kind == FinishEvent.ID) emitFinish(entity, seat, a, b)
  else if (kind == FallEvent.ID) emitFall<FallEvent>(FallEvent.ID, entity, seat, a)
  else if (kind == EliminateEvent.ID) emitFall<EliminateEvent>(EliminateEvent.ID, entity, seat, a)
  else if (kind == GateEvent.ID) emitGate(entity, seat, a, b)
  else if (kind == ProgressEvent.ID) emitProgress(entity, seat, a)
  else if (kind == ScoreEvent.ID) emitSeatAB<ScoreEvent>(ScoreEvent.ID, entity, seat, a, b)
  else if (kind == TeamScoreEvent.ID) {
    const payload = newRecord<TeamScoreEvent>(TeamScoreEvent.SIZE)
    payload.team = seat
    payload.a = a
    payload.b = b
    emit<TeamScoreEvent>(TeamScoreEvent.ID, entity, payload, TeamScoreEvent.SIZE)
  } else if (kind == PossessEvent.ID) emitSeatAB<PossessEvent>(PossessEvent.ID, entity, seat, a, b)
  else if (kind == CrownEvent.ID) emitSeatAB<CrownEvent>(CrownEvent.ID, entity, seat, a, b)
  else if (kind == MatchEvent.ID) emitSeatAB<MatchEvent>(MatchEvent.ID, entity, seat, a, b)
}

function seatRow(results: Column<ShowResultA>, seat: u32): i32 {
  for (let i: u32 = 0; i < results.count; i++) if (results.at(i).seat == <i32>seat) return <i32>i
  return -1
}

function updateSeat(kind: u32, seat: u32, a: i32, b: i32, results: Column<ShowResultA>): void {
  const row = seatRow(results, seat)
  if (row < 0) return
  const seatEntity = results.entity(<u32>row)
  const aRow = results.at(<u32>row)
  const now = <i32>tick()
  if (kind == FinishEvent.ID) {
    aRow.status = 2
    aRow.finish_tick = now
    aRow.finish_sub = a
    aRow.lap = b
  } else if (kind == FallEvent.ID) {
    aRow.falls += 1
  } else if (kind == EliminateEvent.ID) {
    aRow.status = 3
  } else if (kind == GateEvent.ID) {
    aRow.stage = a
    aRow.lap = b
  } else if (kind == ProgressEvent.ID) {
    aRow.route_mm = a
  } else if (kind == ScoreEvent.ID) {
    aRow.score += a
    aRow.last_score_tick = now
  } else if (kind == CrownEvent.ID) {
    aRow.status = 2
    aRow.finish_tick = now
    aRow.finish_sub = a
  }
  results.write()

  const bRows = readColumn<ShowResultB>(ShowResultB.ID, ShowResultB.SIZE)
  const bRow = bRows.find(seatEntity)
  if (bRow < 0) return
  const bValue = bRows.at(<u32>bRow)
  if (kind == EliminateEvent.ID) {
    bValue.out_tick = now
    bValue.out_sub = a
  } else if (kind == PossessEvent.ID) {
    bValue.possessing = a == 1 ? 1 : 0
    if (a == 1) bValue.last_acquire_tick = now
  } else if (kind == MatchEvent.ID) {
    bValue.matches += a
    bValue.cross_ticks += b
  }
  bRows.write()
}

function updateTeamScore(entity: u32, team: u32, a: i32): void {
  const rows = readColumn<ShowTeamContribution>(ShowTeamContribution.ID, ShowTeamContribution.SIZE)
  let row: i32 = -1
  for (let i: u32 = 0; i < rows.count; i++) {
    const candidate = rows.at(i)
    if (candidate.owner == entity && candidate.team == team) {
      row = <i32>i
      break
    }
  }
  const now = <i32>tick()
  if (row >= 0) {
    const value = rows.at(<u32>row)
    value.value += a
    value.tick = now
    rows.write()
    return
  }
  const feature = getComponent<Feature>(entity, Feature.ID, Feature.SIZE)
  if (isNull<Feature>(feature)) return
  const created = newRecord<ShowTeamContribution>(ShowTeamContribution.SIZE)
  created.owner = entity
  created.feature = feature.index
  created.team = team
  created.value = a
  created.tick = now
  setComponent<ShowTeamContribution>(spawn(), ShowTeamContribution.ID, ShowTeamContribution.SIZE, created)
}

/**
 * The seat rules (`rf_seat_rules`) and the objective features (`rf_feature_collectible_post`,
 * `rf_feature_ball_post`, `rf_feature_bank_post`, `rf_feature_capture_zone_post`,
 * `rf_feature_tail_set_pre`, `rf_feature_tail_set_post`, `rf_feature_crown_post`,
 * `rf_feature_memory_tiles_pre` and `rf_feature_memory_tiles_post`) call `recordShowEvent` in place
 * of their own `emit`. It emits the G6 event payload unchanged and, when the show's `ShowResultA`
 * rows exist, applies the cumulative ledger update for the event's seat; a `team_score`
 * accumulates into the feature's `ShowTeamContribution` row instead. `a`/`b` keep the entry point
 * payload meanings: finish crossing/lap, gate stage/lap, progress distance, and the event record's
 * own a/b for score, team_score, possess, crown and match.
 */
export function recordShowEvent(kind: u32, entity: u32, seat: u32, a: i32, b: i32): void {
  emitOriginal(kind, entity, seat, a, b)
  const results = readColumn<ShowResultA>(ShowResultA.ID, ShowResultA.SIZE)
  if (results.count == 0) return
  if (kind == TeamScoreEvent.ID) updateTeamScore(entity, seat, a)
  else updateSeat(kind, seat, a, b, results)
}
