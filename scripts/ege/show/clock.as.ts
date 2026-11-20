import { despawn, newRecord, readColumn, readResource, setComponent, spawn, tick, writeResource } from 'ege'
import {
  Character, EgeTransform, RoundRes, Seat, ShowClock, ShowLifecycleInput, ShowPending, ShowPresentation,
  ShowResultA, ShowResultB, ShowRosterEntry, ShowRoundResult, ShowTeamContribution, ShowUsedMap,
} from '../components.gen'
import { characterColumn, placeSeat, seatColumn, transformOf } from '../lib/seats.as'

// The show clock is the authoritative timer for a show world. The G6 `rf.round.clock` keeps
// reading the `round` resource; this script instead owns a `show_clock` row: it seeds the
// start/end/overtime boundaries once, advances the phase from simulation ticks and mirrors the
// result into `round` so the feature systems and the character freeze keep working. Every timer
// value lives in the show_clock record, so a restore resumes the same phase. Tests seed short
// deterministic intro/round/overtime durations; no wall clock or presentation frame is involved.

function fail(message: string): void {
  abort(message, 'scripts/ege/show/clock.as.ts', 0, 0)
}

function placeUnplaced(entity: u32, seat: Seat, ch: Character, transform: EgeTransform): void {
  if (ch.placed != 0) return
  placeSeat(entity, ch, seat.spawn_t_0, seat.spawn_t_1, seat.spawn_t_2, seat.spawn_facing_0, seat.spawn_facing_1)
  ch.placed = 1
  transform.pos_0 = <f32>seat.spawn_t_0
  transform.pos_1 = <f32>(seat.spawn_t_1 + ch.stand + 0.01)
  transform.pos_2 = <f32>seat.spawn_t_2
  transform.rot_0 = 0
  transform.rot_1 = 0
  transform.rot_2 = 0
  transform.rot_3 = 1
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
}

export function rf_show_clock(): void {
  const clocks = readColumn<ShowClock>(ShowClock.ID, ShowClock.SIZE)
  if (clocks.count == 0) return
  if (clocks.count > 1) fail('a show world has one show_clock row')
  const clock = clocks.at(0)
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)

  // A scene that does not seed the show durations inherits the authored round profile's values.
  if (clock.intro_ticks == 0 && clock.round_ticks == 0 && clock.overtime_ticks == 0) {
    clock.intro_ticks = round.intro_ticks
    clock.round_ticks = round.round_ticks
    clock.overtime_ticks = round.overtime_ticks
  }

  const now = <i32>tick()
  const intro = <i32>clock.intro_ticks
  const roundTicks = <i32>clock.round_ticks
  const overtime = <i32>clock.overtime_ticks
  // The record is uninitialised when the scene left its start/end sentinels at zero or negative.
  if (clock.start_tick < 0 || clock.end_tick <= clock.start_tick || clock.overtime_end_tick < clock.end_tick) {
    const start = clock.start_tick < 0 ? now : <i32>clock.start_tick
    clock.start_tick = start
    clock.end_tick = start + intro + roundTicks
    clock.overtime_end_tick = clock.end_tick + overtime
  }

  const rel = now - <i32>clock.start_tick
  let phase: u32 = 0
  if (rel >= <i32>clock.overtime_end_tick - <i32>clock.start_tick) phase = 3
  else if (rel >= <i32>clock.end_tick - <i32>clock.start_tick) phase = 2
  else if (rel >= intro) phase = 1
  const frozen: u32 = phase == 0 || phase == 3 ? 1 : 0
  clock.phase = phase
  clock.frozen = frozen
  clocks.write()

  // Mirror the show timer into the shared resource: features read these durations and phase,
  // the character freeze reads `round.frozen`, and the ledger closes rounds from the same clock.
  round.intro_ticks = clock.intro_ticks
  round.round_ticks = clock.round_ticks
  round.overtime_ticks = clock.overtime_ticks
  round.phase = phase
  round.frozen = frozen
  writeResource<RoundRes>(RoundRes.ID, RoundRes.SIZE, round)

  const seats = seatColumn()
  const characters = characterColumn()
  for (let i: u32 = 0; i < seats.count; i++) {
    const entity = seats.entity(i)
    const seat = seats.at(i)
    const row = characters.find(entity)
    if (row < 0) continue
    const ch = characters.at(<u32>row)
    const transform = transformOf(entity)
    placeUnplaced(entity, seat, ch, transform)
    ch.frozen = frozen
    if (ch.placed != 0) {
      const placed = transformOf(entity)
      seat.before_0 = placed.pos_0
      seat.before_1 = placed.pos_1
      seat.before_2 = placed.pos_2
    }
  }
  characters.write()
  seats.write()
}

