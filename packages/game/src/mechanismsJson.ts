// S12 physics of a game asset, the MechItem built from it, and the S13 course `mechanisms` and `sounds` blocks.
import { SURFACES } from '@royal-fiesta/sim/course'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { DEFAULT_BUDGET, MECH_CAPS, countBudget, emptyMechanisms } from '@royal-fiesta/sim/mechanismSpec'
import type {
  AnimationSpec, BodyRef, BodySpec, BodyType, JointKind, JointSpec, KeyframeSpec, LeverSpec, LinkSpec, LinkTarget,
  LogicOp, LogicSpec, MechanismBudget, MechanismSpec, MechEventKind, MechItem, MotorSpec, SoundSpec, SwitchSpec,
} from '@royal-fiesta/sim/mechanismSpec'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { add3, degToRad, len3, quatAxisAngle, quatIdentity, quatMul, quatRotate, sub3, v3 } from '@royal-fiesta/sim/vec'
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
  if (ids.has(id)) fail(path, ptr, `id '${id}' is already used; ids are unique, rename one`)
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

type JointFields = Omit<AssetJointJson, 'id' | 'kind' | 'a' | 'b'>

// The S12 joint fields other than id, kind and the two body references.
function jointFields(j: Obj, kind: JointKind, path: string, ptr: string): JointFields {
  let axis: [number, number, number] = [1, 0, 0]
  if (j.axis !== undefined) {
    axis = vec3(j.axis, path, `${ptr}/axis`)
    const len = Math.hypot(axis[0], axis[1], axis[2])
    if (Math.abs(len - 1) > UNIT_EPS) fail(path, `${ptr}/axis`, `axis length ${len} must be 1 within 1e-6; normalise the axis`)
  } else if (kind === 'hinge' || kind === 'slider') {
    fail(path, `${ptr}/axis`, `a ${kind} joint needs a unit axis; add "axis": [x, y, z]`)
  }
  return {
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
  return { id, kind, a, b, ...jointFields(j, kind, path, ptr) }
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

function limitsSpec(j: JointFields): [number, number] | null {
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

// Shared by item and level joints. `restA`/`restB` are null for the world (anchors already in world space).
function jointSpec(j: JointFields & { id: string; kind: JointKind }, a: BodyRef, b: BodyRef, anchorA: Vec3, anchorB: Vec3,
  restA: Pose | null, restB: Pose | null): JointSpec {
  const length = j.kind === 'spring'
    ? len3(sub3(restA ? worldOf(restA, anchorA) : anchorA, restB ? worldOf(restB, anchorB) : anchorB, v3(0, 0, 0)))
    : j.kind === 'rope' ? (j.lengthM ?? 0) : 0
  return {
    id: j.id,
    kind: j.kind,
    a,
    b,
    anchorA,
    anchorB,
    axis: toVec(j.axis),
    limits: limitsSpec(j),
    stiffness: j.stiffness ?? 0,
    damping: j.damping ?? 0,
    length,
    motor: motorSpec(j.motor),
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
    // The caller that places the item rewrites `item`; the mechanism system reads only `body` for item joints.
    return jointSpec(j, { item: 0, body: at(j.a) }, { item: 0, body: at(j.b) }, anchorA, anchorB,
      bodySpecs[at(j.a)].rest, bodySpecs[at(j.b)].rest)
  })
  return { id: o.id, asset: o.asset, t: o.t, r: o.r, s: o.s, bodies: bodySpecs, joints }
}

// ---- S13 course mechanisms and sounds ----

const LOGIC_OPS: readonly LogicOp[] = ['and', 'or', 'not', 'toggle', 'timer', 'delay', 'counter']
const EVENT_KINDS: readonly MechEventKind[] = [
  'switchOn', 'switchOff', 'leverOn', 'leverOff', 'motorStart', 'motorStop', 'animStart', 'animEnd', 'impact',
]
const TICKS_PER_S = 60

// The shared readers above refuse as 'asset'; inside a course they are course refusals.
function asCourse<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (isRefusal(e) && e.area === 'asset') refuse('course', e.path, e.reason)
    throw e
  }
}

function courseFail(path: string, ptr: string, reason: string): never {
  return refuse('course', `${path}#${ptr}`, reason)
}

