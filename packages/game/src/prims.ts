// The game's copy of the raa.prims v0 subset (ARCHITECTURE S3). Pure data parsing: no Node module, no DOM at import.
import { MAX_COLLIDERS_PER_OBSTACLE } from '@royal-fiesta/sim/course'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { quatMul, quatRotate } from '@royal-fiesta/sim/vec'
import type { Quat, Vec3 } from '@royal-fiesta/sim/vec'
import { refuse } from '@royal-fiesta/sim/refusal'
import { fnv1a32 } from '@gamesaloon/rollback'

export type PrimKind = 'sphere' | 'box' | 'roundBox' | 'capsule' | 'cylinder' | 'cone' | 'torus' | 'ellipsoid'
export interface PrimTransform { t: [number, number, number]; r: [number, number, number, number]; s: [number, number, number] }
export interface PrimNode { id: string; kind: PrimKind; params: Record<string, number | number[]>; transform: PrimTransform; material: string | null; op: 'union' | 'subtract' | 'intersect'; children: PrimNode[] }
export interface PrimMaterial { color: [number, number, number]; roughness: number; metallic: number; emissive: number }
export interface PrimsAsset { format: 'raa.prims'; version: 0; id: string; name: string; nodes: PrimNode[]; materials: Record<string, PrimMaterial>; anchors: Record<string, PrimTransform>; collision: { colliders: unknown[] } | null; budget: number }

export const PRIM_CAPS: { maxNodes: 64; maxDepth: 8; defaultBudget: 1500 } = { maxNodes: 64, maxDepth: 8, defaultBudget: 1500 }

const PRIM_KINDS: readonly PrimKind[] = ['sphere', 'box', 'roundBox', 'capsule', 'cylinder', 'cone', 'torus', 'ellipsoid']
const OPS: readonly PrimNode['op'][] = ['union', 'subtract', 'intersect']
const NON_PRIMITIVE = ['trimesh', 'convexHull', 'heightfield', 'polyline']
const PRIMITIVE_ONLY = 'primitive colliders only: the kart study measured 1.25 MB / 12 ms per snapshot for a trimesh track; use cuboid/roundCuboid/ball/capsule/cylinder/cone'

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// RFC 6901 escaping, so keys with '/' or '~' still give a readable pointer.
function esc(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

function fail(ptr: string, reason: string): never {
  return refuse('prims', ptr, reason)
}

function finiteTuple(v: unknown, n: number, ptr: string, what: string): number[] {
  if (!Array.isArray(v) || v.length !== n) fail(ptr, `${what} must be an array of ${n} finite numbers; write [${new Array(n).fill('n').join(', ')}]`)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const x: unknown = v[i]
    if (!isFiniteNum(x)) fail(`${ptr}/${i}`, `${what} component is not a finite number; use a finite JSON number`)
    out.push(x)
  }
  return out
}

function parseTransform(v: unknown, ptr: string): PrimTransform {
  if (v === undefined) return { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }
  if (!isObj(v)) fail(ptr, 'transform must be an object {t, r, s}; remove it or give an object')
  const t = v.t === undefined ? [0, 0, 0] : finiteTuple(v.t, 3, `${ptr}/t`, 'transform.t')
  const r = v.r === undefined ? [0, 0, 0, 1] : finiteTuple(v.r, 4, `${ptr}/r`, 'transform.r')
  const s = v.s === undefined ? [1, 1, 1] : finiteTuple(v.s, 3, `${ptr}/s`, 'transform.s')
  return { t: [t[0], t[1], t[2]], r: [r[0], r[1], r[2], r[3]], s: [s[0], s[1], s[2]] }
}

function parseMaterial(v: unknown, ptr: string): PrimMaterial {
  if (!isObj(v)) fail(ptr, 'material must be an object {color, roughness, metallic, emissive}; fix the material entry')
  const c = finiteTuple(v.color, 3, `${ptr}/color`, 'material color')
  const num = (k: 'roughness' | 'metallic' | 'emissive'): number => {
    const x = v[k]
    if (!isFiniteNum(x)) fail(`${ptr}/${k}`, `material ${k} must be a finite number; give a JSON number`)
    return x
  }
  return { color: [c[0], c[1], c[2]], roughness: num('roughness'), metallic: num('metallic'), emissive: num('emissive') }
}

