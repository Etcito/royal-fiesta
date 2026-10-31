import { CHAR } from '../character/constants.ts'
import { inBox } from '../course.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { Vec3 } from '../vec.ts'
import type { FeatureFactory } from './feature.ts'
import { SeatState } from './seatState.ts'
import { boxParam, numParam } from './params.ts'

export const swimVolumeFeature: FeatureFactory = (spec, path) => {
  const box = boxParam(spec, path)
  const drag = numParam(spec, path, 'drag', 0, 20, CHAR.swim.drag)
  const buoyancy = numParam(spec, path, 'buoyancy', 0, 60, 22)
  const scratch: Vec3 = { x: 0, y: 0, z: 0 }
  const state = new SeatState(() => ({ inside: 0 }))

  return {
    id: spec.id,
    kind: 'swimVolume',
    init(ctx) {
      state.sync(ctx.seats)
    },
    preStep(ctx) {
      state.sync(ctx.seats)
      for (let i = 0; i < state.rows.length; i++) {
        const now = ctx.seats.status(i) === PlayerStatus.alive && inBox(box, ctx.seats.pos(i, scratch))
        if (now) ctx.seats.setSwim(i, true, drag, buoyancy)
        else if (state.rows[i].inside) ctx.seats.setSwim(i, false, 0, 0)
        state.rows[i].inside = now ? 1 : 0
      }
    },
    postStep() {},
    snapshot(w) {
      state.snapshot(w, (w, row) => w.u8(row.inside))
    },
    restore(r, ctx) {
      state.restore(r, ctx.seats, r => ({ inside: r.u8() }))
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
      const i = state.ids.indexOf(seat)
      if (i < 0 || !state.rows[i].inside) return false
      out.x = box.center.x
      out.y = box.center.y + box.half.y
      out.z = box.center.z + box.half.z + 0.5
      return true
    },
  }
}
