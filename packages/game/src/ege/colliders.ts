// E4: mapping from the course's collider list (and an asset's collision list) to the engine's ColliderJson.
// Sizes are copied; only a round box grows to its outer half extents (half + border). The engine has no cone or
// convex hull, so those are refused with the pointer of the offender.

import type { ColliderJson } from '@etcito/game-engine/formats'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'

type Obj = Record<string, unknown>
type Triple = [number, number, number]
type Quad = [number, number, number, number]

const NO_ENGINE = "(cuboid, roundCuboid, ball, capsule, cylinder); use one of those shapes in the asset's collision"

function refuseShape(shape: string, path: string): never {
  return refuse('ege-scene', `${path}/shape`, `shape '${shape}' has no engine collider ${NO_ENGINE}`)
}

function refuseCollider(path: string, why: string): never {
  return refuse('ege-scene', path, why)
}

function num(v: unknown, path: string, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) refuseCollider(`${path}/${key}`, `${key} must be a finite number`)
  return v
}

function triple(v: unknown, path: string, key: string, fallback: Triple, positive: boolean): Triple {
  if (v === undefined) return fallback
  const a = Array.isArray(v) ? v : typeof v === 'object' && v !== null ? [(v as Obj).x, (v as Obj).y, (v as Obj).z] : null
  if (a === null || a.length !== 3) refuseCollider(`${path}/${key}`, `${key} must be three numbers`)
  const out: Triple = [num(a[0], path, key), num(a[1], path, key), num(a[2], path, key)]
  if (positive && (out[0] <= 0 || out[1] <= 0 || out[2] <= 0)) refuseCollider(`${path}/${key}`, `${key} must be positive`)
  return out
}

function quad(v: unknown, path: string, key: string): Quad {
  if (v === undefined) return [0, 0, 0, 1]
  const a = Array.isArray(v) ? v : typeof v === 'object' && v !== null ? [(v as Obj).x, (v as Obj).y, (v as Obj).z, (v as Obj).w] : null
  if (a === null || a.length !== 4) refuseCollider(`${path}/${key}`, `${key} must be four numbers`)
  return [num(a[0], path, key), num(a[1], path, key), num(a[2], path, key), num(a[3], path, key)]
}

interface Fields {
  half?: Triple
  border?: number
  radius?: number
  halfHeight?: number
}

function shapeJson(shape: string, f: Fields, t: Triple, r: Quad, path: string): ColliderJson {
  switch (shape) {
    case 'cuboid':
      return { shape: 'cuboid', halfExtents: f.half!, t, r }
    case 'roundCuboid': {
      const h = f.half!
      const b = f.border!
      return { shape: 'cuboid', halfExtents: [h[0] + b, h[1] + b, h[2] + b], t, r }
    }
    case 'ball':
      return { shape: 'ball', radius: f.radius!, t, r }
    case 'capsule':
    case 'cylinder':
      return { shape, radius: f.radius!, halfHeight: f.halfHeight!, t, r }
    default:
      return refuseShape(shape, path)
  }
}

function specFields(c: ColliderSpec): Fields {
  switch (c.shape) {
    case 'cuboid':
      return { half: [c.half.x, c.half.y, c.half.z] }
    case 'roundCuboid':
      return { half: [c.half.x, c.half.y, c.half.z], border: c.border }
    case 'ball':
      return { radius: c.radius }
    case 'capsule':
    case 'cylinder':
      return { radius: c.radius, halfHeight: c.halfHeight }
    default:
      return {}
  }
}

/**
 * E4: turns a resolved course collider list into engine colliders, refusing a shape the engine has none for.
 * Handoff: card 'Scene emitter part 2: obstacles, mechanisms, extras and features' calls engineColliders and
 * assetColliders; state/keys: none, both are pure and keep no state.
 */
export function engineColliders(list: readonly ColliderSpec[], path: string): ColliderJson[] {
  const out: ColliderJson[] = []
  for (let k = 0; k < list.length; k++) {
    const c = list[k]
    const p = `${path}/${k}`
    const t: Triple = [c.t.x, c.t.y, c.t.z]
    const r: Quad = [c.r.x, c.r.y, c.r.z, c.r.w]
    out.push(shapeJson(c.shape, specFields(c), t, r, p))
  }
  return out
}

function field(raw: Obj, params: Obj, key: string, alias: string): unknown {
  return raw[key] ?? raw[alias] ?? params[key] ?? params[alias]
}

/**
 * E4: turns an asset's raw `collision` entries (flat fields with half/halfExtents and border/borderRadius, or a
 * `params` object) into engine colliders, applying the same mapping and refusals as engineColliders.
 */
export function assetColliders(raw: readonly unknown[], path: string): ColliderJson[] {
  const out: ColliderJson[] = []
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k]
    const p = `${path}/${k}`
    if (typeof c !== 'object' || c === null || Array.isArray(c)) refuseCollider(p, 'collider must be an object')
    const entry = c as Obj
    const params = typeof entry.params === 'object' && entry.params !== null ? entry.params as Obj : {}
    const shape = entry.shape
    if (typeof shape !== 'string') refuseCollider(`${p}/shape`, 'shape must be a string')
    const t = triple(entry.t, p, 't', [0, 0, 0], false)
    const r = quad(entry.r, p, 'r')
    const f: Fields = {}
    if (shape === 'cuboid' || shape === 'roundCuboid') {
      f.half = triple(field(entry, params, 'half', 'halfExtents'), p, 'halfExtents', [0, 0, 0], true)
      if (shape === 'roundCuboid') f.border = num(field(entry, params, 'border', 'borderRadius'), p, 'borderRadius')
    } else if (shape === 'ball') {
      f.radius = num(field(entry, params, 'radius', 'radius'), p, 'radius')
    } else if (shape === 'capsule' || shape === 'cylinder') {
      f.radius = num(field(entry, params, 'radius', 'radius'), p, 'radius')
      f.halfHeight = num(field(entry, params, 'halfHeight', 'halfHeight'), p, 'halfHeight')
    }
    out.push(shapeJson(shape, f, t, r, p))
  }
  return out
}
