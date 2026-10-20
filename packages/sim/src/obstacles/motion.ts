import { FIXED_DT } from '@gamesaloon/rollback-rapier'
import type { MotionKind, ObstacleSpec } from '../course.ts'
import { dsin, TAU } from '../detmath.ts'
import { quatAxisAngle, quatMul, quatConj, quatRotate, add3, sub3, scale3 } from '../vec.ts'
import type { Pose, Quat, Vec3 } from '../vec.ts'

// Module scratch, reused across calls; never part of sim state.
const scratchQ: Quat = { x: 0, y: 0, z: 0, w: 1 }
const scratchV: Vec3 = { x: 0, y: 0, z: 0 }
const poseA: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }
const poseB: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }
const conjA: Quat = { x: 0, y: 0, z: 0, w: 1 }
const local: Vec3 = { x: 0, y: 0, z: 0 }

export function isKinematic(kind: MotionKind): boolean {
  return kind === 'spinner' || kind === 'pendulum' || kind === 'seesaw' ||
    kind === 'rotatingDoor' || kind === 'movingPlatform'
}

export function smoothstep01(u: number): number {
  const c = Math.min(1, Math.max(0, u))
  return c * c * (3 - 2 * c)
}

// In [-1, 1]: -1 at integers, +1 at half-integers.
export function triangleWave(u: number): number {
  return 1 - 4 * Math.abs((u - Math.floor(u)) - 0.5)
}

function copyPose(o: ObstacleSpec, out: Pose): Pose {
  out.t.x = o.t.x
  out.t.y = o.t.y
  out.t.z = o.t.z
  out.r.x = o.r.x
  out.r.y = o.r.y
  out.r.z = o.r.z
  out.r.w = o.r.w
  return out
}

// Pose at round-local tick L; the see-saw reads its own snapshotted angle instead of L.
export function motionPose(o: ObstacleSpec, localTick: number, seesawAngle: number, out: Pose): Pose {
  const m = o.motion
  const L = localTick
  switch (m.kind) {
    case 'static':
    case 'conveyor':
    case 'bouncePad':
      return copyPose(o, out)
    case 'spinner': {
      quatAxisAngle(m.axis, m.phase + m.radPerTick * L, scratchQ)
      copyPose(o, out)
      quatMul(scratchQ, o.r, out.r)
      return out
    }
    case 'pendulum': {
      const theta = m.amp * dsin(TAU * L / m.periodTicks + m.phase)
      quatAxisAngle(m.axis, theta, scratchQ)
      quatMul(scratchQ, o.r, out.r)
      // Swing the origin around the pivot with the same rotation.
      sub3(o.t, m.pivot, scratchV)
      quatRotate(scratchQ, scratchV, scratchV)
      add3(m.pivot, scratchV, out.t)
      return out
    }
    case 'rotatingDoor': {
      const tau = L + m.phaseTicks
      const k = Math.floor(tau / m.periodTicks)
      const u = (tau - k * m.periodTicks) / m.moveTicks
      quatAxisAngle(m.axis, m.stepAngle * (k + smoothstep01(u)), scratchQ)
      copyPose(o, out)
      quatMul(scratchQ, o.r, out.r)
      return out
    }
    case 'movingPlatform': {
      const w = m.wave === 'sine'
        ? dsin(TAU * L / m.periodTicks + m.phase)
        : triangleWave(L / m.periodTicks + m.phase / TAU)
      copyPose(o, out)
      scale3(m.offset, w, scratchV)
      add3(o.t, scratchV, out.t)
      return out
    }
    case 'seesaw': {
      quatAxisAngle(m.axis, seesawAngle, scratchQ)
      copyPose(o, out)
      quatMul(scratchQ, o.r, out.r)
      return out
    }
  }
}

// Velocity of world point p carried by the obstacle over L -> L+1 (finite difference, so it
// matches what the kinematic body actually does in one tick), plus a conveyor's belt speed.
export function pointVelocity(
  o: ObstacleSpec, localTick: number, seesaw0: number, seesaw1: number, p: Vec3, out: Vec3,
): Vec3 {
  const kind = o.motion.kind
  if (kind === 'static' || kind === 'bouncePad') {
    out.x = 0
    out.y = 0
    out.z = 0
    return out
  }
  motionPose(o, localTick, seesaw0, poseA)
  motionPose(o, localTick + 1, seesaw1, poseB)
  quatConj(poseA.r, conjA)
  sub3(p, poseA.t, local)
  quatRotate(conjA, local, local)
  quatRotate(poseB.r, local, scratchV)
  add3(poseB.t, scratchV, scratchV)
  sub3(scratchV, p, scratchV)
  out.x = scratchV.x / FIXED_DT
  out.y = scratchV.y / FIXED_DT
  out.z = scratchV.z / FIXED_DT
  if (o.motion.kind === 'conveyor') add3(out, o.motion.velocity, out)
  return out
}
