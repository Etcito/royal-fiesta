// S12 physics of a game asset and the MechItem built from it (S13). Presets and course mechanisms live elsewhere.
import { SURFACES } from '@royal-fiesta/sim/course'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { MECH_CAPS } from '@royal-fiesta/sim/mechanismSpec'
import type { BodySpec, BodyType, JointKind, JointSpec, MechItem, MotorSpec } from '@royal-fiesta/sim/mechanismSpec'
import { refuse } from '@royal-fiesta/sim/refusal'
import { add3, degToRad, len3, quatIdentity, quatMul, quatRotate, sub3, v3 } from '@royal-fiesta/sim/vec'
import type { Pose, Quat, Vec3 } from '@royal-fiesta/sim/vec'
import type { AssetBodyJson, AssetJointJson, AssetPhysicsJson, GameAsset, MotorJson } from './gameAsset.ts'
import { scaleColliders } from './prims.ts'

type Obj = Record<string, unknown>

const ID_RE = /^[a-z0-9-]{1,32}$/
const BODY_TYPES: readonly BodyType[] = ['dynamic', 'kinematic', 'fixed']
const JOINT_KINDS: readonly JointKind[] = ['fixed', 'hinge', 'slider', 'ball', 'spring', 'rope']
const BODY_KEYS = ['id', 'type', 'colliders', 'parts', 't', 'r', 'density', 'friction', 'restitution', 'linearDamping', 'angularDamping', 'gravityScale', 'ccd', 'surface']
const JOINT_REQUIRED = ['id', 'kind', 'a', 'b', 'anchorA', 'anchorB']
const JOINT_OPTIONAL = ['axis', 'limitsDeg', 'limitsM', 'stiffness', 'damping', 'lengthM', 'motor']
const UNIT_EPS = 1e-6

function fail(path: string, ptr: string, reason: string): never {
  return refuse('asset', `${path}#${ptr}`, reason)
}

function escapePointer(s: string): string { return s.replace(/~/g, '~0').replace(/\//g, '~1') }

function obj(v: unknown, path: string, ptr: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, ptr, 'must be an object; provide an object')
  return v as Obj
}

function arr(v: unknown, path: string, ptr: string): unknown[] {
  if (!Array.isArray(v)) fail(path, ptr, 'must be an array; provide an array')
  return v
}

function keys(v: Obj, required: readonly string[], optional: readonly string[], path: string, ptr: string): void {
  for (const k of Object.keys(v)) {
    if (!required.includes(k) && !optional.includes(k)) fail(path, `${ptr}/${escapePointer(k)}`, `unknown key '${k}'; remove it or use a supported field`)
  }
  for (const k of required) {
    if (!Object.hasOwn(v, k)) fail(path, `${ptr}/${k}`, `missing key '${k}'; add it`)
  }
}

function str(v: unknown, path: string, ptr: string): string {
  if (typeof v !== 'string') fail(path, ptr, 'must be a string; provide text')
  return v
}

function bool(v: unknown, path: string, ptr: string): boolean {
  if (typeof v !== 'boolean') fail(path, ptr, 'must be true or false; write a JSON boolean')
  return v
}

function num(v: unknown, path: string, ptr: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, ptr, 'must be a finite number; use a finite JSON number')
  return v
}

function optNum(v: unknown, dflt: number, path: string, ptr: string): number {
  return v === undefined ? dflt : num(v, path, ptr)
}

function positive(v: unknown, path: string, ptr: string): number {
  const x = num(v, path, ptr)
  if (x <= 0) fail(path, ptr, `${x} must be > 0; use a positive number`)
  return x
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string, ptr: string): T {
  const s = str(v, path, ptr)
  if (!(allowed as readonly string[]).includes(s)) fail(path, ptr, `unknown value '${s}'; use one of ${allowed.join('|')}`)
  return s as T
}

function tuple(v: unknown, n: number, path: string, ptr: string): number[] {
  if (!Array.isArray(v) || v.length !== n) fail(path, ptr, `must be an array of ${n} finite numbers; provide ${n} components`)
  return v.map((x, i) => num(x, path, `${ptr}/${i}`))
}

function vec3(v: unknown, path: string, ptr: string): [number, number, number] {
  const a = tuple(v, 3, path, ptr)
  return [a[0], a[1], a[2]]
}