// Presentation lifecycle (Q7). The rules world owns the displayed show screen and the ordered
// rosters; the scheduler cursor is a separate fact and may already describe the next round.
// `show_presentation` (one row, owner = the season-cursor entity) stores tick, displayed
// round, screen, screen-entry tick, current result, roster counts and the presentation
// durations. Screen encoding: vote=0, loading=1, intro=2, playing=3, overtime=4, results=5,
// podium=6, done=7. `show_roster_entry` children hold list=0 (this round's ascending seatOf)
// and list=1 (next contest's ascending alive roster). `show_lifecycle_input` carries the host
// facts ready_round (round whose worlds are ready, -1 when none) and confirmed_tick (highest
// confirmed simulation tick); the host sets them before the step. They are replayed and
// restored with the world and never choose a screen or an outcome.
//
// This export only reads and writes schema rows, never seat/character columns or the physics
// resources of a round world, so it is safe in the zero-player show_rules schedule. The
// ledger closes a round and enters results; this script advances the remaining screens.

const SCREEN_VOTE: u32 = 0
const SCREEN_LOADING: u32 = 1
const SCREEN_INTRO: u32 = 2
const SCREEN_PLAYING: u32 = 3
const SCREEN_OVERTIME: u32 = 4
const SCREEN_RESULTS: u32 = 5
const SCREEN_PODIUM: u32 = 6
const SCREEN_DONE: u32 = 7

const LIST_CURRENT: u32 = 0
const LIST_NEXT: u32 = 1

const DEFAULT_VOTE_TICKS: u32 = 300
const DEFAULT_RESULTS_TICKS: u32 = 90
const DEFAULT_PODIUM_TICKS: u32 = 150

function hasUsedMap(owner: u32, roundIndex: i32): bool {
  const rows = readColumn<ShowUsedMap>(ShowUsedMap.ID, ShowUsedMap.SIZE)
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner == owner && <i32>row.index == roundIndex) return true
  }
  return false
}

function findResult(owner: u32, roundIndex: i32): i32 {
  const rows = readColumn<ShowRoundResult>(ShowRoundResult.ID, ShowRoundResult.SIZE)
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner == owner && <i32>row.index == roundIndex) return <i32>i
  }
  return -1
}

/** Seats of one roster list in ascending room-seat order. */
function rosterSeats(owner: u32, list: u32): StaticArray<i32> {
  const rows = readColumn<ShowRosterEntry>(ShowRosterEntry.ID, ShowRosterEntry.SIZE)
  let count: i32 = 0
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner == owner && row.list == list) count++
  }
  const seats = new StaticArray<i32>(count)
  let at: i32 = 0
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner != owner || row.list != list) continue
    seats[at++] = <i32>row.room_seat
  }
  for (let i: i32 = 1; i < count; i++) {
    const key = seats[i]
    let j = i - 1
    while (j >= 0 && seats[j] > key) {
      seats[j + 1] = seats[j]
      j--
    }
    seats[j + 1] = key
  }
  return seats
}

