import { Column, emit, newRecord, readColumn, readResource, setComponent, tick, writeResource } from 'ege'
import { Character, CourseRes, EgeTransform, EliminateEvent, FallEvent, FinishEvent, Gate, GateEvent, Home, HomeSpawn, ProgressEvent, RoundRes, Seat } from '../components.gen'
import { releaseGrab } from '../character/grab.as'
import { inBox } from '../lib/boxes.as'
import { characterColumn, parkSeat, placeSeat, seatColumn, transformOf } from '../lib/seats.as'
import { dueRespawn, nextCursor, nextSlot, respawnSlotX, respawnSlotZ, scheduleRespawn } from './respawn.as'
import { FINISH_DONE, FINISH_LAP, gateCrossed, finishCrossed, routeDistanceMm, subTick, ROUTE_NOT_CROSSED } from './route.as'

function resetTeleport(entity: u32, ch: Character, now: i32): void {
  ch.grounded = 0
  ch.ground_obstacle = -1
  ch.ground_item = -1
  ch.ground_body = -1
  ch.coyote = 0
  ch.jump_buffer = 0
  ch.teleport_tick = now
  if (ch.grab_lever >= 0) releaseGrab(entity, ch)
}

function park(entity: u32, ch: Character, seatId: u32, now: i32): void {
  parkSeat(entity, ch, seatId)
  const t = transformOf(entity)
  t.pos_0 = <f32>(<f64>seatId * 5.0)
  t.pos_1 = <f32>(-500.0)
  t.pos_2 = 0
  t.rot_0 = 0
  t.rot_1 = 0
  t.rot_2 = 0
  t.rot_3 = 1
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, t)
  resetTeleport(entity, ch, now)
}

function emitFall<T>(eventId: u32, size: u32, entity: u32, seatId: u32, crossing: u32): void {
  const payload = newRecord<T>(size)
  payload.seat = seatId
  payload.crossing = crossing
  emit<T>(eventId, entity, payload, size)
}

function placeRespawn(entity: u32, seat: Seat, ch: Character, gates: Column<Gate>, homes: Column<Home>, homeSpawns: Column<HomeSpawn>, course: CourseRes, now: i32): void {
  let bx = seat.spawn_t_0
  let by = seat.spawn_t_1
  let bz = seat.spawn_t_2
  let fx = seat.spawn_facing_0
  let fz = seat.spawn_facing_1
  let anchor: u32 = 0
  let anchorKind: u32 = 2
  if (seat.checkpoint >= 0) {
    for (let i: u32 = 0; i < gates.count; i++) {
      const gate = gates.at(i)
      if (gate.index != <u32>seat.checkpoint) continue
      bx = gate.respawn_t_0
      by = gate.respawn_t_1
      bz = gate.respawn_t_2
      fx = gate.respawn_facing_0
      fz = gate.respawn_facing_1
      anchor = i
      anchorKind = 0
      break
    }
  } else anchor = <u32>(-1 - seat.checkpoint)

  if (course.respawn_mode == 1) {
    for (let i: u32 = 0; i < homes.count; i++) {
      const home = homes.at(i)
      if (home.team != seat.team) continue
      anchor = i
      anchorKind = 1
      for (let j: u32 = 0; j < homeSpawns.count; j++) {
        const spawn = homeSpawns.at(j)
        if (spawn.home != home.index || spawn.index != 0) continue
        bx = spawn.t_0
        by = spawn.t_1
        bz = spawn.t_2
        fx = spawn.facing_0
        fz = spawn.facing_1
        break
      }
      break
    }
  }

  let cursor: u32 = seat.cursor
  if (anchorKind == 0) cursor = gates.at(anchor).cursor
  else if (anchorKind == 1) cursor = homes.at(anchor).cursor
  const slot = nextSlot(cursor, course.slots)
  const updatedCursor = nextCursor(slot, course.slots)
  if (anchorKind == 0) {
    if (updatedCursor != cursor) {
      gates.at(anchor).cursor = updatedCursor
      gates.write()
    }
  } else if (anchorKind == 1) {
    if (updatedCursor != cursor) {
      homes.at(anchor).cursor = updatedCursor
      homes.write()
    }
  } else seat.cursor = updatedCursor

  let tx = bx
  let tz = bz
  if (course.wait_ticks != 0) {
    tx = respawnSlotX(bx, bz, fx, fz, slot, course.slots, course.spacing_m)
    tz = respawnSlotZ(bx, bz, fx, fz, slot, course.slots, course.spacing_m)
  }
  placeSeat(entity, ch, tx, by, tz, fx, fz)
  const t = transformOf(entity)
  t.pos_0 = <f32>tx
  t.pos_1 = <f32>(by + ch.stand + 0.01)
  t.pos_2 = <f32>tz
  t.rot_0 = 0
  t.rot_1 = 0
  t.rot_2 = 0
  t.rot_3 = 1
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, t)
  ch.parked = 0
  resetTeleport(entity, ch, now)
  seat.wait_until = -1
  seat.protect_until = now + <i32>course.protect_ticks
  ch.protected_until = seat.protect_until
  seat.prev_y = by + ch.stand + 0.01
}

function fall(seat: Seat, ch: Character, entity: u32, crossing: u32, now: i32, course: CourseRes, gates: Column<Gate>, homes: Column<Home>, homeSpawns: Column<HomeSpawn>): void {
  if (course.respawn_mode == 2) {
    seat.status = 3
    emitFall<EliminateEvent>(EliminateEvent.ID, EliminateEvent.SIZE, entity, seat.seat, crossing)
    park(entity, ch, seat.seat, now)
    return
  }
  emitFall<FallEvent>(FallEvent.ID, FallEvent.SIZE, entity, seat.seat, crossing)
  park(entity, ch, seat.seat, now)
  scheduleRespawn(seat, now, course.wait_ticks, course.protect_ticks)
  if (dueRespawn(seat.wait_until, now)) placeRespawn(entity, seat, ch, gates, homes, homeSpawns, course, now)
}

