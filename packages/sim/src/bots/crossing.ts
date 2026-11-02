import type { ResolvedCourse } from '../course.ts'
import type { Vec3 } from '../vec.ts'
import { quatConj, quatMul, quatRotate, v3 } from '../vec.ts'
import { animationKind, trackPose } from '../mechanisms/animation.ts'
import { CHAR } from '../character/constants.ts'

/** Predict free mechanism tracks with the same clock and pose composition as MechLogic.
 * Only wait before entry: stopping within a swept volume makes a crossing less safe.
 * Linked tracks have stateful playback and must be observed through physics instead.
 */
export function crossingBlocked(course: ResolvedCourse, pos: Vec3, vel: Vec3,
  dx: number, dz: number, tick: number): boolean {
  const m = course.mechanisms
  if (!m) return false
  for (let i = 0; i < m.animations.length; i++) {
    const a = m.animations[i]
    if (animationKind(m, i) !== 'tick') continue
    // A horizontal rotor has no wholly clear walk-through window: jump it
    // using contact look-ahead instead of waiting for an impossible interval.
    if (!a.keys.some(k => Math.abs(k.r.x) + Math.abs(k.r.z) + Math.abs(k.t.x) + Math.abs(k.t.z) > 0.1)) continue
    const body = m.items[a.target.item].bodies[a.target.body]
    // Platforms support from below; only bodies whose rest intersects our height
    // can be crossing hazards. A distant track cannot affect this short horizon.
    const rest = body.rest
    const rx = rest.t.x - pos.x, rz = rest.t.z - pos.z
    const along = rx * dx + rz * dz
    if (along < 1.8 || along > 6 || Math.abs(rx * dz - rz * dx) > 6 ||
        rest.t.y < pos.y - 1 || rest.t.y > pos.y + 5) continue
    let travel = 0, speed = Math.max(0, vel.x * dx + vel.z * dz)
    for (let dt = 0; dt <= 65; dt += 2) {
      const pose = trackPose(a, tick + dt, { t: v3(0, 0, 0), r: { x: 0, y: 0, z: 0, w: 1 } })
      pose.t.x += rest.t.x; pose.t.y += rest.t.y; pose.t.z += rest.t.z
      quatMul(pose.r, rest.r, pose.r)
      const local = quatRotate(quatConj(pose.r, { x: 0, y: 0, z: 0, w: 1 }),
        v3(pos.x + dx * travel - pose.t.x, pos.y - pose.t.y, pos.z + dz * travel - pose.t.z), v3(0, 0, 0))
      for (const c of body.colliders) {
        if (!('half' in c)) continue
        const p = quatRotate(quatConj(c.r, { x: 0, y: 0, z: 0, w: 1 }),
          v3(local.x - c.t.x, local.y - c.t.y, local.z - c.t.z), v3(0, 0, 0))
        if (Math.abs(p.x) < c.half.x + CHAR.radius + 0.15 &&
            Math.abs(p.z) < c.half.z + CHAR.radius + 0.15 &&
            Math.abs(p.y) < c.half.y + CHAR.halfHeight + CHAR.radius) return true
      }
      speed = Math.min(CHAR.maxRun, speed + CHAR.groundAccel * 2 / 60)
      travel += speed * 2 / 60
    }
  }
  return false
}

/** Start an authored bar crossing before contact look-ahead can see its rotating tip. */
export function rotorJumpAhead(course: ResolvedCourse, pos: Vec3, dx: number, dz: number): boolean {
  const direction = Math.hypot(dx, dz)
  if (direction === 0 || !course.mechanisms) return false
  for (const a of course.mechanisms.animations) {
    if (!a.keys.some(k => Math.abs(k.r.y) > 0.1) || a.keys.some(k => Math.abs(k.r.x) + Math.abs(k.r.z) > 0.1)) continue
    const body = course.mechanisms.items[a.target.item].bodies[a.target.body]
    // Preserve unmarked walk-through routes; the authored jump marks identify
    // bars that block the intended lane, including narrow elevated walkways.
    if (!course.path.some(n => n.jump && Math.hypot(n.p.x - body.rest.t.x, n.p.z - body.rest.t.z) < 2)) continue
    const x = body.rest.t.x - pos.x, z = body.rest.t.z - pos.z
    const along = (x * dx + z * dz) / direction
    const across = Math.abs(x * dz - z * dx) / direction
    if (along > 1.5 && along < 2.5 && across < 2 && Math.abs(body.rest.t.y - pos.y) < 1.5) return true
  }
  return false
}