/** Replaces one roster list with the ascending seats and contiguous positions. */
function writeRoster(owner: u32, list: u32, seats: StaticArray<i32>): void {
  const rows = readColumn<ShowRosterEntry>(ShowRosterEntry.ID, ShowRosterEntry.SIZE)
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner == owner && row.list == list) despawn(rows.entity(i))
  }
  for (let i: i32 = 0; i < seats.length; i++) {
    const row = newRecord<ShowRosterEntry>(ShowRosterEntry.SIZE)
    row.owner = owner
    row.list = list
    row.position = <u32>i
    row.room_seat = <u32>seats[i]
    setComponent<ShowRosterEntry>(spawn(), ShowRosterEntry.ID, ShowRosterEntry.SIZE, row)
  }
}

/** Removes this round's cumulative ingest rows so the next contest starts from fresh publishers. */
function resetCumulative(): void {
  const a = readColumn<ShowResultA>(ShowResultA.ID, ShowResultA.SIZE)
  for (let i: u32 = 0; i < a.count; i++) despawn(a.entity(i))
  const b = readColumn<ShowResultB>(ShowResultB.ID, ShowResultB.SIZE)
  for (let i: u32 = 0; i < b.count; i++) despawn(b.entity(i))
  const team = readColumn<ShowTeamContribution>(ShowTeamContribution.ID, ShowTeamContribution.SIZE)
  for (let i: u32 = 0; i < team.count; i++) despawn(team.entity(i))
  const pending = readColumn<ShowPending>(ShowPending.ID, ShowPending.SIZE)
  for (let i: u32 = 0; i < pending.count; i++) despawn(pending.entity(i))
}

function startRound(presentation: ShowPresentation, clock: ShowClock, now: i32): void {
  const intro = <i32>clock.intro_ticks
  const roundTicks = <i32>clock.round_ticks
  const overtime = <i32>clock.overtime_ticks
  if (intro + roundTicks + overtime <= 0) fail('a show clock needs authored intro, round and overtime durations')
  clock.start_tick = now
  clock.end_tick = now + intro + roundTicks
  clock.overtime_end_tick = clock.end_tick + overtime
  clock.phase = 0
  clock.frozen = 1
  presentation.screen = SCREEN_INTRO
  presentation.entered_tick = <u32>now
}

/**
 * Handoff: G7.2 Rules, season and results: run the local authoritative show (#9093) and
 * G7.1 Identity, inputs and world construction: construct show and rules worlds (#9091). This
 * `rf_show_presentation` entry sits in the production `show_rules` schedule after
 * `rf.show.season`.
 * #9091 seeds one `show_presentation` row (owner = the season-cursor entity, initial screen
 * vote=0, entered_tick=0, result_index=-1, both rosters 0..59 and equal counts, and the
 * presentation durations; testMode seeds 1/1/1 while gameplay caps keep their authored clock
 * values) plus one `show_clock` row carrying the authored intro/round/overtime durations and
 * one `show_lifecycle_input` row {ready_round:-1, confirmed_tick:0}. #9093 writes only the host
 * facts ready_round and confirmed_tick before each step. The script advances vote (after a
 * committed `show_used_map`), loading (on a matching ready_round), intro/playing/overtime (from
 * the stored clock boundaries), results (after confirmed_tick > end_tick and the results
 * duration) to the next vote with list=1 installed as list=0, or to podium and then terminal
 * done for a winning result. It reads no physics-only round resource or character column. Readers
 * (readShowState/readShowRoundResult) decode `ShowPresentation.screen`, `.round_index`,
 * `.entered_tick`, `.result_index` and the `ShowRosterEntry` rows without reconstructing them.
 */
