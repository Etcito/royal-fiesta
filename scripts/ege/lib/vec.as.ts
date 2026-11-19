import { atan2, cos, sin } from 'ege'

@unmanaged
export class V3 {
  x: f64
  y: f64
  z: f64
}

@unmanaged
export class Quat4 {
  x: f64
  y: f64
  z: f64
  w: f64
}

export function v3(x: f64, y: f64, z: f64): V3 {
  const value = new V3()
  value.x = x
  value.y = y
  value.z = z
  return value
}

export function approach2(vx: f64, vz: f64, tx: f64, tz: f64, rate: f64, out: V3): V3 {
  const dx = tx - vx
  const dz = tz - vz
  const dist = Math.sqrt(dx * dx + dz * dz)
  if (!(dist > rate)) {
    out.x = tx
    out.z = tz
    return out
  }
  const scale = rate / dist
  out.x = vx + dx * scale
  out.z = vz + dz * scale
  return out
}

export function turnFacing(fx: f64, fz: f64, tx: f64, tz: f64, maxRad: f64, out: V3): V3 {
  const targetLength = Math.sqrt(tx * tx + tz * tz)
  if (!(targetLength >= 1e-6)) {
    out.x = fx
    out.z = fz
    return out
  }
  const angle = atan2(fz * tx - fx * tz, fx * tx + fz * tz)
  if (Math.abs(angle) <= maxRad) {
    out.x = tx / targetLength
    out.z = tz / targetLength
    return out
  }
  const step = Math.sign(angle) * maxRad
  const c = cos(step)
  const s = sin(step)
  const nx = fx * c + fz * s
  const nz = fz * c - fx * s
  const inv = 1 / Math.sqrt(nx * nx + nz * nz)
  out.x = nx * inv
  out.z = nz * inv
  return out
}

export function quatAxisAngleY(rad: f64, out: Quat4): Quat4 {
  const half = rad * 0.5
  out.x = 0
  out.y = sin(half)
  out.z = 0
  out.w = cos(half)
  return out
}
