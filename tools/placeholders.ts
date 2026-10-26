// Placeholder content (S12/S13): one sdfm.game-asset per fixture prims, the v1 courses and the podium course.
// It only writes JSON: no MAMA, raa-sdfm or apps import, so the MAMA document shape (sdfm v2) is spelled out here.
// node --experimental-strip-types tools/placeholders.ts [--check]
import { contentPath } from './content.ts'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TICK_RATE } from '@gamesaloon/rollback-rapier'
import { canonicalJson } from '../packages/game/src/course.ts'
import { migrateCourseV0 } from '../packages/game/src/courseV1.ts'
import { assetFilePath } from '../packages/game/src/gameAsset.ts'
import type { AssetCategory, World } from '../packages/game/src/gameAsset.ts'
import { collidersOf, parsePrims, PRIM_CAPS } from '../packages/game/src/prims.ts'
import type { PrimMaterial, PrimNode, PrimsAsset } from '../packages/game/src/prims.ts'
import { PODIUM_ORIGIN, PODIUM_V0_LAYOUT } from '../packages/game/src/render/podiumStage.ts'
import type { ColliderSpec } from '../packages/sim/src/course.ts'
import { PROFILES } from '../packages/sim/src/match/setup.ts'
import { refuse } from '../packages/sim/src/refusal.ts'
import { isAuthored, readAuthored } from './authored.ts'
import type { Authored } from './authored.ts'
import { repoRoot } from './bricks.ts'

type V3 = [number, number, number]
type Q4 = [number, number, number, number]
type Obj = Record<string, unknown>
interface Frame { t: V3; r: Q4; s: V3 }

const OUTPUT_DIRS = ['assets', 'courses']
const MESHER = { output: 'lowpoly' } as const
const BLOCK_ID = 'candy.podium-block'
const BLOCK_SIZE: V3 = [2, 1, 2]
// MAMA's roundBox default bevel (core/sdf/primitives/basic.ts RBOX_RADIUS).
const BLOCK_RADIUS = 0.1

// MAMA core/doc/defaults.ts SETTINGS_DEFAULTS: the validator needs every section.
const SETTINGS = {
  mesh: { detail: null, maxDepth: 9, adaptivity: 0.02, sharpAngleDeg: 30 },
  lowpoly: { targetTriangles: 2000, keepWeight: 10, featureAngleDeg: 35 },
  uv: { texelsPerMeter: null, padding: 8 },
  bake: { resolution: 1024, maps: ['normal', 'baseColor', 'orm'], cageDistance: null, samples: 1 },
  export: {
    geometry: 'lowpoly', skin: false, lods: [1],
    quad: { targetFaces: 1000, subdivide: 0, method: 'auto', features: 'auto', featureAngleDeg: 35, adaptive: true, alignCurvature: true, seed: 1, detail: true, maxFacesRatio: 3 },
    poly: { segments: 16, additive: 'keep' },
  },
  paramesh: { fieldResolution: 96, precision: 'f16', subdivisions: 16, transitionLoops: 2 },
}
// MAMA material.output inline defaults: values equal to them are not stored (canonical form).
const OUTPUT_DEFAULTS: Record<string, string | number> = { 'in.base_color': '#bcbcbc', 'in.emissive': '#000000', 'in.metallic': 0, 'in.roughness': 0.5 }
const GROUP_COLOR = '#b0b0b0' // MAMA NODE_DEFAULTS.color

// Sub-nanometre snap: keeps asin/atan2 last-ulp noise and -0 out of the files.
function snap(x: number): number {
  return Math.round(x * 1e9) / 1e9 || 0
}

function qmul(a: Q4, b: Q4): Q4 {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

function qrot(q: Q4, v: V3): V3 {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx]
}

// The prims composition (prims.ts compose): t = p.t + p.r (p.s * c.t), r = p.r c.r, s = p.s * c.s.
function compose(p: Frame, c: Frame): Frame {
  const rt = qrot(p.r, [p.s[0] * c.t[0], p.s[1] * c.t[1], p.s[2] * c.t[2]])
  return { t: [p.t[0] + rt[0], p.t[1] + rt[1], p.t[2] + rt[2]], r: qmul(p.r, c.r), s: [p.s[0] * c.s[0], p.s[1] * c.s[1], p.s[2] * c.s[2]] }
}

// MAMA math/quat.ts eulerDegFromQuat: three.js 'XYZ' Euler angles, in degrees.
function eulerDeg(q: Q4): V3 {
  const n = Math.hypot(q[0], q[1], q[2], q[3])
  const [x, y, z, w] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w)
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w), m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y)
  const ey = Math.asin(Math.min(1, Math.max(-1, m13)))
  let ex: number, ez: number
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33)
    ez = Math.atan2(-m12, m11)
  } else {
    ex = Math.atan2(m32, m22)
    ez = 0
  }
  const deg = 180 / Math.PI
  return [snap(ex * deg), snap(ey * deg), snap(ez * deg)]
}

