import { fnv1a32 } from '@gamesaloon/rollback'
import { legacyLevel, MAX_COLLIDERS_PER_OBSTACLE, MAX_OBSTACLES } from '@royal-fiesta/sim/course'
import type { Box, Checkpoint, ColliderSpec, CourseKind, Motion, ObstacleSpec, PathNode, ProfileName, Region, ResolvedCourse, SpawnPoint } from '@royal-fiesta/sim/course'
import { degToRad, v3, yawFacing } from '@royal-fiesta/sim/vec'
import type { Quat, Vec3 } from '@royal-fiesta/sim/vec'
import { refuse, RefusalError } from '@royal-fiesta/sim/refusal'
import type { AssetResolver } from './assets.ts'
import { collidersOf, parseColliderJson, scaleColliders } from './prims.ts'

type Obj = Record<string, unknown>
const KINDS: readonly CourseKind[] = ['race', 'survival', 'hub', 'gallery']
const PROFILES: readonly ProfileName[] = ['standard', 'sprint']
const ASSET_NAME = /^[a-z0-9-]{1,48}$/
const COURSE_ID = /^[a-z0-9-]{1,40}$/
const SHA256 = /^[0-9a-f]{64}$/

function fail(path: string, ptr: string, reason: string): never {
  return refuse('course', `${path}${ptr}`, reason)
}

function obj(v: unknown, path: string, ptr: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, ptr, 'must be an object; provide an object')
  return v as Obj
}

function keys(v: Obj, allowed: readonly string[], path: string, ptr: string): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) fail(path, `${ptr}/${escapePointer(k)}`, `unknown key '${k}'; remove it or use a supported field`)
  }
}

function escapePointer(s: string): string { return s.replace(/~/g, '~0').replace(/\//g, '~1') }

function str(v: unknown, path: string, ptr: string): string {
  if (typeof v !== 'string') fail(path, ptr, 'must be a string; provide text')
  return v
}

function finiteNum(v: unknown, path: string, ptr: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, ptr, 'must be a finite number; use a finite JSON number')
  return v
}

function posNum(v: unknown, path: string, ptr: string): number {
  const n = finiteNum(v, path, ptr)
  if (n <= 0) fail(path, ptr, 'must be > 0; use a positive number')
  return n
}

function int(v: unknown, path: string, ptr: string): number {
  const n = finiteNum(v, path, ptr)
  if (!Number.isInteger(n)) fail(path, ptr, 'must be an integer; use a whole number')
  return n
}

function bool(v: unknown, path: string, ptr: string): boolean {
  if (typeof v !== 'boolean') fail(path, ptr, 'must be a boolean; use true or false')
  return v
}

function tuple(v: unknown, n: number, path: string, ptr: string): number[] {
  if (!Array.isArray(v) || v.length !== n) fail(path, ptr, `must be an array of ${n} finite numbers; provide ${n} components`)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(finiteNum(v[i], path, `${ptr}/${i}`))
  return out
}

function vec3(v: unknown, path: string, ptr: string): Vec3 {
  const a = tuple(v, 3, path, ptr)
  return v3(a[0], a[1], a[2])
}

function quat(v: unknown, path: string, ptr: string): Quat {
  const a = tuple(v, 4, path, ptr)
  const norm = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3])
  if (Math.abs(norm - 1) > 1e-6) fail(path, ptr, 'quaternion norm must be within 1e-6 of 1; provide a unit quaternion')
  return { x: a[0], y: a[1], z: a[2], w: a[3] }
}

function unitAxis(v: unknown, path: string, ptr: string): Vec3 {
  const a = vec3(v, path, ptr)
  const norm = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
  if (Math.abs(norm - 1) > 1e-6) fail(path, ptr, 'axis norm must be within 1e-6 of 1; provide a unit axis')
  return a
}

function box(v: unknown, path: string, ptr: string): Box {
  const o = obj(v, path, ptr)
  keys(o, ['center', 'half'], path, ptr)
  const center = vec3(o.center, path, `${ptr}/center`)
  const half = vec3(o.half, path, `${ptr}/half`)
  if (half.x <= 0 || half.y <= 0 || half.z <= 0) fail(path, `${ptr}/half`, 'box half extents must be > 0; use positive extents')
  return { center, half }
}

