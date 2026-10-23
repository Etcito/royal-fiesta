// Course v1 (S13): the v0 course plus world, decor, environment and podium, with S12 asset ids.
// The sim course is built by the v0 loader on a v0-shaped copy with explicit colliders (the course
// override or the asset's raw collision), so every conversion stays identical (rule 1.5).
import { fnv1a32 } from '@gamesaloon/rollback'
import type { MotionKind, ResolvedCourse } from '@royal-fiesta/sim/course'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import type { AssetResolver, ResolvedAsset } from './assets.ts'
import type { PodiumLayout } from './content.ts'
import { canonicalJson, loadCourse } from './course.ts'
import { ASSET_ID_RE } from './gameAsset.ts'
import type { GameAsset, GameAssetSource, World } from './gameAsset.ts'
import type { PrimsAsset } from './prims.ts'
import type { QuatT, Vec3T } from './render/port.ts'

export type CourseKindV1 = 'race' | 'survival' | 'hub' | 'podium' | 'gallery'
export interface DecorItem { id: string; asset: string; t: Vec3T; r: QuatT; s: Vec3T }
export interface PodiumSpec {
  spots: { t: Vec3T; yawDeg: number }[]
  camera: { eye: Vec3T; target: Vec3T; fovYDeg: number }
}

// A loaded v1 course. `json` is the validated v1 form (migrated when the file was v0).
export interface CourseV1 {
  id: string
  name: string
  kind: CourseKindV1
  world: World
  decor: DecorItem[]
  environment: Readonly<Record<string, unknown>> | null
  podium: PodiumSpec | null
  sim: ResolvedCourse | null // null for kind podium (view only)
  assetIds: string[] // sorted, unique over obstacles + decor
  contentHash: number // S13 hash; equals sim.contentHash when sim exists
  json: Record<string, unknown>
}

// The parsed asset plus the file it came from: the raw `collision` JSON feeds the sim and the hash.
export interface ResolvedGameAsset { asset: GameAsset; source: GameAssetSource }
export interface GameAssetResolver { resolve(id: string): Promise<ResolvedGameAsset> }

export type MotionFieldType = 'number' | 'vec3' | { enum: readonly string[] }
// The S2 parameter keys per motion kind (without 'kind'), as game/course reads them.
export const MOTION_FIELDS: Readonly<Record<MotionKind, Readonly<Record<string, MotionFieldType>>>> = {
  static: {},
  spinner: { axis: 'vec3', speedDegS: 'number', phaseDeg: 'number' },
  pendulum: { pivot: 'vec3', axis: 'vec3', ampDeg: 'number', periodS: 'number', phaseDeg: 'number' },
  seesaw: { axis: 'vec3', maxDeg: 'number', spring: 'number', damping: 'number', inertia: 'number' },
  rotatingDoor: { axis: 'vec3', stepDeg: 'number', periodS: 'number', moveS: 'number', phaseS: 'number' },
  conveyor: { velocity: 'vec3' },
  bouncePad: { speed: 'number' },
  movingPlatform: { offset: 'vec3', periodS: 'number', phaseDeg: 'number', wave: { enum: ['sine', 'pingpong'] } },
}

const V0_NAMES = [
  'floor-tile', 'floor-disc', 'wall-block', 'spinner-bar', 'pendulum-hammer', 'seesaw-plank', 'rotating-door',
  'conveyor-belt', 'bounce-pad', 'moving-platform', 'finish-arch', 'checkpoint-gate', 'queue-pad', 'plaza-fountain',
] as const
export const V0_ASSET_MAP: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(V0_NAMES.map(n => [n, `candy.${n}`])),
  bean: 'penguin.body',
})

