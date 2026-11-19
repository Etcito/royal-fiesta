import { setComponent, tick, readResource, writeResource } from 'ege'
import { CourseRes, EgeTransform, RoundRes } from '../components.gen'
import { characterColumn, placeSeat, seatColumn, transformOf } from '../lib/seats.as'

/**
 * Handoff: Headless engine round harness and its test: `rf_round_clock` advances
 * the phase, places unplaced seats and applies the intro/ended freeze each tick.
 */
export function rf_round_clock(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const course = readResource<CourseRes>(CourseRes.ID, CourseRes.SIZE)
  const now = tick()
  const playingAt = round.intro_ticks
  const overtimeAt = playingAt + round.round_ticks
  const endedAt = overtimeAt + round.overtime_ticks
  let phase: u32 = 0
  if (round.ended_tick >= 0 || now >= endedAt) phase = 3
  else if (now >= overtimeAt) phase = 2
  else if (now >= playingAt) phase = 1
  round.phase = phase
  round.frozen = <u32>(phase == 0 || phase == 3)
  writeResource<RoundRes>(RoundRes.ID, RoundRes.SIZE, round)

  const seats = seatColumn()
  const characters = characterColumn()
  for (let i: u32 = 0; i < seats.count; i++) {
    const entity = seats.entity(i)
    const seat = seats.at(i)
    const row = characters.find(entity)
    if (row < 0) continue
    const ch = characters.at(<u32>row)
    const needsPlacement = ch.placed == 0
    if (needsPlacement) {
      placeSeat(entity, ch, seat.spawn_t_0, seat.spawn_t_1, seat.spawn_t_2, seat.spawn_facing_0, seat.spawn_facing_1)
      ch.placed = 1
    }
    ch.frozen = round.frozen
    const transform = transformOf(entity)
    if (needsPlacement) {
      transform.pos_0 = <f32>seat.spawn_t_0
      transform.pos_1 = <f32>(seat.spawn_t_1 + ch.stand + 0.01)
      transform.pos_2 = <f32>seat.spawn_t_2
      transform.rot_0 = 0
      transform.rot_1 = 0
      transform.rot_2 = 0
      transform.rot_3 = 1
      setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
    }
    seat.before_0 = transform.pos_0
    seat.before_1 = transform.pos_1
    seat.before_2 = transform.pos_2
  }
  characters.write()
  seats.write()
}
