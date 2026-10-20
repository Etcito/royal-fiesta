import type { Vec3 } from '@royal-fiesta/sim/vec'
import type { CameraPose } from './port.ts'

const FOLLOW_RATE = 8

export function followCamera(prev: CameraPose | null, player: Vec3, facing: { x: number; z: number }, dtS: number): CameraPose {
  let fx = facing.x
  let fz = facing.z
  const len = Math.sqrt(fx * fx + fz * fz)
  if (len === 0) {
    fx = 0
    fz = 1
  } else {
    fx /= len
    fz /= len
  }
  const eye: [number, number, number] = [player.x - fx * 7, player.y + 4, player.z - fz * 7]
  const target: [number, number, number] = [player.x, player.y + 1.2, player.z]
  if (prev === null) return { eye, target, fovYDeg: 60, near: 0.1, far: 500 }
  const k = 1 - Math.exp(-FOLLOW_RATE * dtS)
  const mix = (a: readonly [number, number, number], b: [number, number, number]): [number, number, number] =>
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
  return { eye: mix(prev.eye, eye), target: mix(prev.target, target), fovYDeg: 60, near: 0.1, far: 500 }
}
