import { PI, dsin, dcos, dsincos } from './detmath.ts'
import type { SinCos } from './detmath.ts'

// Out parameters may alias inputs: every function reads all inputs into locals first.

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export interface Pose { t: Vec3; r: Quat }

// Scratch for quatAxisAngle only; never part of sim state.
const scratchSc: SinCos = { s: 0, c: 0 }

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 }
}

export function pose(): Pose {
  return { t: v3(0, 0, 0), r: quatIdentity() }
}

export function add3(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  const x = a.x + b.x, y = a.y + b.y, z = a.z + b.z
  out.x = x
  out.y = y
  out.z = z
  return out
}

export function sub3(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z
  out.x = x
  out.y = y
  out.z = z
  return out
}

export function scale3(a: Vec3, k: number, out: Vec3): Vec3 {
  const x = a.x * k, y = a.y * k, z = a.z * k
  out.x = x
  out.y = y
  out.z = z
  return out
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function cross3(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  const ax = a.x, ay = a.y, az = a.z
  const bx = b.x, by = b.y, bz = b.z
  out.x = ay * bz - az * by
  out.y = az * bx - ax * bz
  out.z = ax * by - ay * bx
  return out
}

export function len3(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

export function normalize3(a: Vec3, out: Vec3): Vec3 {
  const x = a.x, y = a.y, z = a.z
  const len = Math.sqrt(x * x + y * y + z * z)
  // Zero (or underflowed) length gives zero, never NaN.
  if (!(len > 0)) {
    out.x = 0
    out.y = 0
    out.z = 0
    return out
  }
  const inv = 1 / len
  out.x = x * inv
  out.y = y * inv
  out.z = z * inv
  return out
}

// Expects a unit axis.
export function quatAxisAngle(axis: Vec3, angle: number, out: Quat): Quat {
  const ax = axis.x, ay = axis.y, az = axis.z
  dsincos(angle / 2, scratchSc)
  const s = scratchSc.s
  out.x = ax * s
  out.y = ay * s
  out.z = az * s
  out.w = scratchSc.c
  return out
}

// Hamilton product a*b: rotating by the result applies b, then a.
export function quatMul(a: Quat, b: Quat, out: Quat): Quat {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w
  const bx = b.x, by = b.y, bz = b.z, bw = b.w
  out.x = aw * bx + ax * bw + ay * bz - az * by
  out.y = aw * by - ax * bz + ay * bw + az * bx
  out.z = aw * bz + ax * by - ay * bx + az * bw
  out.w = aw * bw - ax * bx - ay * by - az * bz
  return out
}

export function quatConj(q: Quat, out: Quat): Quat {
  const x = q.x, y = q.y, z = q.z, w = q.w
  out.x = -x
  out.y = -y
  out.z = -z
  out.w = w
  return out
}

export function quatNormalize(q: Quat, out: Quat): Quat {
  const x = q.x, y = q.y, z = q.z, w = q.w
  const len = Math.sqrt(x * x + y * y + z * z + w * w)
  if (!(len > 0)) {
    out.x = 0
    out.y = 0
    out.z = 0
    out.w = 1
    return out
  }
  const inv = 1 / len
  out.x = x * inv
  out.y = y * inv
  out.z = z * inv
  out.w = w * inv
  return out
}

// q*v*conj(q) via t = 2 (q.xyz x v); v' = v + w t + q.xyz x t.
export function quatRotate(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w
  const vx = v.x, vy = v.y, vz = v.z
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  out.x = vx + qw * tx + (qy * tz - qz * ty)
  out.y = vy + qw * ty + (qz * tx - qx * tz)
  out.z = vz + qw * tz + (qx * ty - qy * tx)
  return out
}

export function degToRad(deg: number): number {
  return deg * (PI / 180)
}

// Yaw 0 faces +Z; positive yaw turns toward +X.
export function yawFacing(yaw: number, out: { x: number; z: number }): { x: number; z: number } {
  out.x = dsin(yaw)
  out.z = dcos(yaw)
  return out
}