interface NodeWalk { count: number; materials: Record<string, PrimMaterial> }

function parseNode(v: unknown, ptr: string, depth: number, walk: NodeWalk): PrimNode {
  walk.count++
  if (walk.count > PRIM_CAPS.maxNodes) fail(ptr, `more than ${PRIM_CAPS.maxNodes} nodes in total (descendants included); merge or remove nodes`)
  if (depth > PRIM_CAPS.maxDepth) fail(ptr, `node depth ${depth} exceeds ${PRIM_CAPS.maxDepth}; flatten the hierarchy`)
  if (!isObj(v)) fail(ptr, 'node must be an object; fix the nodes entry')
  if (typeof v.id !== 'string') fail(`${ptr}/id`, 'node id must be a string; give the node a string id')
  const kind = v.kind
  if (typeof kind !== 'string' || !PRIM_KINDS.includes(kind as PrimKind)) {
    fail(`${ptr}/kind`, `unknown kind ${JSON.stringify(kind)}; use one of ${PRIM_KINDS.join('/')}`)
  }
  if (!isObj(v.params)) fail(`${ptr}/params`, 'params must be an object of finite numbers; add params')
  const params: Record<string, number | number[]> = {}
  const keys = Object.keys(v.params)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const p = v.params[k]
    const pp = `${ptr}/params/${esc(k)}`
    if (isFiniteNum(p)) params[k] = p
    else if (Array.isArray(p)) {
      const arr: number[] = []
      for (let j = 0; j < p.length; j++) {
        const x: unknown = p[j]
        if (!isFiniteNum(x)) fail(`${pp}/${j}`, 'param array element is not a finite number; use finite JSON numbers')
        arr.push(x)
      }
      params[k] = arr
    } else fail(pp, 'param must be a finite number or an array of finite numbers; fix the value')
  }
  const m = v.material
  if (m !== null && (typeof m !== 'string' || !Object.hasOwn(walk.materials, m))) {
    fail(`${ptr}/material`, `material ${JSON.stringify(m)} is neither null nor a key of materials; use null or add it to materials`)
  }
  const op = v.op === undefined ? 'union' : v.op
  if (typeof op !== 'string' || !OPS.includes(op as PrimNode['op'])) {
    fail(`${ptr}/op`, `op ${JSON.stringify(op)} is not union/subtract/intersect; use one of those`)
  }
  const transform = parseTransform(v.transform, `${ptr}/transform`)
  const children: PrimNode[] = []
  if (v.children !== undefined) {
    if (!Array.isArray(v.children)) fail(`${ptr}/children`, 'children must be an array; use [] or remove it')
    for (let i = 0; i < v.children.length; i++) {
      children.push(parseNode(v.children[i], `${ptr}/children/${i}`, depth + 1, walk))
    }
  }
  return { id: v.id, kind: kind as PrimKind, params, transform, material: m, op: op as PrimNode['op'], children }
}

