import type { RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { CHAR, CarryKind, CharMode } from '../character/constants.ts'
import { inBox } from '../course.ts'
import type { FeatureSpec } from '../course.ts'
import { G, groups } from '../groups.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { v3, quatIdentity } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureSeats } from './feature.ts'
import { SeatState, orderedSeatIndices } from './seatState.ts'
import { boxParam, listParam, objOf, stringParam, ticksParam, vec3Of } from './params.ts'

export const CARRY_KIND = 'carryItem'
export interface CarryRules {
  onePerBean: true
  dropOnStun: true
  dropOnFall: true
  resetTicks: number
  protectedHomes: boolean
}

function sameVector(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

function dist2(a: Vec3, b: Vec3): number {
  const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z
  return x * x + y * y + z * z
}

export function carryItemFeature(spec: FeatureSpec, path: string): CourseFeature {
  const asset = stringParam(spec, path, 'asset', /^[a-z0-9.-]{1,64}$/)
  const items = listParam(spec, path, 'spawns', 1, 16).map((value, i) => ({
    spawn: vec3Of(value, `${path}/spawns/${i}`), body: -1, holder: -1, lastTouchTick: 0,
    lastHand: vec3Of(value, `${path}/spawns/${i}`),
  }))
  const homes = listParam(spec, path, 'homes', 0, 4).map((value, i) => {
    const ptr = `${path}/homes/${i}`
    const params = objOf(value, ptr)
    const box = boxParam({ ...spec, params }, ptr)
    const team = params.team
    if (team !== null && team !== 0 && team !== 1) {
      refuse('feature', `${ptr}/team`, 'expected team 0, 1 or null; write a team index or null')
    }
    return { ...box, team }
  })
  const rules: CarryRules = {
    onePerBean: true, dropOnStun: true, dropOnFall: true,
    resetTicks: ticksParam(spec, path, 'resetS', 0, Number.MAX_SAFE_INTEGER / 60),
    protectedHomes: homes.some(home => home.team !== null),
  }
  let physics: RapierWorldSim
  let seats: FeatureSeats
  const state = new SeatState(() => ({ prevGrab: 0 }))
  const zero = v3(0, 0, 0), pos = v3(0, 0, 0), facing = v3(0, 0, 0), vel = v3(0, 0, 0)
  const hand = (i: number): Vec3 => {
    seats.pos(i, pos)
    seats.facing(i, facing)
    return v3(pos.x + facing.x * 0.55, pos.y + 0.25, pos.z + facing.z * 0.55)
  }
  const protectedHome = (p: Vec3, team: number): boolean => rules.protectedHomes &&
    homes.some(home => home.team !== null && home.team !== team && inBox(home, p))

  return {
    id: spec.id,
    kind: CARRY_KIND,
    init(ctx) {
      physics = ctx.physics
      seats = ctx.seats
      state.sync(seats)
      for (const item of items) {
        const p = item.spawn
        item.holder = -1
        item.lastTouchTick = ctx.tick
        item.body = physics.createBody(
          ctx.R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z),
          [ctx.R.ColliderDesc.ball(0.35).setDensity(1)
            .setCollisionGroups(groups(G.DEBRIS, G.STATIC | G.MOVING | G.DEBRIS))],
        )
      }
    },
    preStep(ctx) {
      state.sync(seats)
      for (const item of items) {
        if (item.holder < 0) continue
        const i = state.ids.indexOf(item.holder)
        if (i < 0) {
          item.holder = -1
          item.lastTouchTick = ctx.tick
          continue
        }
        const body = physics.body(item.body)
        const fallen = seats.status(i) !== PlayerStatus.alive || seats.mode(i) === CharMode.parked
        if (fallen || seats.mode(i) === CharMode.stunned || !seats.input(i).grab) {
          // A parked seat has already moved away; the item retains its last hand pose.
          body.setTranslation(fallen ? item.lastHand : hand(i), true)
          item.holder = -1
          seats.setCarry(i, CarryKind.none, -1)
          item.lastTouchTick = ctx.tick
          body.setLinvel(seats.vel(i, vel), true)
          ctx.sound('move.release', body.translation(), 1)
        }
      }
      for (const item of items) {
        if (item.holder < 0) continue
        const body = physics.body(item.body)
        item.lastHand = hand(state.ids.indexOf(item.holder))
        body.setTranslation(item.lastHand, true)
        body.setLinvel(zero, true)
        item.lastTouchTick = ctx.tick
      }
      for (const i of orderedSeatIndices(seats)) {
        const grab = seats.input(i).grab
        const pressed = grab && !state.rows[i].prevGrab
        state.rows[i].prevGrab = grab ? 1 : 0
        if (!pressed || seats.status(i) !== PlayerStatus.alive || seats.protectedNow(i) ||
            seats.carry(i) !== CarryKind.none ||
            (seats.mode(i) !== CharMode.ground && seats.mode(i) !== CharMode.air)) continue
        seats.pos(i, pos)
        let best = -1, bestD = CHAR.grabRange * CHAR.grabRange
        for (let j = 0; j < items.length; j++) {
          const item = items[j]
          if (item.holder >= 0) continue
          const p = physics.body(item.body).translation()
          if (protectedHome(p, seats.team(i))) continue
          const d = dist2(pos, p)
          if (d <= bestD && (best < 0 || d < bestD)) { best = j; bestD = d }
        }
        if (best < 0) continue
        const item = items[best]
        item.holder = seats.seat(i)
        item.lastTouchTick = ctx.tick
        seats.setCarry(i, CarryKind.object, best)
        const body = physics.body(item.body)
        item.lastHand = hand(i)
        body.setTranslation(item.lastHand, true)
        body.setLinvel(zero, true)
        ctx.sound('move.carry', body.translation(), 1)
      }
      for (const item of items) {
        if (item.holder >= 0) continue
        const body = physics.body(item.body)
        if (ctx.tick - item.lastTouchTick < rules.resetTicks && body.translation().y >= ctx.course.killPlaneY) continue
        body.setTranslation(item.spawn, true)
        body.setRotation(quatIdentity(), true)
        body.setLinvel(zero, true)
        body.setAngvel(zero, true)
        item.lastTouchTick = ctx.tick
      }
    },
    postStep() {},
    snapshot(w) {
      for (const item of items) {
        const body = physics.body(item.body)
        const p = body.translation(), q = body.rotation(), v = body.linvel(), a = body.angvel()
        w.i16(item.holder); w.i32(item.lastTouchTick)
        w.f64(p.x); w.f64(p.y); w.f64(p.z)
        w.f64(q.x); w.f64(q.y); w.f64(q.z); w.f64(q.w)
        w.f64(v.x); w.f64(v.y); w.f64(v.z)
        w.f64(a.x); w.f64(a.y); w.f64(a.z)
        w.u8(body.isSleeping() ? 1 : 0)
        w.f64(item.lastHand.x); w.f64(item.lastHand.y); w.f64(item.lastHand.z)
      }
      state.snapshot(w, (w, row) => w.u8(row.prevGrab))
    },
    restore(r, ctx) {
      physics = ctx.physics
      seats = ctx.seats
      for (const item of items) {
        item.holder = r.i16(); item.lastTouchTick = r.i32()
        const body = physics.body(item.body)
        const p = v3(r.f64(), r.f64(), r.f64())
        const q = { x: r.f64(), y: r.f64(), z: r.f64(), w: r.f64() }
        const v = v3(r.f64(), r.f64(), r.f64()), a = v3(r.f64(), r.f64(), r.f64())
        const sleeping = r.u8() !== 0
        // Domain rollback already restored Rapier. Reapplying a rotation can
        // renormalize it; waking a sleeping body also changes future steps.
        if (!sameVector(body.translation(), p)) body.setTranslation(p, false)
        const rotation = body.rotation()
        if (!sameVector(rotation, q) || rotation.w !== q.w) body.setRotation(q, false)
        if (!sameVector(body.linvel(), v)) body.setLinvel(v, false)
        if (!sameVector(body.angvel(), a)) body.setAngvel(a, false)
        if (sleeping !== body.isSleeping()) { if (sleeping) body.sleep(); else body.wakeUp() }
        item.lastHand = v3(r.f64(), r.f64(), r.f64())
      }
      state.restore(r, seats, r => ({ prevGrab: r.u8() }))
    },
    draw(out) {
      for (const item of items) {
        const body = physics.body(item.body)
        out.push({ asset, t: body.translation(), r: body.rotation(), s: v3(0.7, 0.7, 0.7),
          visible: true, tint: item.holder >= 0 ? 4 : 0 })
      }
    },
    grabCandidates(position, direction, out) {
      for (let id = 0; id < items.length; id++) {
        const item = items[id]
        if (item.holder >= 0) continue
        const p = physics.body(item.body).translation()
        const d = Math.sqrt(dist2(position, p))
        const dx = p.x - position.x, dz = p.z - position.z
        const planar = Math.sqrt(dx * dx + dz * dz)
        if (d <= CHAR.grabRange && (planar === 0 ||
            (dx * direction.x + dz * direction.z) / planar >= CHAR.grabConeDot)) out.push({ id, dist: d })
      }
    },
    botTarget(seat, position, out) {
      let i = -1
      for (let j = 0; j < seats.count; j++) if (seats.seat(j) === seat) { i = j; break }
      if (i < 0) return false
      let best: Vec3 | undefined, bestD = Infinity
      const consider = (p: Vec3): void => {
        const d = dist2(position, p)
        if (d < bestD) { best = p; bestD = d }
      }
      if (items.some(item => item.holder === seat)) {
        for (const home of homes) if (home.team === null || home.team === seats.team(i)) consider(home.center)
      } else {
        for (const item of items) if (item.holder < 0) consider(physics.body(item.body).translation())
        if (!best) for (const home of homes) consider(home.center)
      }
      if (!best) return false
      Object.assign(out, best)
      return true
    },
  }
}
