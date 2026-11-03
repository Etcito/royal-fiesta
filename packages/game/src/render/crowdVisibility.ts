import type { CameraPose } from './port.ts'

// Keep a generous four metre sphere (penguin, costume and nearby shadow) around the
// point. This only removes distant off-screen crowd members; it is never sim state.
export function inCrowdView(camera: CameraPose | null, pos: { x: number; y: number; z: number }, aspect: number): boolean {
  if (camera === null) return true
  const [ex, ey, ez] = camera.eye
  let fx = camera.target[0] - ex, fy = camera.target[1] - ey, fz = camera.target[2] - ez
  const length = Math.hypot(fx, fy, fz)
  if (length === 0) return true
  fx /= length; fy /= length; fz /= length
  const up = camera.up ?? [0, 1, 0]
  let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0]
  const rightLength = Math.hypot(rx, ry, rz)
  if (rightLength === 0) return true
  rx /= rightLength; ry /= rightLength; rz /= rightLength
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
  const x = pos.x - ex, y = pos.y - ey, z = pos.z - ez
  const depth = x * fx + y * fy + z * fz
  const radius = 4
  if (depth < -radius || depth > camera.far + radius) return false
  const vertical = Math.tan(camera.fovYDeg * Math.PI / 360), horizontal = vertical * aspect
  return Math.abs(x * rx + y * ry + z * rz) <= depth * horizontal + radius * Math.hypot(1, horizontal) &&
    Math.abs(x * ux + y * uy + z * uz) <= depth * vertical + radius * Math.hypot(1, vertical)
}
