import type { AnimationSpec, MechanismSpec } from '../mechanismSpec.ts'
import { quatNormalize } from '../vec.ts'
import type { Pose } from '../vec.ts'

export type PartKind = 'sim' | 'tick'

// Stateful mechanism types. Animation ownership depends on incoming links.
export const MECH_TYPE_KINDS = {
  switch: 'sim',
  lever: 'sim',
  logic: 'sim',
  motor: 'sim',
  door: 'sim',
  spring: 'sim',
} as const satisfies Readonly<Record<string, PartKind>>

// A free track is a function of (tick - loadTick), with no playback state.
export function animationKind(m: MechanismSpec, animation: number): PartKind {
  for (let i = 0; i < m.links.length; i++) {
    const target = m.links[i].to
    if (target.kind === 'animation' && target.animation === animation) return 'sim'
  }
  return 'tick'
}

export function trackPose(a: AnimationSpec, localTick: number, out: Pose): Pose {
  const keys = a.keys
  const last = keys[keys.length - 1]
  const length = last.tick
  let lt = 0
  if (keys.length > 1 && length > 0) {
    switch (a.loop) {
      case 'loop':
        lt = ((localTick % length) + length) % length
        break
      case 'pingpong': {
        const period = 2 * length
        const phase = ((localTick % period) + period) % period
        lt = phase <= length ? phase : period - phase
        break
      }
      case 'once':
        lt = Math.max(0, Math.min(length, localTick))
        break
    }
  }

  let k0 = keys[0]
  let k1 = k0
  if (keys.length > 1 && length > 0 && lt > k0.tick) {
    let i = 1
    while (i < keys.length - 1 && lt > keys[i].tick) i++
    k0 = keys[i - 1]
    k1 = keys[i]
  }
  let f = k0 === k1 ? 0 : (lt - k0.tick) / (k1.tick - k0.tick)
  if (a.easing === 'smooth') f = f * f * (3 - 2 * f)
  out.t.x = k0.t.x + (k1.t.x - k0.t.x) * f
  out.t.y = k0.t.y + (k1.t.y - k0.t.y) * f
  out.t.z = k0.t.z + (k1.t.z - k0.t.z) * f

  const q0 = k0.r, q1 = k1.r
  const sign = q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w < 0 ? -1 : 1
  const x = q0.x + (sign * q1.x - q0.x) * f
  const y = q0.y + (sign * q1.y - q0.y) * f
  const z = q0.z + (sign * q1.z - q0.z) * f
  const w = q0.w + (sign * q1.w - q0.w) * f
  out.r.x = x
  out.r.y = y
  out.r.z = z
  out.r.w = w
  quatNormalize(out.r, out.r)
  return out
}
