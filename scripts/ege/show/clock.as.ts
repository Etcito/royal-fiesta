import { readColumn, readResource, setComponent, tick, writeResource } from 'ege'
import { Character, EgeTransform, RoundRes, Seat, ShowClock } from '../components.gen'
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
