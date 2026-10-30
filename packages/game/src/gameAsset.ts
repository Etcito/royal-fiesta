// The game's reader of sdfm.game-asset v1 (S12). Content only: the file stem == id and folder == world
// rules belong to the scanners (node-content, web-content-v1), so invalid fixtures can live under fixtures/.
// An obstacle with an empty collision is valid here; course-v1 refuses it when a course uses it as an obstacle.
import type { ColliderSpec, Surface } from '@royal-fiesta/sim/course'
import type { BodyType, JointKind } from '@royal-fiesta/sim/mechanismSpec'
import type { Quat, Vec3 } from '@royal-fiesta/sim/vec'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { canonicalJson } from './course.ts'
import { parseAssetPhysics } from './mechanismsJson.ts'
import { parseColliderJson } from './prims.ts'

export type World = 'candy' | 'ice' | 'jungle' | 'neon' | 'common'
export type AssetCategory = 'obstacle' | 'prop' | 'scenery' | 'character' | 'cosmetic' | 'fx'
export type MesherOutput = 'quad' | 'paramesh' | 'dc' | 'lowpoly' | 'poly'

export interface MotorJson {
  mode: 'speed' | 'target'
  speedDegS?: number
  speedMS?: number
  targetDeg?: number
  targetM?: number
  stiffness: number
  damping: number
  maxForce: number
  enabled: boolean
}

export interface AssetBodyJson {
  id: string
  type: BodyType
  colliders: number[]
  parts: string[]
  t: [number, number, number]
  r: [number, number, number, number]
  density: number
  friction: number
  restitution: number
  linearDamping: number
  angularDamping: number
  gravityScale: number
  ccd: boolean
  surface: Surface
}

export interface AssetJointJson {
  id: string
  kind: JointKind
  a: string
  b: string
  anchorA: [number, number, number]
  anchorB: [number, number, number]
  axis: [number, number, number]
  limitsDeg?: [number, number] | null
  limitsM?: [number, number] | null
  stiffness?: number
  damping?: number
  lengthM?: number
  motor: MotorJson | null
}

export interface AssetPhysicsJson {
  bodies: AssetBodyJson[]
  joints: AssetJointJson[]
}

export interface GameAsset {
  format: 'sdfm.game-asset'
  version: 1
  game: 'royal-fiesta'
  id: string
  name: string
  category: AssetCategory
  world: World
  mesher: { output: MesherOutput; params?: Record<string, unknown> }
  document: Record<string, unknown>
  collision: ColliderSpec[]
  physics?: AssetPhysicsJson
  anchors: Record<string, { t: Vec3; r: Quat }>
  bounds: { min: Vec3; max: Vec3 }
  hash: string
}

// One asset file as a scanner found it: its repository path and its parsed JSON.
export interface GameAssetSource { path: string; json: unknown }

export const ASSET_ID_RE: RegExp = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/
export const GAME_ASSET_CAPS: { maxDocumentBytes: 2097152; maxColliders: 8 } = { maxDocumentBytes: 2097152, maxColliders: 8 }

const WORLDS: readonly World[] = ['candy', 'ice', 'jungle', 'neon', 'common']
const CATEGORIES: readonly AssetCategory[] = ['obstacle', 'prop', 'scenery', 'character', 'cosmetic', 'fx']
const OUTPUTS: readonly MesherOutput[] = ['quad', 'paramesh', 'dc', 'lowpoly', 'poly']
const TOP_KEYS = ['format', 'version', 'game', 'id', 'name', 'category', 'world', 'mesher', 'document', 'collision', 'anchors', 'bounds', 'hash'] as const
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']
const SCRIPT_RE = /<script|javascript:/i

type Obj = Record<string, unknown>

export function assetFilePath(world: World, id: string): string {
  return `assets/${world}/${id}.asset.json`
}

export function assetMeshPath(world: World, id: string): string {
  return `assets/${world}/${id}.mesh`
}

function fail(path: string, ptr: string, reason: string): never {
  return refuse('asset', `${path}#${ptr}`, reason)
}

