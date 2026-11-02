import { PoseLookAt, type LookRigBone } from './poseLookAt.ts'
// View-side visual IK (S20) over a graph pose. Targets are world points the caller reads from simulation
// state; the corrected pose is for rendering only and nothing here writes the sim or the source pose.
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { loadAnimBrick } from './brick.ts'
import type { CharacterPose } from './driver.ts'

type Brick = Awaited<ReturnType<typeof loadAnimBrick>>
type Rig = ReturnType<Brick['loadRig']>
type Vec3 = [number, number, number]

export interface Vec3Like { readonly x: number; readonly y: number; readonly z: number }
export interface GroundContact { readonly point: Vec3Like; readonly normal: Vec3Like }
/** The scene's character placement: yaw atan2(facing.x, facing.z) about +Y, then translate to pos; unit scale. */
export interface CharacterTransform {
  readonly pos: Vec3Like
  readonly facing: { readonly x: number; readonly z: number }
}
/** World-space simulation targets; a missing one leaves its correction inactive. */
export interface IkTargets {
  readonly mode: number // CharMode: hands reach only while grabbing (the graph's grab and hang states)
  readonly ground?: GroundContact | null
  readonly grab?: Vec3Like | null
  readonly look?: Vec3Like | null // camera-forward look target
}
export interface IkActive { feet: boolean; hands: boolean; look: boolean }
export interface VisualPose {
  readonly local: Float32Array
  readonly model: Float32Array
  readonly skin: Float32Array
  readonly active: IkActive
}

// Chains and bones of the protected penguin rig. Legs have no knee bone, so a foot is placed by
// turning its upper leg toward the foot target; the hands use the rig's own flipper chains.
const HAND_CHAINS = ['flipperL', 'flipperR'] as const
const LEGS = [['upperLeg.l', 'foot.l'], ['upperLeg.r', 'foot.r']] as const
const HEAD = 'head'
const HEAD_FORWARD: Vec3 = [0, 0, 1]
const FOOT_UP: Vec3 = [0, 1, 0]
const LEG_MAX_DEG = 30
const LOOK_MAX_DEG = 60

const finite = (v: Vec3Like): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)

/** Inverse of the character transform: a world point (or direction) in the pose's coordinate frame. */
export function toPoseFrame(v: Vec3Like, xf: CharacterTransform, direction = false): Vec3 {
  const yaw = Math.atan2(xf.facing.x, xf.facing.z), c = Math.cos(yaw), s = Math.sin(yaw)
  const x = direction ? v.x : v.x - xf.pos.x, z = direction ? v.z : v.z - xf.pos.z
  return [x * c - z * s, direction ? v.y : v.y - xf.pos.y, x * s + z * c]
}

