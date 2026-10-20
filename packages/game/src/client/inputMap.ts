import type { PlayerInput } from '@royal-fiesta/sim/input'

// Bindings applied by apps/web main.ts (this module is the reference):
// keys W/ArrowUp forward, S/ArrowDown back, A/ArrowLeft left, D/ArrowRight right,
// Space jump, Shift dive, E grab; gamepad left stick -> stickX/stickY (up = +stickY).
export interface RawControls { left: boolean; right: boolean; forward: boolean; back: boolean; stickX: number; stickY: number; jump: boolean; dive: boolean; grab: boolean }

const STICK_DEADZONE = 0.15

export function emptyControls(): RawControls {
  return { left: false, right: false, forward: false, back: false, stickX: 0, stickY: 0, jump: false, dive: false, grab: false }
}

export function controlsToInput(c: RawControls, cameraFacing: { x: number; z: number }, out: PlayerInput): PlayerInput {
  let x = (c.right ? 1 : 0) - (c.left ? 1 : 0)
  let y = (c.forward ? 1 : 0) - (c.back ? 1 : 0)
  const sx = Number.isFinite(c.stickX) ? c.stickX : 0
  const sy = Number.isFinite(c.stickY) ? c.stickY : 0
  if (Math.abs(sx) + Math.abs(sy) > STICK_DEADZONE) {
    x = sx
    y = sy
  }
  const len = Math.sqrt(x * x + y * y)
  if (len > 1) {
    x /= len
    y /= len
  }
  // Facing projected on XZ; a degenerate camera falls back to looking along +Z.
  let fx = cameraFacing.x
  let fz = cameraFacing.z
  const fl = Math.sqrt(fx * fx + fz * fz)
  if (Number.isFinite(fl) && fl > 1e-6) {
    fx /= fl
    fz /= fl
  } else {
    fx = 0
    fz = 1
  }
  // +X is right when looking along +Z, so right = (f.z, -f.x).
  const rx = fz
  const rz = -fx
  out.moveX = rx * x + fx * y
  out.moveZ = rz * x + fz * y
  out.jump = c.jump
  out.dive = c.dive
  out.grab = c.grab
  return out
}
