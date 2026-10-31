import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { CHAR, CharMode } from '../character/constants.ts'
import type { FeatureSpec } from '../course.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { quatIdentity, v3 } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw } from './feature.ts'
import { intParam, listParam, ticksParam, vec3Of } from './params.ts'
import { orderedSeatIndices } from './seatState.ts'

export const COLLECTIBLE_KIND = 'collectible'

const CONTACT_RADIUS = CHAR.radius + 0.5
const CONTACT_RADIUS2 = CONTACT_RADIUS * CONTACT_RADIUS
const SPOT_ASSET = 'candy.floor-disc'

export function collectibleFeature(spec: FeatureSpec, path: string): CourseFeature {
  const spots = listParam(spec, path, 'spots', 1, 64).map((value, i) =>
    vec3Of(value, `${path}/spots/${i}`))
  const value = intParam(spec, path, 'value', 1, 100)
  const regenTicks = ticksParam(spec, path, 'regenS', 0.1, 600)
  const readyTick = new Int32Array(spots.length)
  const pos: Vec3 = { x: 0, y: 0, z: 0 }
  let tick = 0

  return {
    id: spec.id,
    kind: COLLECTIBLE_KIND,
    init(ctx: FeatureCtx) {
      tick = ctx.tick
      readyTick.fill(0)
    },
    preStep(ctx: FeatureCtx) {
      tick = ctx.tick
    },
    postStep(ctx: FeatureCtx) {
      tick = ctx.tick
      if (ctx.roundTick < 0) return
      const order = orderedSeatIndices(ctx.seats)
      for (let s = 0; s < spots.length; s++) {
        if (tick < readyTick[s]) continue
        const spot = spots[s]
        let best = -1
        let bestD = Infinity
        for (let k = 0; k < order.length; k++) {
          const i = order[k]
          if (ctx.seats.status(i) !== PlayerStatus.alive) continue
          if (ctx.seats.mode(i) === CharMode.parked) continue
          const p = ctx.seats.pos(i, pos)
          const dx = p.x - spot.x
          const dy = p.y - spot.y
          const dz = p.z - spot.z
          const d = dx * dx + dy * dy + dz * dz
          if (d <= CONTACT_RADIUS2 && (best < 0 || d < bestD)) { best = i; bestD = d }
        }
        if (best < 0) continue
        ctx.emit('score', ctx.seats.seat(best), value, 0)
        ctx.sound('obj.pickup', spot, 1)
        readyTick[s] = tick + regenTicks
      }
    },
    snapshot(w: SnapWriter) {
      for (let s = 0; s < readyTick.length; s++) w.i32(readyTick[s])
    },
    restore(r: SnapReader, ctx: FeatureCtx) {
      tick = ctx.tick
      for (let s = 0; s < readyTick.length; s++) readyTick[s] = r.i32()
    },
    draw(out: FeatureDraw[]) {
      for (let s = 0; s < spots.length; s++) {
        out.push({
          asset: SPOT_ASSET,
          t: { x: spots[s].x, y: spots[s].y, z: spots[s].z },
          r: quatIdentity(),
          s: v3(0.6, 0.6, 0.6),
          visible: tick >= readyTick[s],
          tint: 0,
        })
      }
    },
    botTarget(_seat: number, position: Vec3, out: Vec3): boolean {
      let best = -1
      let bestD = Infinity
      for (let s = 0; s < spots.length; s++) {
        if (tick < readyTick[s]) continue
        const dx = position.x - spots[s].x
        const dy = position.y - spots[s].y
        const dz = position.z - spots[s].z
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestD) { best = s; bestD = d }
      }
      if (best < 0) return false
      Object.assign(out, spots[best])
      return true
    },
    grabCandidates(_position: Vec3, _facing: { x: number; z: number }, _out: { id: number; dist: number }[]) {},
  }
}
