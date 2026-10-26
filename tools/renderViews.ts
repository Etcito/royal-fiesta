// Renders the S21 views with SDF Modeler's Node renderer (1.14 camera) into <input.out>/<subject>-<view>.png.
// The judge card runs it first: PNGs are never committed, so every fresh worktree renders its own.
import { contentPath } from './content.ts'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { decodePng } from '../apps/headless/src/gpuRecord.ts'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { repoRoot } from './bricks.ts'
import { loadAssetFile, mountedBounds, type AuthoredAsset } from './contentProbe.ts'
import { fuzzAndBloom, parseLegend, relight } from './viewGrade.ts'
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
  // A flat slab seen with the 0.25 x height rise is edge-on and its top vanishes: flat pieces look down 30 degrees.
  const flat = ext[1] < 0.3 * Math.max(ext[0], ext[2])
  const rise = flat ? dist * Math.tan(30 * Math.PI / 180) : 0.25 * ext[1]
  const position: V3 = [target[0] + dist * Math.sin(yaw), target[1] + rise, target[2] + dist * Math.cos(yaw)]
  return { position, target, fovYDeg: 30, ortho: false, orthoHeight: 0 }
}

export interface Rgba { width: number; height: number; data: Uint8Array }
const BACK_TOP: V3 = [244, 246, 250]
const BACK_BOTTOM: V3 = [208, 214, 224]

// Pixel of a world point seen by the camera (y down), or null behind it.
export function projectPoint(cam: Camera, p: V3, width: number, height: number): [number, number] | null {
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const unit = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l] }
  const f = unit(sub(cam.target, cam.position))
  const r = unit([-f[2], 0, f[0]])
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  const d = sub(p, cam.position)
  const z = dot(d, f)
  if (z <= 0) return null
  const t = Math.tan(cam.fovYDeg * Math.PI / 360) * z
  return [(dot(d, r) / (t * width / height) + 1) * width / 2, (1 - dot(d, u) / t) * height / 2]
}

// The renderer clears to one flat dark grey; the views sit on a light neutral studio gradient with a soft floor shadow
// instead (1.14 neutral background). Edge pixels are re-blended from their estimated coverage so no dark fringe stays.
export function stageOnBackdrop(img: Rgba, shadow: { cx: number; cy: number; rx: number; ry: number }): Rgba {
  const { width: w, height: h, data } = img
  const key = [data[0], data[1], data[2]]
  const isKey = (i: number): boolean => Math.abs(data[i * 4] - key[0]) + Math.abs(data[i * 4 + 1] - key[1]) + Math.abs(data[i * 4 + 2] - key[2]) <= 3
  const corners = [0, w - 1, (h - 1) * w, h * w - 1]
  if (!corners.every(isKey)) return img
  const out = new Uint8Array(data)
  const back = (x: number, y: number): V3 => {
    const t = y / (h - 1)
    const dx = (x - shadow.cx) / shadow.rx
    const dy = (y - shadow.cy) / shadow.ry
    const s = 1 - 0.38 * Math.exp(-2.2 * (dx * dx + dy * dy))
    return [0, 1, 2].map((c) => (BACK_TOP[c] + (BACK_BOTTOM[c] - BACK_TOP[c]) * t) * s) as V3
  }
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const b = back(x, y)
      if (isKey(i)) {
        for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(b[c])
        out[i * 4 + 3] = 255
        continue
      }
      // Edge pixel: step away from the key neighbours to an inner pixel and take coverage along key -> inner colour.
      let gx = 0
      let gy = 0
      for (const [ox, oy] of N4) {
        const nx = x + ox
        const ny = y + oy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && isKey(ny * w + nx)) { gx -= ox; gy -= oy }
      }
      if (gx === 0 && gy === 0) continue
      const qx = Math.min(w - 1, Math.max(0, x + 2 * Math.sign(gx)))
      const qy = Math.min(h - 1, Math.max(0, y + 2 * Math.sign(gy)))
      const q = qy * w + qx
      if (isKey(q)) continue
      let num = 0
      let den = 0
      for (let c = 0; c < 3; c++) {
        const pk = data[i * 4 + c] - key[c]
        const qk = data[q * 4 + c] - key[c]
        num += pk * qk
        den += qk * qk
      }
      const a = den > 0 ? Math.min(1, Math.max(0, num / den)) : 1
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(Math.min(255, Math.max(0, data[i * 4 + c] + (1 - a) * (b[c] - key[c]))))
    }
  }
  return { width: w, height: h, data: out }
}