function escapePointer(s: string): string { return s.replace(/~/g, '~0').replace(/\//g, '~1') }

function obj(v: unknown, path: string, ptr: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, ptr, 'must be an object; provide an object')
  return v as Obj
}

function keys(v: Obj, required: readonly string[], optional: readonly string[], path: string, ptr: string): void {
  for (const k of Object.keys(v)) {
    if (!required.includes(k) && !optional.includes(k)) fail(path, `${ptr}/${escapePointer(k)}`, `unknown key '${k}'; remove it or use a supported field`)
  }
  for (const k of required) {
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

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string, ptr: string): T {
  const s = str(v, path, ptr)
  if (!(allowed as readonly string[]).includes(s)) fail(path, ptr, `unknown value '${s}'; use one of ${allowed.join('|')}`)
  return s as T
}

function tuple(v: unknown, n: number, path: string, ptr: string): number[] {
  if (!Array.isArray(v) || v.length !== n) fail(path, ptr, `must be an array of ${n} finite numbers; provide ${n} components`)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(finiteNum(v[i], path, `${ptr}/${i}`))
  return out
}

function vec3(v: unknown, path: string, ptr: string): Vec3 {
  const a = tuple(v, 3, path, ptr)
  return { x: a[0], y: a[1], z: a[2] }
}

function quat(v: unknown, path: string, ptr: string): Quat {
  const a = tuple(v, 4, path, ptr)
  const norm = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3])
  if (Math.abs(norm - 1) > 1e-6) fail(path, ptr, 'quaternion norm must be within 1e-6 of 1; provide a unit quaternion')
  return { x: a[0], y: a[1], z: a[2], w: a[3] }
}

// Every node of the SDF Modeler document: finite numbers, no prototype keys, no script strings.
function walkDocument(v: unknown, path: string, ptr: string): void {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(path, ptr, 'non-finite number; use a finite JSON number')
  } else if (typeof v === 'string') {
    if (SCRIPT_RE.test(v)) fail(path, ptr, "string contains '<script' or 'javascript:'; remove the script text")
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) walkDocument(v[i], path, `${ptr}/${i}`)
  } else if (typeof v === 'object' && v !== null) {
    for (const k of Object.keys(v)) {
      const kp = `${ptr}/${escapePointer(k)}`
      if (FORBIDDEN_KEYS.includes(k)) fail(path, kp, `forbidden key '${k}'; rename or remove it`)
      walkDocument((v as Obj)[k], path, kp)
    }
  } else if (v !== null && typeof v !== 'boolean') {
    fail(path, ptr, `value of type ${typeof v} is not JSON; use a JSON value`)
  }
}

