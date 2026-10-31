// Snapshot-driven rotations relative to the rig rest pose. No render clock is involved.
import { CHAR, CharMode, CarryKind } from '@royal-fiesta/sim/character/constants'
import type { PoseLayer } from './layers.ts'
import { walkBones, type WalkBones } from './walkCycle.ts'

export function actionPose(mode: number, carry: number, strokeTimer: number, out: Float32Array, bones: WalkBones): void {
  out.fill(0)
  for (let i = 3; i < out.length; i += 4) out[i] = 1
  const rotate = (bone: number, x: number, y: number, z: number): void => {
    const sx = Math.sin(x / 2), cx = Math.cos(x / 2)
    const sy = Math.sin(y / 2), cy = Math.cos(y / 2)
    const sz = Math.sin(z / 2), cz = Math.cos(z / 2)
    out.set([sx*cy*cz + cx*sy*sz, cx*sy*cz - sx*cy*sz,
      cx*cy*sz + sx*sy*cz, cx*cy*cz - sx*sy*sz], bone * 4)
  }
  const sliding = mode === CharMode.slide, swimming = mode === CharMode.swim
  const phase = sliding ? 1 - strokeTimer / CHAR.slide.strokeCooldownTicks :
    swimming ? 1 - strokeTimer / CHAR.swim.strokeCooldownTicks : 0
  if (sliding || swimming) {
    // Swim follows a gentler half-sine sweep; slide makes a full butterfly recovery.
    const sweep = strokeTimer > 0 ? Math.sin(Math.PI * phase) : 0
    const reach = strokeTimer > 0 ? Math.sin(2 * Math.PI * phase) : 0
    rotate(bones.root, sliding ? Math.PI / 2 : 1.05, 0, 0)
    rotate(bones.head, -0.45, 0, 0)
    rotate(bones.legL, -0.2, 0, 0); rotate(bones.legR, -0.2, 0, 0)
    const down = (sliding ? 1.15 : 0.85) - sweep * (sliding ? 1.8 : 1.1)
    rotate(bones.flipperL, reach * (sliding ? 1 : 0.5), 0, -down)
    rotate(bones.flipperR, reach * (sliding ? 1 : 0.5), 0, down)
  }
  if (carry !== CarryKind.none || mode === CharMode.grabbing) {
    const holding = carry !== CarryKind.none
    // Mirrored yaw brings the flippers in front (+Z); carry cups them inward.
    rotate(bones.flipperL, holding ? -0.35 : 0, holding ? -1.25 : -1.5, -0.25)
    rotate(bones.flipperR, holding ? -0.35 : 0, holding ? 1.25 : 1.5, 0.25)
  }
}

export const ACTION_LAYER: PoseLayer = {
  name: 'action',
  create(names) {
    const bones = walkBones(names), target = new Float32Array(names.length * 4)
    const affected = Object.values(bones)
    let ramp = 0
    return {
      observe(obs) {
        const active = obs.mode === CharMode.slide || obs.mode === CharMode.swim ||
          obs.mode === CharMode.grabbing || (obs.carry ?? 0) !== CarryKind.none
        ramp = Math.max(0, Math.min(6, ramp + (active ? 1 : -1)))
        // Retain the last target while fading back to the graph.
        if (active) actionPose(obs.mode, obs.carry ?? 0, obs.strokeTimer ?? 0, target, bones)
      },
      apply(local) {
        if (!ramp) return
        for (const bone of affected) {
          const q = bone * 4, o = bone * 10 + 3, weight = ramp / 6
          let dot = 0
          for (let i = 0; i < 4; i++) dot += local[o+i] * target[q+i]
          const sign = dot < 0 ? -1 : 1
          let norm = 0
          for (let i = 0; i < 4; i++) {
            local[o+i] += (sign * target[q+i] - local[o+i]) * weight
            norm += local[o+i] ** 2
          }
          norm = Math.sqrt(norm)
          for (let i = 0; i < 4; i++) local[o+i] /= norm
        }
      },
      reset() { ramp = 0; target.fill(0) },
    }
  },
}