function optArr(v: unknown, path: string, ptr: string): unknown[] {
  return v === undefined || v === null ? [] : arr(v, path, ptr)
}

function ticksOf(v: unknown, min: number, path: string, ptr: string): number {
  const s = num(v, path, ptr)
  const t = Math.round(s * TICKS_PER_S)
  if (t < min) courseFail(path, ptr, `${s} s is ${t} ticks, below ${min}; use at least ${min / TICKS_PER_S} s`)
  return t
}

function count(v: unknown, path: string, ptr: string): number {
  const x = num(v, path, ptr)
  if (!Number.isInteger(x) || x < 0) courseFail(path, ptr, `${x} must be a non-negative integer; use a whole number`)
  return x
}

// Index of each element after sorting the group by id, keyed by the element's input position.
function sortedOrder<T extends { id: string }>(list: readonly T[]): { sorted: T[]; index: Map<string, number> } {
  const sorted = [...list].sort(byId)
  return { sorted, index: new Map(sorted.map((x, i) => [x.id, i] as const)) }
}

interface Ctx {
  path: string
  items: readonly MechItem[]
  itemIndex: Map<string, number>
  itemJointStart: number[]
  levelJoints: Map<string, number>
  jointKinds: JointKind[]
}

// `{item: obstacle id | null, body: body id}`; item null is the world, BodyRef {item: -1, body: -1}.
function refOf(v: unknown, c: Ctx, ptr: string, worldOk: boolean): BodyRef {
  const r = obj(v, c.path, ptr)
  keys(r, ['item'], ['body'], c.path, ptr)
  if (r.item === null) {
    if (!worldOk) courseFail(c.path, `${ptr}/item`, 'the world cannot be used here; name a mechanism item and one of its bodies')
    if (r.body !== undefined && r.body !== null) courseFail(c.path, `${ptr}/body`, 'the world has no bodies; use "body": null with item null')
    return { item: -1, body: -1 }
  }
  const itemId = str(r.item, c.path, `${ptr}/item`)
  const item = c.itemIndex.get(itemId)
  if (item === undefined) courseFail(c.path, `${ptr}/item`, `unknown mechanism item '${itemId}'; use the id of an obstacle whose asset has physics`)
  const bodyId = str(r.body, c.path, `${ptr}/body`)
  const body = c.items[item].bodies.findIndex(b => b.id === bodyId)
  if (body < 0) courseFail(c.path, `${ptr}/body`, `unknown body '${bodyId}' in item '${itemId}'; use one of ${c.items[item].bodies.map(b => b.id).join('|')}`)
  return { item, body }
}

// A joint reference is a level joint id, `<obstacle id>/<joint id>` for an item joint, or (with `item`) a joint
// id of that item. It becomes the flat joint index: item joints in item order, then level joints by id.
function jointRef(v: unknown, c: Ctx, ptr: string, want: readonly JointKind[], item: number): number {
  const id = str(v, c.path, ptr)
  let flat: number | undefined = c.levelJoints.get(id)
  const slash = id.indexOf('/')
  if (flat === undefined && slash >= 0) {
    const k = c.itemIndex.get(id.slice(0, slash))
    const j = k === undefined ? -1 : c.items[k].joints.findIndex(x => x.id === id.slice(slash + 1))
    if (k !== undefined && j >= 0) flat = c.itemJointStart[k] + j
  } else if (flat === undefined && item >= 0) {
    const j = c.items[item].joints.findIndex(x => x.id === id)
    if (j >= 0) flat = c.itemJointStart[item] + j
  }
  if (flat === undefined) courseFail(c.path, ptr, `unknown joint '${id}'; use a mechanisms joint id or '<obstacle id>/<joint id>'`)
  const kind = c.jointKinds[flat]
  if (!want.includes(kind)) courseFail(c.path, ptr, `joint '${id}' is a ${kind} joint; use a ${want.join(' or ')} joint`)
  return flat
}

function signalRef(v: unknown, signals: Map<string, number>, path: string, ptr: string): number {
  const id = str(v, path, ptr)
  const i = signals.get(id)
  if (i === undefined) courseFail(path, ptr, `unknown signal '${id}'; use a switch, lever or logic id`)
  return i
}

function uniqueIds(list: readonly unknown[], path: string, ptr: string, ids: Set<string>): string[] {
  return list.map((v, i) => idOf(obj(v, path, `${ptr}/${i}`).id, path, `${ptr}/${i}/id`, ids))
}

