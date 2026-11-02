// Same shortest-arc/capped look-at and rest-relative XYZ limits as raa-ik/src/{reach,limits,pose}.rs.
// Keep the S20 wasm solver for chains; the five single-bone corrections avoid serialising an entire
// twelve-bone pose through wasm on every call. Only the changed bone's subtree needs FK again.
import { localMatrixInto, multiplyInto } from './poseMath.ts'
type V = readonly [
  number,
  number,
  number
]
type Q = readonly [
  number,
  number,
  number,
  number
]
export interface LookRigBone {
  name: string
  parent: string | null
  rest: {
    t: number[]
    r: number[]
    s: number[]
  }
}
interface Limit {
  bone: string
  min: number[]
  max: number[]
}
interface Pose {
  local: Float32Array
  model: Float32Array
  skin: Float32Array
}
const mul = (a: Q, b: Q): Q => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
const unit = (q: Q): Q => { const n = Math.hypot(...q); return q.map(x => x / n) as unknown as Q; }
const norm = (v: V): V => { const n = Math.hypot(...v); return n < 1e-10 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n]; }
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
function limitRotation(rest: Q, q: Q, limit: Limit | undefined): Q {
  if (!limit)
    return q
  const r = unit(rest), n = unit(q)
  let d = mul([-r[0], -r[1], -r[2], r[3]], n)
  if (d[3] < 0)
    d = d.map(v => -v) as unknown as Q
  const [x, y, z, w] = d, m13 = clamp(2 * (x * z + w * y), -1, 1)
  const angles = [Math.abs(m13) < 0.9999999 ? Math.atan2(-2 * (y * z - w * x), 1 - 2 * (x * x + y * y)) : Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + z * z)), Math.asin(m13), Math.abs(m13) < 0.9999999 ? Math.atan2(-2 * (x * y - w * z), 1 - 2 * (y * y + z * z)) : 0]
  const capped = angles.map((v, i) => clamp(v, limit.min[i] * Math.PI / 180, limit.max[i] * Math.PI / 180))
  if (capped.every((v, i) => v === angles[i]))
    return q
  const [a, b, c] = capped.map(v => v / 2), sx = Math.sin(a), cx = Math.cos(a), sy = Math.sin(b), cy = Math.cos(b), sz = Math.sin(c), cz = Math.cos(c)
  let out = unit(mul(r, [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz]))
  if (out.reduce((s, v, i) => s + v * n[i], 0) < 0)
    out = out.map(v => -v) as unknown as Q
  return out
}
// Inverse affine basis times a direction, including non-uniform scale.
function toParent(m: Float32Array, o: number, v: V): V {
  if (o < 0)
    return v
  const a: V = [m[o], m[o + 1], m[o + 2]], b: V = [m[o + 4], m[o + 5], m[o + 6]], c: V = [m[o + 8], m[o + 9], m[o + 10]]
  const x = cross(b, c), y = cross(c, a), z = cross(a, b), det = dot(a, x)
  return [dot(x, v) / det, dot(y, v) / det, dot(z, v) / det]
}
export class PoseLookAt {
  private readonly parents: number[]
  private readonly descendants: number[][]
  private readonly inverse: Float32Array
  private readonly scratch = new Float32Array(16)
  private readonly limits: Map<string, Limit>
  private readonly bones: LookRigBone[]
  constructor(bones: LookRigBone[], limits: Limit[]) {
    this.bones = bones
    this.parents = bones.map(b => bones.findIndex(p => p.name === b.parent))
    this.descendants = bones.map((_, bone) => bones.flatMap((_, i) => { let p = i; while (p >= 0 && p !== bone)
      p = this.parents[p]; return p === bone ? [i] : []; }))
    this.limits = new Map(limits.map(l => [l.bone, l]))
    const model = new Float32Array(bones.length * 16)
    bones.forEach((b, i) => {
      localMatrixInto(this.scratch, 0, [...b.rest.t, ...b.rest.r, ...b.rest.s], 0)
      if (this.parents[i] < 0)
        model.set(this.scratch, i * 16)
      else
        multiplyInto(model, i * 16, model, this.parents[i] * 16, this.scratch, 0)
    })
    this.inverse = new Float32Array(model.length)
    bones.forEach((_, i) => {
      const o = i * 16, t: V = [model[o + 12], model[o + 13], model[o + 14]]
      for (let c = 0; c < 3; c++) {
        const v = toParent(model, o, c === 0 ? [1, 0, 0] : c === 1 ? [0, 1, 0] : [0, 0, 1])
        this.inverse.set(v, o + c * 4)
      }
      const v = toParent(model, o, t)
      this.inverse.set([-v[0], -v[1], -v[2], 1], o + 12)
    })
  }
  apply(pose: Pose, bone: number, target: V, axis: V, maxDeg: number): Pose {
    const m = pose.model, o = bone * 16, local = pose["local"], l = bone * 10
    const from: V = [m[o] * axis[0] + m[o + 4] * axis[1] + m[o + 8] * axis[2], m[o + 1] * axis[0] + m[o + 5] * axis[1] + m[o + 9] * axis[2], m[o + 2] * axis[0] + m[o + 6] * axis[1] + m[o + 10] * axis[2]]
    const to: V = [target[0] - m[o + 12], target[1] - m[o + 13], target[2] - m[o + 14]]
    if (Math.hypot(...from) < 1e-10 || Math.hypot(...to) < 1e-10)
      return pose
    const cap = Math.max(0, maxDeg) * Math.PI / 180
    const angle = Math.acos(clamp(dot(norm(from), norm(to)), -1, 1)), weight = angle <= cap ? 1 : cap / angle
    const a = norm(toParent(m, this.parents[bone] * 16, from)), b = norm(toParent(m, this.parents[bone] * 16, to))
    let arc: Q
    if (dot(a, b) < -0.999999) {
      const v = norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
      arc = [v[0], v[1], v[2], 0]
    }
    else {
      const v = cross(a, b)
      arc = unit([v[0], v[1], v[2], 1 + dot(a, b)])
    }
    const theta = Math.acos(clamp(arc[3], -1, 1)), k = theta < 1e-7 ? weight : Math.sin(theta * weight) / Math.sin(theta)
    const delta: Q = [arc[0] * k, arc[1] * k, arc[2] * k, Math.cos(theta * weight)]
    const q = limitRotation(this.bones[bone].rest.r as unknown as Q, unit(mul(delta, [local[l + 3], local[l + 4], local[l + 5], local[l + 6]])), this.limits.get(this.bones[bone].name))
    local.set(q, l + 3)
    for (const i of this.descendants[bone]) {
      localMatrixInto(this.scratch, 0, local, i * 10)
      if (this.parents[i] < 0)
        m.set(this.scratch, i * 16)
      else
        multiplyInto(m, i * 16, m, this.parents[i] * 16, this.scratch, 0)
      multiplyInto(pose.skin, i * 16, m, i * 16, this.inverse, i * 16)
    }
    return pose
  }
}
