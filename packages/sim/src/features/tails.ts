// tailSet (map O): tails are handed to half the seats on the first round tick.
// A grab transfers the nearest tail; the new holder is immune for immunityS.
// A holder that dies or parks drops its tail back to the spawn pile.

import { CHAR, CarryKind, CharMode } from '../character/constants.ts'
import type { FeatureSpec } from '../course.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { quatIdentity, v3 } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory, FeatureSeats } from './feature.ts'
import { ticksParam, vec3Param } from './params.ts'
import { SeatState, orderedSeatIndices } from './seatState.ts'

export const TAIL_KIND = 'tailSet'

const FLEE_M = 6
const REPOSSESS_TICKS = 60

interface TailRow {
  hasTail: number
  immuneUntil: number
  prevGrab: number
}

function dist2(a: Vec3, b: Vec3): number {
  const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z
  return x * x + y * y + z * z
}

function countOf(spec: FeatureSpec, path: string): 'half' | number {
  const value = spec.params.count
  if (value === 'half') return 'half'
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 30) return value
  return refuse('feature', `${path}/count`,
    "expected count as 'half' or an integer 1..30; write 'half' or a whole number in that range")
}

export const tailSetFeature: FeatureFactory = (spec, path): CourseFeature => {
  const count = countOf(spec, path)
  const spawn = vec3Param(spec, path, 'spawn')
  const immunityTicks = ticksParam(spec, path, 'immunityS', 0, 30)
  let seats!: FeatureSeats
  let assigned = false
  let freeTails = 0
  let tick = 0
  const state = new SeatState<TailRow>(() => ({ hasTail: 0, immuneUntil: 0, prevGrab: 0 }))
  const pos = v3(0, 0, 0)
  const other = v3(0, 0, 0)

  const hold = (ctx: FeatureCtx, i: number): void => {
    const row = state.rows[i]
    row.hasTail = 1
    row.immuneUntil = ctx.tick + immunityTicks
    seats.setCarry(i, CarryKind.tail, 0)
    seats.pos(i, pos)
    ctx.emit('possess', seats.seat(i), 1, 0)
    ctx.sound('obj.tail', pos, 1)
  }

  return {
    id: spec.id,
    kind: TAIL_KIND,
    init(ctx) {
      seats = ctx.seats
      assigned = false
      freeTails = 0
      tick = ctx.tick
      state.sync(seats)
    },
    preStep(ctx) {
      tick = ctx.tick
      state.sync(seats)
      const order = orderedSeatIndices(seats)
      if (!assigned && ctx.roundTick >= 0) {
        assigned = true
        const picks = order.slice()
        const n = count === 'half' ? Math.floor(seats.count / 2) : Math.min(count, seats.count)
        for (let i = 0; i < n; i++) {
          const j = ctx.rng.int(i, picks.length - 1)
          const swap = picks[i]
          picks[i] = picks[j]
          picks[j] = swap
          const slot = picks[i]
          state.rows[slot].hasTail = 1
          seats.setCarry(slot, CarryKind.tail, 0)
          seats.pos(slot, pos)
          ctx.emit('possess', seats.seat(slot), 1, 0)
          ctx.sound('obj.tail', pos, 1)
        }
      }
      for (const i of order) {
        const row = state.rows[i]
        if (row.hasTail === 0) continue
        if (seats.status(i) === PlayerStatus.alive && seats.mode(i) !== CharMode.parked) continue
        row.hasTail = 0
        row.immuneUntil = 0
        if (freeTails < 255) freeTails++
        seats.setCarry(i, CarryKind.none, -1)
        ctx.emit('possess', seats.seat(i), 0, 0)
      }
      const taken = new Set<number>()
      for (const i of order) {
        const row = state.rows[i]
        const grab = seats.input(i).grab
        const pressed = grab && row.prevGrab === 0
        row.prevGrab = grab ? 1 : 0
        if (!pressed || row.hasTail !== 0 || seats.carry(i) !== CarryKind.none) continue
        if (seats.status(i) !== PlayerStatus.alive || seats.protectedNow(i)) continue
        const mode = seats.mode(i)
        if (mode !== CharMode.ground && mode !== CharMode.air) continue
        seats.pos(i, pos)
        let best = -1
        let bestD = CHAR.grabRange * CHAR.grabRange
        for (const j of order) {
          const holder = state.rows[j]
          if (holder.hasTail === 0 || holder.immuneUntil > tick || taken.has(j)) continue
          seats.pos(j, other)
          const d = dist2(pos, other)
          if (d <= bestD && (best < 0 || d < bestD)) { best = j; bestD = d }
        }
        if (best >= 0) {
          const holder = state.rows[best]
          holder.hasTail = 0
          holder.immuneUntil = 0
          taken.add(best)
          seats.setCarry(best, CarryKind.none, -1)
          ctx.emit('possess', seats.seat(best), 0, 0)
          hold(ctx, i)
          continue
        }
        if (freeTails > 0 && dist2(pos, spawn) <= CHAR.grabRange * CHAR.grabRange) {
          freeTails--
          hold(ctx, i)
        }
      }
      if (ctx.roundTick > 0 && ctx.roundTick % REPOSSESS_TICKS === 0) {
        for (const i of order) {
          if (state.rows[i].hasTail === 0) continue
          ctx.emit('possess', seats.seat(i), 1, 0)
        }
      }
    },
    postStep(ctx) { tick = ctx.tick },
    snapshot(w) {
      w.u8(assigned ? 1 : 0)
      w.u8(freeTails)
      state.snapshot(w, (w, row) => { w.u8(row.hasTail); w.i32(row.immuneUntil); w.u8(row.prevGrab) })
    },
    restore(r, ctx) {
      seats = ctx.seats
      assigned = r.u8() !== 0
      freeTails = r.u8()
      tick = ctx.tick
      state.restore(r, seats, r => ({ hasTail: r.u8(), immuneUntil: r.i32(), prevGrab: r.u8() }))
    },
    draw(out) {
      for (let i = 0; i < state.rows.length; i++) {
        if (state.rows[i].hasTail === 0) continue
        seats.pos(i, pos)
        out.push({
          asset: 'candy.floor-disc', t: v3(pos.x, pos.y, pos.z), r: quatIdentity(),
          s: v3(0.5, 0.12, 0.5), visible: true, tint: 4,
        })
      }
    },
    botTarget(seat, position, out) {
      const i = state.ids.indexOf(seat)
      if (i < 0) return false
      if (state.rows[i].hasTail !== 0) {
        let nearest = -1
        let best = Infinity
        for (let j = 0; j < state.rows.length; j++) {
          if (state.rows[j].hasTail !== 0) continue
          seats.pos(j, other)
          const d = dist2(position, other)
          if (d < best) { best = d; nearest = j }
        }
        if (nearest < 0) return false
        seats.pos(nearest, other)
        let dx = position.x - other.x
        let dz = position.z - other.z
        const len = Math.sqrt(dx * dx + dz * dz)
        if (len < 1e-6) { dx = 0; dz = 1 } else { dx /= len; dz /= len }
        out.x = position.x + dx * FLEE_M
        out.y = position.y
        out.z = position.z + dz * FLEE_M
        return true
      }
      let best = -1
      let bestD = Infinity
      for (let j = 0; j < state.rows.length; j++) {
        const holder = state.rows[j]
        if (holder.hasTail === 0 || holder.immuneUntil > tick) continue
        seats.pos(j, other)
        const d = dist2(position, other)
        if (d < bestD) { best = j; bestD = d }
      }
      if (best >= 0) {
        seats.pos(best, out)
        return true
      }
      if (freeTails > 0) {
        out.x = spawn.x
        out.y = spawn.y
        out.z = spawn.z
        return true
      }
      return false
    },
    grabCandidates(position, direction, out) {
      for (let i = 0; i < state.rows.length; i++) {
        if (state.rows[i].hasTail === 0) continue
        seats.pos(i, other)
        const d = Math.sqrt(dist2(position, other))
        if (d < 1e-6 || d > CHAR.grabRange) continue
        const dx = other.x - position.x
        const dz = other.z - position.z
        const planar = Math.sqrt(dx * dx + dz * dz)
        if (planar === 0 || (dx * direction.x + dz * direction.z) / planar >= CHAR.grabConeDot) {
          out.push({ id: i, dist: d })
        }
      }
      if (freeTails > 0) {
        const d = Math.sqrt(dist2(position, spawn))
        if (d <= CHAR.grabRange) {
          const dx = spawn.x - position.x
          const dz = spawn.z - position.z
          const planar = Math.sqrt(dx * dx + dz * dz)
          if (planar === 0 || (dx * direction.x + dz * direction.z) / planar >= CHAR.grabConeDot) {
            out.push({ id: -1, dist: d })
          }
        }
      }
    },
  }
}