function levelJointOf(v: unknown, c: Ctx, ptr: string, ids: Set<string>): { json: AssetJointJson; a: BodyRef; b: BodyRef } {
  const j = obj(v, c.path, ptr)
  keys(j, JOINT_REQUIRED, JOINT_OPTIONAL, c.path, ptr)
  const id = idOf(j.id, c.path, `${ptr}/id`, ids)
  const kind = oneOf(j.kind, JOINT_KINDS, c.path, `${ptr}/kind`)
  const a = refOf(j.a, c, `${ptr}/a`, true)
  const b = refOf(j.b, c, `${ptr}/b`, true)
  if (a.item === b.item && a.body === b.body) courseFail(c.path, `${ptr}/b`, `joint '${id}' joins a body to itself; use two different bodies (at most one world)`)
  return { json: { id, kind, a: '', b: '', ...jointFields(j, kind, c.path, ptr) }, a, b }
}

function switchOf(v: unknown, c: Ctx, ptr: string): SwitchSpec {
  const o = obj(v, c.path, ptr)
  const mode = oneOf(o.mode, ['weight', 'travel'] as const, c.path, `${ptr}/mode`)
  const plate = () => refOf(o.plate, c, `${ptr}/plate`, false)
  if (mode === 'weight') {
    keys(o, ['id', 'plate', 'mode', 'onKg', 'offKg'], [], c.path, ptr)
    const onKg = num(o.onKg, c.path, `${ptr}/onKg`)
    const offKg = num(o.offKg, c.path, `${ptr}/offKg`)
    if (!(onKg > offKg)) courseFail(c.path, `${ptr}/onKg`, `onKg ${onKg} must be > offKg ${offKg}; raise onKg above offKg`)
    return { id: o.id as string, plate: plate(), mode, onKg, offKg, joint: -1, onM: 0, offM: 0 }
  }
  keys(o, ['id', 'plate', 'mode', 'joint', 'onM', 'offM'], [], c.path, ptr)
  const p = plate()
  const joint = jointRef(o.joint, c, `${ptr}/joint`, ['slider'], p.item)
  const onM = num(o.onM, c.path, `${ptr}/onM`)
  const offM = num(o.offM, c.path, `${ptr}/offM`)
  if (!(onM > offM)) courseFail(c.path, `${ptr}/onM`, `onM ${onM} must be > offM ${offM}; raise onM above offM`)
  return { id: o.id as string, plate: p, mode, onKg: 0, offKg: 0, joint, onM, offM }
}

function leverOf(v: unknown, c: Ctx, ptr: string): LeverSpec {
  const o = obj(v, c.path, ptr)
  keys(o, ['id', 'handle', 'joint', 'onDeg', 'offDeg', 'grabRangeM'], [], c.path, ptr)
  const handle = refOf(o.handle, c, `${ptr}/handle`, false)
  const joint = jointRef(o.joint, c, `${ptr}/joint`, ['hinge'], handle.item)
  const onDeg = num(o.onDeg, c.path, `${ptr}/onDeg`)
  const offDeg = num(o.offDeg, c.path, `${ptr}/offDeg`)
  if (!(onDeg > offDeg)) courseFail(c.path, `${ptr}/onDeg`, `onDeg ${onDeg} must be > offDeg ${offDeg}; raise onDeg above offDeg`)
  return {
    id: o.id as string, handle, joint, onAngle: degToRad(onDeg), offAngle: degToRad(offDeg),
    grabRange: positive(o.grabRangeM, c.path, `${ptr}/grabRangeM`),
  }
}

