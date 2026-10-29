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

// Inverse of an affine column-major matrix: the inverse 3x3 rows are the cofactor cross products.
function affineInverse(m: ArrayLike<number>, o: number): Float64Array {
  const col = (c: number) => [m[o + c * 4], m[o + c * 4 + 1], m[o + c * 4 + 2]]
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const [c0, c1, c2] = [col(0), col(1), col(2)], rows = [cross(c1, c2), cross(c2, c0), cross(c0, c1)]
  const det = c0[0] * rows[0][0] + c0[1] * rows[0][1] + c0[2] * rows[0][2]
  const out = new Float64Array(16)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = rows[r][c] / det
    out[12 + r] = -(out[r] * m[o + 12] + out[4 + r] * m[o + 13] + out[8 + r] * m[o + 14])
  }
  out[15] = 1
  return out
}

// S17 local TRS of every bone from its model matrix: local = inverse(parent model) * model.
export function localPose(model: ArrayLike<number>, parents: readonly number[]): Float32Array {
  const out = new Float32Array(parents.length * 10)
  const l = new Float64Array(16)
  parents.forEach((parent, i) => {
    const inv = parent < 0 ? null : affineInverse(model, parent * 16)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      if (inv === null) { l[c * 4 + r] = model[i * 16 + c * 4 + r]; continue }
      let v = 0
      for (let k = 0; k < 4; k++) v += inv[k * 4 + r] * model[i * 16 + c * 4 + k]
      l[c * 4 + r] = v
    }
    const s = [0, 1, 2].map(c => Math.hypot(l[c * 4], l[c * 4 + 1], l[c * 4 + 2]))
    const m = (r: number, c: number) => l[c * 4 + r] / s[c]
    const tr = m(0, 0) + m(1, 1) + m(2, 2)
    let q: number[]
    if (tr > 0) {
      const k = Math.sqrt(tr + 1) * 2
      q = [(m(2, 1) - m(1, 2)) / k, (m(0, 2) - m(2, 0)) / k, (m(1, 0) - m(0, 1)) / k, k / 4]
    } else if (m(0, 0) > m(1, 1) && m(0, 0) > m(2, 2)) {
      const k = Math.sqrt(1 + m(0, 0) - m(1, 1) - m(2, 2)) * 2
      q = [k / 4, (m(0, 1) + m(1, 0)) / k, (m(0, 2) + m(2, 0)) / k, (m(2, 1) - m(1, 2)) / k]
    } else if (m(1, 1) > m(2, 2)) {
      const k = Math.sqrt(1 + m(1, 1) - m(0, 0) - m(2, 2)) * 2
      q = [(m(0, 1) + m(1, 0)) / k, k / 4, (m(1, 2) + m(2, 1)) / k, (m(0, 2) - m(2, 0)) / k]
    } else {
      const k = Math.sqrt(1 + m(2, 2) - m(0, 0) - m(1, 1)) * 2
      q = [(m(0, 2) + m(2, 0)) / k, (m(1, 2) + m(2, 1)) / k, k / 4, (m(1, 0) - m(0, 1)) / k]
    }
    const n = Math.hypot(q[0], q[1], q[2], q[3]) * (q[3] < 0 ? -1 : 1)
    out.set([l[12], l[13], l[14], q[0] / n, q[1] / n, q[2] / n, q[3] / n, s[0], s[1], s[2]], i * 10)
  })
  return out
}

/** Stateless per evaluation: every call starts from the given graph pose, so corrections never accumulate. */
export class VisualIk {
  private readonly api: Brick
  private readonly rig: Rig
  private readonly parents: number[]
  private readonly index: Map<string, number>

  private constructor(api: Brick, rig: Rig, parents: number[], index: Map<string, number>) {
    this.api = api; this.rig = rig; this.parents = parents; this.index = index
  }

  /** rigJson is the S16 rig the graph poses use; its chains and bones are used, never extended. */
  static create(api: Brick, rigJson: string): VisualIk {
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
    return new VisualIk(api, api.loadRig(rigJson), parents, index)
  }

  evaluate(source: Pick<CharacterPose, 'model' | 'skin'>, xf: CharacterTransform, targets: IkTargets): VisualPose {
    const ik = this.api.ik, active: IkActive = { feet: false, hands: false, look: false }
    let pose: Omit<VisualPose, 'active'> = {
      local: localPose(source.model, this.parents), model: source.model.slice(), skin: source.skin.slice(),
    }
    const { look, grab, ground } = targets
    if (look && finite(look)) {
      pose = ik.lookAt(this.rig, pose, HEAD, toPoseFrame(look, xf), HEAD_FORWARD, LOOK_MAX_DEG)
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
        pose = ik.lookAt(this.rig, pose, upper, target, axis, LEG_MAX_DEG)
        m = pose.model
        pose = ik.lookAt(this.rig, pose, foot, [m[o] + n[0], m[o + 1] + n[1], m[o + 2] + n[2]], FOOT_UP, LEG_MAX_DEG)
      }
      active.feet = true
    }
    const { local, model, skin } = pose
    return { local, model, skin, active }
  }

  dispose(): void { this.rig.free() }
}
