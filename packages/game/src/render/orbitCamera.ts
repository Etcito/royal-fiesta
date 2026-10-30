import { cameraBasis, yawTurn } from '../client/cameraBasis.ts'
import type { Planar, PlanarBasis } from '../client/cameraBasis.ts'
import type { ArmClip } from './cameraOcclusion.ts'
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
// Spring arm: the eye stops CAMERA_RADIUS short of an obstacle on the way back from the target (never
// closer than MIN_ARM), snaps in at once and eases back out at ARM_RECOVER_M_S so a passing wall does not pop.
// It only eases out once nothing shortened it for ARM_HOLD_S: a ray grazing an edge (hit, miss, hit...) as the
// player moves would otherwise pump the eye in and out every frame, which reads as the player vibrating.
export const CAMERA_RADIUS = 0.3
export const MIN_ARM = 0.5
export const ARM_RECOVER_M_S = 12
export const ARM_HOLD_S = 0.4

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
  // Current arm length (target to eye); below ORBIT_DISTANCE while an obstacle shortens it.
  private arm = ORBIT_DISTANCE
  // Seconds left before the arm may ease back out (ARM_HOLD_S after the last shortening).
  private hold = 0

  reset(yaw = 0): void {
    this.yaw = wrapYaw(yaw)
    this.pitch = DEFAULT_PITCH
    this.arm = ORBIT_DISTANCE
    this.hold = 0
  }

  // Screen basis on XZ of the current pose; pass basis() to stickToWorld for movement. It reads the view
  // direction only and never touches the arm: the page asks for it every frame (movement, mouse turns), and
  // resetting the arm there removed the ease-out, so the eye popped between full and clipped each frame.
  basis(): PlanarBasis {
    const p = this.at(ORIGIN, ORBIT_DISTANCE)
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

  // The eye sits on a sphere of ORBIT_DISTANCE around the target; with `clip` (obstacle test) the arm
  // shortens to stop short of geometry between the target and the eye. basis() never clips: the
  // movement frame depends on the view direction only.
  pose(focus: { x: number; y: number; z: number }, dtS = 0, clip?: ArmClip): CameraPose {
    const fx = Math.sin(this.yaw)
    const fz = Math.cos(this.yaw)
    const ch = Math.cos(this.pitch)
    const sv = Math.sin(this.pitch)
    if (clip === undefined) {
      this.arm = ORBIT_DISTANCE
      this.hold = 0
      return this.at(focus, ORBIT_DISTANCE)
    }
    const free = clip([focus.x, focus.y + TARGET_HEIGHT, focus.z], [-fx * ch, sv, -fz * ch], ORBIT_DISTANCE, CAMERA_RADIUS)
    const want = Math.max(MIN_ARM, free)
    const dt = Number.isFinite(dtS) && dtS > 0 ? dtS : 0
    // An obstacle at or inside the current arm (the same hit as last frame included) restarts the hold.
    if (want <= this.arm) {
      this.arm = want
      this.hold = ARM_HOLD_S
    } else if (this.hold > 0) {
      this.hold -= dt
    } else {
      this.arm = Math.min(want, this.arm + ARM_RECOVER_M_S * dt)
    }
    return this.at(focus, this.arm)
  }

  // The pose with the eye `len` back from the target along the current yaw and pitch.
  private at(focus: { x: number; y: number; z: number }, len: number): CameraPose {
    const fx = Math.sin(this.yaw)
    const fz = Math.cos(this.yaw)
    const ch = Math.cos(this.pitch)
    const sv = Math.sin(this.pitch)
    const tx = focus.x
    const ty = focus.y + TARGET_HEIGHT
    const tz = focus.z
    return { eye: [tx - fx * ch * len, ty + sv * len, tz - fz * ch * len], target: [tx, ty, tz], fovYDeg: 60, near: 0.1, far: 500 }
  }

  // amountRad > 0 rotates the forward toward screen-right; a zero turn keeps yaw bit-exact.
  private turn(amountRad: number): void {
    if (amountRad === 0) return
    const f = yawTurn(this.ground(), amountRad)
    this.yaw = wrapYaw(Math.atan2(f.x, f.z))
  }
}