export function parsePrims(json: unknown, path: string): PrimsAsset {
  const root = `${path}#`
  if (!isObj(json)) fail(`${root}/`, 'asset must be a JSON object; check the file content')
  if (json.format !== 'raa.prims') fail(`${root}/format`, `format ${JSON.stringify(json.format)} is not "raa.prims"; set "format": "raa.prims"`)
  if (json.version !== 0) fail(`${root}/version`, `version ${JSON.stringify(json.version)} is not 0; only raa.prims v0 is supported`)
  if (typeof json.id !== 'string') fail(`${root}/id`, 'id must be a string; give the asset a string id')
  if (typeof json.name !== 'string') fail(`${root}/name`, 'name must be a string; give the asset a string name')

  const materials: Record<string, PrimMaterial> = {}
  if (json.materials !== undefined) {
    if (!isObj(json.materials)) fail(`${root}/materials`, 'materials must be an object; use {} or remove it')
    const keys = Object.keys(json.materials)
    for (let i = 0; i < keys.length; i++) {
      materials[keys[i]] = parseMaterial(json.materials[keys[i]], `${root}/materials/${esc(keys[i])}`)
    }
  }

  const anchors: Record<string, PrimTransform> = {}
  if (json.anchors !== undefined) {
    if (!isObj(json.anchors)) fail(`${root}/anchors`, 'anchors must be an object; use {} or remove it')
    const keys = Object.keys(json.anchors)
    for (let i = 0; i < keys.length; i++) {
      const ap = `${root}/anchors/${esc(keys[i])}`
      const a = json.anchors[keys[i]]
      if (!isObj(a)) fail(ap, 'anchor must be a transform object {t, r, s}; fix the anchor')
      anchors[keys[i]] = parseTransform(a, ap)
    }
  }

  if (!Array.isArray(json.nodes)) fail(`${root}/nodes`, 'nodes array is missing; add "nodes": [...]')
  const walk: NodeWalk = { count: 0, materials }
  const nodes: PrimNode[] = []
  for (let i = 0; i < json.nodes.length; i++) nodes.push(parseNode(json.nodes[i], `${root}/nodes/${i}`, 1, walk))

  let collision: PrimsAsset['collision'] = null
  const col = json.collision
  if (col !== undefined && col !== null) {
    if (!isObj(col) || !Array.isArray(col.colliders)) {
      fail(`${root}/collision`, 'collision must be null or an object with a colliders array; write {"colliders": [...]} or null')
    }
    collision = { colliders: structuredClone(col.colliders) }
  }

  let budget: number = PRIM_CAPS.defaultBudget
  if (json.budget !== undefined) {
    const b = json.budget
    if (typeof b !== 'number' || !Number.isInteger(b) || b <= 0) fail(`${root}/budget`, 'budget must be a positive integer; remove it for the default 1500')
    budget = b
  }

  return { format: 'raa.prims', version: 0, id: json.id, name: json.name, nodes, materials, anchors, collision, budget }
}

const COLLIDER_FIELDS: Record<string, readonly string[]> = {
  cuboid: ['half'],
  roundCuboid: ['half', 'border'],
  ball: ['radius'],
  capsule: ['halfHeight', 'radius'],
  cylinder: ['halfHeight', 'radius'],
  cone: ['halfHeight', 'radius'],
}

function positive(v: unknown, ptr: string, what: string): number {
  if (!isFiniteNum(v) || v <= 0) fail(ptr, `${what} must be a finite number > 0; give a positive JSON number`)
  return v
}

// `path` is already a full file#pointer to the collider object.
export function parseColliderJson(j: unknown, path: string): ColliderSpec {
  if (!isObj(j)) fail(path, 'collider must be an object {shape, ...}; fix the collider entry')
  const shape = j.shape
  if (typeof shape === 'string' && NON_PRIMITIVE.includes(shape)) fail(`${path}/shape`, PRIMITIVE_ONLY)
  if (typeof shape !== 'string' || !Object.hasOwn(COLLIDER_FIELDS, shape)) {
    fail(`${path}/shape`, `unknown shape ${JSON.stringify(shape)}; use cuboid/roundCuboid/ball/capsule/cylinder/cone`)
  }
  const fields = COLLIDER_FIELDS[shape]
  const keys = Object.keys(j)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (k !== 'shape' && k !== 't' && k !== 'r' && !fields.includes(k)) {
      fail(`${path}/${esc(k)}`, `unknown field for ${shape}; allowed fields are shape, ${fields.join(', ')}, t, r`)
    }
  }
  const tv = j.t === undefined ? [0, 0, 0] : finiteTuple(j.t, 3, `${path}/t`, 'collider t')
  const rv = j.r === undefined ? [0, 0, 0, 1] : finiteTuple(j.r, 4, `${path}/r`, 'collider r')
  const norm = Math.sqrt(rv[0] * rv[0] + rv[1] * rv[1] + rv[2] * rv[2] + rv[3] * rv[3])
  if (Math.abs(norm - 1) > 1e-6) fail(`${path}/r`, `quaternion norm ${norm} is not 1 within 1e-6; normalise [x, y, z, w]`)
  const t: Vec3 = { x: tv[0], y: tv[1], z: tv[2] }
  const r: Quat = { x: rv[0], y: rv[1], z: rv[2], w: rv[3] }
  const half = (): Vec3 => {
    const h = finiteTuple(j.half, 3, `${path}/half`, 'half extents')
    for (let i = 0; i < 3; i++) positive(h[i], `${path}/half/${i}`, 'half extent')
    return { x: h[0], y: h[1], z: h[2] }
  }
  switch (shape) {
    case 'cuboid': return { shape, half: half(), t, r }
    case 'roundCuboid': return { shape, half: half(), border: positive(j.border, `${path}/border`, 'border'), t, r }
    case 'ball': return { shape, radius: positive(j.radius, `${path}/radius`, 'radius'), t, r }
    default: {
      const s = shape as 'capsule' | 'cylinder' | 'cone'
      const halfHeight = positive(j.halfHeight, `${path}/halfHeight`, 'halfHeight')
      return { shape: s, halfHeight, radius: positive(j.radius, `${path}/radius`, 'radius'), t, r }
    }
  }
}