// Prims colours are sRGB except emissive, which is linear (RAA README); MAMA stores sRGB hex for both.
function srgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function hex(c: readonly number[]): string {
  return '#' + c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
}

function materialDef(name: string, m: PrimMaterial): Obj {
  const values: Record<string, string | number> = {
    'in.base_color': hex(m.color), 'in.emissive': hex(m.emissive.map(srgb)), 'in.metallic': m.metallic, 'in.roughness': m.roughness,
  }
  const params: Record<string, string | number> = {}
  for (const k of Object.keys(values).sort()) if (values[k] !== OUTPUT_DEFAULTS[k]) params[k] = values[k]
  const out: Obj = { id: 'out', type: 'material.output' }
  if (Object.keys(params).length > 0) out.params = params
  return { name, graph: { nodes: [out], links: [] } }
}

// Every field of a MAMA SdfNode (NODE_DEFAULTS order), so the document needs no normalisation.
function sdfNode(id: string, name: string, kind: string, f: Frame, op: string, color: string, material: string | null): Obj {
  return {
    id, name, kind, visible: true, locked: false,
    transform: { position: f.t.map(snap), rotation: eulerDeg(f.r), scale: f.s.map(snap) },
    pivot: [0, 0, 0], pose: { translation: [0, 0, 0], rotation: [0, 0, 0] },
    op, smooth: 0, colorBlend: 'smooth', round: 0, roundStyle: 'round', shell: 0, noise: null,
    color, material, tags: [], rigid: false, lattice: null,
  }
}

function addNodes(prims: PrimsAsset, list: PrimNode[], nodes: Obj, used: Set<string>): string[] {
  return list.map(n => {
    const m = prims.materials[n.material]
    const node = sdfNode(n.id, n.id, n.kind, n.transform, n.op, hex(m.color), n.material)
    node.params = structuredClone(n.params)
    if (n.children) node.children = addNodes(prims, n.children, nodes, used)
    used.add(n.material)
    nodes[n.id] = node
    return n.id
  })
}

// One group subtree: the group carries the game fields (asset, mesher); MAMA keeps unknown node keys.
function documentOf(prims: PrimsAsset, id: string, path: string): Obj {
  const groupId = id.replace(/[.-]/g, '_')
  const nodes: Obj = {}
  const used = new Set<string>()
  const children = addNodes(prims, prims.nodes, nodes, used)
  if (Object.hasOwn(nodes, groupId)) refuse('asset', `${path}#/nodes`, `node id '${groupId}' is the group id of ${id}; rename the node`)
  const identity: Frame = { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }
  const group = sdfNode(groupId, prims.name, 'group', identity, 'union', GROUP_COLOR, null)
  Object.assign(group, { children, modifiers: [], asset: id, mesher: { ...MESHER } })
  const materials: Obj = {}
  for (const k of [...used].sort()) materials[k] = materialDef(k, prims.materials[k])
  return {
    format: 'sdfm', version: 2, name: prims.name, root: [groupId], nodes: { [groupId]: group, ...nodes },
    materials, shapes: {}, views: {}, settings: structuredClone(SETTINGS),
  }
}

// The S12 file form of a collider: flat arrays, as parseColliderJson reads them.
function flatCollider(c: ColliderSpec): Obj {
  const t = [c.t.x, c.t.y, c.t.z]
  const r = [c.r.x, c.r.y, c.r.z, c.r.w]
  switch (c.shape) {
    case 'cuboid': return { shape: c.shape, half: [c.half.x, c.half.y, c.half.z], t, r }
    case 'roundCuboid': return { shape: c.shape, half: [c.half.x, c.half.y, c.half.z], border: c.border, t, r }
    case 'ball': return { shape: c.shape, radius: c.radius, t, r }
    default: return { shape: c.shape, halfHeight: c.halfHeight, radius: c.radius, t, r }
  }
}

// Local half extents of a centred primitive (as raa-assets-tools bounds), capsule caps included.
function localHalf(n: PrimNode): V3 {
  const p = n.params as Record<string, number & number[]>
  switch (n.kind) {
    case 'sphere': return [p.radius, p.radius, p.radius]
    case 'box':
    case 'roundBox': return [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2]
    case 'capsule': return [p.radius, Math.max(p.height / 2, p.radius), p.radius]
    case 'cylinder': return [p.radius, p.height / 2, p.radius]
    case 'cone': { const r = Math.max(p.radiusBottom, p.radiusTop); return [r, p.height / 2, r] }
    case 'torus': return [p.majorRadius + p.minorRadius, p.minorRadius, p.majorRadius + p.minorRadius]
    case 'ellipsoid': return [p.radii[0], p.radii[1], p.radii[2]]
  }
}