function logicOf(v: unknown, signals: Map<string, number>, path: string, ptr: string): LogicSpec {
  const o = obj(v, path, ptr)
  keys(o, ['id', 'op', 'inputs'], ['seconds', 'count'], path, ptr)
  const op = oneOf(o.op, LOGIC_OPS, path, `${ptr}/op`)
  const inputs = arr(o.inputs, path, `${ptr}/inputs`).map((x, i) => signalRef(x, signals, path, `${ptr}/inputs/${i}`))
  if (op === 'not' && inputs.length !== 1) courseFail(path, `${ptr}/inputs`, `a not node takes exactly 1 input, not ${inputs.length}; list one signal`)
  if ((op === 'and' || op === 'or') && inputs.length === 0) courseFail(path, `${ptr}/inputs`, `an ${op} node needs at least 1 input; list its signals`)
  const timed = op === 'timer' || op === 'delay'
  optNum(o.seconds, 0, path, `${ptr}/seconds`)
  const ticks = timed ? ticksOf(o.seconds, 1, path, `${ptr}/seconds`) : 0
  let n = 0
  if (op === 'counter') {
    n = count(o.count, path, `${ptr}/count`)
    if (n < 1) courseFail(path, `${ptr}/count`, 'a counter needs count >= 1; set the number of pulses')
  } else if (o.count !== undefined) {
    count(o.count, path, `${ptr}/count`)
  }
  return { id: o.id as string, op, inputs, ticks, count: n }
}

// rDeg is Euler degrees applied in X, then Y, then Z order: r = qZ * qY * qX (quatMul applies its right side first).
function eulerQuat(d: readonly number[]): Quat {
  const qx = quatAxisAngle(v3(1, 0, 0), degToRad(d[0]), quatIdentity())
  const qy = quatAxisAngle(v3(0, 1, 0), degToRad(d[1]), quatIdentity())
  const qz = quatAxisAngle(v3(0, 0, 1), degToRad(d[2]), quatIdentity())
  return quatMul(qz, quatMul(qy, qx, quatIdentity()), quatIdentity())
}

function animationOf(v: unknown, c: Ctx, ptr: string): AnimationSpec {
  const o = obj(v, c.path, ptr)
  keys(o, ['id', 'target', 'keys', 'easing', 'loop', 'autostart'], [], c.path, ptr)
  const target = refOf(o.target, c, `${ptr}/target`, false)
  const body = c.items[target.item].bodies[target.body]
  if (body.type !== 'kinematic') {
    courseFail(c.path, `${ptr}/target`, `body '${body.id}' is ${body.type}; animations drive kinematic bodies only, make the body kinematic or target another`)
  }
  const keysIn = arr(o.keys, c.path, `${ptr}/keys`)
  if (keysIn.length === 0 || keysIn.length > MECH_CAPS.maxKeys) {
    courseFail(c.path, `${ptr}/keys`, `${keysIn.length} keys, expected 1..${MECH_CAPS.maxKeys}; adjust the key count`)
  }
  let last = -1
  const frames: KeyframeSpec[] = keysIn.map((k, i) => {
    const kp = `${ptr}/keys/${i}`
    const kj = obj(k, c.path, kp)
    keys(kj, ['atS', 't', 'rDeg'], [], c.path, kp)
    const tick = ticksOf(kj.atS, 0, c.path, `${kp}/atS`)
    if (tick <= last) courseFail(c.path, `${kp}/atS`, `tick ${tick} does not follow tick ${last}; keys need strictly increasing atS (1/60 s apart)`)
    last = tick
    return { tick, t: toVec(vec3(kj.t, c.path, `${kp}/t`)), r: eulerQuat(vec3(kj.rDeg, c.path, `${kp}/rDeg`)) }
  })
  return {
    id: o.id as string, target, keys: frames,
    easing: oneOf(o.easing, ['linear', 'smooth'] as const, c.path, `${ptr}/easing`),
    loop: oneOf(o.loop, ['loop', 'pingpong', 'once'] as const, c.path, `${ptr}/loop`),
    autostart: bool(o.autostart, c.path, `${ptr}/autostart`),
  }
}

function linkMotor(v: unknown, kind: JointKind, path: string, ptr: string): MotorSpec {
  if (v === null || v === undefined) courseFail(path, ptr, 'a motor link needs a motor; write the S12 motor object')
  return motorSpec(motorOf(v, kind, path, ptr)) as MotorSpec
}