interface Frame { t: Vec3; r: Quat; s: Vec3 }

const EPS = 1e-9

function isUniform(s: Vec3): boolean {
  return Math.abs(s.x - s.y) <= EPS && Math.abs(s.y - s.z) <= EPS && Math.abs(s.x - s.z) <= EPS
}

function compose(p: Frame, c: PrimTransform): Frame {
  const sc: Vec3 = { x: p.s.x * c.t[0], y: p.s.y * c.t[1], z: p.s.z * c.t[2] }
  const t = quatRotate(p.r, sc, { x: 0, y: 0, z: 0 })
  t.x += p.t.x
  t.y += p.t.y
  t.z += p.t.z
  const r = quatMul(p.r, { x: c.r[0], y: c.r[1], z: c.r[2], w: c.r[3] }, { x: 0, y: 0, z: 0, w: 1 })
  return { t, r, s: { x: p.s.x * c.s[0], y: p.s.y * c.s[1], z: p.s.z * c.s[2] } }
}

function numParam(n: PrimNode, key: string, ptr: string): number {
  const v = n.params[key]
  if (!isFiniteNum(v) || v <= 0) fail(`${ptr}/params/${key}`, `${n.kind} needs params.${key} as a finite number > 0; add it`)
  return v
}

function sizeParam(n: PrimNode, ptr: string): Vec3 {
  const v = n.params.size
  if (!Array.isArray(v) || v.length !== 3 || !v.every(x => x > 0)) {
    fail(`${ptr}/params/size`, `${n.kind} needs params.size as 3 finite numbers > 0; write "size": [x, y, z]`)
  }
  return { x: v[0], y: v[1], z: v[2] }
}

function deriveNode(n: PrimNode, f: Frame, ptr: string): ColliderSpec {
  const { t, r, s } = f
  if (!(s.x > 0 && s.y > 0 && s.z > 0)) fail(`${ptr}/transform/s`, 'composed scale must be > 0 on every axis; use positive scales')
  if (n.kind === 'torus' || n.kind === 'ellipsoid') fail(`${ptr}/kind`, `no Rapier primitive for ${n.kind}: add collision.colliders`)
  if (n.kind === 'box') {
    const size = sizeParam(n, ptr)
    return { shape: 'cuboid', half: { x: size.x / 2 * s.x, y: size.y / 2 * s.y, z: size.z / 2 * s.z }, t, r }
  }
  if (n.kind === 'roundBox') {
    const size = sizeParam(n, ptr)
    const radius = numParam(n, 'radius', ptr)
    const half = { x: size.x / 2 * s.x - radius, y: size.y / 2 * s.y - radius, z: size.z / 2 * s.z - radius }
    if (!(half.x > 0 && half.y > 0 && half.z > 0)) {
      fail(`${ptr}/params/radius`, 'roundBox radius leaves a half extent <= 0; make radius smaller than every scaled size/2')
    }
    return { shape: 'roundCuboid', half, border: radius, t, r }
  }
  if (!isUniform(s)) {
    fail(`${ptr}/transform/s`, `non-uniform composed scale on ${n.kind} has no exact collider; use a uniform scale or add collision.colliders`)
  }
  const k = s.x
  if (n.kind === 'sphere') return { shape: 'ball', radius: numParam(n, 'radius', ptr) * k, t, r }
  const radius = numParam(n, 'radius', ptr) * k
  const halfHeight = numParam(n, 'height', ptr) / 2 * k
  const shape = n.kind === 'capsule' ? 'capsule' : n.kind === 'cylinder' ? 'cylinder' : 'cone'
  return { shape, halfHeight, radius, t, r }
}

