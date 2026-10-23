// Renders the S21 views with SDF Modeler's Node renderer (1.14 camera) into <input.out>/<subject>-<view>.png.
// The judge card runs it first: PNGs are never committed, so every fresh worktree renders its own.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { repoRoot } from './bricks.ts'
import { loadAssetFile, mountedBounds, type AuthoredAsset } from './contentProbe.ts'
import { VIEW_YAWS, type ViewName, type ViewsInput } from './viewsRecord.ts'

const AREA = 'render-views'
const USAGE = 'usage: node --experimental-strip-types tools/renderViews.ts <views.input.json>'
const SDFM_NAME = 'SDF_Modeler_MCP'
// What the sdfm Node build needs; the rest of the checkout (fixtures, bench, out) is never read.
const SDFM_COPY = ['src', 'scripts', 'bin', 'package.json', 'tsconfig.node.json']
const SDFM_LINK = ['node_modules', 'vendor']

type V3 = [number, number, number]
type Obj = Record<string, unknown>
export interface Camera { position: V3; target: V3; fovYDeg: number; ortho: false; orthoHeight: number }
interface Sdfm { call(name: string, input?: unknown): Promise<{ text: string }>; close(): Promise<void> }

// 1.14: target = bounds centre, distance = 1.1 x diagonal / (2 tan 15deg), eye raised by 0.25 x height.
export function viewCamera(bounds: { min: V3; max: V3 }, yawDeg: number): Camera {
  const { min, max } = bounds
  const target: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const dist = 1.1 * Math.hypot(ext[0], ext[1], ext[2]) / (2 * Math.tan(15 * Math.PI / 180))
  const yaw = yawDeg * Math.PI / 180
  const position: V3 = [target[0] + dist * Math.sin(yaw), target[1] + 0.25 * ext[1], target[2] + dist * Math.cos(yaw)]
  return { position, target, fovYDeg: 30, ortho: false, orthoHeight: 0 }
}

// The penguin document plus each costume's nodes, shifted by its mount offset (anchors carry identity rotation, 1.12).
export function mergeDocuments(body: Obj, costumes: { document: Obj; offset: V3; rel: string }[]): Obj {
  const nodes: Obj = { ...(body.nodes as Obj) }
  const materials: Obj = { ...(body.materials as Obj) }
  const root = [...(body.root as string[])]
  for (const c of costumes) {
    const cn = c.document.nodes as Obj
    const cm = c.document.materials as Obj
    for (const k of Object.keys(cn)) if (k in nodes) refuse(AREA, `${c.rel}#/document/nodes/${k}`, 'node id also used by the penguin; re-save the costume with unique node ids')
    for (const k of Object.keys(cm)) if (k in materials) refuse(AREA, `${c.rel}#/document/materials/${k}`, 'material id also used by the penguin; re-save the costume with unique material ids')
    Object.assign(nodes, cn)
    Object.assign(materials, cm)
    for (const id of c.document.root as string[]) {
      if (c.offset.some((v) => v !== 0)) {
        const n = nodes[id] as Obj
        const tr = (n.transform ?? {}) as Obj
        const p = (tr.position ?? [0, 0, 0]) as V3
        nodes[id] = { ...n, transform: { ...tr, position: [p[0] + c.offset[0], p[1] + c.offset[1], p[2] + c.offset[2]] } }
      }
      root.push(id)
    }
  }
  return { ...body, nodes, materials, root }
}

function union(a: { min: V3; max: V3 }, b: { min: V3; max: V3 }): { min: V3; max: V3 } {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }
}

// SDFM_DIR, then $RF_BRICKS_DIR/SDF_Modeler_MCP, then the folder next to this repository.
function sdfmDir(root: string): string {
  const tries = [
    ...(process.env.SDFM_DIR ? [process.env.SDFM_DIR] : []),
    ...(process.env.RF_BRICKS_DIR ? [join(process.env.RF_BRICKS_DIR, SDFM_NAME)] : []),
    join(dirname(root), SDFM_NAME),
  ]
  const hit = tries.find((d) => existsSync(join(d, 'bin/sdfm.mjs')))
  if (hit === undefined) refuse(AREA, SDFM_NAME, `no SDF Modeler checkout (tried ${tries.join(', ')}); set SDFM_DIR to an SDF Modeler checkout with node_modules`)
  return hit
}