function spawn(v: unknown, path: string, ptr: string): SpawnPoint {
  const o = obj(v, path, ptr)
  keys(o, ['t', 'yawDeg'], path, ptr)
  const t = vec3(o.t, path, `${ptr}/t`)
  const yaw = degToRad(finiteNum(o.yawDeg, path, `${ptr}/yawDeg`))
  return { t, facing: yawFacing(yaw, { x: 0, z: 1 }) }
}

function tickCount(v: unknown, path: string, ptr: string): number {
  const ticks = Math.round(finiteNum(v, path, ptr) * 60)
  if (ticks < 1) fail(path, ptr, `rounds to ${ticks} ticks; use at least 1/60 s`)
  return ticks
}

function phaseTicks(v: unknown, path: string, ptr: string): number {
  const ticks = Math.round(finiteNum(v, path, ptr) * 60)
  if (ticks < 0) fail(path, ptr, `rounds to ${ticks} ticks; use a non-negative phase`)
  return ticks
}

function nonNegative(v: unknown, path: string, ptr: string): number {
  const n = finiteNum(v, path, ptr)
  if (n < 0) fail(path, ptr, 'must be >= 0; use a non-negative number')
  return n
}

function motion(v: unknown, path: string, ptr: string): Motion {
  const o = obj(v, path, ptr)
  const kind = str(o.kind, path, `${ptr}/kind`)
  const fields: Record<string, readonly string[]> = {
    static: ['kind'], spinner: ['kind', 'axis', 'speedDegS', 'phaseDeg'],
    pendulum: ['kind', 'pivot', 'axis', 'ampDeg', 'periodS', 'phaseDeg'],
    seesaw: ['kind', 'axis', 'maxDeg', 'spring', 'damping', 'inertia'],
    rotatingDoor: ['kind', 'axis', 'stepDeg', 'periodS', 'moveS', 'phaseS'],
    conveyor: ['kind', 'velocity'], bouncePad: ['kind', 'speed'],
    movingPlatform: ['kind', 'offset', 'periodS', 'phaseDeg', 'wave'],
  }
  const known = fields[kind]
  if (!known) fail(path, `${ptr}/kind`, `unknown motion kind '${kind}'; use a supported motion kind`)
  keys(o, known, path, ptr)
  switch (kind) {
    case 'static': return { kind }
    case 'spinner': return { kind, axis: unitAxis(o.axis, path, `${ptr}/axis`), radPerTick: degToRad(finiteNum(o.speedDegS, path, `${ptr}/speedDegS`)) / 60, phase: degToRad(finiteNum(o.phaseDeg, path, `${ptr}/phaseDeg`)) }
    case 'pendulum': return { kind, pivot: vec3(o.pivot, path, `${ptr}/pivot`), axis: unitAxis(o.axis, path, `${ptr}/axis`), amp: degToRad(finiteNum(o.ampDeg, path, `${ptr}/ampDeg`)), periodTicks: tickCount(o.periodS, path, `${ptr}/periodS`), phase: degToRad(finiteNum(o.phaseDeg, path, `${ptr}/phaseDeg`)) }
    case 'seesaw': return { kind, axis: unitAxis(o.axis, path, `${ptr}/axis`), maxAngle: degToRad(finiteNum(o.maxDeg, path, `${ptr}/maxDeg`)), spring: nonNegative(o.spring, path, `${ptr}/spring`), damping: nonNegative(o.damping, path, `${ptr}/damping`), inertia: posNum(o.inertia, path, `${ptr}/inertia`) }
    case 'rotatingDoor': return { kind, axis: unitAxis(o.axis, path, `${ptr}/axis`), stepAngle: degToRad(finiteNum(o.stepDeg, path, `${ptr}/stepDeg`)), periodTicks: tickCount(o.periodS, path, `${ptr}/periodS`), moveTicks: tickCount(o.moveS, path, `${ptr}/moveS`), phaseTicks: phaseTicks(o.phaseS, path, `${ptr}/phaseS`) }
    case 'conveyor': return { kind, velocity: vec3(o.velocity, path, `${ptr}/velocity`) }
    case 'bouncePad': return { kind, speed: posNum(o.speed, path, `${ptr}/speed`) }
    case 'movingPlatform': {
      const wave = str(o.wave, path, `${ptr}/wave`)
      if (wave !== 'sine' && wave !== 'pingpong') fail(path, `${ptr}/wave`, "wave must be 'sine' or 'pingpong'; choose one of those values")
      return { kind, offset: vec3(o.offset, path, `${ptr}/offset`), periodTicks: tickCount(o.periodS, path, `${ptr}/periodS`), phase: degToRad(finiteNum(o.phaseDeg, path, `${ptr}/phaseDeg`)), wave }
    }
    default: return fail(path, `${ptr}/kind`, `unknown motion kind '${kind}'; use a supported motion kind`)
  }
}