function linkOf(v: unknown, c: Ctx, signals: Map<string, number>, anims: Map<string, number>, ptr: string): LinkSpec {
  const o = obj(v, c.path, ptr)
  keys(o, ['id', 'from', 'to'], [], c.path, ptr)
  const from = signalRef(o.from, signals, c.path, `${ptr}/from`)
  const tp = `${ptr}/to`
  const t = obj(o.to, c.path, tp)
  const kind = oneOf(t.kind, ['motor', 'door', 'spring', 'animation'] as const, c.path, `${tp}/kind`)
  let to: LinkTarget
  if (kind === 'motor') {
    keys(t, ['kind', 'joint', 'on', 'off'], [], c.path, tp)
    const joint = jointRef(t.joint, c, `${tp}/joint`, ['hinge', 'slider'], -1)
    const jk = c.jointKinds[joint]
    to = { kind, joint, on: linkMotor(t.on, jk, c.path, `${tp}/on`), off: linkMotor(t.off, jk, c.path, `${tp}/off`) }
  } else if (kind === 'door') {
    keys(t, ['kind', 'joint', 'openDeg', 'closedDeg'], [], c.path, tp)
    to = {
      kind, joint: jointRef(t.joint, c, `${tp}/joint`, ['hinge'], -1),
      openAngle: degToRad(num(t.openDeg, c.path, `${tp}/openDeg`)),
      closedAngle: degToRad(num(t.closedDeg, c.path, `${tp}/closedDeg`)),
    }
  } else if (kind === 'spring') {
    keys(t, ['kind', 'joint', 'stiffnessOn', 'stiffnessOff'], [], c.path, tp)
    const nonNeg = (f: 'stiffnessOn' | 'stiffnessOff'): number => {
      const x = num(t[f], c.path, `${tp}/${f}`)
      if (x < 0) courseFail(c.path, `${tp}/${f}`, `${f} ${x} must be >= 0; use a non-negative stiffness`)
      return x
    }
    to = { kind, joint: jointRef(t.joint, c, `${tp}/joint`, ['spring'], -1), stiffnessOn: nonNeg('stiffnessOn'), stiffnessOff: nonNeg('stiffnessOff') }
  } else {
    keys(t, ['kind', 'animation', 'on', 'off'], [], c.path, tp)
    const id = str(t.animation, c.path, `${tp}/animation`)
    const animation = anims.get(id)
    if (animation === undefined) courseFail(c.path, `${tp}/animation`, `unknown animation '${id}'; use an id from mechanisms.animations`)
    to = {
      kind, animation,
      on: oneOf(t.on, ['play', 'reverse'] as const, c.path, `${tp}/on`),
      off: oneOf(t.off, ['pause', 'reverse', 'stop'] as const, c.path, `${tp}/off`),
    }
  }
  return { id: o.id as string, from, to }
}

// Refuses a logic cycle with no toggle or delay node: those latch or postpone their output, so only cycles
// through the other ops are instantaneous. DFS over the logic inputs restricted to the other nodes.
function checkLogicCycles(logic: readonly LogicSpec[], base: number, inputAt: Map<string, number>, path: string): void {
  const breaks = (l: LogicSpec): boolean => l.op === 'toggle' || l.op === 'delay'
  const state = new Uint8Array(logic.length) // 0 new, 1 on the stack, 2 done
  const stack: number[] = []
  const visit = (i: number): void => {
    state[i] = 1
    stack.push(i)
    for (const s of logic[i].inputs) {
      const j = s - base
      if (j < 0 || breaks(logic[j])) continue
      if (state[j] === 1) {
        const cycle = stack.slice(stack.indexOf(j)).map(k => logic[k].id)
        courseFail(path, `/mechanisms/logic/${inputAt.get(logic[i].id)}/inputs`,
          `logic cycle ${[...cycle, logic[j].id].join(' -> ')} has no toggle or delay; break it with a toggle or delay node`)
      }
      if (state[j] === 0) visit(j)
    }
    stack.pop()
    state[i] = 2
  }
  for (let i = 0; i < logic.length; i++) if (state[i] === 0 && !breaks(logic[i])) visit(i)
}

function budgetOf(v: unknown, path: string): MechanismBudget {
  if (v === undefined || v === null) return { ...DEFAULT_BUDGET }
  const o = obj(v, path, '/mechanisms/budget')
  keys(o, ['dynamicBodies', 'joints'], [], path, '/mechanisms/budget')
  return { dynamicBodies: count(o.dynamicBodies, path, '/mechanisms/budget/dynamicBodies'), joints: count(o.joints, path, '/mechanisms/budget/joints') }
}

