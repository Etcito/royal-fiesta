// The authored travel limit of a mechanism asset, as a pose of its moving body relative to rest.
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import type { Vec3T, QuatT } from '@royal-fiesta/game/render/port'

export interface LimitPose { body: string; joint: string; t: Vec3T; r: QuatT }

// A hinge turns its second body about anchorB by the upper limit angle; a slider moves it along the axis to its lower
// limit. The pose keeps anchorB fixed, so the body tilts about the hinge, not about the asset origin.
export function limitPoseOf(asset: GameAsset): LimitPose {
  const physics = asset.physics
  if (physics === undefined) throw new Error(`${asset.id}: no physics block`)
  const joint = physics.joints.find(j => (j.kind === 'hinge' || j.kind === 'slider')
    && physics.bodies.some(b => b.id === j.b && b.type === 'dynamic'))
  if (joint === undefined) throw new Error(`${asset.id}: no hinge or slider on a dynamic body`)
  const [ax, ay, az] = joint.axis
  if (joint.kind === 'slider') {
    const d = joint.limitsM![0]
    return { body: joint.b, joint: joint.id, t: [ax * d, ay * d, az * d], r: [0, 0, 0, 1] }
  }
  const angle = joint.limitsDeg![1] * Math.PI / 180
  const s = Math.sin(angle / 2)
  const r: QuatT = [ax * s, ay * s, az * s, Math.cos(angle / 2)]
  // v' = v + 2w(q x v) + 2 q x (q x v), with q = (r.xyz)
  const rotate = (v: Vec3T): Vec3T => {
    const cx = r[1] * v[2] - r[2] * v[1], cy = r[2] * v[0] - r[0] * v[2], cz = r[0] * v[1] - r[1] * v[0]
    return [
      v[0] + 2 * (r[3] * cx + r[1] * cz - r[2] * cy),
      v[1] + 2 * (r[3] * cy + r[2] * cx - r[0] * cz),
      v[2] + 2 * (r[3] * cz + r[0] * cy - r[1] * cx),
    ]
  }
  const p = joint.anchorB
  const q = rotate([p[0], p[1], p[2]])
  return { body: joint.b, joint: joint.id, t: [p[0] - q[0], p[1] - q[1], p[2] - q[2]], r }
}