function checkpoint(v: unknown, path: string, ptr: string): Checkpoint {
  const o = obj(v, path, ptr)
  keys(o, ['center', 'half', 'respawn'], path, ptr)
  return { box: box({ center: o.center, half: o.half }, path, ptr), respawn: spawn(o.respawn, path, `${ptr}/respawn`) }
}

function pathNode(v: unknown, path: string, ptr: string): PathNode {
  const o = obj(v, path, ptr)
  keys(o, ['p', 'jump', 'dive'], path, ptr)
  return { p: vec3(o.p, path, `${ptr}/p`), jump: bool(o.jump, path, `${ptr}/jump`), dive: bool(o.dive, path, `${ptr}/dive`) }
}

function region(v: unknown, path: string, ptr: string): Region {
  const o = obj(v, path, ptr)
  keys(o, ['id', 'center', 'half', 'adjacent'], path, ptr)
  const id = int(o.id, path, `${ptr}/id`)
  if (!Array.isArray(o.adjacent)) fail(path, `${ptr}/adjacent`, 'must be an array of region ids; provide an array')
  const adjacent: number[] = []
  for (let i = 0; i < o.adjacent.length; i++) adjacent.push(int(o.adjacent[i], path, `${ptr}/adjacent/${i}`))
  return { id, box: box({ center: o.center, half: o.half }, path, ptr), adjacent }
}

function obstacleBase(v: unknown, path: string, ptr: string): { id: string; asset: string; t: Vec3; r: Quat; s: Vec3; friction: number; motion: Motion; rawColliders: unknown } {
  const o = obj(v, path, ptr)
  keys(o, ['id', 'asset', 't', 'r', 's', 'friction', 'motion', 'colliders'], path, ptr)
  const id = str(o.id, path, `${ptr}/id`)
  const asset = str(o.asset, path, `${ptr}/asset`)
  if (!ASSET_NAME.test(asset)) fail(path, `${ptr}/asset`, 'asset must match ^[a-z0-9-]{1,48}$; use lowercase letters, digits and hyphens')
  const t = vec3(o.t, path, `${ptr}/t`)
  const r = quat(o.r, path, `${ptr}/r`)
  const s = vec3(o.s, path, `${ptr}/s`)
  if (s.x <= 0 || s.y <= 0 || s.z <= 0) fail(path, `${ptr}/s`, 'scale components must be > 0; use positive values')
  const friction = nonNegative(o.friction, path, `${ptr}/friction`)
  const m = motion(o.motion, path, `${ptr}/motion`)
  if (o.colliders !== null && !Array.isArray(o.colliders)) fail(path, `${ptr}/colliders`, 'must be null or an array; use null or collider objects')
  return { id, asset, t, r, s, friction, motion: m, rawColliders: o.colliders }
}