// RGBA8 PNG, filter 0 on every row.
export function encodePng(img: Rgba): Uint8Array {
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height)
  for (let y = 0; y < img.height; y++) Buffer.from(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4)).copy(raw, y * (img.width * 4 + 1) + 1)
  const chunk = (type: string, body: Uint8Array): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))])
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

// A soft ellipse on the floor under the penguin's feet, as wide as the penguin seen from that yaw.
export function floorShadow(cam: Camera, b: { min: V3; max: V3 }, yawDeg: number, width: number, height: number): { cx: number; cy: number; rx: number; ry: number } {
  const cx = (b.min[0] + b.max[0]) / 2
  const cz = (b.min[2] + b.max[2]) / 2
  const r = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2
  const yaw = yawDeg * Math.PI / 180
  const c = projectPoint(cam, [cx, b.min[1], cz], width, height)
  const e = projectPoint(cam, [cx + r * Math.cos(yaw), b.min[1], cz - r * Math.sin(yaw)], width, height)
  if (c === null || e === null) refuse(AREA, 'camera', 'the floor is behind the view camera; check the bounds of the subject')
  const rx = Math.max(1, Math.hypot(e[0] - c[0], e[1] - c[1]))
  return { cx: c[0], cy: c[1], rx, ry: rx * 0.22 }
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

// Material name -> the `in.roughness` of its material.output node, for the gloss of the studio grade.
export function materialRoughness(doc: Obj): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of Object.values((doc.materials ?? {}) as Record<string, { name?: string; graph?: { nodes?: { type?: string; params?: Obj }[] } }>)) {
    const o = m.graph?.nodes?.find((n) => n.type === 'material.output')
    const r = o?.params?.['in.roughness']
    if (typeof m.name === 'string' && typeof r === 'number') out[m.name] = r
  }
  return out
}

// Material name -> the `in.base_color` of its material.output node as sRGB 0..1, for the candy hue of the studio grade.
export function materialBase(doc: Obj): Record<string, V3> {
  const out: Record<string, V3> = {}
  for (const m of Object.values((doc.materials ?? {}) as Record<string, { name?: string; graph?: { nodes?: { type?: string; params?: Obj }[] } }>)) {
    const c = m.graph?.nodes?.find((n) => n.type === 'material.output')?.params?.['in.base_color']
    if (typeof m.name !== 'string' || typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c)) continue
    const v = parseInt(c.slice(1), 16)
    out[m.name] = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
  }
  return out
}

const WORLDS = ['candy', 'ice', 'jungle', 'neon', 'common']
type XYZ = { x: number; y: number; z: number }
const aabb = (b: { min: XYZ; max: XYZ }): { min: V3; max: V3 } => ({ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] })

async function loadAsset(id: string, root: string): Promise<AuthoredAsset> {
  const hits = WORLDS.map((w) => `assets/${w}/${id}.asset.json`).filter((p) => existsSync(contentPath(p, root)))
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
      const doc = mergeDocuments(body.json.document as Obj, parts)
      const roughness = materialRoughness(doc)
      const base = materialBase(doc)
      const sdfm = await createSdfm({ doc })
      for (const v of s.views as ViewName[]) {
        const out = resolve(input.out, `${s.name}-${v}.png`)
        const t0 = Date.now()
        try {
          const camera = viewCamera(bounds, VIEW_YAWS[v])
          // The shaded image plus the normals and materials passes of the same camera feed the studio grade (viewGrade.ts).
          const pass = async (mode: string, file: string): Promise<{ img: Rgba; text: string }> => {
            const r = await sdfm.call('render', { camera, width: input.width, height: input.height, mode, out: file })
            const img = decodePng(new Uint8Array(readFileSync(file)), input.width, input.height, file)
            if (img.channels !== 4) refuse(AREA, file, `${img.channels} channels, expected RGBA; check the SDF Modeler render output`)
            return { img, text: r.text }
          }
          const shaded = await pass('shaded', out)
          const normals = await pass('normals', join(tmpdir(), `rf-views-${process.pid}-normals.png`))
          const materials = await pass('materials', join(tmpdir(), `rf-views-${process.pid}-materials.png`))
          const relit = relight({ shaded: shaded.img, normals: normals.img, materials: materials.img, legend: parseLegend(materials.text), roughness, base }, camera.position, camera.target)
          const staged = stageOnBackdrop(relit.img, floorShadow(camera, aabb(body.asset.bounds), VIEW_YAWS[v], input.width, input.height))
          writeFileSync(out, encodePng(fuzzAndBloom(staged, relit)))
          console.log(`[render] ${s.name}/${v} ${Date.now() - t0} ms: ${shaded.text.split(';')[0]}`)
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