function unitQuat(v: unknown, path: string, ptr: string): [number, number, number, number] {
  const a = tuple(v, 4, path, ptr)
  if (Math.abs(Math.hypot(a[0], a[1], a[2], a[3]) - 1) > UNIT_EPS) fail(path, ptr, 'quaternion norm must be within 1e-6 of 1; provide a unit quaternion')
  return [a[0], a[1], a[2], a[3]]
}

function idOf(v: unknown, path: string, ptr: string, ids: Set<string>): string {
  const id = str(v, path, ptr)
  if (!ID_RE.test(id)) fail(path, ptr, `id '${id}' must match ${ID_RE.source}; rename it`)
  if (ids.has(id)) fail(path, ptr, `id '${id}' is already used in this asset; body and joint ids are unique`)
  ids.add(id)
  return id
}

function bodyOf(v: unknown, path: string, ptr: string, count: number, owner: Map<number, string>, ids: Set<string>): AssetBodyJson {
  const b = obj(v, path, ptr)
  keys(b, BODY_KEYS, [], path, ptr)
  const id = idOf(b.id, path, `${ptr}/id`, ids)
  const colliders = arr(b.colliders, path, `${ptr}/colliders`).map((c, j) => {
    const cp = `${ptr}/colliders/${j}`
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c >= count) {
      fail(path, cp, `collider index ${String(c)} must be an integer below ${count}; use an index into collision`)
    }
    const other = owner.get(c)
    if (other !== undefined) fail(path, cp, `collider ${c} is already in body '${other}'; each collider belongs to exactly one body`)
    owner.set(c, id)
    return c
  })
  const parts = arr(b.parts, path, `${ptr}/parts`).map((x, j) => str(x, path, `${ptr}/parts/${j}`))
  return {
    id,
    type: oneOf(b.type, BODY_TYPES, path, `${ptr}/type`),
    colliders,
    parts,
    t: vec3(b.t, path, `${ptr}/t`),
    r: unitQuat(b.r, path, `${ptr}/r`),
    density: positive(b.density, path, `${ptr}/density`),
    friction: num(b.friction, path, `${ptr}/friction`),
    restitution: num(b.restitution, path, `${ptr}/restitution`),
    linearDamping: num(b.linearDamping, path, `${ptr}/linearDamping`),
    angularDamping: num(b.angularDamping, path, `${ptr}/angularDamping`),
    gravityScale: num(b.gravityScale, path, `${ptr}/gravityScale`),
    ccd: bool(b.ccd, path, `${ptr}/ccd`),
    surface: oneOf(b.surface, SURFACES, path, `${ptr}/surface`),
  }
}

function limitsOf(j: Obj, field: 'limitsDeg' | 'limitsM', kind: JointKind, path: string, ptr: string): [number, number] | null {
  const v = j[field]
  if (v === undefined || v === null) return null
  const want = field === 'limitsDeg' ? 'hinge' : 'slider'
  if (kind !== want) fail(path, `${ptr}/${field}`, `${field} applies to ${want} joints; remove it or set it to null`)
  const a = tuple(v, 2, path, `${ptr}/${field}`)
  if (a[0] > a[1]) fail(path, `${ptr}/${field}`, `min ${a[0]} > max ${a[1]}; write [min, max] with min <= max`)
  return [a[0], a[1]]
}

function motorOf(v: unknown, kind: JointKind, path: string, ptr: string): MotorJson | null {
  if (v === undefined || v === null) return null
  if (kind !== 'hinge' && kind !== 'slider') fail(path, ptr, `a motor applies to hinge and slider joints; set motor to null on a ${kind} joint`)
  const m = obj(v, path, ptr)
  const hinge = kind === 'hinge'
  const mode = oneOf(m.mode, ['speed', 'target'] as const, path, `${ptr}/mode`)
  const field = mode === 'speed'
    ? (hinge ? 'speedDegS' : 'speedMS')
    : (hinge ? 'targetDeg' : 'targetM')
  keys(m, ['mode', 'stiffness', 'damping', 'maxForce', 'enabled', field], [], path, ptr)
  const maxForce = num(m.maxForce, path, `${ptr}/maxForce`)
  if (maxForce < 0) fail(path, `${ptr}/maxForce`, `maxForce ${maxForce} must be >= 0; use a non-negative force`)
  const out: MotorJson = {
    mode,
    stiffness: num(m.stiffness, path, `${ptr}/stiffness`),
    damping: num(m.damping, path, `${ptr}/damping`),
    maxForce,
    enabled: bool(m.enabled, path, `${ptr}/enabled`),
  }
  out[field] = num(m[field], path, `${ptr}/${field}`)
  return out
}

