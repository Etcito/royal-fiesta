import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { CHAR, CharMode } from '../character/constants.ts'
import { approach2 } from '../character/controller.ts'
import { dsincos } from '../detmath.ts'
import type { SinCos } from '../detmath.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { degToRad, quatAxisAngle, quatIdentity, v3 } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { FeatureCtx, FeatureDraw, FeatureFactory } from './feature.ts'
import { SeatState } from './seatState.ts'
import { boxParam, enumParam, numParam, ticksParam } from './params.ts'

const BOT_RANGE2 = 25 * 25
const ELIGIBILITY = ['all', 'trailingTeam'] as const

function boostedMode(mode: number): boolean {
  return mode === CharMode.ground || mode === CharMode.air || mode === CharMode.slide
}

export const boostLaneFeature: FeatureFactory = (spec, path) => {
  const box = boxParam(spec, path)
  const yaw = degToRad(numParam(spec, path, 'yawDeg', -180, 180))
  const boost = numParam(spec, path, 'boost', 0, 10)
  const duration = ticksParam(spec, path, 'durationS', 0.1, 30)
  const recharge = ticksParam(spec, path, 'rechargeS', 0, 60)
  const eligibility = enumParam(spec, path, 'eligibility', ELIGIBILITY)
  const turn: SinCos = { s: 0, c: 0 }
  const local: Vec3 = { x: 0, y: 0, z: 0 }
  const pos: Vec3 = { x: 0, y: 0, z: 0 }
  const vel: Vec3 = { x: 0, y: 0, z: 0 }
  const next: Vec3 = { x: 0, y: 0, z: 0 }
  const planar = { x: 0, z: 0 }
  const state = new SeatState(() => ({ boostUntil: 0, readyAt: 0 }))
  let tick = 0

  const toLocal = (p: Vec3, out: Vec3): Vec3 => {
    const dx = p.x - box.center.x
    const dz = p.z - box.center.z
    dsincos(-yaw, turn)
    out.x = turn.c * dx + turn.s * dz
    out.y = p.y - box.center.y
    out.z = turn.c * dz - turn.s * dx
    return out
  }

  const inside = (p: Vec3): boolean => {
    toLocal(p, local)
    return Math.abs(local.x) <= box.half.x &&
      Math.abs(local.y) <= box.half.y &&
      Math.abs(local.z) <= box.half.z
  }

  const eligible = (ctx: FeatureCtx, i: number): boolean => {
    return eligibility === 'all' || ctx.seats.team(i) === ctx.trailingTeam
  }

  const step = (ctx: FeatureCtx): void => {
    tick = ctx.tick
    state.sync(ctx.seats)
    for (let i = 0; i < state.rows.length; i++) {
      if (ctx.seats.status(i) !== PlayerStatus.alive) continue
      const mode = ctx.seats.mode(i)
      if (mode === CharMode.parked) continue
      const p = ctx.seats.pos(i, pos)
      if (inside(p) && eligible(ctx, i) && tick >= state.rows[i].readyAt) {
        state.rows[i].boostUntil = tick + duration
        state.rows[i].readyAt = tick + duration + recharge
        ctx.sound('mech.boost', { x: p.x, y: p.y, z: p.z }, 1)
      }
      if (tick < state.rows[i].boostUntil && boostedMode(mode)) {
        const input = ctx.seats.input(i)
        const len = Math.sqrt(input.moveX * input.moveX + input.moveZ * input.moveZ)
        if (!(len > 0)) continue
        const v = ctx.seats.vel(i, vel)
        const cap = CHAR.maxRun + boost
        const rate = CHAR.groundAccel * (ctx.physics.dt ?? 1 / 60)
        approach2(v.x, v.z, (input.moveX / len) * cap, (input.moveZ / len) * cap, rate, planar)
        next.x = planar.x
        next.y = v.y
        next.z = planar.z
        ctx.seats.setVelocity(i, next)
      }
    }
  }

  const anyBoosted = (): boolean => {
    for (let i = 0; i < state.rows.length; i++) {
      if (state.rows[i].boostUntil > tick) return true
    }
    return false
  }

  return {
    id: spec.id,
    kind: 'boostLane',
    init(ctx) {
      tick = ctx.tick
      state.sync(ctx.seats)
    },
    preStep(ctx) {
      step(ctx)
    },
    postStep(_ctx) {},
    snapshot(w: SnapWriter) {
      state.snapshot(w, (w, row) => { w.i32(row.boostUntil); w.i32(row.readyAt) })
    },
    restore(r: SnapReader, ctx: FeatureCtx) {
      state.restore(r, ctx.seats, r => ({ boostUntil: r.i32(), readyAt: r.i32() }))
      tick = ctx.tick
    },
    draw(out: FeatureDraw[]) {
      out.push({
        asset: 'candy.conveyor-belt',
        t: { x: box.center.x, y: box.center.y, z: box.center.z },
        r: quatAxisAngle(v3(0, 1, 0), yaw, quatIdentity()),
        s: { x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2 },
        visible: true,
        tint: anyBoosted() ? 4 : 0,
      })
    },
    botTarget(seat: number, p: Vec3, out: Vec3): boolean {
      const i = state.ids.indexOf(seat)
      if (i < 0) return false
      const dx = p.x - box.center.x
      const dy = p.y - box.center.y
      const dz = p.z - box.center.z
      if (dx * dx + dy * dy + dz * dz > BOT_RANGE2) return false
      toLocal(p, local)
      if (!(local.z < box.half.z)) return false
      dsincos(yaw, turn)
      out.x = box.center.x + turn.s * box.half.z
      out.y = box.center.y
      out.z = box.center.z + turn.c * box.half.z
      return true
    },
  }
}
