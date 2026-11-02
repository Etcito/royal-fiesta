// Scene documents use the same authored camera nodes as SDF Modeler.
import type { CameraPose } from './render/port.ts'
import { refuse } from '@royal-fiesta/sim/refusal'

type Obj = Record<string, unknown>
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export function sceneCamera(scene: unknown, purpose: string): CameraPose | undefined {
  if (scene === undefined) return undefined
  if (!object(scene) || scene.format !== 'sdfm' || (scene.version !== 1 && scene.version !== 2) || !Array.isArray(scene.root) || !object(scene.nodes))
    return refuse('course', '#/scene', 'scene must be an SDF document')
  const nodes = scene.nodes
  for (const id of scene.root) {
    const node = nodes[String(id)]
    if (!object(node) || node.kind !== 'camera' || node.visible === false) continue
    const p = node.params
    if (!object(p)) return refuse('course', '#/scene', 'camera needs params')
    const vector = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
    if (!vector(p.position) || !vector(p.target) || typeof p.fov !== 'number' || p.fov < 1 || p.fov > 179 || !['thumbnail', 'start', 'podium', 'free'].includes(String(p.purpose)))
      return refuse('course', '#/scene', 'invalid camera position, target, fov or purpose')
    if (p.position.every((v, i) => v === (p.target as number[])[i])) return refuse('course', '#/scene', 'camera position and target coincide')
    if (p.purpose !== purpose) continue
    const transform = object(node.transform) ? node.transform : {}
    const pose = object(node.pose) ? node.pose : {}
    const v = (value: unknown, fallback: [number, number, number]): [number, number, number] => {
      if (value === undefined) return fallback
      if (!vector(value)) return refuse('course', '#/scene', 'invalid camera transform')
      return value
    }
    // Same XYZ Euler order and pivot/pose composition as MAMA localMatrix.
    const rotate = (point: number[], degrees: number[]): [number, number, number] => {
      let [x, y, z] = point
      const [a, b, c] = degrees.map(d => d * Math.PI / 180)
      ;[x, y] = [Math.cos(c) * x - Math.sin(c) * y, Math.sin(c) * x + Math.cos(c) * y]
      ;[x, z] = [Math.cos(b) * x + Math.sin(b) * z, -Math.sin(b) * x + Math.cos(b) * z]
      ;[y, z] = [Math.cos(a) * y - Math.sin(a) * z, Math.sin(a) * y + Math.cos(a) * z]
      return [x, y, z]
    }
    const pivot = v(node.pivot, [0, 0, 0]), scale = v(transform.scale, [1, 1, 1])
    if (scale.some(x => x === 0)) return refuse('course', '#/scene', 'camera scale must be nonzero')
    const position = v(transform.position, [0, 0, 0]), translation = v(pose.translation, [0, 0, 0])
    const point = (value: number[]): [number, number, number] => {
      const scaled = value.map((x, i) => (x - pivot[i]) * scale[i])
      const rotated = rotate(rotate(scaled, v(transform.rotation, [0, 0, 0])), v(pose.rotation, [0, 0, 0]))
      return rotated.map((x, i) => x + position[i] + pivot[i] + translation[i]) as [number, number, number]
    }
    if (p.roll !== undefined && (typeof p.roll !== 'number' || !Number.isFinite(p.roll))) return refuse('course', '#/scene', 'invalid camera roll')
    const eye = point(p.position), target = point(p.target)
    const norm = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n) }
    const cross = (a: number[], b: number[]) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    const forward = norm(target.map((x, i) => x-eye[i]))
    const origin = point([0, 0, 0]), upPoint = point([0, 1, 0])
    let up = norm(upPoint.map((x, i) => x-origin[i]))
    let right = cross(forward, up)
    if (Math.hypot(...right) < 1e-8) right = cross(forward, [0, 0, 1])
    right = norm(right); up = norm(cross(right, forward))
    const roll = Number(p.roll ?? 0) * Math.PI / 180
    const rolled = up.map((x, i) => x * Math.cos(roll) + right[i] * Math.sin(roll)) as [number, number, number]
    return { eye, target, up: rolled, fovYDeg: p.fov, near: .1, far: 10000 }
  }
  return undefined
}