function collider(v: unknown, path: string, ptr: string): ColliderSpec {
  try {
    return parseColliderJson(v, `${path}#${ptr}`)
  } catch (e) {
    // prims refuses with the full file#pointer we gave it; keep the suffix, move it to area 'asset'
    if (isRefusal(e)) refuse('asset', e.path, e.reason)
    throw e
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  let hex = ''
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0')
  return hex
}

function utf8(s: string): Uint8Array { return new TextEncoder().encode(s) }

// SDF Modeler's serializeDocument text (its asset_save_game hash form): 2-space JSON in
// insertion key order, number-only arrays on one line as `[a, b, c]`, one trailing newline;
// a node's rig and clips keep plain JSON.stringify layout (MAMA Exact json fields).
export function sdfmText(value: unknown): string {
  const write = (v: unknown, pad: string): string => {
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]'
      if (v.every((x) => typeof x === 'number')) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`
      const inner = pad + '  '
      return `[\n${v.map((x) => inner + write(x, inner)).join(',\n')}\n${pad}]`
    }
    if (v !== null && typeof v === 'object') {
      const ks = Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      if (ks.length === 0) return '{}'
      const inner = pad + '  '
      // a document node's rig and clips are written as plain JSON.stringify(v, null, 2), re-indented
      const node = 'id' in v && 'kind' in v
      const field = (k: string, x: unknown): string =>
        node && (k === 'rig' || k === 'clips') ? JSON.stringify(x, null, 2).replace(/\n/g, '\n' + inner) : write(x, inner)
      return `{\n${ks.map((k) => `${inner}${JSON.stringify(k)}: ${field(k, (v as Record<string, unknown>)[k])}`).join(',\n')}\n${pad}}`
    }
    return JSON.stringify(v)
  }
  return write(value, '') + '\n'
}

type Json = Record<string, unknown>
const isJsonObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
// MAMA roundNumber: numbers are written rounded to 1e-6 (-0 as 0); a subtree MAMA writes exactly keeps its number.
function roundNumber(x: number): number {
  if (!Number.isFinite(x)) return x
  const scaled = x * 1e6
  const r = Number.isFinite(scaled) && Math.abs(scaled) < 2 ** 53 ? Math.round(scaled) / 1e6 : x
  return r === 0 ? 0 : r
}
const numberText = (x: number, exact: boolean): string => (!Number.isFinite(x) ? 'null' : exact ? (x === 0 ? '0' : String(x)) : String(roundNumber(x)))

// The MAMA `format` layout: 2-space indent in insertion key order, number-only arrays on one line, `null` for a
// non-finite number. `exactAt(path)` names the subtrees written with their exact numbers, `jsonAt(path)` the ones written
// as plain JSON.stringify(v, null, 2) re-indented (MAMA Exact json: a node's rig and clips).
function formatJson(v: unknown, pad: string, path: readonly string[], exact: boolean,
  exactAt: (p: readonly string[]) => boolean, jsonAt: (p: readonly string[]) => boolean): string {
  if (typeof v === 'number') return numberText(v, exact)
  if (typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) return JSON.stringify(v ?? null)
  const inner = pad + '  '
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (v.every((x) => typeof x === 'number')) return `[${v.map((x) => numberText(x, exact)).join(', ')}]`
    return `[\n${v.map((x, i) => inner + formatJson(x, inner, [...path, String(i)], exact, exactAt, jsonAt)).join(',\n')}\n${pad}]`
  }
  if (isJsonObject(v)) {
    const ks = Object.keys(v).filter((k) => v[k] !== undefined)
    if (ks.length === 0) return '{}'
    const field = (k: string): string => {
      const p = [...path, k]
      if (jsonAt(p)) return JSON.stringify(v[k], null, 2).replace(/\n/g, '\n' + inner)
      return formatJson(v[k], inner, p, exact || exactAt(p), exactAt, jsonAt)
    }
    return `{\n${ks.map((k) => `${inner}${JSON.stringify(k)}: ${field(k)}`).join(',\n')}\n${pad}}`
  }
  return 'null'
}

/**
 * The document text SDF Modeler saves (MAMA serializeDocument layout) for a document already in its canonical key order:
 * numbers rounded to 1e-6 except the subtrees MAMA writes exactly (a Paramesh shape's cage corners, the surfaces and
 * drawings maps), a node's rig and clips as plain JSON.stringify(v, null, 2). The asset hash is the sha256 of this text.
 */
export function assetDocumentText(document: unknown): string {
  const exactAt = (p: readonly string[]): boolean =>
    (p.length === 1 && (p[0] === 'surfaces' || p[0] === 'drawings')) ||
    (p.length === 5 && p[0] === 'nodes' && p[2] === 'paramesh' && p[3] === 'shape' && p[4] === 'cage')
  const jsonAt = (p: readonly string[]): boolean => p.length === 3 && p[0] === 'nodes' && (p[2] === 'rig' || p[2] === 'clips')
  return formatJson(document, '', [], false, exactAt, jsonAt) + '\n'
}

const ASSET_FILE_KEYS = ['format', 'version', 'game', 'id', 'name', 'category', 'world', 'mesher', 'document', 'collision', 'physics', 'anchors', 'bounds', 'hash'] as const
const COLLIDER_KEY_ORDER = ['shape', 't', 'r', 'halfExtents', 'borderRadius', 'radius', 'halfHeight']

/**
 * The asset file text SDF Modeler writes (MAMA serializeAssetFile, the canonical form of every assets/<world>/*.asset.json):
 * keys format ... hash in that order (physics only when present, world null when unset), the mesher as output then
 * params with sorted params, each collider as shape, t, r, then its size keys, anchors as {t, r}, bounds as {min, max},
 * the document as assetDocumentText, numbers rounded to 1e-6, trailing newline. Every asset writer uses it, and the guard
 * refuses an asset file whose text is not exactly this text of its own parsed content.
 */
export function assetFileText(asset: unknown): string {
  if (!isJsonObject(asset)) throw new Error('an asset file is a JSON object')
  const a = asset
  const mesher = (m: unknown): unknown => {
    if (!isJsonObject(m)) return m ?? null
    const out: Json = {}
    if (m.output !== undefined) out.output = m.output
    if (isJsonObject(m.params)) out.params = Object.fromEntries(Object.keys(m.params).sort().filter((k) => (m.params as Json)[k] !== undefined).map((k) => [k, (m.params as Json)[k]]))
    else if (m.params !== undefined) out.params = m.params
    for (const [k, x] of Object.entries(m)) if (k !== 'output' && k !== 'params' && x !== undefined) out[k] = x
    return out
  }
  const collider = (c: unknown): unknown => {
    if (!isJsonObject(c)) return c
    const out: Json = {}
    for (const k of COLLIDER_KEY_ORDER) if (c[k] !== undefined) out[k] = c[k]
    for (const [k, x] of Object.entries(c)) if (!(k in out) && x !== undefined) out[k] = x
    return out
  }
  const value: Json = {
    format: a.format, version: a.version, game: a.game, id: a.id, name: a.name, category: a.category,
    world: a.world ?? null,
    mesher: mesher(a.mesher),
    document: null,
    collision: Array.isArray(a.collision) ? a.collision.map(collider) : a.collision,
    physics: a.physics,
    anchors: isJsonObject(a.anchors) ? Object.fromEntries(Object.entries(a.anchors).map(([k, x]) => [k, isJsonObject(x) ? { t: x.t, r: x.r } : x])) : a.anchors,
    bounds: isJsonObject(a.bounds) ? { min: a.bounds.min, max: a.bounds.max } : a.bounds,
    hash: a.hash,
  }
  const doc = assetDocumentText(a.document).replace(/\n$/, '').split('\n').map((line, i) => (i === 0 ? line : '  ' + line)).join('\n')
  const lines = ASSET_FILE_KEYS.filter((k) => value[k] !== undefined)
    .map((k) => `  ${JSON.stringify(k)}: ${k === 'document' ? doc : formatJson(value[k], '  ', [], false, () => false, () => false)}`)
  return `{\n${lines.join(',\n')}\n}\n`
}

export async function parseGameAsset(json: unknown, path: string): Promise<GameAsset> {
  const o = obj(json, path, '')
  keys(o, TOP_KEYS, ['physics'], path, '')
  if (o.format !== 'sdfm.game-asset') fail(path, '/format', "format must be 'sdfm.game-asset'; write \"format\": \"sdfm.game-asset\"")
  if (o.version !== 1) fail(path, '/version', 'version must be 1; write "version": 1')
  if (o.game !== 'royal-fiesta') fail(path, '/game', "game must be 'royal-fiesta'; write \"game\": \"royal-fiesta\"")
  const id = str(o.id, path, '/id')
  if (!ASSET_ID_RE.test(id)) fail(path, '/id', `id '${id}' does not match ${ASSET_ID_RE.source}; use <world>.<name> such as candy.spinner-bar`)
  const name = str(o.name, path, '/name')
  const category = oneOf(o.category, CATEGORIES, path, '/category')
  const world = oneOf(o.world, WORLDS, path, '/world')

  const m = obj(o.mesher, path, '/mesher')
  keys(m, ['output'], ['params'], path, '/mesher')
  const mesher: GameAsset['mesher'] = { output: oneOf(m.output, OUTPUTS, path, '/mesher/output') }
  if (m.params !== undefined) {
    const params = obj(m.params, path, '/mesher/params')
    walkDocument(params, path, '/mesher/params')
    mesher.params = params
  }

  const document = obj(o.document, path, '/document')
  walkDocument(document, path, '/document')
  const canonical = canonicalJson(document)
  const documentBytes = utf8(canonical).length
  if (documentBytes > GAME_ASSET_CAPS.maxDocumentBytes) {
    fail(path, '/document', `canonical document is ${documentBytes} bytes, over ${GAME_ASSET_CAPS.maxDocumentBytes}; simplify the document`)
  }

  if (!Array.isArray(o.collision)) fail(path, '/collision', 'must be an array; use [] or list the colliders')
  if (o.collision.length > GAME_ASSET_CAPS.maxColliders) {
    fail(path, '/collision', `${o.collision.length} colliders, over ${GAME_ASSET_CAPS.maxColliders}; merge or remove some`)
  }
  const collision = o.collision.map((c, i) => collider(c, path, `/collision/${i}`))
  const physics = parseAssetPhysics(o.physics, collision, path)

  const a = obj(o.anchors, path, '/anchors')
  const anchors: GameAsset['anchors'] = {}
  for (const k of Object.keys(a)) {
    const ap = `/anchors/${escapePointer(k)}`
    if (FORBIDDEN_KEYS.includes(k)) fail(path, ap, `forbidden anchor name '${k}'; rename it`)
    const e = obj(a[k], path, ap)
    keys(e, ['t', 'r'], [], path, ap)
    anchors[k] = { t: vec3(e.t, path, `${ap}/t`), r: quat(e.r, path, `${ap}/r`) }
  }

  const b = obj(o.bounds, path, '/bounds')
  keys(b, ['min', 'max'], [], path, '/bounds')
  const min = vec3(b.min, path, '/bounds/min')
  const max = vec3(b.max, path, '/bounds/max')
  for (const axis of ['x', 'y', 'z'] as const) {
    if (min[axis] > max[axis]) fail(path, '/bounds', `min.${axis} ${min[axis]} > max.${axis} ${max[axis]}; make min <= max on each axis`)
  }

  // Hash last: everything else is cheap and names a more precise pointer.
  const hash = str(o.hash, path, '/hash')
  const actual = await sha256Hex(utf8(canonical))
  if (hash !== actual) {
    const text = await sha256Hex(utf8(sdfmText(document)))
    if (hash !== text) {
      fail(path, '/hash', `hash ${hash} does not match sha256 of canonicalJson(document) ${actual} nor of the SDF Modeler document text ${text}; re-save the asset with SDF Modeler or set "hash": "${actual}"`)
    }
  }

  return {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta',
    id, name, category, world, mesher, document, collision, anchors, bounds: { min, max }, hash,
    ...(physics ? { physics } : {}),
  }
}