// The sibling checkout is read-only, so its Node side is compiled in a temp copy keyed by its commit.
async function sdfmApi(src: string): Promise<{ createSdfm(o: { doc: Obj }): Promise<Sdfm> }> {
  let head = 'local'
  try { head = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
  const dir = join(tmpdir(), `rf-sdfm-${head.slice(0, 12)}`)
  const api = join(dir, 'build-node/node/api.js')
  if (!existsSync(api)) {
    mkdirSync(dir, { recursive: true })
    for (const p of SDFM_COPY) cpSync(join(src, p), join(dir, p), { recursive: true })
    for (const p of SDFM_LINK) if (!existsSync(join(dir, p)) && existsSync(join(src, p))) symlinkSync(join(src, p), join(dir, p))
    console.log(`[render] compiling SDF Modeler ${head.slice(0, 12)} in ${dir}`)
    const proof = await import(pathToFileURL(join(dir, 'scripts/lib/proof.mjs')).href)
    proof.compileNode()
  }
  return import(pathToFileURL(api).href)
}

const WORLDS = ['candy', 'ice', 'jungle', 'neon', 'common']
type XYZ = { x: number; y: number; z: number }
const aabb = (b: { min: XYZ; max: XYZ }): { min: V3; max: V3 } => ({ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] })

async function loadAsset(id: string, root: string): Promise<AuthoredAsset> {
  const hits = WORLDS.map((w) => `assets/${w}/${id}.asset.json`).filter((p) => existsSync(join(root, p)))
  if (hits.length !== 1) refuse(AREA, `assets/<world>/${id}.asset.json`, `${hits.length} files for asset '${id}'; save exactly one`)
  return loadAssetFile(hits[0])
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 1) refuse(AREA, 'argv', `expected one input file; ${USAGE}`)
    const root = repoRoot()
    const input = JSON.parse(readFileSync(argv[0], 'utf8')) as ViewsInput
    if (input.format !== 'royal-fiesta.views-input') refuse(AREA, `${argv[0]}#/format`, 'not a views input; pass a proofs/cN/views.input.json file')
    // An empty NMC_GPU_URL makes sdfm render in Node instead of sending a job to the GPU host.
    process.env.NMC_GPU_URL = ''
    const { createSdfm } = await sdfmApi(sdfmDir(root))
    let failed = 0
    for (const s of input.subjects) {
      const [bodyId, ...costumeIds] = s.assets
      const body = await loadAsset(bodyId, root)
      const costumes = await Promise.all(costumeIds.map((id) => loadAsset(id, root)))
      let bounds = aabb(body.asset.bounds)
      const parts = costumes.map((c) => {
        const m = mountedBounds(c, body)
        bounds = union(bounds, m)
        const cb = aabb(c.asset.bounds)
        return { document: c.json.document as Obj, offset: [m.min[0] - cb.min[0], m.min[1] - cb.min[1], m.min[2] - cb.min[2]] as V3, rel: c.rel }
      })
      const sdfm = await createSdfm({ doc: mergeDocuments(body.json.document as Obj, parts) })
      for (const v of s.views as ViewName[]) {
        const out = resolve(input.out, `${s.name}-${v}.png`)
        const t0 = Date.now()
        try {
          const r = await sdfm.call('render', { camera: viewCamera(bounds, VIEW_YAWS[v]), width: input.width, height: input.height, out })
          console.log(`[render] ${s.name}/${v} ${Date.now() - t0} ms: ${r.text.split(';')[0]}`)
        } catch (e) {
          console.error(`[render] ${s.name}/${v}: ${(e as Error).message}`)
          failed++
        }
      }
      await sdfm.close()
    }
    return failed === 0 ? 0 : 1
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
// Dawn keeps the event loop alive, so the CLI exits explicitly.
if (import.meta.url === entry) process.exit(await main(process.argv.slice(2)))