const KINDS: readonly CourseKindV1[] = ['race', 'survival', 'hub', 'podium', 'gallery']
const WORLDS: readonly World[] = ['candy', 'ice', 'jungle', 'neon', 'common']
const S2_KEYS = ['format', 'version', 'id', 'name', 'kind', 'profiles', 'timeLimitS', 'killPlaneY', 'spawns', 'checkpoints', 'finish', 'path', 'regions', 'queuePad', 'obstacles']
const S13_KEYS = [...S2_KEYS, 'world', 'decor', 'environment', 'podium']
const ENV_KEYS = ['sky', 'sun', 'fog', 'post']

type Obj = Record<string, unknown>

function fail(path: string, ptr: string, reason: string): never {
  return refuse('course', `${path}${ptr}`, reason)
}

function escapePointer(s: string): string { return s.replace(/~/g, '~0').replace(/\//g, '~1') }

function obj(v: unknown, path: string, ptr: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, ptr, 'must be an object; provide an object')
  return v as Obj
}

function keys(v: Obj, allowed: readonly string[], path: string, ptr: string): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) fail(path, `${ptr}/${escapePointer(k)}`, `unknown key '${k}'; remove it or use a supported field`)
  }
}

function required(v: Obj, names: readonly string[], path: string, ptr: string): void {
  for (const k of names) {
    if (!Object.hasOwn(v, k)) fail(path, `${ptr}/${escapePointer(k)}`, `missing key '${k}'; add it`)
  }
}

function str(v: unknown, path: string, ptr: string): string {
  if (typeof v !== 'string') fail(path, ptr, 'must be a string; provide text')
  return v
}

function finiteNum(v: unknown, path: string, ptr: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, ptr, 'must be a finite number; use a finite JSON number')
  return v
}

function arr(v: unknown, path: string, ptr: string): unknown[] {
  if (!Array.isArray(v)) fail(path, ptr, 'must be an array; provide an array')
  return v
}

function tuple(v: unknown, n: number, path: string, ptr: string): number[] {
  if (!Array.isArray(v) || v.length !== n) fail(path, ptr, `must be an array of ${n} finite numbers; provide ${n} components`)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(finiteNum(v[i], path, `${ptr}/${i}`))
  return out
}

function vec3(v: unknown, path: string, ptr: string): Vec3T {
  const a = tuple(v, 3, path, ptr)
  return [a[0], a[1], a[2]]
}

function quat(v: unknown, path: string, ptr: string): QuatT {
  const a = tuple(v, 4, path, ptr)
  const norm = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3])
  if (Math.abs(norm - 1) > 1e-6) fail(path, ptr, 'quaternion norm must be within 1e-6 of 1; provide a unit quaternion')
  return [a[0], a[1], a[2], a[3]]
}

function assetId(v: unknown, path: string, ptr: string): string {
  const id = str(v, path, ptr)
  if (!ASSET_ID_RE.test(id)) fail(path, ptr, `asset '${id}' does not match ${ASSET_ID_RE.source}; use an S12 asset id such as candy.spinner-bar`)
  return id
}

// v0 -> v1 (S13), pure: a fresh object, every other key kept unchanged.
export function migrateCourseV0(json: unknown, path: string): Record<string, unknown> {
  const root = obj(json, path, '#')
  if (root.format !== 'royal-fiesta.course') fail(path, '#/format', "format must be 'royal-fiesta.course'; use a course file")
  if (root.version !== 0) fail(path, '#/version', 'version must be 0 to migrate; pass a course v0 file')
  if (root.assetsManifest !== null) fail(path, '#/assetsManifest', 'a store manifest cannot be migrated; set assetsManifest to null and use fixture asset names')
  const obstacles = arr(root.obstacles, path, '#/obstacles').map((v, i) => {
    const o = obj(v, path, `#/obstacles/${i}`)
    const name = str(o.asset, path, `#/obstacles/${i}/asset`)
    if (!Object.hasOwn(V0_ASSET_MAP, name)) fail(path, `#/obstacles/${i}/asset`, `v0 asset '${name}' has no v1 id; use one of ${Object.keys(V0_ASSET_MAP).join(', ')}`)
    return { ...structuredClone(o), asset: V0_ASSET_MAP[name] }
  })
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(root)) {
    if (k === 'assetsManifest') continue
    if (k === 'version') {
      out.version = 1
      out.world = 'candy'
    } else out[k] = k === 'obstacles' ? obstacles : structuredClone(root[k])
  }
  out.world = 'candy'
  out.decor = []
  out.environment = null
  out.podium = null
  return out
}