export function rf_show_presentation(): void {
  const rows = readColumn<ShowPresentation>(ShowPresentation.ID, ShowPresentation.SIZE)
  if (rows.count == 0) return
  if (rows.count > 1) fail('a rules world has one show_presentation row')
  const presentation = rows.at(0)
  const now = <i32>tick()
  presentation.tick = <u32>now
  if (presentation.vote_ticks == 0 && presentation.results_ticks == 0 && presentation.podium_ticks == 0) {
    presentation.vote_ticks = DEFAULT_VOTE_TICKS
    presentation.results_ticks = DEFAULT_RESULTS_TICKS
    presentation.podium_ticks = DEFAULT_PODIUM_TICKS
  }
  const owner = presentation.owner

  const life = readColumn<ShowLifecycleInput>(ShowLifecycleInput.ID, ShowLifecycleInput.SIZE)
  if (life.count > 1) fail('a rules world has one show_lifecycle_input row')
  let readyRound: i32 = -1
  let confirmedTick: i32 = -1
  if (life.count == 1) {
    readyRound = <i32>life.at(0).ready_round
    confirmedTick = <i32>life.at(0).confirmed_tick
  }
  const clocks = readColumn<ShowClock>(ShowClock.ID, ShowClock.SIZE)
  if (clocks.count > 1) fail('a show world has one show_clock row')

  const roundIndex = <i32>presentation.round_index
  const screen = presentation.screen

  if (screen == SCREEN_VOTE) {
    if (hasUsedMap(owner, roundIndex)) {
      presentation.screen = SCREEN_LOADING
      presentation.entered_tick = <u32>now
    }
  } else if (screen == SCREEN_LOADING) {
    if (readyRound >= 0 && readyRound == roundIndex && clocks.count == 1) {
      startRound(presentation, clocks.at(0), now)
      clocks.write()
    }
  } else if (screen == SCREEN_INTRO || screen == SCREEN_PLAYING || screen == SCREEN_OVERTIME) {
    const resultAt = findResult(owner, roundIndex)
    if (presentation.result_index < 0 && resultAt >= 0) {
      presentation.screen = SCREEN_RESULTS
      presentation.entered_tick = <u32>now
      presentation.result_index = roundIndex
    } else if (clocks.count == 1) {
      const clock = clocks.at(0)
      const intro = <i32>clock.intro_ticks
      const capTick = intro + <i32>clock.round_ticks
      const overtimeEnd = capTick + <i32>clock.overtime_ticks
      const rel = now - <i32>clock.start_tick
      if (rel >= overtimeEnd) {
        clock.phase = 3
        clock.frozen = 1
        clocks.write()
      } else if (rel >= capTick && presentation.screen != SCREEN_OVERTIME) {
        presentation.screen = SCREEN_OVERTIME
        presentation.entered_tick = clock.end_tick
        clock.phase = 2
        clock.frozen = 0
        clocks.write()
      } else if (rel >= intro && presentation.screen == SCREEN_INTRO) {
        presentation.screen = SCREEN_PLAYING
        presentation.entered_tick = <u32>(<i32>clock.start_tick + intro)
        clock.phase = 1
        clock.frozen = 0
        clocks.write()
      }
    }
  } else if (screen == SCREEN_RESULTS) {
    const at = presentation.result_index >= 0 ? presentation.result_index : roundIndex
    const resultAt = findResult(owner, at)
    if (resultAt >= 0) {
      const results = readColumn<ShowRoundResult>(ShowRoundResult.ID, ShowRoundResult.SIZE)
      const result = results.at(<u32>resultAt)
      const resultTick = <i32>result.end_tick
      const duration = <i32>presentation.results_ticks
      if (now >= <i32>presentation.entered_tick + duration && confirmedTick > resultTick) {
        if (<i32>result.champion >= 0) {
          presentation.screen = SCREEN_PODIUM
          presentation.entered_tick = <u32>now
        } else {
          const next = rosterSeats(owner, LIST_NEXT)
          writeRoster(owner, LIST_CURRENT, next)
          resetCumulative()
          presentation.round_index = <u32>(<i32>result.index + 1)
          presentation.screen = SCREEN_VOTE
          presentation.entered_tick = <u32>now
          presentation.result_index = -1
          presentation.seat_count = <u32>next.length
          presentation.alive_count = <u32>next.length
        }
      }
    }
  } else if (screen == SCREEN_PODIUM) {
    if (now >= <i32>presentation.entered_tick + <i32>presentation.podium_ticks) {
      presentation.screen = SCREEN_DONE
      presentation.entered_tick = <u32>now
    }
  }
  rows.write()
}