function jointOf(v: unknown, path: string, ptr: string, bodyIds: Set<string>, ids: Set<string>): AssetJointJson {
  const j = obj(v, path, ptr)
  keys(j, JOINT_REQUIRED, JOINT_OPTIONAL, path, ptr)
  const id = idOf(j.id, path, `${ptr}/id`, ids)
  const kind = oneOf(j.kind, JOINT_KINDS, path, `${ptr}/kind`)
  const bodyRef = (field: 'a' | 'b'): string => {
    const x = str(j[field], path, `${ptr}/${field}`)
    if (!bodyIds.has(x)) fail(path, `${ptr}/${field}`, `body '${x}' is not in this asset; use the id of one of its bodies`)
    return x
  }
  const a = bodyRef('a')
  const b = bodyRef('b')
  if (a === b) fail(path, `${ptr}/b`, `joint '${id}' joins body '${a}' to itself; use two different bodies`)
  let axis: [number, number, number] = [1, 0, 0]
  if (j.axis !== undefined) {
    axis = vec3(j.axis, path, `${ptr}/axis`)
    const len = Math.hypot(axis[0], axis[1], axis[2])
    if (Math.abs(len - 1) > UNIT_EPS) fail(path, `${ptr}/axis`, `axis length ${len} must be 1 within 1e-6; normalise the axis`)
  } else if (kind === 'hinge' || kind === 'slider') {
    fail(path, `${ptr}/axis`, `a ${kind} joint needs a unit axis; add "axis": [x, y, z]`)
  }
  return {
    id, kind, a, b,
    anchorA: vec3(j.anchorA, path, `${ptr}/anchorA`),
    anchorB: vec3(j.anchorB, path, `${ptr}/anchorB`),
    axis,
    limitsDeg: limitsOf(j, 'limitsDeg', kind, path, ptr),
    limitsM: limitsOf(j, 'limitsM', kind, path, ptr),
    stiffness: optNum(j.stiffness, 0, path, `${ptr}/stiffness`),
    damping: optNum(j.damping, 0, path, `${ptr}/damping`),
    lengthM: optNum(j.lengthM, 0, path, `${ptr}/lengthM`),
    motor: motorOf(j.motor, kind, path, `${ptr}/motor`),
  }
}

// `collision` is the asset's parsed collider list; each collider index must belong to exactly one body.
export function parseAssetPhysics(json: unknown, collision: readonly ColliderSpec[], path: string): AssetPhysicsJson | null {
  if (json === undefined) return null
  const p = obj(json, path, '/physics')
  keys(p, ['bodies', 'joints'], [], path, '/physics')
  const bodiesIn = arr(p.bodies, path, '/physics/bodies')
  if (bodiesIn.length === 0) fail(path, '/physics/bodies', 'needs at least one body; add a body')
  if (bodiesIn.length > MECH_CAPS.maxBodiesPerItem) fail(path, '/physics/bodies', `${bodiesIn.length} bodies, over ${MECH_CAPS.maxBodiesPerItem}; merge bodies`)
  const jointsIn = arr(p.joints, path, '/physics/joints')
  if (jointsIn.length > MECH_CAPS.maxJoints) fail(path, '/physics/joints', `${jointsIn.length} joints, over ${MECH_CAPS.maxJoints}; remove some`)

  const ids = new Set<string>()
  const owner = new Map<number, string>()
  const bodies = bodiesIn.map((b, i) => bodyOf(b, path, `/physics/bodies/${i}`, collision.length, owner, ids))
  for (let k = 0; k < collision.length; k++) {
    if (!owner.has(k)) fail(path, '/physics/bodies', `collision ${k} belongs to no body; add index ${k} to one body's colliders`)
  }
  const bodyIds = new Set(bodies.map(b => b.id))
  const joints = jointsIn.map((j, i) => jointOf(j, path, `/physics/joints/${i}`, bodyIds, ids))
  return { bodies, joints }
}