function decorItem(v: unknown, path: string, ptr: string): DecorItem {
  const o = obj(v, path, ptr)
  keys(o, ['id', 'asset', 't', 'r', 's'], path, ptr)
  required(o, ['id', 'asset', 't', 'r', 's'], path, ptr)
  const s = vec3(o.s, path, `${ptr}/s`)
  if (s[0] <= 0 || s[1] <= 0 || s[2] <= 0) fail(path, `${ptr}/s`, 'scale components must be > 0; use positive values')
  return { id: str(o.id, path, `${ptr}/id`), asset: assetId(o.asset, path, `${ptr}/asset`), t: vec3(o.t, path, `${ptr}/t`), r: quat(o.r, path, `${ptr}/r`), s }
}

// Names or override objects, passed to RAA unchanged: only the key set and the sun shape are the game's.
function environment(v: unknown, path: string): Readonly<Record<string, unknown>> | null {
  if (v === null) return null
  const o = obj(v, path, '#/environment')
  keys(o, ENV_KEYS, path, '#/environment')
  for (const k of ['sky', 'fog', 'post']) {
    const e = o[k]
    if (e !== undefined && typeof e !== 'string' && (typeof e !== 'object' || e === null || Array.isArray(e))) {
      fail(path, `#/environment/${k}`, 'must be a name or an override object; use a string or an object')
    }
  }
  if (o.sun !== undefined) {
    const sun = obj(o.sun, path, '#/environment/sun')
    keys(sun, ['dir', 'color', 'intensity'], path, '#/environment/sun')
    required(sun, ['dir', 'color', 'intensity'], path, '#/environment/sun')
    vec3(sun.dir, path, '#/environment/sun/dir')
    vec3(sun.color, path, '#/environment/sun/color')
    finiteNum(sun.intensity, path, '#/environment/sun/intensity')
  }
  return o
}

function podiumSpec(v: unknown, path: string): PodiumSpec {
  const o = obj(v, path, '#/podium')
  keys(o, ['spots', 'camera'], path, '#/podium')
  required(o, ['spots', 'camera'], path, '#/podium')
  const raw = arr(o.spots, path, '#/podium/spots')
  if (raw.length !== 3) fail(path, '#/podium/spots', `has ${raw.length} spots; give exactly 3 (1st, 2nd, 3rd)`)
  const spots = raw.map((sv, i) => {
    const ptr = `#/podium/spots/${i}`
    const so = obj(sv, path, ptr)
    keys(so, ['t', 'yawDeg'], path, ptr)
    return { t: vec3(so.t, path, `${ptr}/t`), yawDeg: finiteNum(so.yawDeg, path, `${ptr}/yawDeg`) }
  })
  const c = obj(o.camera, path, '#/podium/camera')
  keys(c, ['eye', 'target', 'fovYDeg'], path, '#/podium/camera')
  const fovYDeg = finiteNum(c.fovYDeg, path, '#/podium/camera/fovYDeg')
  if (fovYDeg <= 0 || fovYDeg >= 180) fail(path, '#/podium/camera/fovYDeg', 'must be in (0, 180) degrees; use a vertical field of view such as 60')
  return { spots, camera: { eye: vec3(c.eye, path, '#/podium/camera/eye'), target: vec3(c.target, path, '#/podium/camera/target'), fovYDeg } }
}

