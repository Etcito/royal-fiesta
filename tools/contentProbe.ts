// Read-only probes over authored asset files, shared by the content proofs (C2, C3, C6).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseGameAsset, type GameAsset } from '../packages/game/src/gameAsset.ts'
import { refuse } from '../packages/sim/src/refusal.ts'
import { repoRoot } from './bricks.ts'

export interface AuthoredAsset { rel: string; asset: GameAsset; json: Record<string, unknown> }
type V3 = [number, number, number]
interface Aabb { min: V3; max: V3 }

export async function loadAssetFile(rel: string): Promise<AuthoredAsset> {
  let text: string
  try {
    text = await readFile(join(repoRoot(), rel), 'utf8')
  } catch {
    return refuse('content', rel, 'file not found; save the asset there or fix the path')
  }
  const json = JSON.parse(text) as Record<string, unknown>
  const asset = await parseGameAsset(json, rel)
  return { rel, asset, json }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// SDF Modeler v2 keys nodes by id, so the object order is the document order.
export function documentNodes(a: AuthoredAsset): Record<string, unknown>[] {
  const nodes = a.asset.document.nodes
  if (!isObj(nodes)) refuse('content', `${a.rel}#/document/nodes`, 'not an object keyed by node id; re-save with SDF Modeler v2')
  return Object.values(nodes).map((n, i) => {
    if (!isObj(n)) refuse('content', `${a.rel}#/document/nodes/${Object.keys(nodes)[i]}`, 'node is not an object; re-save the document')
    return n
  })
}

const v3 = (v: unknown): V3 => Array.isArray(v) && v.length === 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : [0, 0, 0]

export function rigidGroups(a: AuthoredAsset): { name: string; pivot: V3; mesher: unknown }[] {
  const nodes = documentNodes(a)
  const byId = new Map<string, Record<string, unknown>>()
  for (const n of nodes) byId.set(String(n.id), n)
  // Parent links come from the children lists, walked from the document roots.
  const parent = new Map<string, string>()
  const roots = a.asset.document.root
  const stack: string[] = Array.isArray(roots) ? roots.map(String) : []
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    const kids = byId.get(id)?.children
    if (Array.isArray(kids)) for (const k of kids) { parent.set(String(k), id); stack.push(String(k)) }
  }
  const out: { name: string; pivot: V3; mesher: unknown }[] = []
  for (const n of nodes) {
    if (n.kind !== 'group' || n.rigid !== true) continue
    const p = v3(n.pivot)
    let cur: string | undefined = String(n.id)
    while (cur !== undefined) {
      const node = byId.get(cur)
      const t = isObj(node?.transform) ? v3(node.transform.position) : [0, 0, 0]
      p[0] += t[0]; p[1] += t[1]; p[2] += t[2]
      cur = parent.get(cur)
    }
    out.push({ name: String(n.name), pivot: p, mesher: n.mesher })
  }
  return out
}

export function materialColours(a: AuthoredAsset): { name: string; hex: string }[] {
  const mats = a.asset.document.materials
  const entries: [string, unknown][] = Array.isArray(mats) ? mats.map((m, i) => [String(i), m])
    : isObj(mats) ? Object.entries(mats) : []
  return entries.map(([key, m]) => {
    const name = isObj(m) ? String(m.name) : key
    const graph = isObj(m) && isObj(m.graph) ? m.graph : {}
    const gn = Array.isArray(graph.nodes) ? graph.nodes : []
    const out = gn.find((n: unknown) => isObj(n) && n.type === 'material.output') as Record<string, unknown> | undefined
    if (out === undefined) refuse('content', `${a.rel}#/document/materials/${key}`, 'no material.output node; end the graph with material.output')
    const params = isObj(out.params) ? out.params : {}
    return { name, hex: String(params['in.base_color']).toLowerCase() }
  })
}