function toVec(t: readonly number[]): Vec3 {
  return { x: t[0], y: t[1], z: t[2] }
}

function toQuat(r: readonly number[]): Quat {
  return { x: r[0], y: r[1], z: r[2], w: r[3] }
}

function scaledBy(t: readonly number[], s: Vec3): Vec3 {
  return { x: t[0] * s.x, y: t[1] * s.y, z: t[2] * s.z }
}

function worldOf(pose: Pose, p: Vec3): Vec3 {
  return add3(pose.t, quatRotate(pose.r, p, v3(0, 0, 0)), v3(0, 0, 0))
}

function byId<T extends { id: string }>(x: T, y: T): number {
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
}

// An asset without physics is one fixed body made of all its colliders.
function wholeAsset(asset: GameAsset): AssetPhysicsJson {
  return {
    bodies: [{
      id: 'body', type: 'fixed', colliders: asset.collision.map((_, i) => i), parts: [],
      t: [0, 0, 0], r: [0, 0, 0, 1], density: 400, friction: 0.6, restitution: 0,
      linearDamping: 0, angularDamping: 0.05, gravityScale: 1, ccd: false, surface: 'normal',
    }],
    joints: [],
  }
}

function limitsSpec(j: AssetJointJson): [number, number] | null {
  if (j.limitsDeg) return [degToRad(j.limitsDeg[0]), degToRad(j.limitsDeg[1])]
  if (j.limitsM) return [j.limitsM[0], j.limitsM[1]]
  return null
}

function motorSpec(m: MotorJson | null): MotorSpec | null {
  if (m === null) return null
  return {
    mode: m.mode,
    speed: m.speedDegS !== undefined ? degToRad(m.speedDegS) : (m.speedMS ?? 0),
    target: m.targetDeg !== undefined ? degToRad(m.targetDeg) : (m.targetM ?? 0),
    stiffness: m.stiffness,
    damping: m.damping,
    maxForce: m.maxForce,
    enabled: m.enabled,
  }
}

export function itemOf(o: { id: string; asset: string; t: Vec3; r: Quat; s: Vec3 }, asset: GameAsset, path: string): MechItem {
  const physics = asset.physics ?? wholeAsset(asset)
  const bodies = [...physics.bodies].sort(byId)
  const index = new Map(bodies.map((b, i) => [b.id, i] as const))
  const at = (id: string): number => index.get(id) as number
  const bodySpecs: BodySpec[] = bodies.map(b => {
    const colliders = scaleColliders(b.colliders.map(i => asset.collision[i]), o.s, path)
    const rest: Pose = {
      t: add3(o.t, quatRotate(o.r, scaledBy(b.t, o.s), v3(0, 0, 0)), v3(0, 0, 0)),
      r: quatMul(o.r, toQuat(b.r), quatIdentity()),
    }
    return {
      id: b.id, type: b.type, colliders, rest,
      density: b.density, friction: b.friction, restitution: b.restitution,
      linearDamping: b.linearDamping, angularDamping: b.angularDamping,
      gravityScale: b.gravityScale, ccd: b.ccd, surface: b.surface,
    }
  })
  const joints: JointSpec[] = [...physics.joints].sort(byId).map(j => {
    const anchorA = scaledBy(j.anchorA, o.s)
    const anchorB = scaledBy(j.anchorB, o.s)
    const restA = bodySpecs[at(j.a)].rest
    const restB = bodySpecs[at(j.b)].rest
    const length = j.kind === 'spring'
      ? len3(sub3(worldOf(restA, anchorA), worldOf(restB, anchorB), v3(0, 0, 0)))
      : j.kind === 'rope' ? (j.lengthM ?? 0) : 0
    return {
      id: j.id,
      kind: j.kind,
      // The caller that places the item rewrites `item`; the mechanism system reads only `body` for item joints.
      a: { item: 0, body: at(j.a) },
      b: { item: 0, body: at(j.b) },
      anchorA,
      anchorB,
      axis: toVec(j.axis),
      limits: limitsSpec(j),
      stiffness: j.stiffness ?? 0,
      damping: j.damping ?? 0,
      length,
      motor: motorSpec(j.motor),
    }
  })
  return { id: o.id, asset: o.asset, t: o.t, r: o.r, s: o.s, bodies: bodySpecs, joints }
}