// The v0 loader only ever sees explicit colliders, so it never asks this resolver for any.
const NO_PRIMS: PrimsAsset = {
  format: 'raa.prims', version: 0, id: 'explicit-colliders', name: 'explicit colliders', budget: { triangles: 1500, segments: 16 },
  nodes: [], materials: {}, anchors: {}, collision: { mode: 'override', colliders: [] },
}
const EXPLICIT_ONLY: AssetResolver = {
  resolve: (name: string): Promise<ResolvedAsset> => Promise.resolve({ name, asset: NO_PRIMS, hash: 0, origin: 'fixtures' }),
}

function le32(h: number): Uint8Array {
  const u = h >>> 0
  return new Uint8Array([u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255])
}

async function resolveAsset(assets: GameAssetResolver, id: string, path: string, ptr: string): Promise<ResolvedGameAsset> {
  try {
    return await assets.resolve(id)
  } catch (error) {
    if (isRefusal(error)) fail(path, ptr, `cannot resolve asset '${id}': ${error.message}`)
    throw error
  }
}

export async function loadCourseV1(json: unknown, path: string, assets: GameAssetResolver): Promise<CourseV1> {
  const input = obj(json, path, '#')
  const v1 = input.version === 0 ? migrateCourseV0(input, path) : input
  if (Object.hasOwn(v1, 'assetsManifest')) fail(path, '#/assetsManifest', "unknown key 'assetsManifest'; v1 courses have no assetsManifest")
  keys(v1, S13_KEYS, path, '#')
  required(v1, ['world', 'decor', 'environment', 'podium'], path, '#')
  if (v1.format !== 'royal-fiesta.course') fail(path, '#/format', "format must be 'royal-fiesta.course'; use a course file")
  if (v1.version !== 1) fail(path, '#/version', 'version must be 1; write a course v1 file (or a v0 file to migrate)')
  const world = str(v1.world, path, '#/world') as World
  if (!WORLDS.includes(world)) fail(path, '#/world', `unknown world '${world}'; use one of ${WORLDS.join('|')}`)
  const kind = str(v1.kind, path, '#/kind') as CourseKindV1
  if (!KINDS.includes(kind)) fail(path, '#/kind', `unknown kind '${kind}'; use one of ${KINDS.join('|')}`)
  const id = str(v1.id, path, '#/id')
  const name = str(v1.name, path, '#/name')

  const ids = new Set<string>()
  const obstacles = arr(v1.obstacles, path, '#/obstacles').map((v, i) => {
    const ptr = `#/obstacles/${i}`
    const o = obj(v, path, ptr)
    const oid = str(o.id, path, `${ptr}/id`)
    if (ids.has(oid)) fail(path, `${ptr}/id`, `duplicate id '${oid}'; use ids unique across obstacles and decor`)
    ids.add(oid)
    if (o.colliders !== null && !Array.isArray(o.colliders)) fail(path, `${ptr}/colliders`, 'must be null or an array; use null or collider objects')
    return { o, id: oid, asset: assetId(o.asset, path, `${ptr}/asset`) }
  })
  const decor = arr(v1.decor, path, '#/decor').map((v, i) => {
    const d = decorItem(v, path, `#/decor/${i}`)
    if (ids.has(d.id)) fail(path, `#/decor/${i}/id`, `duplicate id '${d.id}'; use ids unique across obstacles and decor`)
    ids.add(d.id)
    return d
  })
  const env = environment(v1.environment, path)

  let podium: PodiumSpec | null = null
  if (kind === 'podium') {
    if (v1.podium === null) fail(path, '#/podium', 'a podium course needs podium {spots, camera}; add it')
    podium = podiumSpec(v1.podium, path)
    if (v1.finish !== null) fail(path, '#/finish', 'a podium course has no finish; set finish to null')
    if (!Array.isArray(v1.checkpoints) || v1.checkpoints.length > 0) fail(path, '#/checkpoints', 'a podium course has no checkpoints; set checkpoints to []')
    if (!Array.isArray(v1.path) || v1.path.length > 0) fail(path, '#/path', 'a podium course has no path; set path to []')
    if (v1.queuePad !== null) fail(path, '#/queuePad', 'a podium course has no queue pad; set queuePad to null')
    obstacles.forEach(({ o }, i) => {
      const m = obj(o.motion, path, `#/obstacles/${i}/motion`)
      if (m.kind !== 'static') fail(path, `#/obstacles/${i}/motion/kind`, `motion '${String(m.kind)}' on a podium course; podium obstacles must be static`)
    })
  } else if (v1.podium !== null) {
    fail(path, '#/podium', `podium must be null for kind ${kind}; set podium to null`)
  }

  const resolved: ResolvedGameAsset[] = []
  const rawCollision: unknown[][] = []
  for (let i = 0; i < obstacles.length; i++) {
    const ptr = `#/obstacles/${i}/asset`
    const r = await resolveAsset(assets, obstacles[i].asset, path, ptr)
    const raw = (r.source.json as Obj | null)?.collision
    if (!Array.isArray(raw)) fail(path, ptr, `asset '${obstacles[i].asset}' has no collision array; fix ${r.source.path}`)
    if (r.asset.category === 'obstacle' && raw.length === 0 && obstacles[i].o.colliders === null) {
      fail(path, ptr, `obstacle asset '${obstacles[i].asset}' has an empty collision; add collision to ${r.source.path} or a colliders override here`)
    }
    resolved.push(r)
    rawCollision.push(raw)
  }
  for (let i = 0; i < decor.length; i++) await resolveAsset(assets, decor[i].asset, path, `#/decor/${i}/asset`)

  const enc = new TextEncoder()
  let hash = fnv1a32(enc.encode(canonicalJson(v1)))
  for (let i = 0; i < resolved.length; i++) {
    hash = fnv1a32(le32(fnv1a32(enc.encode(resolved[i].asset.hash + canonicalJson(rawCollision[i])))), hash)
  }
  const contentHash = hash >>> 0

  // v0-shaped copy: placeholder asset names, explicit colliders, so loadCourse does every conversion.
  const copy: Obj = {}
  for (const k of S2_KEYS) if (Object.hasOwn(v1, k)) copy[k] = structuredClone(v1[k])
  copy.version = 0
  copy.assetsManifest = null
  copy.obstacles = obstacles.map(({ o }, i) => ({ ...structuredClone(o), asset: `o${i}`, colliders: structuredClone(o.colliders ?? rawCollision[i]) }))
  let sim: ResolvedCourse | null = null
  if (kind === 'podium') {
    // Validated with the gallery rules (spawns padded to its minimum of 8); the podium is view only.
    const spawns = arr(copy.spawns, path, '#/spawns')
    while (spawns.length < 8) spawns.push({ t: [0, 0, 0], yawDeg: 0 })
    copy.kind = 'gallery'
    await loadCourse(copy, path, EXPLICIT_ONLY)
  } else {
    const c = await loadCourse(copy, path, EXPLICIT_ONLY)
    sim = { ...c, obstacles: c.obstacles.map((o, i) => ({ ...o, asset: obstacles[i].asset })), contentHash }
  }

  const assetIds = [...new Set([...obstacles.map(o => o.asset), ...decor.map(d => d.asset)])].sort()
  return { id, name, kind, world, decor, environment: env, podium, sim, assetIds, contentHash, json: v1 }
}

export function podiumLayoutOf(course: CourseV1): PodiumLayout {
  if (course.podium === null) refuse('content', `courses/${course.id}.course.json#/podium`, `course '${course.id}' has no podium; use a kind podium course`)
  const { spots, camera } = course.podium
  return {
    courseId: course.id,
    spots: spots.map(s => ({ t: s.t, yawDeg: s.yawDeg })),
    camera: { eye: camera.eye, target: camera.target, fovYDeg: camera.fovYDeg, near: 0.1, far: 500 },
  }
}