// S17 local TRS from model matrices. Cache each parent inverse once per pose
// several flippers/legs/head share the root. Scratch arrays stay local to this solve.
export function localPose(model: ArrayLike<number>, parents: readonly number[]): Float32Array {
  const out = new Float32Array(parents.length * 10)
  const inverses = new Float64Array(parents.length * 16), ready = new Uint8Array(parents.length)
  const l = new Float64Array(16)
  for (let i = 0; i < parents.length; i++) {
    const parent = parents[i], p = parent * 16, b = i * 16
    if (parent >= 0 && !ready[parent]) {
      const a0 = model[p], a1 = model[p + 1], a2 = model[p + 2], b0 = model[p + 4], b1 = model[p + 5], b2 = model[p + 6], c0 = model[p + 8], c1 = model[p + 9], c2 = model[p + 10]
      const x0 = b1 * c2 - b2 * c1, x1 = b2 * c0 - b0 * c2, x2 = b0 * c1 - b1 * c0
      const y0 = c1 * a2 - c2 * a1, y1 = c2 * a0 - c0 * a2, y2 = c0 * a1 - c1 * a0
      const z0 = a1 * b2 - a2 * b1, z1 = a2 * b0 - a0 * b2, z2 = a0 * b1 - a1 * b0
      const det = a0 * x0 + a1 * x1 + a2 * x2
      inverses[p] = x0 / det
      inverses[p + 4] = x1 / det
      inverses[p + 8] = x2 / det
      inverses[p + 1] = y0 / det
      inverses[p + 5] = y1 / det
      inverses[p + 9] = y2 / det
      inverses[p + 2] = z0 / det
      inverses[p + 6] = z1 / det
      inverses[p + 10] = z2 / det
      for (let r = 0; r < 3; r++)
        inverses[p + 12 + r] = -(inverses[p + r] * model[p + 12] + inverses[p + 4 + r] * model[p + 13] + inverses[p + 8 + r] * model[p + 14])
      inverses[p + 15] = 1
      ready[parent] = 1
    }
    for (let c = 0; c < 4; c++) {
      const x = model[b + c * 4], y = model[b + c * 4 + 1], z = model[b + c * 4 + 2]
      for (let r = 0; r < 3; r++)
        l[c * 4 + r] = parent < 0 ? model[b + c * 4 + r] : inverses[p + r] * x + inverses[p + 4 + r] * y + inverses[p + 8 + r] * z + (c === 3 ? inverses[p + 12 + r] : 0)
      l[c * 4 + 3] = c === 3 ? 1 : 0
    }
    const sx = Math.sqrt(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]), sy = Math.sqrt(l[4] * l[4] + l[5] * l[5] + l[6] * l[6]), sz = Math.sqrt(l[8] * l[8] + l[9] * l[9] + l[10] * l[10])
    const m00 = l[0] / sx, m10 = l[1] / sx, m20 = l[2] / sx, m01 = l[4] / sy, m11 = l[5] / sy, m21 = l[6] / sy, m02 = l[8] / sz, m12 = l[9] / sz, m22 = l[10] / sz
    const tr = m00 + m11 + m22
    let x: number, y: number, z: number, w: number
    if (tr > 0) {
      const k = Math.sqrt(tr + 1) * 2
      x = (m21 - m12) / k
      y = (m02 - m20) / k
      z = (m10 - m01) / k
      w = k / 4
    }
    else if (m00 > m11 && m00 > m22) {
      const k = Math.sqrt(1 + m00 - m11 - m22) * 2
      x = k / 4
      y = (m01 + m10) / k
      z = (m02 + m20) / k
      w = (m21 - m12) / k
    }
    else if (m11 > m22) {
      const k = Math.sqrt(1 + m11 - m00 - m22) * 2
      x = (m01 + m10) / k
      y = k / 4
      z = (m12 + m21) / k
      w = (m02 - m20) / k
    }
    else {
      const k = Math.sqrt(1 + m22 - m00 - m11) * 2
      x = (m02 + m20) / k
      y = (m12 + m21) / k
      z = k / 4
      w = (m10 - m01) / k
    }
    const n = Math.sqrt(x * x + y * y + z * z + w * w) * (w < 0 ? -1 : 1), o = i * 10
    out[o] = l[12]
    out[o + 1] = l[13]
    out[o + 2] = l[14]
    out[o + 3] = x / n
    out[o + 4] = y / n
    out[o + 5] = z / n
    out[o + 6] = w / n
    out[o + 7] = sx
    out[o + 8] = sy
    out[o + 9] = sz
  }
  return out
}

/** Stateless per evaluation: every call starts from the given graph pose, so corrections never accumulate. */
export class VisualIk {
  private readonly api: Brick
  private readonly rig: Rig
  private readonly parents: number[]
  private readonly index: Map<string, number>
  private fast: PoseLookAt | null = null

  private constructor(api: Brick, rig: Rig, parents: number[], index: Map<string, number>) {
    this.api = api; this.rig = rig; this.parents = parents; this.index = index
  }

