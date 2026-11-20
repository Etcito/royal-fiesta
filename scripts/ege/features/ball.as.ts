import { Column, emit, getComponent, isNull, newRecord, pose, readColumn, readResource, setAngvel, setLinvel, setPose, tick } from 'ege'
import {
  Character, CourseRes, EgeTransform, FeatureBall, FeatureGoal, Home, HomeSpawn, RoundRes, Seat, TeamScoreEvent,
} from '../components.gen'
import { characterColumn, placeSeat, seatColumn } from '../lib/seats.as'
import { ticksOf } from '../lib/units.as'

// packages/sim/src/features/football.ts:26: the ball returns 180 ticks after a goal.
const SCORE_RESET_TICKS: i32 = 180
// packages/sim/src/features/football.ts:27: an anchor move above 0.25 m restarts the idle timer.
const ANCHOR_MOVE2: f64 = 0.25 * 0.25
// packages/sim/src/season/respawn.ts:7-9: the slot grid of homeSpawn.
const GRID_COLUMNS: u32 = 4
const GRID_ROWS: u32 = 3
const MAX_SLOTS: u32 = 12

// packages/sim/src/features/football.ts:46-50: X and Z shrink by the ball radius, Y does not.
function insideGoal(goal: FeatureGoal, x: f64, y: f64, z: f64, radius: f64): bool {
  return Math.abs(x - goal.center_0) <= goal.half_0 - radius &&
    Math.abs(y - goal.center_1) <= goal.half_1 &&
    Math.abs(z - goal.center_2) <= goal.half_2 - radius
}

// packages/sim/src/features/football.ts:135-145: spawn pose, identity rotation, zero velocity.
function placeBall(entity: u32, ball: FeatureBall, now: i32): void {
  setPose(entity, pose(<f32>ball.spawn_0, <f32>ball.spawn_1, <f32>ball.spawn_2))
  setLinvel(entity, 0, 0, 0)
  setAngvel(entity, 0, 0, 0)
  ball.anchor_0 = ball.spawn_0
  ball.anchor_1 = ball.spawn_1
  ball.anchor_2 = ball.spawn_2
  ball.anchor_tick = now
}

// packages/sim/src/season/teams.ts:29-35 and respawn.ts:64-80: homeSpawn picks the team home's
// respawn[k % n] and spreads it over the slot grid floor(k / n). The records already hold the
// authored homes and spawns; the seat helpers stay untouched.
function resetHomeSeats(
  course: CourseRes, homes: Column<Home>, homeSpawns: Column<HomeSpawn>,
  seats: Column<Seat>, characters: Column<Character>,
): void {
  if (course.home_count == 0) return
  let k0: u32 = 0
  let k1: u32 = 0
  for (let rank: u32 = 0; rank < seats.count; rank++) {
    let row: i32 = -1
    for (let j: u32 = 0; j < seats.count; j++) {
      if (seats.at(j).seat != rank) continue
      row = <i32>j
      break
    }
    if (row < 0) continue
    const seat = seats.at(<u32>row)
    if (seat.status != 1) continue
    const k = seat.team == 1 ? k1++ : k0++
    let homeIndex: u32 = 0
    let found = false
    for (let h: u32 = 0; h < homes.count; h++) {
      if (homes.at(h).team != seat.team) continue
      homeIndex = homes.at(h).index
      found = true
      break
    }
    if (!found) continue
    let total: u32 = 0
    for (let s: u32 = 0; s < homeSpawns.count; s++) {
      if (homeSpawns.at(s).home == homeIndex) total++
    }
    if (total == 0) continue
    const baseIndex = k % total
    let baseRow: i32 = -1
    for (let s: u32 = 0; s < homeSpawns.count; s++) {
      const spawn = homeSpawns.at(s)
      if (spawn.home == homeIndex && spawn.index == baseIndex) {
        baseRow = <i32>s
        break
      }
    }
    if (baseRow < 0) continue
    const base = homeSpawns.at(<u32>baseRow)
    let count: u32 = course.slots > MAX_SLOTS ? MAX_SLOTS : course.slots
    if (count == 0) count = 1
    const slot = k / total
    const index = slot % count
    const column = index % GRID_COLUMNS
    const gridRow = index / GRID_COLUMNS
    const alongRight = (<f64>column - (<f64>GRID_COLUMNS - 1.0) / 2.0) * course.spacing_m
    const alongBack = (<f64>gridRow - (<f64>GRID_ROWS - 1.0) / 2.0) * course.spacing_m
    const fx = base.facing_0
    const fz = base.facing_1
    const x = base.t_0 - fz * alongRight - fx * alongBack
    const z = base.t_2 + fx * alongRight - fz * alongBack
    const entity = seats.entity(<u32>row)
    const chRow = characters.find(entity)
    if (chRow < 0) continue
    placeSeat(entity, characters.at(<u32>chRow), x, base.t_1, z, fx, fz)
  }
}

// no handoff: Emit defending goals and their visual boxes supplies the feature_goal records this
// system scores against; its goal module has no callable entry point for the behaviour.
// no handoff: Emit dynamic balls with source mass supplies the feature_ball records this system
// moves; the emitter has no callable entry point for the behaviour.
export function rf_feature_ball_post(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const course = readResource<CourseRes>(CourseRes.ID, CourseRes.SIZE)
  const balls = readColumn<FeatureBall>(FeatureBall.ID, FeatureBall.SIZE)
  const goals = readColumn<FeatureGoal>(FeatureGoal.ID, FeatureGoal.SIZE)
  const homes = readColumn<Home>(Home.ID, Home.SIZE)
  const homeSpawns = readColumn<HomeSpawn>(HomeSpawn.ID, HomeSpawn.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick()
  const playing = now >= <i32>round.intro_ticks
  for (let b: u32 = 0; b < balls.count; b++) {
    const entity = balls.entity(b)
    const ball = balls.at(b)
    const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
    if (isNull<EgeTransform>(transform)) continue
    const x = <f64>transform.pos_0
    const y = <f64>transform.pos_1
    const z = <f64>transform.pos_2
    if (ball.placed == 0) ball.placed = 1

    if (playing) {
      if (ball.pending < 0) {
        for (let g: u32 = 0; g < goals.count; g++) {
          const goal = goals.at(g)
          if (!insideGoal(goal, x, y, z, ball.radius)) continue
          const event = newRecord<TeamScoreEvent>(TeamScoreEvent.SIZE)
          event.team = 1 - goal.team
          event.a = 1
          event.b = 0
          emit<TeamScoreEvent>(TeamScoreEvent.ID, entity, event, TeamScoreEvent.SIZE)
          ball.pending = now + SCORE_RESET_TICKS
          break
        }
      }
      if (ball.pending >= 0 && now >= ball.pending) {
        ball.pending = -1
        placeBall(entity, ball, now)
        resetHomeSeats(course, homes, homeSpawns, seats, characters)
        continue
      }
    }
    if (ball.pending >= 0) continue

    const dx = x - ball.anchor_0
    const dy = y - ball.anchor_1
    const dz = z - ball.anchor_2
    if (dx * dx + dy * dy + dz * dz > ANCHOR_MOVE2) {
      ball.anchor_0 = x
      ball.anchor_1 = y
      ball.anchor_2 = z
      ball.anchor_tick = now
    } else if (now - ball.anchor_tick >= ticksOf(ball.reset_s) || y < course.kill_plane_y) {
      placeBall(entity, ball, now)
    }
  }
  balls.write()
  seats.write()
  characters.write()
}