function deriveWalk(nodes: PrimNode[], parent: Frame, ptr: string, out: ColliderSpec[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    // subtract/intersect subtrees never collide (S3).
    if (n.op !== 'union') continue
    const np = `${ptr}/${i}`
    const f = compose(parent, n.transform)
    out.push(deriveNode(n, f, np))
    deriveWalk(n.children, f, `${np}/children`, out)
  }
}

// S3: explicit collision.colliders win; otherwise every union node maps to one Rapier primitive.
export function collidersOf(asset: PrimsAsset, path: string): ColliderSpec[] {
  let out: ColliderSpec[]
  if (asset.collision !== null) {
    out = asset.collision.colliders.map((c, i) => parseColliderJson(c, `${path}#/collision/colliders/${i}`))
  } else {
    out = []
    const root: Frame = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 }, s: { x: 1, y: 1, z: 1 } }
    deriveWalk(asset.nodes, root, `${path}#/nodes`, out)
  }
  if (out.length === 0) fail(`${path}#/collision`, 'asset has no collider; add collision.colliders')
  if (out.length > MAX_COLLIDERS_PER_OBSTACLE) {
    fail(`${path}#/collision`, `asset has ${out.length} colliders, more than ${MAX_COLLIDERS_PER_OBSTACLE}; merge nodes or add a shorter collision.colliders`)
  }
  return out
}

function isIdentity(q: Quat): boolean {
  return Math.abs(q.x) <= EPS && Math.abs(q.y) <= EPS && Math.abs(q.z) <= EPS && Math.abs(Math.abs(q.w) - 1) <= EPS
}

const NON_UNIFORM = 'non-uniform scale is allowed only for cuboid/roundCuboid colliders; use a uniform s or an explicit colliders override'

// S2 obstacle scale rules; returns new specs and never mutates `cs`.
export function scaleColliders(cs: ColliderSpec[], s: Vec3, path: string): ColliderSpec[] {
  if (!(isFiniteNum(s.x) && isFiniteNum(s.y) && isFiniteNum(s.z) && s.x > 0 && s.y > 0 && s.z > 0)) {
    fail(path, 'scale components must be finite and > 0; use positive numbers')
  }
  const r = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w })
  if (isUniform(s)) {
    const k = s.x
    return cs.map((c): ColliderSpec => {
      const t = { x: c.t.x * k, y: c.t.y * k, z: c.t.z * k }
      switch (c.shape) {
        case 'cuboid': return { shape: c.shape, half: { x: c.half.x * k, y: c.half.y * k, z: c.half.z * k }, t, r: r(c.r) }
        case 'roundCuboid': return { shape: c.shape, half: { x: c.half.x * k, y: c.half.y * k, z: c.half.z * k }, border: c.border * k, t, r: r(c.r) }
        case 'ball': return { shape: c.shape, radius: c.radius * k, t, r: r(c.r) }
        default: return { shape: c.shape, halfHeight: c.halfHeight * k, radius: c.radius * k, t, r: r(c.r) }
      }
    })
  }
  // A rotated box cannot be scaled per axis exactly, so only axis-aligned boxes qualify.
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]
    if ((c.shape !== 'cuboid' && c.shape !== 'roundCuboid') || !isIdentity(c.r)) fail(path, NON_UNIFORM)
  }
  const m = Math.min(s.x, s.y, s.z)
  return cs.map((c): ColliderSpec => {
    const t = { x: c.t.x * s.x, y: c.t.y * s.y, z: c.t.z * s.z }
    if (c.shape === 'cuboid') return { shape: c.shape, half: { x: c.half.x * s.x, y: c.half.y * s.y, z: c.half.z * s.z }, t, r: r(c.r) }
    if (c.shape === 'roundCuboid') return { shape: c.shape, half: { x: c.half.x * s.x, y: c.half.y * s.y, z: c.half.z * s.z }, border: c.border * m, t, r: r(c.r) }
    return fail(path, NON_UNIFORM)
  })
}

// fnv1a32 of the UTF-8 bytes of the file text; part of the course contentHash.
export function assetHash(text: string): number {
  return fnv1a32(new TextEncoder().encode(text)) >>> 0
}
