// Pure steering helpers. No allocation: every result is written into `out`, which the
// caller owns and which may alias the caller's own input state.
import { datan2, dsincos } from '../detmath.ts'
import type { SinCos } from '../detmath.ts'

// Scratch for dsincos only; never part of sim state.
const scratchSc: SinCos = { s: 0, c: 0 }

// Moves (vx,vz) toward (tx,tz) by at most maxDelta of vector length; lands exactly
// on the target when the remaining distance is <= maxDelta.
export function approach2(
  vx: number, vz: number, tx: number, tz: number, maxDelta: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  const dx = tx - vx
  const dz = tz - vz
  const dist = Math.sqrt(dx * dx + dz * dz)
  if (!(dist > maxDelta)) {
    out.x = tx
    out.z = tz
    return out
  }
  const k = maxDelta / dist
  out.x = vx + dx * k
  out.z = vz + dz * k
  return out
}

// Rotates the unit facing (fx,fz) toward the target direction by at most maxAngle
// (yaw convention: 0 faces +Z, positive turns toward +X). A target shorter than
// 1e-6 leaves the facing copied unchanged.
export function turnFacing(
  fx: number, fz: number, tx: number, tz: number, maxAngle: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  const tLen = Math.sqrt(tx * tx + tz * tz)
  if (!(tLen >= 1e-6)) {
    out.x = fx
    out.z = fz
    return out
  }
  const cross = fz * tx - fx * tz
  const dot = fx * tx + fz * tz
  const angle = datan2(cross, dot)
  if (Math.abs(angle) <= maxAngle) {
    const inv = 1 / tLen
    out.x = tx * inv
    out.z = tz * inv
    return out
  }
  const step = Math.sign(angle) * maxAngle
  dsincos(step, scratchSc)
  const s = scratchSc.s
  const c = scratchSc.c
  const nx = fx * c + fz * s
  const nz = fz * c - fx * s
  const inv = 1 / Math.sqrt(nx * nx + nz * nz)
  out.x = nx * inv
  out.z = nz * inv
  return out
}