// AABB of the union nodes under their composed transforms; subtract/intersect subtrees only remove matter.
function boundsOf(prims: PrimsAsset, path: string): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity]
  const max: V3 = [-Infinity, -Infinity, -Infinity]
  const walk = (list: PrimNode[], parent: Frame): void => {
    for (const n of list) {
      if (n.op !== 'union') continue
      const f = compose(parent, n.transform)
      const h = localHalf(n)
      for (let i = 0; i < 8; i++) {
        const c: V3 = [(i & 1 ? 1 : -1) * h[0] * f.s[0], (i & 2 ? 1 : -1) * h[1] * f.s[1], (i & 4 ? 1 : -1) * h[2] * f.s[2]]
        const w = qrot(f.r, c)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], f.t[a] + w[a])
          max[a] = Math.max(max[a], f.t[a] + w[a])
        }
      }
      if (n.children) walk(n.children, f)
    }
  }
  walk(prims.nodes, { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] })
  if (!Number.isFinite(min[0])) refuse('asset', `${path}#/nodes`, 'no union node; add a union node')
  return { min: min.map(snap) as V3, max: max.map(snap) as V3 }
}

function assetFile(prims: PrimsAsset, id: string, category: AssetCategory, world: World, path: string): Obj {
  const document = documentOf(prims, id, path)
  const anchors: Obj = {}
  for (const [k, a] of Object.entries(prims.anchors)) anchors[k] = { t: [...a.t], r: [...a.r] }
  return {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta', id, name: prims.name, category, world,
    mesher: { ...MESHER }, document, collision: collidersOf(prims, path).map(flatCollider), anchors,
    bounds: boundsOf(prims, path), hash: createHash('sha256').update(canonicalJson(document)).digest('hex'),
  }
}

// The podium step: one roundBox, white like the wall it replaces (PodiumStage tints it per place).
function podiumBlock(wall: PrimsAsset): PrimsAsset {
  return {
    format: 'raa.prims', version: 0, id: 'podium-block', name: 'Podium Block', budget: { ...PRIM_CAPS.defaultBudget },
    nodes: [{
      id: 'block', kind: 'roundBox', params: { size: [...BLOCK_SIZE], radius: BLOCK_RADIUS },
      transform: { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }, material: 'white', op: 'union',
    }],
    materials: { white: structuredClone(wall.materials.white) },
    anchors: {},
    collision: {
      mode: 'override',
      colliders: [{ node: null, shape: 'cuboid', params: { halfExtents: BLOCK_SIZE.map(v => v / 2) }, t: [0, 0, 0], r: [0, 0, 0, 1] }],
    },
  }
}

// Rotation about +Y that turns +Z to the spot's yaw (PodiumStage yawQuat).
function yawQuat(yawDeg: number): Q4 {
  const half = (yawDeg * Math.PI) / 360
  return [0, snap(Math.sin(half)), 0, snap(Math.cos(half))]
}

// The V0 podium as a course: every number comes from PODIUM_V0_LAYOUT, the match profiles or the v0 courses.
function podiumCourse(v0: Obj[]): Obj {
  const floorY = PODIUM_ORIGIN[1]
  // Beans stand on the blocks: they take the friction of the static floor tiles.
  const floors = v0.flatMap(c => c.obstacles as Obj[]).filter(o => o.asset === 'floor-tile' && (o.motion as Obj).kind === 'static')
  const frictions = [...new Set(floors.map(o => o.friction as number))]
  if (frictions.length !== 1) refuse('course', 'fixtures/courses', `static floor-tile frictions are [${frictions.join(', ')}]; the podium needs one shared value`)
  const obstacles = PODIUM_V0_LAYOUT.spots.map(({ t, yawDeg }, i) => {
    const top = t[1] - floorY
    return {
      id: `block-${i + 1}`, asset: BLOCK_ID, t: [t[0], floorY + top / 2, t[2]], r: yawQuat(yawDeg), s: [1, top / BLOCK_SIZE[1], 1],
      friction: frictions[0], motion: { kind: 'static' }, colliders: null,
    }
  })
  const { eye, target, fovYDeg } = PODIUM_V0_LAYOUT.camera
  return {
    format: 'royal-fiesta.course', version: 1, world: 'candy', id: 'podium', name: 'Podium', kind: 'podium', profiles: [],
    timeLimitS: Math.max(...Object.values(PROFILES).map(p => p.podiumTicks)) / TICK_RATE,
    killPlaneY: floorY + Math.min(...v0.map(c => c.killPlaneY as number)),
    spawns: [], checkpoints: [], finish: null, path: [], regions: [], queuePad: null, obstacles,
    decor: [], environment: null,
    podium: { spots: PODIUM_V0_LAYOUT.spots.map(s => ({ t: [...s.t], yawDeg: s.yawDeg })), camera: { eye: [...eye], target: [...target], fovYDeg } },
  }
}

