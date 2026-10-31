import { CHAR, CharMode } from '../character/constants.ts'
import { levelOf } from '../course.ts'
import type { SpawnPoint } from '../course.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { respawnSlot } from '../season/respawn.ts'
import { quatIdentity, v3 } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { FeatureFactory } from './feature.ts'
import { numParam, vec3Param } from './params.ts'
import { orderedSeatIndices, SeatState } from './seatState.ts'

export const crownFeature: FeatureFactory = (spec, path) => {
  const t = vec3Param(spec, path, 't')
  const grabRangeM = numParam(spec, path, 'grabRangeM', 0.25, 3, 1)
  const state = new SeatState(() => ({ prevDist: 0 }))
  const pos = v3(0, 0, 0)
  const spawn: SpawnPoint = { t: v3(0, 0, 0), facing: { x: 0, z: 1 } }
  let taken = 0
  let nextResetTick = 0

  const distance = (p: Vec3): number => {
    const dx = p.x - t.x, dy = p.y - t.y, dz = p.z - t.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  return {
    id: spec.id,
    kind: 'crown',
    init(ctx) {
      if (ctx.course.checkpoints.length === 0) {
        refuse('feature', path, 'crown needs CP1; add a checkpoint')
      }
      const L = levelOf(ctx.course)
      taken = 0
      nextResetTick = L.timeCapTicks + L.overtimeTicks
      state.sync(ctx.seats)
      for (let i = 0; i < ctx.seats.count; i++) {
        state.rows[i].prevDist = distance(ctx.seats.pos(i, pos))
      }
    },
    preStep() {},
    postStep(ctx) {
      const seats = ctx.seats
      state.sync(seats)
      let grabbed = false
      for (const i of orderedSeatIndices(seats)) {
        const d = distance(seats.pos(i, pos))
        const mode = seats.mode(i)
        if (ctx.roundTick >= 0 && !taken && seats.status(i) === PlayerStatus.alive &&
            (mode === CharMode.ground || mode === CharMode.air || mode === CharMode.dive) &&
            !seats.protectedNow(i) && seats.input(i).grab && d <= grabRangeM) {
          const prev = state.rows[i].prevDist
          const sub = prev > grabRangeM
            ? Math.max(0, Math.min(65535, Math.round(65535 * (prev - grabRangeM) / (prev - d))))
            : 0
          ctx.emit('crown', seats.seat(i), sub, 0)
          grabbed = true
        }
        state.rows[i].prevDist = d
      }
      // Keep all contenders on the first grab tick for ledger arbitration.
      if (grabbed) {
        taken = 1
        ctx.sound('obj.crown', t, 1)
      }
      const L = levelOf(ctx.course)
      const capEnd = L.timeCapTicks + L.overtimeTicks
      if (!taken && ctx.roundTick >= 0 && ctx.roundTick >= capEnd && ctx.roundTick >= nextResetTick) {
        let k = 0
        for (const i of orderedSeatIndices(seats)) {
          if (seats.status(i) !== PlayerStatus.alive) continue
          seats.teleport(i, respawnSlot(ctx.course.checkpoints[0].respawn, k++, L.respawn, spawn))
          state.rows[i].prevDist = distance(spawn.t)
        }
        const interval = Math.max(600, L.overtimeTicks)
        nextResetTick = capEnd + (Math.floor((ctx.roundTick - capEnd) / interval) + 1) * interval
      }
    },
    snapshot(w) {
      w.u8(taken)
      w.i32(nextResetTick)
      state.snapshot(w, (w, row) => w.f64(row.prevDist))
    },
    restore(r, ctx) {
      taken = r.u8()
      nextResetTick = r.i32()
      state.restore(r, ctx.seats, r => ({ prevDist: r.f64() }))
    },
    draw(out) {
      out.push({ asset: 'candy.tower', t: { ...t }, r: quatIdentity(), s: v3(0.25, 0.25, 0.25),
        visible: true, tint: taken ? 4 : 0 })
    },
    botTarget(_seat, _pos, out) {
      if (taken) return false
      Object.assign(out, t)
      return true
    },
    grabCandidates(position, facing, out) {
      if (taken) return
      const d = distance(position)
      const dx = t.x - position.x, dz = t.z - position.z
      const planar = Math.sqrt(dx * dx + dz * dz)
      if (d <= grabRangeM && (planar === 0 ||
          (dx * facing.x + dz * facing.z) / planar >= CHAR.grabConeDot)) out.push({ id: 0, dist: d })
    },
  }
}
