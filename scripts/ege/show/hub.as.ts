import { Column, cos, getComponent, inputCode, isNull, readColumn, readResource, setComponent, sin, tick } from 'ege'
import {
  Character, CourseRes, EgeTransform, Seat, ShowControl, ShowHubOccupant, ShowHubState, ShowSeatIdentity,
} from '../components.gen'
import { characterColumn, placeSeat, seatColumn, transformOf } from '../lib/seats.as'
import { s1OfEngine } from '../bots/brain.as'
import { Mulberry } from './scheduler.as'

// The hub script is the non-competitive lobby half of G7.2. It never writes a round result and
// never changes a seat's status: the local human is driven through `show_control`, a fall returns
// to the seat spawn, and the occupant rows supply the lobby queue occupancy and the existing
// lobby-bot wandering (a fresh seeded target around the seat spawn every two seconds). The RNG
// state, wander target, next-wander tick and occupancy totals all live in schema rows, so a
// snapshot restores the same wandering without any wall-clock duration.

const KIND_BOT: u32 = 1
const HUB_WANDER_TICKS: i32 = 120
const TAU: f64 = 6.283185307179586
const HUB_ARRIVE_M: f64 = 0.5
const HUB_NEUTRAL_S1: u32 = 32639

function fail(message: string): void {
  abort(message, 'scripts/ege/show/hub.as.ts', 0, 0)
}

function recover(entity: u32, seat: Seat, ch: Character, now: i32): void {
  placeSeat(entity, ch, seat.spawn_t_0, seat.spawn_t_1, seat.spawn_t_2, seat.spawn_facing_0, seat.spawn_facing_1)
  ch.placed = 1
  ch.parked = 0
  ch.frozen = 0
  ch.grounded = 0
  ch.ground_obstacle = -1
  ch.ground_item = -1
  ch.ground_body = -1
  ch.coyote = 0
  ch.jump_buffer = 0
  ch.teleport_tick = now
  const transform = transformOf(entity)
  transform.pos_0 = <f32>seat.spawn_t_0
  transform.pos_1 = <f32>(seat.spawn_t_1 + ch.stand + 0.01)
  transform.pos_2 = <f32>seat.spawn_t_2
  transform.rot_0 = 0
  transform.rot_1 = 0
  transform.rot_2 = 0
  transform.rot_3 = 1
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
}

function seatIndexForRound(seats: Column<Seat>, roundSeat: u32): i32 {
  for (let i: u32 = 0; i < seats.count; i++) {
    if (<u32>seats.at(i).seat == roundSeat) return <i32>i
  }
  return -1
}

/** One S1 axis byte: clamp(round(n*127), -127, 127) + 127. */
function axisByte(n: f64): u32 {
  const scaled = <i32>Math.round(n * 127.0)
  const clamped = scaled < -127 ? -127 : (scaled > 127 ? 127 : scaled)
  return <u32>(clamped + 127)
}

/** Steers a scripted lobby bot seat toward its wander target by writing its S1 show_control. */
function steerBot(entity: u32, identities: Column<ShowSeatIdentity>, occupant: ShowHubOccupant): void {
  const identityRow = identities.find(entity)
  if (identityRow < 0 || identities.at(<u32>identityRow).input_slot >= 0) return
  const control = getComponent<ShowControl>(entity, ShowControl.ID, ShowControl.SIZE)
  if (isNull<ShowControl>(control)) return
  const transform = transformOf(entity)
  const dx = occupant.wander_x - <f64>transform.pos_0
  const dz = occupant.wander_z - <f64>transform.pos_2
  const d = Math.sqrt(dx * dx + dz * dz)
  control.code = d <= HUB_ARRIVE_M ? HUB_NEUTRAL_S1 : axisByte(dx / d) | (axisByte(dz / d) << 8)
  setComponent<ShowControl>(entity, ShowControl.ID, ShowControl.SIZE, control)
}

function stepWander(seat: Seat, occupant: ShowHubOccupant, now: i32): void {
  if (now < occupant.wander_tick) return
  const rng = new Mulberry(occupant.rng_state)
  const angle = rng.nextUnit() * TAU
  const radius = <f64>rng.int(1, 4)
  occupant.wander_x = seat.spawn_t_0 + <f64>sin(angle) * radius
  occupant.wander_z = seat.spawn_t_2 + <f64>cos(angle) * radius
  occupant.rng_state = rng.state
  occupant.wander_tick = now + HUB_WANDER_TICKS
}

/** Hub locomotion, fall recovery and local queue occupancy; the show clock owns no hub closure. */
export function rf_show_hub(): void {
  const now = <i32>tick()
  const course = readResource<CourseRes>(CourseRes.ID, CourseRes.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const identities = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)

  for (let i: u32 = 0; i < seats.count; i++) {
    const entity = seats.entity(i)
    const seat = seats.at(i)
    const row = characters.find(entity)
    if (row < 0) continue
    const ch = characters.at(<u32>row)
    const transform = transformOf(entity)
    if (ch.placed == 0 || <f64>transform.pos_1 < course.kill_plane_y) recover(entity, seat, ch, now)
    else ch.frozen = 0

    // A local human copies its assigned engine input slot into the shared control record that
    // rf.character.pre reads; scripted seats keep whatever a bot system wrote.
    const identityRow = identities.find(entity)
    if (identityRow >= 0 && identities.at(<u32>identityRow).input_slot >= 0) {
      const control = getComponent<ShowControl>(entity, ShowControl.ID, ShowControl.SIZE)
      if (!isNull<ShowControl>(control)) {
        control.code = s1OfEngine(inputCode(seat.player))
        setComponent<ShowControl>(entity, ShowControl.ID, ShowControl.SIZE, control)
      }
    }
  }
  characters.write()
  seats.write()

  const hubs = readColumn<ShowHubState>(ShowHubState.ID, ShowHubState.SIZE)
  if (hubs.count == 0) return
  if (hubs.count > 1) fail('a hub world has one show_hub_state row')
  const hub = hubs.at(0)
  const occupants = readColumn<ShowHubOccupant>(ShowHubOccupant.ID, ShowHubOccupant.SIZE)
  let occupantsActive: u32 = 0
  let humans: u32 = 0
  let bots: u32 = 0
  for (let i: u32 = 0; i < occupants.count; i++) {
    const occupant = occupants.at(i)
    if (occupant.active == 0) continue
    occupantsActive++
    if (occupant.kind == KIND_BOT) {
      bots++
      const index = seatIndexForRound(seats, occupant.round_seat)
      if (index >= 0) {
        stepWander(seats.at(<u32>index), occupant, now)
        steerBot(seats.entity(<u32>index), identities, occupant)
      }
    } else {
      humans++
    }
  }
  occupants.write()
  hub.occupants = occupantsActive
  hub.humans = humans
  hub.bots = bots
  hub.tick = now
  hubs.write()
}
