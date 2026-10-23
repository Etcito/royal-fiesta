import type { PlayerInput } from '@royal-fiesta/sim/input'
import { basisFromFacing, stickToWorld } from './cameraBasis.ts'
import type { Planar } from './cameraBasis.ts'

// Bindings applied by apps/web main.ts (this module is the reference):
// keys W/ArrowUp forward, S/ArrowDown back, A/ArrowLeft left, D/ArrowRight right,
// Space jump, Shift dive, E grab; gamepad left stick -> stickX = axes[0], stickY = -axes[1] (up = +stickY).
// Right input moves toward the camera's screen-right (cameraBasis, right-handed: looking along +Z, right is -X).
export interface RawControls { left: boolean; right: boolean; forward: boolean; back: boolean; stickX: number; stickY: number; jump: boolean; dive: boolean; grab: boolean }

const STICK_DEADZONE = 0.15
const world: Planar = { x: 0, z: 0 }

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
  // World direction only through the shared right-handed basis (ARCHITECTURE 1.6).
  stickToWorld(x, y, basisFromFacing(cameraFacing), world)
  out.moveX = world.x
  out.moveZ = world.z
  out.jump = c.jump
  out.dive = c.dive
  out.grab = c.grab
  return out
}