export function colliderAabb(a: AuthoredAsset): Aabb | null {
  if (a.asset.collision.length === 0) return null
  const min: V3 = [Infinity, Infinity, Infinity]
  const max: V3 = [-Infinity, -Infinity, -Infinity]
  for (const c of a.asset.collision) {
    let h: V3
    if (c.shape === 'cuboid') h = [c.half.x, c.half.y, c.half.z]
    else if (c.shape === 'roundCuboid') h = [c.half.x + c.border, c.half.y + c.border, c.half.z + c.border]
    else if (c.shape === 'ball') h = [c.radius, c.radius, c.radius]
    else if (c.shape === 'capsule') h = [c.radius, c.halfHeight + c.radius, c.radius]
    else h = [c.radius, c.halfHeight, c.radius]
    const { x, y, z, w } = c.r
    // Rotation matrix rows; the rotated box extent is |R| times the half extents.
    const m = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    const t = [c.t.x, c.t.y, c.t.z]
    for (let i = 0; i < 3; i++) {
      const e = Math.abs(m[i][0]) * h[0] + Math.abs(m[i][1]) * h[1] + Math.abs(m[i][2]) * h[2]
      min[i] = Math.min(min[i], t[i] - e)
      max[i] = Math.max(max[i], t[i] + e)
    }
  }
  return { min, max }
}

const AXES = ['x', 'y', 'z'] as const
const bv = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z]

export function visualFitsCollision(a: AuthoredAsset): string | null {
  const box = colliderAabb(a)
  if (box === null) return null
  const bmin = bv(a.asset.bounds.min)
  const bmax = bv(a.asset.bounds.max)
  for (let i = 0; i < 3; i++) {
    if (box.min[i] < bmin[i] - 0.1 || box.max[i] > bmax[i] + 0.1) {
      return `${a.rel} ${AXES[i]}: collider [${box.min[i]}, ${box.max[i]}] outside bounds [${bmin[i]}, ${bmax[i]}] + 0.1`
    }
    const m = Math.max(0.5, 0.25 * (box.max[i] - box.min[i]))
    if (bmin[i] < box.min[i] - m || bmax[i] > box.max[i] + m) {
      return `${a.rel} ${AXES[i]}: bounds [${bmin[i]}, ${bmax[i]}] outside collider [${box.min[i]}, ${box.max[i]}] + ${m}`
    }
  }
  return null
}

export function mountedBounds(costume: AuthoredAsset, body: AuthoredAsset): Aabb {
  const names = Object.keys(costume.asset.anchors)
  if (names.length !== 1) refuse('content', `${costume.rel}#/anchors`, `has ${names.length} anchors; give the costume exactly one slot anchor`)
  const bodyAnchor = body.asset.anchors[names[0]]
  if (bodyAnchor === undefined) refuse('content', `${costume.rel}#/anchors/${names[0]}`, `no such anchor on ${body.asset.id}; name it after a body anchor`)
  // Anchors carry identity rotation (1.12), so mounting is a translation.
  const d = bv(bodyAnchor.t)
  const c = bv(costume.asset.anchors[names[0]].t)
  const off: V3 = [d[0] - c[0], d[1] - c[1], d[2] - c[2]]
  const mn = bv(costume.asset.bounds.min)
  const mx = bv(costume.asset.bounds.max)
  return { min: [mn[0] + off[0], mn[1] + off[1], mn[2] + off[2]], max: [mx[0] + off[0], mx[1] + off[1], mx[2] + off[2]] }
}

const BANNED = ['.png', '.jpg', '.jpeg', '.webp', '.glb', '.gltf', '.obj', '.fbx', 'data:']
const MAX_BYTES = 524288
const esc = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1')

export function proceduralProblems(a: AuthoredAsset, rawBytes: number): string[] {
  const out: string[] = []
  const walk = (v: unknown, ptr: string): void => {
    if (typeof v === 'string') {
      const low = v.toLowerCase()
      const hit = BANNED.find((b) => low.includes(b))
      if (hit !== undefined) out.push(`${a.rel}#${ptr}: names '${hit}' (${JSON.stringify(v)}); use SDF nodes and material graphs only`)
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`))
    else if (isObj(v)) for (const k of Object.keys(v)) walk(v[k], `${ptr}/${esc(k)}`)
  }
  walk(a.json, '')
  if (rawBytes > MAX_BYTES) out.push(`${a.rel}: ${rawBytes} bytes > ${MAX_BYTES}; simplify the document`)
  return out
}
