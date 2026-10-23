import { cameraBasis, yawTurn } from '../client/cameraBasis.ts'
import type { Planar, PlanarBasis } from '../client/cameraBasis.ts'
import type { CameraPose } from './port.ts'

// View-side third-person orbit camera: a local client value, never in the sim snapshot.
// yaw follows the sim's yawFacing (forward = (sin yaw, cos yaw)); turning right lowers it,
// but every turn goes through yawTurn so no yaw sign lives here (ARCHITECTURE 1.6).
export const PITCH_MIN = -0.25
export const PITCH_MAX = 1.2
export const DEFAULT_PITCH = Math.atan2(2.8, 7)
export const ORBIT_DISTANCE = Math.sqrt(7 * 7 + 2.8 * 2.8)
export const TARGET_HEIGHT = 1.2
export const MOUSE_RAD_PER_PX = 0.0005
export const STICK_RAD_S = 0.6
export const STICK_DEADZONE = 0.15

const TAU = Math.PI * 2
const ORIGIN = { x: 0, y: 0, z: 0 }

// Sensitivity is the integer setting 1..10.
function sensSteps(sensitivity: number): number {
  if (!Number.isFinite(sensitivity)) return 5
  return Math.min(10, Math.max(1, Math.round(sensitivity)))
}

function wrapYaw(a: number): number {
  let y = a - TAU * Math.floor(a / TAU)
  if (y > Math.PI) y -= TAU
  return y
}

function clampPitch(p: number): number {
  return Math.min(PITCH_MAX, Math.max(PITCH_MIN, p))
}

function dead(v: number): number {
  return Number.isFinite(v) && Math.abs(v) > STICK_DEADZONE ? v : 0
}

export class OrbitCamera {
  yaw = 0
  pitch = DEFAULT_PITCH

  reset(yaw = 0): void {
    this.yaw = wrapYaw(yaw)
    this.pitch = DEFAULT_PITCH
  }

  // Screen basis on XZ of the current pose; pass basis() to stickToWorld for movement.
  basis(): PlanarBasis {
    const p = this.pose(ORIGIN)
    return cameraBasis(p.eye, p.target)
  }

  // Ground forward on XZ: pass it as controlsToInput's cameraFacing.
  ground(): Planar {
    return this.basis().forward
  }

  // dx > 0 turns the view right; dy < 0 (mouse up) looks up, i.e. lowers the pitch.
  mouse(dx: number, dy: number, sensitivity: number, invertY: boolean): void {
    const k = sensSteps(sensitivity) * MOUSE_RAD_PER_PX
    if (Number.isFinite(dx)) this.turn(dx * k)
    if (Number.isFinite(dy)) this.pitch = clampPitch(this.pitch + (invertY ? -dy : dy) * k)
  }

  // rx > 0 turns right. Gamepad up is negative ry; pushing up looks up unless invertY.
  stick(rx: number, ry: number, dtS: number, sensitivity: number, invertY: boolean): void {
    if (!Number.isFinite(dtS) || dtS <= 0) return
    const k = sensSteps(sensitivity) * STICK_RAD_S * dtS
    const x = dead(rx)
    const y = dead(ry)
    this.turn(x * k)
    this.pitch = clampPitch(this.pitch + (invertY ? -y : y) * k)
  }

  // Direct pose, no smoothing: the eye sits on a sphere of ORBIT_DISTANCE around the target.
  pose(focus: { x: number; y: number; z: number }): CameraPose {
    const fx = Math.sin(this.yaw)
    const fz = Math.cos(this.yaw)
    const h = Math.cos(this.pitch) * ORBIT_DISTANCE
    const v = Math.sin(this.pitch) * ORBIT_DISTANCE
    const tx = focus.x
    const ty = focus.y + TARGET_HEIGHT
    const tz = focus.z
    return { eye: [tx - fx * h, ty + v, tz - fz * h], target: [tx, ty, tz], fovYDeg: 60, near: 0.1, far: 500 }
  }

  // amountRad > 0 rotates the forward toward screen-right; a zero turn keeps yaw bit-exact.
  private turn(amountRad: number): void {
    if (amountRad === 0) return
    const f = yawTurn(this.ground(), amountRad)
    this.yaw = wrapYaw(Math.atan2(f.x, f.z))
  }
}