function checkLimits(m: MechanismSpec, path: string): void {
  if (m.items.length > MECH_CAPS.maxItems) courseFail(path, '/mechanisms', `${m.items.length} mechanism items, over ${MECH_CAPS.maxItems}; use fewer physics obstacles`)
  const used = countBudget(m)
  if (used.joints > MECH_CAPS.maxJoints) courseFail(path, '/mechanisms/joints', `${used.joints} joints, over ${MECH_CAPS.maxJoints}; remove joints`)
  if (m.signals.length > MECH_CAPS.maxSignals) courseFail(path, '/mechanisms', `${m.signals.length} signals, over ${MECH_CAPS.maxSignals}; remove switches, levers or logic`)
  if (used.dynamicBodies > m.budget.dynamicBodies) {
    courseFail(path, '/mechanisms/budget', `${used.dynamicBodies} dynamic bodies, over the budget of ${m.budget.dynamicBodies}; make bodies fixed or kinematic, or raise budget.dynamicBodies`)
  }
  if (used.joints > m.budget.joints) {
    courseFail(path, '/mechanisms/budget', `${used.joints} joints, over the budget of ${m.budget.joints}; remove joints or raise budget.joints`)
  }
}

const MECH_KEYS = ['joints', 'switches', 'levers', 'logic', 'animations', 'links', 'budget']

// `items` are the placed mechanism items in course order (itemOf, with item joint refs rewritten by the caller).
// Joint references become flat joint indices: every item's joints in item order, then level joints sorted by id.
export function parseCourseMechanisms(json: unknown, items: readonly MechItem[], path: string): MechanismSpec {
  return asCourse(() => {
    if (json === undefined || json === null) {
      const m = { ...emptyMechanisms(), items: [...items] }
      checkLimits(m, path)
      return m
    }
    const o = obj(json, path, '/mechanisms')
    keys(o, [], MECH_KEYS, path, '/mechanisms')
    if (items.length > MECH_CAPS.maxItems) courseFail(path, '/mechanisms', `${items.length} mechanism items, over ${MECH_CAPS.maxItems}; use fewer physics obstacles`)
    const itemJointStart: number[] = []
    let itemJoints = 0
    for (const it of items) { itemJointStart.push(itemJoints); itemJoints += it.joints.length }
    const c: Ctx = {
      path, items, itemIndex: new Map(items.map((it, i) => [it.id, i] as const)), itemJointStart,
      levelJoints: new Map(), jointKinds: items.flatMap(it => it.joints.map(j => j.kind)),
    }

    const jointsIn = optArr(o.joints, path, '/mechanisms/joints')
    if (itemJoints + jointsIn.length > MECH_CAPS.maxJoints) {
      courseFail(path, '/mechanisms/joints', `${itemJoints + jointsIn.length} joints, over ${MECH_CAPS.maxJoints}; remove joints`)
    }
    const jointIds = new Set<string>()
    const level = jointsIn.map((v, i) => levelJointOf(v, c, `/mechanisms/joints/${i}`, jointIds))
      .sort((x, y) => byId(x.json, y.json))
    level.forEach((l, i) => { c.levelJoints.set(l.json.id, itemJoints + i); c.jointKinds.push(l.json.kind) })
    const restOf = (r: BodyRef): Pose | null => r.item < 0 ? null : items[r.item].bodies[r.body].rest
    const joints = level.map(l => jointSpec(l.json, l.a, l.b, toVec(l.json.anchorA), toVec(l.json.anchorB), restOf(l.a), restOf(l.b)))

    const switchesIn = optArr(o.switches, path, '/mechanisms/switches')
    const leversIn = optArr(o.levers, path, '/mechanisms/levers')
    const logicIn = optArr(o.logic, path, '/mechanisms/logic')
    const signalIds = new Set<string>()
    const groups = [
      uniqueIds(switchesIn, path, '/mechanisms/switches', signalIds),
      uniqueIds(leversIn, path, '/mechanisms/levers', signalIds),
      uniqueIds(logicIn, path, '/mechanisms/logic', signalIds),
    ]
    const signalNames = groups.flatMap(g => [...g].sort())
    if (signalNames.length > MECH_CAPS.maxSignals) courseFail(path, '/mechanisms', `${signalNames.length} signals, over ${MECH_CAPS.maxSignals}; remove switches, levers or logic`)
    const signals = new Map(signalNames.map((id, i) => [id, i] as const))

    const switches = sortedOrder(switchesIn.map((v, i) => switchOf(v, c, `/mechanisms/switches/${i}`))).sorted
    const levers = sortedOrder(leversIn.map((v, i) => leverOf(v, c, `/mechanisms/levers/${i}`))).sorted
    const logic = sortedOrder(logicIn.map((v, i) => logicOf(v, signals, path, `/mechanisms/logic/${i}`))).sorted
    checkLogicCycles(logic, groups[0].length + groups[1].length, new Map(groups[2].map((id, i) => [id, i] as const)), path)

    const animsIn = optArr(o.animations, path, '/mechanisms/animations')
    uniqueIds(animsIn, path, '/mechanisms/animations', new Set())
    const anims = sortedOrder(animsIn.map((v, i) => animationOf(v, c, `/mechanisms/animations/${i}`)))
    const linksIn = optArr(o.links, path, '/mechanisms/links')
    uniqueIds(linksIn, path, '/mechanisms/links', new Set())
    const links = sortedOrder(linksIn.map((v, i) => linkOf(v, c, signals, anims.index, `/mechanisms/links/${i}`))).sorted

    const m: MechanismSpec = {
      items: [...items], joints, switches, levers, logic, links, animations: anims.sorted,
      signals: signalNames, budget: budgetOf(o.budget, path),
    }
    checkLimits(m, path)
    return m
  })
}

