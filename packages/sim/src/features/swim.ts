import { CHAR } from '../character/constants.ts'
import { inBox } from '../course.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { Vec3 } from '../vec.ts'
import type { FeatureCtx, FeatureFactory } from './feature.ts'
import { boxParam, numParam } from './params.ts'

export const swimVolumeFeature: FeatureFactory = (spec, path) => {
  const box = boxParam(spec, path)
  const drag = numParam(spec, path, 'drag', 0, 20, CHAR.swim.drag)
  const buoyancy = numParam(spec, path, 'buoyancy', 0, 60, 22)
  const scratch: Vec3 = { x: 0, y: 0, z: 0 }
  let inside = new Uint8Array(0)
  let seatIds: number[] = []

  const mapSeats = (ctx: FeatureCtx): void => {
    seatIds = []
    for (let i = 0; i < ctx.seats.count; i++) seatIds.push(ctx.seats.seat(i))
  }

  return {
    id: spec.id,
    kind: 'swimVolume',
    init(ctx) {
      inside = new Uint8Array(ctx.seats.count)
      mapSeats(ctx)
    },
    preStep(ctx) {
      for (let i = 0; i < inside.length; i++) {
        const now = ctx.seats.status(i) === PlayerStatus.alive && inBox(box, ctx.seats.pos(i, scratch))
        if (now) ctx.seats.setSwim(i, true, drag, buoyancy)
        else if (inside[i]) ctx.seats.setSwim(i, false, 0, 0)
        inside[i] = now ? 1 : 0
      }
    },
    postStep() {},
    snapshot(w) {
      w.u16(inside.length)
      for (let i = 0; i < inside.length; i++) w.u8(inside[i])
    },
    restore(r, ctx) {
      const saved = new Uint8Array(r.u16())
      for (let i = 0; i < saved.length; i++) saved[i] = r.u8()
      inside = new Uint8Array(ctx.seats.count)
      inside.set(saved.subarray(0, Math.min(saved.length, inside.length)))
      mapSeats(ctx)
    },
    draw(out) {
      out.push({
        asset: 'candy.slime-pool',
        t: { ...box.center },
        r: { x: 0, y: 0, z: 0, w: 1 },
        s: { x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2 },
        visible: true,
        tint: 0,
      })
    },
    botTarget(seat, _pos, out) {
      const i = seatIds.indexOf(seat)
      if (i < 0 || !inside[i]) return false
      out.x = box.center.x
      out.y = box.center.y + box.half.y
      out.z = box.center.z + box.half.z + 0.5
      return true
    },
  }
}
