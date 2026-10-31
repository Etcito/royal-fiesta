import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { GRAVITY_Y } from '../world.ts'
import { inBox, levelOf } from '../course.ts'
import type { Box, ResolvedCourse } from '../course.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { Vec3 } from '../vec.ts'
import { refuse } from '../refusal.ts'
import { SeatState } from './seatState.ts'
import { boolParam, boxParam, intParam, numParam, vec3Param } from './params.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory } from './feature.ts'

const G = Math.abs(GRAVITY_Y)

function dist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function nearestStage(course: ResolvedCourse, p: Vec3): number {
  const stages = levelOf(course).route.stages
  let best = -1
  let bestD = Number.POSITIVE_INFINITY
  for (let c = 0; c < course.checkpoints.length; c++) {
    const d = dist2(course.checkpoints[c].respawn.t, p)
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best < 0 ? -1 : stages[best] ?? -1
}

export const launchPadFeature: FeatureFactory = (spec, path) => {
  const box = boxParam(spec, path)
  const target = vec3Param(spec, path, 'target')
  const apexM = numParam(spec, path, 'apexM', 0.5, 40)
  const recoverOnly = boolParam(spec, path, 'recoverOnly', false)
  let padStage = -1
  let tick = 0
  const state = new SeatState(() => ({
    inside: 0, launched: -1, flight: 0, lastFall: -1, prevProtected: 0, alive: PlayerStatus.alive as number,
  }))
  const scratch: Vec3 = { x: 0, y: 0, z: 0 }

  const syncStatus = (ctx: FeatureCtx): void => {
    for (let i = 0; i < state.rows.length; i++) state.rows[i].alive = ctx.seats.status(i)
  }

  const trackProtected = (ctx: FeatureCtx): void => {
    for (let i = 0; i < state.rows.length; i++) {
      const now = ctx.seats.protectedNow(i) ? 1 : 0
      if (now === 1 && state.rows[i].prevProtected === 0) state.rows[i].lastFall = nearestStage(ctx.course, ctx.seats.pos(i, scratch))
      state.rows[i].prevProtected = now
    }
  }

  const eligible = (i: number): boolean => {
    if (state.rows[i].alive !== PlayerStatus.alive) return false
    if (!recoverOnly) return true
    return padStage >= 0 && state.rows[i].lastFall === padStage
  }

  const fire = (ctx: FeatureCtx, i: number, start: Vec3): void => {
    const apexY = (start.y > target.y ? start.y : target.y) + apexM
    const vy = Math.sqrt(2 * G * (apexY - start.y))
    const T = vy / G + Math.sqrt(2 * (apexY - target.y) / G)
    state.rows[i].launched = ctx.tick
    state.rows[i].flight = Math.ceil(T * 60)
    ctx.seats.setVelocity(i, { x: (target.x - start.x) / T, y: vy, z: (target.z - start.z) / T })
    ctx.sound('mech.launch', box.center, 1)
  }

  const scan = (ctx: FeatureCtx): void => {
    for (let i = 0; i < state.rows.length; i++) {
      const p = ctx.seats.pos(i, scratch)
      const now = inBox(box, p) ? 1 : 0
      if (now === 1 && state.rows[i].inside === 0 && eligible(i)) fire(ctx, i, p)
      state.rows[i].inside = now
    }
  }

  return {
    id: spec.id,
    kind: 'launchPad',
    init(ctx) {
      tick = ctx.tick
      state.sync(ctx.seats)
      if (recoverOnly) padStage = nearestStage(ctx.course, box.center)
    },
    preStep(ctx) {
      tick = ctx.tick
      state.sync(ctx.seats)
      syncStatus(ctx)
      if (recoverOnly) trackProtected(ctx)
      scan(ctx)
    },
    postStep(ctx) {
      tick = ctx.tick
      state.sync(ctx.seats)
      syncStatus(ctx)
      if (recoverOnly) trackProtected(ctx)
      scan(ctx)
    },
    snapshot(w: SnapWriter) {
      state.snapshot(w, (w, row) => {
        w.u8(row.inside); w.i32(row.launched); w.i32(row.flight); w.u8(row.alive)
        if (recoverOnly) { w.i16(row.lastFall); w.u8(row.prevProtected) }
      })
    },
    restore(r: SnapReader, ctx: FeatureCtx) {
      state.restore(r, ctx.seats, r => ({
        inside: r.u8(), launched: r.i32(), flight: r.i32(), alive: r.u8(),
        lastFall: recoverOnly ? r.i16() : -1, prevProtected: recoverOnly ? r.u8() : 0,
      }))
      tick = ctx.tick
      if (recoverOnly) padStage = nearestStage(ctx.course, box.center)
    },
    draw(out: FeatureDraw[]) {
      out.push({
        asset: 'candy.mech-spring-pad',
        t: { x: box.center.x, y: box.center.y, z: box.center.z },
        r: { x: 0, y: 0, z: 0, w: 1 },
        s: { x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2 },
        visible: true,
        tint: 0,
      })
    },
    botTarget(seat: number, pos: Vec3, out: Vec3): boolean {
      const i = state.ids.indexOf(seat)
      if (i < 0) return false
      if (state.rows[i].launched >= 0 && tick - state.rows[i].launched < state.rows[i].flight) {
        out.x = target.x
        out.y = target.y
        out.z = target.z
        return true
      }
      if (!eligible(i)) return false
      if (dist2(pos, target) <= dist2(box.center, target)) return false
      out.x = box.center.x
      out.y = box.center.y
      out.z = box.center.z
      return true
    },
  }
}

export const catchVolumeFeature: FeatureFactory = (spec, path) => {
  const box = boxParam(spec, path)
  const stage = intParam(spec, path, 'respawnStage', 0, 1_000_000)
  let checkpoint = -1
  const state = new SeatState(() => ({ inside: 0 }))
  const scratch: Vec3 = { x: 0, y: 0, z: 0 }

  const scan = (ctx: FeatureCtx): void => {
    state.sync(ctx.seats)
    for (let i = 0; i < ctx.seats.count; i++) {
      const now = inBox(box, ctx.seats.pos(i, scratch)) ? 1 : 0
      if (now === 1 && state.rows[i].inside === 0 && checkpoint >= 0 && ctx.seats.status(i) === PlayerStatus.alive) {
        ctx.seats.teleport(i, ctx.course.checkpoints[checkpoint].respawn)
      }
      state.rows[i].inside = now
    }
  }

  return {
    id: spec.id,
    kind: 'catchVolume',
    init(ctx) {
      state.sync(ctx.seats)
      const stages = levelOf(ctx.course).route.stages
      for (let c = 0; c < ctx.course.checkpoints.length; c++) {
        if ((stages[c] ?? -1) === stage) {
          checkpoint = c
          break
        }
      }
      if (checkpoint < 0) {
        refuse('feature', `${path}/respawnStage`,
          `no checkpoint at route stage ${stage}; add a checkpoint of that stage`)
      }
    },
    preStep(ctx) { scan(ctx) },
    postStep(ctx) { scan(ctx) },
    snapshot(w: SnapWriter) {
      state.snapshot(w, (w, row) => w.u8(row.inside))
    },
    restore(r: SnapReader, ctx: FeatureCtx) {
      state.restore(r, ctx.seats, r => ({ inside: r.u8() }))
    },
    draw(out: FeatureDraw[]) {
      out.push({
        asset: 'candy.floor-disc',
        t: { x: box.center.x, y: box.center.y, z: box.center.z },
        r: { x: 0, y: 0, z: 0, w: 1 },
        s: { x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2 },
        visible: false,
        tint: 0,
      })
    },
    botTarget() { return false },
  }
}
