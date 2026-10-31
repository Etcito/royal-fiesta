import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { GRAVITY_Y } from '../world.ts'
import { inBox, levelOf } from '../course.ts'
import type { Box, ResolvedCourse } from '../course.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { Vec3 } from '../vec.ts'
import { refuse } from '../refusal.ts'
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
  let seatIds: number[] = []
  let inside = new Uint8Array(0)
  let launched = new Int32Array(0)
  let flight = new Int32Array(0)
  let lastFall = new Int8Array(0)
  let prevProtected = new Uint8Array(0)
  let alive = new Uint8Array(0)
  const scratch: Vec3 = { x: 0, y: 0, z: 0 }

  const resize = (ctx: FeatureCtx): void => {
    const n = ctx.seats.count
    if (inside.length === n) return
    inside = new Uint8Array(n)
    launched = new Int32Array(n).fill(-1)
    flight = new Int32Array(n)
    lastFall = new Int8Array(n).fill(-1)
    prevProtected = new Uint8Array(n)
    alive = new Uint8Array(n).fill(PlayerStatus.alive)
    seatIds = []
    for (let i = 0; i < n; i++) seatIds.push(ctx.seats.seat(i))
  }

  const syncStatus = (ctx: FeatureCtx): void => {
    for (let i = 0; i < alive.length; i++) alive[i] = ctx.seats.status(i)
  }

  const trackProtected = (ctx: FeatureCtx): void => {
    for (let i = 0; i < prevProtected.length; i++) {
      const now = ctx.seats.protectedNow(i) ? 1 : 0
      if (now === 1 && prevProtected[i] === 0) lastFall[i] = nearestStage(ctx.course, ctx.seats.pos(i, scratch))
      prevProtected[i] = now
    }
  }

  const eligible = (i: number): boolean => {
    if (alive[i] !== PlayerStatus.alive) return false
    if (!recoverOnly) return true
    return padStage >= 0 && lastFall[i] === padStage
  }

  const fire = (ctx: FeatureCtx, i: number, start: Vec3): void => {
    const apexY = (start.y > target.y ? start.y : target.y) + apexM
    const vy = Math.sqrt(2 * G * (apexY - start.y))
    const T = vy / G + Math.sqrt(2 * (apexY - target.y) / G)
    launched[i] = ctx.tick
    flight[i] = Math.ceil(T * 60)
    ctx.seats.setVelocity(i, { x: (target.x - start.x) / T, y: vy, z: (target.z - start.z) / T })
    ctx.sound('mech.launch', box.center, 1)
  }

  const scan = (ctx: FeatureCtx): void => {
    for (let i = 0; i < inside.length; i++) {
      const p = ctx.seats.pos(i, scratch)
      const now = inBox(box, p) ? 1 : 0
      if (now === 1 && inside[i] === 0 && eligible(i)) fire(ctx, i, p)
      inside[i] = now
    }
  }

  return {
    id: spec.id,
    kind: 'launchPad',
    init(ctx) {
      tick = ctx.tick
      resize(ctx)
      if (recoverOnly) padStage = nearestStage(ctx.course, box.center)
    },
    preStep(ctx) {
      tick = ctx.tick
      resize(ctx)
      syncStatus(ctx)
      if (recoverOnly) trackProtected(ctx)
      scan(ctx)
    },
    postStep(ctx) {
      tick = ctx.tick
      resize(ctx)
      syncStatus(ctx)
      if (recoverOnly) trackProtected(ctx)
      scan(ctx)
    },
    snapshot(w: SnapWriter) {
      w.u16(inside.length)
      for (let i = 0; i < inside.length; i++) {
        w.u8(inside[i]); w.i32(launched[i]); w.i32(flight[i]); w.u8(alive[i])
        if (recoverOnly) { w.i16(lastFall[i]); w.u8(prevProtected[i]) }
      }
    },
    restore(r: SnapReader, ctx: FeatureCtx) {
      const n = r.u16()
      inside = new Uint8Array(n)
      launched = new Int32Array(n)
      flight = new Int32Array(n)
      lastFall = new Int8Array(n)
      prevProtected = new Uint8Array(n)
      alive = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        inside[i] = r.u8(); launched[i] = r.i32(); flight[i] = r.i32(); alive[i] = r.u8()
        if (recoverOnly) { lastFall[i] = r.i16(); prevProtected[i] = r.u8() }
      }
      tick = ctx.tick
      seatIds = []
      for (let i = 0; i < ctx.seats.count; i++) seatIds.push(ctx.seats.seat(i))
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
      const i = seatIds.indexOf(seat)
      if (i < 0) return false
      if (launched[i] >= 0 && tick - launched[i] < flight[i]) {
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
  let inside = new Uint8Array(0)
  const scratch: Vec3 = { x: 0, y: 0, z: 0 }

  const scan = (ctx: FeatureCtx): void => {
    for (let i = 0; i < inside.length; i++) {
      const now = inBox(box, ctx.seats.pos(i, scratch)) ? 1 : 0
      if (now === 1 && inside[i] === 0 && checkpoint >= 0 && ctx.seats.status(i) === PlayerStatus.alive) {
        ctx.seats.teleport(i, ctx.course.checkpoints[checkpoint].respawn)
      }
      inside[i] = now
    }
  }

  return {
    id: spec.id,
    kind: 'catchVolume',
    init(ctx) {
      inside = new Uint8Array(ctx.seats.count)
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
      w.u16(inside.length)
      for (let i = 0; i < inside.length; i++) w.u8(inside[i])
    },
    restore(r: SnapReader) {
      const n = r.u16()
      inside = new Uint8Array(n)
      for (let i = 0; i < n; i++) inside[i] = r.u8()
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
