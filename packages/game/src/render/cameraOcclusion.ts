import type { ColliderSpec, ResolvedCourse } from '@royal-fiesta/sim/course'

// Spring-arm test for the third-person camera: how far from `from` along a unit direction a
// sphere of `radius` can travel before it touches an obstacle collider. View-side only; it reads
// the interpolated obstacle poses the scene draws, never the sim.
//
// Every collider is tested in its own frame as an expanded box (cuboid, roundCuboid, and the Y-axis
// bounds of capsule, cylinder, cone) or an expanded sphere (ball). A collider that already contains
// `from` is ignored, so a player wedged in geometry keeps a camera instead of collapsing it.

const OB = 7

export type ArmClip = (
  from: readonly [number, number, number], dir: readonly [number, number, number], maxLen: number, radius: number,
) => number

// v rotated by the conjugate of the quaternion q[o..o+3] = (x, y, z, w).
function rotInv(q: ArrayLike<number>, o: number, x: number, y: number, z: number, out: number[]): void {
  const qx = -q[o], qy = -q[o + 1], qz = -q[o + 2], qw = q[o + 3]
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  out[0] = x + qw * tx + (qy * tz - qz * ty)
  out[1] = y + qw * ty + (qz * tx - qx * tz)
  out[2] = z + qw * tz + (qx * ty - qy * tx)
}

function boxHalf(c: ColliderSpec): [number, number, number] | null {
  switch (c.shape) {
    case 'cuboid': return [c.half.x, c.half.y, c.half.z]
    case 'roundCuboid': return [c.half.x + c.border, c.half.y + c.border, c.half.z + c.border]
    case 'capsule': return [c.radius, c.halfHeight + c.radius, c.radius]
    case 'cylinder': case 'cone': return [c.radius, c.halfHeight, c.radius]
    default: return null
  }
}

// Slab test; returns the entry distance, or -1 for a miss, a start inside, or an entry beyond maxLen.
function slab(o: number[], d: number[], h: readonly number[], maxLen: number): number {
  let t0 = 0
  let t1 = maxLen
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (Math.abs(o[k]) > h[k]) return -1
      continue
    }
    let a = (-h[k] - o[k]) / d[k]
    let b = (h[k] - o[k]) / d[k]
    if (a > b) { const s = a; a = b; b = s }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return -1
  }
  return t0 > 0 ? t0 : -1
}

function sphere(o: number[], d: number[], r: number, maxLen: number): number {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2]
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r
  if (c <= 0) return -1
  const disc = b * b - c
  if (b >= 0 || disc < 0) return -1
  const t = -b - Math.sqrt(disc)
  return t > 0 && t <= maxLen ? t : -1
}

// poses: the course obstacles' world poses, OB numbers each (t xyz, r xyzw).
export function armClip(course: ResolvedCourse, poses: Float64Array): ArmClip {
  const o = [0, 0, 0]
  const d = [0, 0, 0]
  const w = [0, 0, 0]
  const dl = [0, 0, 0]
  const h = [0, 0, 0]
  const q = [0, 0, 0, 1]
  return (from, dir, maxLen, radius) => {
    let best = maxLen
    const obstacles = course.obstacles
    for (let i = 0; i < obstacles.length; i++) {
      const b = i * OB
      if (b + OB > poses.length) break
      rotInv(poses, b + 3, from[0] - poses[b], from[1] - poses[b + 1], from[2] - poses[b + 2], w)
      const px = w[0], py = w[1], pz = w[2]
      rotInv(poses, b + 3, dir[0], dir[1], dir[2], d)
      for (const c of obstacles[i].colliders) {
        q[0] = c.r.x; q[1] = c.r.y; q[2] = c.r.z; q[3] = c.r.w
        rotInv(q, 0, px - c.t.x, py - c.t.y, pz - c.t.z, o)
        rotInv(q, 0, d[0], d[1], d[2], dl)
        const half = boxHalf(c)
        let t: number
        if (half === null) t = sphere(o, dl, (c as { radius: number }).radius + radius, best)
        else {
          h[0] = half[0] + radius; h[1] = half[1] + radius; h[2] = half[2] + radius
          t = slab(o, dl, h, best)
        }
        if (t >= 0 && t < best) best = t
      }
    }
    return best
  }
}