  /** rigJson is the S16 rig the graph poses use; its chains and bones are used, never extended. */
  static create(api: Brick, rigJson: string, fast = true): VisualIk {
    const preset = JSON.parse(rigJson) as { bones: { name: string; parent: string | null }[]; ikChains: { name: string }[] }
    const index = new Map(preset.bones.map((b, i) => [b.name, i]))
    const parents = preset.bones.map(b => (b.parent === null ? -1 : index.get(b.parent) ?? -1))
    for (const name of [HEAD, ...LEGS.flat()]) if (!index.has(name)) throw new Error(`rig has no bone ${name}`)
    for (const [upper, foot] of LEGS) {
      if (parents[index.get(foot)!] !== index.get(upper)) throw new Error(`${foot} is not a child of ${upper}`)
    }
    for (const chain of HAND_CHAINS) {
      if (!preset.ikChains.some(c => c.name === chain)) throw new Error(`rig has no chain ${chain}`)
    }
    const result = new VisualIk(api, api.loadRig(rigJson), parents, index)
    const full = JSON.parse(rigJson)
    if (fast) result.fast = new PoseLookAt(full.bones as LookRigBone[], full.limits ?? [])
    return result
  }

  evaluate(source: Pick<CharacterPose, 'model' | 'skin'> & { local?: Float32Array }, xf: CharacterTransform, targets: IkTargets): VisualPose {
    const ik = this.api.ik, active: IkActive = { feet: false, hands: false, look: false }
    let pose: Omit<VisualPose, 'active'> = {
      local: source["local"]?.slice() ?? localPose(source.model, this.parents), model: source.model.slice(), skin: source.skin.slice(),
    }
    const lookAt = (p: typeof pose, name: string, target: Vec3, axis: Vec3, cap: number) =>
      this.fast && target.every(Number.isFinite) ? this.fast.apply(p, this.index.get(name)!, target, axis, cap) : ik.lookAt(this.rig, p, name, target, axis, cap)
    const { look, grab, ground } = targets
    if (look && finite(look)) {
      pose = lookAt(pose, HEAD, toPoseFrame(look, xf), HEAD_FORWARD, LOOK_MAX_DEG)
      active.look = true
    }
    if (grab && targets.mode === CharMode.grabbing && finite(grab)) {
      const target = toPoseFrame(grab, xf)
      for (const chain of HAND_CHAINS) pose = ik.handReach(this.rig, pose, chain, target, 1)
      active.hands = true
    }
    const p = ground && finite(ground.point) && finite(ground.normal) ? toPoseFrame(ground.point, xf) : null
    const n = p && ground ? toPoseFrame(ground.normal, xf, true) : null
    if (p && n && n[1] > 1e-3) {
      // Keep each animated foot's height above the ground but follow the contact plane under it: with no
      // knee, the upper leg swings its fixed length to that height. Then the foot's up axis turns to the normal.
      for (const [upper, foot] of LEGS) {
        const f = this.index.get(foot)!, o = f * 16 + 12, h = this.index.get(upper)! * 16 + 12
        let m = pose.model
        const d = [m[o] - m[h], m[o + 1] - m[h + 1], m[o + 2] - m[h + 2]], len = Math.hypot(d[0], d[1], d[2])
        const dy = Math.max(-len, Math.min(len, d[1] - (n[0] * (m[o] - p[0]) + n[2] * (m[o + 2] - p[2])) / n[1]))
        const flat = Math.hypot(d[0], d[2]), k = Math.sqrt(len * len - dy * dy) / (flat || 1)
        const target: Vec3 = [m[h] + d[0] * k, m[h + 1] + dy, m[h + 2] + (flat ? d[2] * k : k)]
        const { local: poseLocal } = pose
        const axis: Vec3 = [poseLocal[f * 10], poseLocal[f * 10 + 1], poseLocal[f * 10 + 2]]
        pose = lookAt(pose, upper, target, axis, LEG_MAX_DEG)
        m = pose.model
        pose = lookAt(pose, foot, [m[o] + n[0], m[o + 1] + n[1], m[o + 2] + n[2]], FOOT_UP, LEG_MAX_DEG)
      }
      active.feet = true
    }
    const { local, model, skin } = pose
    return { local, model, skin, active }
  }

  dispose(): void { this.rig.free() }
}
