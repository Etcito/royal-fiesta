import type { Vec3T } from '../render/port.ts'

// The single source of the planar camera basis (ARCHITECTURE 1.6). RAA is right-handed
// (raa-math look_at_rh), so for forward f on XZ the screen-right vector is (-f.z, f.x).
// Every keyboard, gamepad, mouse and camera path goes through here; no copy exists elsewhere.

export interface Planar { x: number; z: number }
export interface PlanarBasis { forward: Planar; right: Planar }

const normalised = (x: number, z: number): Planar => {
  const len = Math.sqrt(x * x + z * z)
  if (!Number.isFinite(len) || len < 1e-9) return { x: 0, z: 1 }
  return { x: x / len, z: z / len }
}

export function basisFromFacing(facing: Planar): PlanarBasis {
  const forward = normalised(facing.x, facing.z)
  return { forward, right: { x: -forward.z, z: forward.x } }
}

export function cameraBasis(eye: Vec3T, target: Vec3T): PlanarBasis {
  return basisFromFacing({ x: target[0] - eye[0], z: target[2] - eye[2] })
}

export function stickToWorld(x: number, y: number, b: PlanarBasis, out: Planar): Planar {
  out.x = b.right.x * x + b.forward.x * y
  out.z = b.right.z * x + b.forward.z * y
  return out
}

export function yawTurn(forward: Planar, amountRad: number): Planar {
  const b = basisFromFacing(forward)
  if (!Number.isFinite(amountRad)) return b.forward
  const c = Math.cos(amountRad)
  const s = Math.sin(amountRad)
  // Renormalise so repeated turns never drift off unit length.
  return normalised(b.forward.x * c + b.right.x * s, b.forward.z * c + b.right.z * s)
}