function text(v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n'
}

async function readJson(root: string, rel: string): Promise<unknown> {
  return JSON.parse(await readFile(contentPath(rel, root), 'utf8'))
}

export async function buildContent(authored?: Authored): Promise<Map<string, string>> {
  const root = repoRoot()
  const registry = authored ?? readAuthored(root)
  const files: [string, string][] = []
  const primsByName = new Map<string, PrimsAsset>()
  for (const f of (await readdir(join(root, 'fixtures/assets'))).filter(f => f.endsWith('.prims.json')).sort()) {
    const name = f.slice(0, -'.prims.json'.length)
    const path = `fixtures/assets/${f}`
    const prims = parsePrims(await readJson(root, path), path)
    primsByName.set(name, prims)
    const asset = name === 'bean' ? assetFile(prims, 'penguin.body', 'character', 'common', path) : assetFile(prims, `candy.${name}`, 'obstacle', 'candy', path)
    files.push([assetFilePath(asset.world as World, asset.id as string), text(asset)])
  }
  const wall = primsByName.get('wall-block')
  if (!wall) refuse('asset', 'fixtures/assets/wall-block.prims.json', 'missing; the podium block takes its white material')
  files.push([assetFilePath('candy', BLOCK_ID), text(assetFile(podiumBlock(wall), BLOCK_ID, 'obstacle', 'candy', 'tools/placeholders.ts#podium-block'))])

  const v0: Obj[] = []
  for (const f of (await readdir(join(root, 'fixtures/courses'))).filter(f => f.endsWith('.course.json')).sort()) {
    const path = `fixtures/courses/${f}`
    const json = await readJson(root, path) as Obj
    v0.push(json)
    const v1 = migrateCourseV0(json, path)
    files.push([`courses/${String(v1.id)}.course.json`, text(v1)])
  }
  files.push(['courses/podium.course.json', text(podiumCourse(v0))])
  // Authored files are hand-made; the podium course still reads every v0 fixture above.
  return new Map(files.filter(([p]) => !isAuthored(registry, p)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}

async function listFiles(root: string, rel: string): Promise<string[]> {
  if (!existsSync(contentPath(rel, root))) return []
  const out: string[] = []
  for (const e of await readdir(contentPath(rel, root), { withFileTypes: true })) {
    const p = `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...await listFiles(root, p))
    else out.push(p)
  }
  return out
}

// Files under assets/ or courses/ that are neither generated nor authored.
async function staleFiles(root: string, content: Map<string, string>, authored: Authored): Promise<string[]> {
  const all = (await Promise.all(OUTPUT_DIRS.map(d => listFiles(root, d)))).flat()
  return all.filter(p => !content.has(p) && !isAuthored(authored, p)).sort()
}

async function main(argv: string[]): Promise<number> {
  const unknown = argv.filter(a => a !== '--check')
  if (unknown.length > 0) {
    console.error(`placeholders: unknown argument ${unknown[0]}; usage: tools/placeholders.ts [--check]`)
    return 2
  }
  const root = repoRoot()
  const authored = readAuthored(root)
  const content = await buildContent(authored)
  const stale = await staleFiles(root, content, authored)
  if (argv.includes('--check')) {
    const problems: string[] = []
    for (const [p, t] of content) {
      const file = contentPath(p, root)
      if (!existsSync(file)) problems.push(`missing ${p}`)
      else if (await readFile(file, 'utf8') !== t) problems.push(`differs ${p}`)
    }
    // Authored files are only checked for presence, never compared.
    for (const p of authored.files) if (!existsSync(contentPath(p, root))) problems.push(`missing ${p}`)
    for (const p of stale) problems.push(`stale ${p}`)
    if (problems.length === 0) {
      console.log(`placeholders: ${content.size} files up to date${authored.files.length > 0 ? ` (+${authored.files.length} authored)` : ''}`)
      return 0
    }
    for (const line of problems) console.error(line)
    console.error(`placeholders: ${problems.length} of ${content.size} files out of date; run node --experimental-strip-types tools/placeholders.ts`)
    return 1
  }
  for (const [p, t] of content) {
    await mkdir(dirname(contentPath(p, root)), { recursive: true })
    await writeFile(contentPath(p, root), t)
  }
  console.log(`placeholders: wrote ${content.size} files`)
  if (stale.length === 0) return 0
  // Never deletes: a stale file may be hand-made content.
  for (const p of stale) console.error(`stale ${p}`)
  console.error(`placeholders: ${stale.length} stale files; delete them or add their source`)
  return 1
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
