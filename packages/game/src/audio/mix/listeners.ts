import type { Vec3 } from '@royal-fiesta/sim/vec'

/** A local listener: world position and horizontal facing (+Z forward has +X on the right). */
export interface ListenerPose {
  pos: Vec3
  forward: Vec3
}

export interface SpatialResult {
  gain: number
  pan: number
}

function nearest(pos: Vec3, listeners: readonly ListenerPose[]): ListenerPose | null {
  let best: ListenerPose | null = null
  let bestD = Infinity
  for (const listener of listeners) {
    const d = Math.hypot(pos.x - listener.pos.x, pos.y - listener.pos.y, pos.z - listener.pos.z)
    if (d < bestD) {
      bestD = d
      best = listener
    }
  }
  return best
}

/**
 * Gain and pan from the nearest of the local listeners. Gain is ref / max(ref, d) and
 * 0 beyond max; pan follows haa's spatial scene: the horizontal unit direction to the
 * source dotted with the listener's right vector (fz, -fx), clamped to -1..1.
 */
export function spatialFor(
  pos: Vec3,
  listeners: readonly ListenerPose[],
  falloff: { ref: number; max: number },
): SpatialResult {
  const listener = nearest(pos, listeners)
  if (listener === null) return { gain: 1, pan: 0 }

  const dx = pos.x - listener.pos.x
  const dy = pos.y - listener.pos.y
  const dz = pos.z - listener.pos.z
  const d = Math.hypot(dx, dy, dz)
  const gain = d > falloff.max ? 0 : falloff.ref / Math.max(falloff.ref, d)

  const fx = listener.forward.x
  const fz = listener.forward.z
  const flen = Math.hypot(fx, fz)
  const hlen = Math.hypot(dx, dz)
  let pan = 0
  if (flen > 0 && hlen > 0) {
    pan = Math.max(-1, Math.min(1, ((dx / hlen) * fz - (dz / hlen) * fx) / flen))
  }
  return { gain, pan }
}