function courseError(path: string, ptr: string, error: unknown): never {
  if (error instanceof RefusalError) {
    const prefix = `${path}#`
    if (error.path.startsWith(prefix)) {
      const nested = `#${error.path.slice(prefix.length)}`
      if (nested.startsWith(ptr)) fail(path, nested, error.reason)
    }
    fail(path, ptr, error.reason)
  }
  throw error
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

export function canonicalJson(value: unknown): string {
  return canonical(value)
}

export async function loadCourse(json: unknown, path: string, assets: AssetResolver): Promise<ResolvedCourse> {
  const root = obj(json, path, '#')
  keys(root, ['format', 'version', 'id', 'name', 'kind', 'profiles', 'assetsManifest', 'timeLimitS', 'killPlaneY', 'spawns', 'checkpoints', 'finish', 'path', 'regions', 'queuePad', 'obstacles'], path, '#')
  if (root.format !== 'royal-fiesta.course') fail(path, '#/format', "format must be 'royal-fiesta.course'; use course v0 format")
  if (root.version !== 0) fail(path, '#/version', 'version must be 0; use a course v0 file')
  const id = str(root.id, path, '#/id')
  if (!COURSE_ID.test(id)) fail(path, '#/id', 'id must match ^[a-z0-9-]{1,40}$; use lowercase letters, digits and hyphens')
  const basename = path.split(/[\\/]/).pop() ?? path
  const stem = basename.endsWith('.course.json') ? basename.slice(0, -'.course.json'.length) : basename
  if (id !== stem) fail(path, '#/id', `id must equal file stem '${stem}'; rename the id or file`)
  const name = str(root.name, path, '#/name')
  if (name.trim().length === 0) fail(path, '#/name', 'name must be non-empty; provide a course name')
  const kindValue = str(root.kind, path, '#/kind')
  if (!KINDS.includes(kindValue as CourseKind)) fail(path, '#/kind', "kind must be race, survival, hub or gallery; choose a supported course kind")
  const kind = kindValue as CourseKind
  if (!Array.isArray(root.profiles)) fail(path, '#/profiles', 'must be an array; list supported profiles')
  const profiles: ProfileName[] = []
  for (let i = 0; i < root.profiles.length; i++) {
    const value = str(root.profiles[i], path, `#/profiles/${i}`)
    if (!PROFILES.includes(value as ProfileName)) fail(path, `#/profiles/${i}`, "profile must be 'standard' or 'sprint'; choose a supported profile")
    if (profiles.includes(value as ProfileName)) fail(path, `#/profiles/${i}`, `duplicate profile '${value}'; list each profile once`)
    profiles.push(value as ProfileName)
  }
  if (root.assetsManifest !== null && (typeof root.assetsManifest !== 'string' || !SHA256.test(root.assetsManifest))) fail(path, '#/assetsManifest', 'must be null or 64 lowercase hexadecimal characters; provide a manifest hash or null')
  const timeLimitS = posNum(root.timeLimitS, path, '#/timeLimitS')
  const killPlaneY = finiteNum(root.killPlaneY, path, '#/killPlaneY')
  if (!Array.isArray(root.spawns)) fail(path, '#/spawns', 'must be an array; add spawn points')
  const spawns = root.spawns.map((v, i) => spawn(v, path, `#/spawns/${i}`))
  const minSpawns = kind === 'hub' ? 1 : 8
  if (spawns.length < minSpawns) fail(path, '#/spawns', `needs at least ${minSpawns} spawns for ${kind}; add spawn points`)
  if (!Array.isArray(root.checkpoints)) fail(path, '#/checkpoints', 'must be an array; use an ordered checkpoint array')
  const checkpoints = root.checkpoints.map((v, i) => checkpoint(v, path, `#/checkpoints/${i}`))
  let finish: Box | null
  if (kind === 'race') {
    if (root.finish == null) fail(path, '#/finish', 'a race needs a finish box; add finish {center, half}')
    finish = box(root.finish, path, '#/finish')
  } else {
    if (root.finish !== null) fail(path, '#/finish', `finish must be null for ${kind}; set finish to null`)
    finish = null
  }
  if (!Array.isArray(root.path)) fail(path, '#/path', 'must be an array; provide path nodes')
  const pathNodes = root.path.map((v, i) => pathNode(v, path, `#/path/${i}`))
  if (!Array.isArray(root.regions)) fail(path, '#/regions', 'must be an array; provide regions')
  const regions = root.regions.map((v, i) => region(v, path, `#/regions/${i}`))
  const regionIds = new Set<number>()
  for (let i = 0; i < regions.length; i++) {
    if (regionIds.has(regions[i].id)) fail(path, `#/regions/${i}/id`, `duplicate region id ${regions[i].id}; use unique ids`)
    regionIds.add(regions[i].id)
  }
  for (let i = 0; i < regions.length; i++) {
    for (let j = 0; j < regions[i].adjacent.length; j++) {
      if (!regionIds.has(regions[i].adjacent[j])) fail(path, `#/regions/${i}/adjacent/${j}`, `region ${regions[i].adjacent[j]} does not exist; add that region or remove the adjacency`)
    }
  }
  let queuePad: Box | null
  if (kind === 'hub') queuePad = box(root.queuePad, path, '#/queuePad')
  else {
    if (root.queuePad !== null) fail(path, '#/queuePad', `queuePad must be null for ${kind}; set queuePad to null`)
    queuePad = null
  }
  if (!Array.isArray(root.obstacles)) fail(path, '#/obstacles', 'must be an array; provide obstacles')
  if (root.obstacles.length > MAX_OBSTACLES) fail(path, '#/obstacles', `has more than ${MAX_OBSTACLES} obstacles; remove obstacles`)
  const obstacles: ObstacleSpec[] = []
  const obstacleIds = new Set<string>()
  let hash = fnv1a32(new TextEncoder().encode(canonicalJson(json)))
  for (let i = 0; i < root.obstacles.length; i++) {
    const ptr = `#/obstacles/${i}`
    const raw = obstacleBase(root.obstacles[i], path, ptr)
    if (obstacleIds.has(raw.id)) fail(path, `${ptr}/id`, `duplicate obstacle id '${raw.id}'; use unique ids`)
    obstacleIds.add(raw.id)
    let resolved
    try {
      resolved = await assets.resolve(raw.asset)
    } catch (error) {
      if (error instanceof RefusalError) fail(path, `${ptr}/asset`, `cannot resolve asset '${raw.asset}': ${error.message}`)
      throw error
    }
    let colliders: ColliderSpec[]
    if (raw.rawColliders !== null) {
      if ((raw.rawColliders as unknown[]).length > MAX_COLLIDERS_PER_OBSTACLE) fail(path, `${ptr}/colliders`, `has more than ${MAX_COLLIDERS_PER_OBSTACLE} colliders; remove colliders`)
      colliders = (raw.rawColliders as unknown[]).map((c, k) => {
        try { return parseColliderJson(c, `${path}#${ptr.slice(1)}/colliders/${k}`) } catch (error) {
          return courseError(path, `${ptr}/colliders/${k}`, error)
        }
      })
    } else {
      const assetPath = resolved.origin === 'fixtures' ? `fixtures/assets/${raw.asset}.prims.json` : `store:${raw.asset}`
      try { colliders = collidersOf(resolved.asset, assetPath) } catch (error) { return courseError(path, `${ptr}/asset`, error) }
    }
    if (colliders.length > MAX_COLLIDERS_PER_OBSTACLE) fail(path, `${ptr}/colliders`, `has more than ${MAX_COLLIDERS_PER_OBSTACLE} colliders; remove colliders`)
    try { colliders = scaleColliders(colliders, raw.s, `${path}#${ptr.slice(1)}/s`) } catch (error) { courseError(path, `${ptr}/s`, error) }
    obstacles.push({ id: raw.id, asset: raw.asset, t: raw.t, r: raw.r, s: raw.s, friction: raw.friction, motion: raw.motion, colliders })
    const bytes = new Uint8Array(4)
    const assetHash = resolved.hash >>> 0
    bytes[0] = assetHash & 255
    bytes[1] = (assetHash >>> 8) & 255
    bytes[2] = (assetHash >>> 16) & 255
    bytes[3] = (assetHash >>> 24) & 255
    hash = fnv1a32(bytes, hash)
  }
  return { id, name, kind, profiles, timeLimitS, killPlaneY, spawns, checkpoints, finish, path: pathNodes, regions, queuePad, obstacles, contentHash: hash >>> 0, level: legacyLevel({ kind, timeLimitS, checkpoints }), features: [] }
}
