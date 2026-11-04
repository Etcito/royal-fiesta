import type { ResolvedCourse } from '../course.ts'
import { dhypot } from '../detmath.ts'
import type { Vec3 } from '../vec.ts'
import { quatRotate, v3 } from '../vec.ts'

/** Long rises need the support's centreline, not a chord to the next floor's node. */
export function rampTarget(course: ResolvedCourse, index: number, pos: Vec3): Vec3 | null {
  const from = course.path[index - 1]?.p, to = course.path[index]?.p
  if (!from || !to || to.y - from.y < 2 || to.y - pos.y < 0.35) return null
  const length = dhypot(to.x - from.x, to.z - from.z)
  if (length < 15) return null
  for (const o of course.obstacles) {
    if (o.motion.kind !== 'static') continue
    for (const c of o.colliders) {
      if (!('half' in c)) continue
      const axis = quatRotate(o.r, quatRotate(c.r, v3(0, 0, 1), v3(0, 0, 0)), v3(0, 0, 0))
      if (Math.abs(axis.y) < 0.05 || Math.abs(axis.y) > 0.4 || c.half.z < 7) continue
      if (dhypot(o.t.x - from.x, o.t.z - from.z) > length || dhypot(o.t.x - to.x, o.t.z - to.z) > length) continue
      const sign = axis.x * (to.x - from.x) + axis.z * (to.z - from.z) > 0 ? 1 : -1
      const ux = axis.x * sign, uz = axis.z * sign
      const along = (pos.x - o.t.x) * ux + (pos.z - o.t.z) * uz
      const aim = Math.max(-c.half.z + 1, Math.min(c.half.z, along + 3))
      return { x: o.t.x + ux * aim, y: pos.y, z: o.t.z + uz * aim }
    }
  }
  return null
}