const SOUND_REQUIRED = ['id', 'patch', 'item', 't', 'event', 'signal']
const SOUND_OPTIONAL = ['gain', 'refM', 'maxM', 'loop']

// `m` is the parsed course mechanisms; `obstacleIds` are every obstacle id of the course.
export function parseCourseSounds(json: unknown, m: MechanismSpec, obstacleIds: readonly string[], path: string): SoundSpec[] {
  return asCourse(() => {
    if (json === undefined || json === null) return []
    const list = arr(json, path, '/sounds')
    if (list.length > MECH_CAPS.maxSounds) courseFail(path, '/sounds', `${list.length} sounds, over ${MECH_CAPS.maxSounds}; remove sounds`)
    const ids = new Set<string>()
    return list.map((v, i): SoundSpec => {
      const ptr = `/sounds/${i}`
      const o = obj(v, path, ptr)
      keys(o, SOUND_REQUIRED, SOUND_OPTIONAL, path, ptr)
      const id = idOf(o.id, path, `${ptr}/id`, ids)
      const patch = str(o.patch, path, `${ptr}/patch`)
      if (patch.length === 0) courseFail(path, `${ptr}/patch`, 'empty patch id; name a haa patch')
      let item = -1
      if (o.item !== null) {
        const name = str(o.item, path, `${ptr}/item`)
        item = m.items.findIndex(it => it.id === name)
        if (item < 0 && obstacleIds.includes(name)) {
          courseFail(path, `${ptr}/item`, `obstacle '${name}' is not a mechanism item; use item null and a world t`)
        }
        if (item < 0) courseFail(path, `${ptr}/item`, `unknown obstacle '${name}'; use a mechanism item id or null`)
      }
      const event = o.event === null ? null : oneOf(o.event, EVENT_KINDS, path, `${ptr}/event`)
      let signal = -1
      if (o.signal !== null) {
        const name = str(o.signal, path, `${ptr}/signal`)
        signal = m.signals.indexOf(name)
        if (signal < 0) courseFail(path, `${ptr}/signal`, `unknown signal '${name}'; use a switch, lever or logic id or null`)
      }
      const gain = optNum(o.gain, 1, path, `${ptr}/gain`)
      if (gain < 0) courseFail(path, `${ptr}/gain`, `gain ${gain} must be >= 0; use a non-negative gain`)
      const ref = o.refM === undefined ? 2 : positive(o.refM, path, `${ptr}/refM`)
      const max = optNum(o.maxM, 60, path, `${ptr}/maxM`)
      if (!(max > ref)) courseFail(path, `${ptr}/maxM`, `maxM ${max} must be > refM ${ref}; raise maxM above refM`)
      const loop = o.loop === undefined ? false : bool(o.loop, path, `${ptr}/loop`)
      return { id, patch, item, t: toVec(vec3(o.t, path, `${ptr}/t`)), event, signal, gain, ref, max, loop }
    })
  })
}
