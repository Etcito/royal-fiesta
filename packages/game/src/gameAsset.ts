// The game's reader of sdfm.game-asset v1 (S12). Content only: the file stem == id and folder == world
// rules belong to the scanners (node-content, web-content-v1), so invalid fixtures can live under fixtures/.
// An obstacle with an empty collision is valid here; course-v1 refuses it when a course uses it as an obstacle.
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import type { Quat, Vec3 } from '@royal-fiesta/sim/vec'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { canonicalJson } from './course.ts'
import { parseColliderJson } from './prims.ts'

export type World = 'candy' | 'ice' | 'jungle' | 'neon' | 'common'
export type AssetCategory = 'obstacle' | 'prop' | 'scenery' | 'character' | 'cosmetic' | 'fx'
export type MesherOutput = 'quad' | 'paramesh' | 'dc' | 'lowpoly' | 'poly'

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
function sdfmText(value: unknown): string {
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

export async function parseGameAsset(json: unknown, path: string): Promise<GameAsset> {
  const o = obj(json, path, '')
  keys(o, TOP_KEYS, [], path, '')
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
  }
}