export function rf_seat_rules(): void {
  const now = <i32>tick()
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const course = readResource<CourseRes>(CourseRes.ID, CourseRes.SIZE)
  if (round.frozen != 0) return
  const seats = seatColumn()
  const characters = characterColumn()
  const gates = readColumn<Gate>(Gate.ID, Gate.SIZE)
  const homes = readColumn<Home>(Home.ID, Home.SIZE)
  const homeSpawns = readColumn<HomeSpawn>(HomeSpawn.ID, HomeSpawn.SIZE)
  for (let i: u32 = 0; i < seats.count; i++) {
    const entity = seats.entity(i)
    const seat = seats.at(i)
    if (seat.kill_request == 0) continue
    const row = characters.find(entity)
    if (row >= 0 && seat.status == 1) {
      const ch = characters.at(<u32>row)
      const transform = transformOf(entity)
      fall(seat, ch, entity, subTick(seat.prev_y, <f64>transform.pos_1, course.kill_plane_y), now, course, gates, homes, homeSpawns)
    }
    seat.kill_request = 0
  }

  for (let i: u32 = 0; i < seats.count; i++) {
    const entity = seats.entity(i)
    const seat = seats.at(i)
    if (seat.status != 1) continue
    const row = characters.find(entity)
    if (row < 0) continue
    const ch = characters.at(<u32>row)
    if (seat.wait_until >= 0) {
      if (dueRespawn(seat.wait_until, now)) placeRespawn(entity, seat, ch, gates, homes, homeSpawns, course, now)
      continue
    }
    const transform = transformOf(entity)
    const x = <f64>transform.pos_0
    const y = <f64>transform.pos_1
    const z = <f64>transform.pos_2
    for (let j: u32 = 0; j < gates.count; j++) {
      const gate = gates.at(j)
      if (!inBox(gate.center_0, gate.center_1, gate.center_2, gate.half_0, gate.half_1, gate.half_2, x, y, z)) continue
      const stage = gateCrossed(course.ordered, course.stage_count, gate.index, gate.stage, seat.stage)
      if (stage == ROUTE_NOT_CROSSED) continue
      seat.stage = stage
      seat.checkpoint = <i32>gate.index
      const event = newRecord<GateEvent>(GateEvent.SIZE)
      event.seat = seat.seat
      event.stage = stage
      event.lap = seat.lap
      emit<GateEvent>(GateEvent.ID, entity, event, GateEvent.SIZE)
    }
    if (course.has_finish != 0 && inBox(course.finish_center_0, course.finish_center_1, course.finish_center_2, course.finish_half_0, course.finish_half_1, course.finish_half_2, x, y, z)) {
      const result = finishCrossed(course.ordered, course.laps, course.last_stage, seat.stage, seat.lap)
      if (result == FINISH_LAP) {
        seat.lap++
        seat.stage = -1
        const event = newRecord<GateEvent>(GateEvent.SIZE)
        event.seat = seat.seat
        event.stage = seat.stage
        event.lap = seat.lap
        emit<GateEvent>(GateEvent.ID, entity, event, GateEvent.SIZE)
      } else if (result == FINISH_DONE) {
        seat.finished = 1
        let crossing: u32 = 0
        for (let axis: u32 = 0; axis < 3; axis++) {
          const prev = axis == 0 ? seat.before_0 : axis == 1 ? seat.before_1 : seat.before_2
          const pos = axis == 0 ? x : axis == 1 ? y : z
          const center = axis == 0 ? course.finish_center_0 : axis == 1 ? course.finish_center_1 : course.finish_center_2
          const half = axis == 0 ? course.finish_half_0 : axis == 1 ? course.finish_half_1 : course.finish_half_2
          const lo = center - half
          const hi = center + half
          const part = prev < lo ? subTick(prev, pos, lo) : prev > hi ? subTick(prev, pos, hi) : 0
          if (part > crossing) crossing = part
        }
        seat.status = 2
        const event = newRecord<FinishEvent>(FinishEvent.SIZE)
        event.seat = seat.seat
        event.crossing = crossing
        event.lap = seat.lap
        emit<FinishEvent>(FinishEvent.ID, entity, event, FinishEvent.SIZE)
        park(entity, ch, seat.seat, now)
        continue
      }
    }
    if (y < course.kill_plane_y) {
      fall(seat, ch, entity, subTick(seat.prev_y, y, course.kill_plane_y), now, course, gates, homes, homeSpawns)
      continue
    }
    seat.prev_y = y
    if ((round.kind == 0 || round.kind == 6) && (now - <i32>round.intro_ticks) % 30 == 0) {
      const event = newRecord<ProgressEvent>(ProgressEvent.SIZE)
      event.seat = seat.seat
      event.distance_mm = routeDistanceMm(seat.stage, x, y, z)
      emit<ProgressEvent>(ProgressEvent.ID, entity, event, ProgressEvent.SIZE)
    }
  }

  round.alive = 0
  round.qualified = 0
  round.eliminated = 0
  for (let i: u32 = 0; i < seats.count; i++) {
    const status = seats.at(i).status
    if (status == 1) round.alive++
    else if (status == 2) round.qualified++
    else if (status == 3) round.eliminated++
  }
  if (round.alive == 0 && (round.phase == 1 || round.phase == 2)) {
    round.phase = 3
    round.ended_tick = now
  }
  characters.write()
  seats.write()
  writeResource<RoundRes>(RoundRes.ID, RoundRes.SIZE, round)
}
