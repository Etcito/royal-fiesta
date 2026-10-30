/// <reference types="vite/client" />
// MAMA mesh worker core: one MeshRequest -> one MeshedAsset. The payload is the upload shape of
// @etcito/raa-sdfm's meshDocument (per-material mesh parts + the compiled graph materials), so the
// render path can hand it to RAA without remeshing. The MAMA calls are the ones that package makes.
import { RefusalError, isRefusal } from '@royal-fiesta/sim/refusal'
import type { MeshedAsset, MeshRequest } from '../mamaApi.ts'
import { meshIssues, repairMesh } from '../meshValidity.ts'
import type { SdfmCompiledMaterial } from '@etcito/raa-sdfm'
import { readSdfm } from '@etcito/mama/sdfm.ts'
import type { BuiltMaterial } from '@etcito/mama/sdfm.ts'
import { meshAssets } from '@etcito/mama/core/game/mesh-assets.ts'
import type { AssetMeshResult } from '@etcito/mama/core/game/mesh-assets.ts'
import { BASE_WGSL, HELPERS } from '@etcito/mama/core/material-graph/helpers.ts'
import { COMMON_NO_PROGRAM_WGSL } from '@etcito/mama/gpu/wgsl/common.ts'
import { sha256Hex } from '@etcito/mama/core/image/sha256.ts'
import { ensureMesher, setMesherWasm } from '@etcito/mama/core/paramesh/runtime.ts'
import { inlinePool } from '@etcito/mama/core/compute/pool.ts'
import type { GroupMesher, SdfDocument } from '@etcito/mama/core/doc/types.ts'

// MaterialFull fields in declaration order (MAMA core/material-graph/wgsl-parts.ts). The renderer
// reads exactly these names out of every compiled graph material.
const MATERIAL_FULL_FIELDS = ['base_color', 'metallic', 'roughness', 'emissive', 'height'] as const

interface PayloadMesh {
  material: string | null
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array | null
  indices: Uint32Array
}

// S18 joint/weight streams of a skinned part, in the vertex order the render port concatenates its meshes.
interface PayloadSkin { joints: Uint16Array; weights: Float32Array }

interface PayloadPart {
  partId: string
  name: string
  frame: Float64Array
  meshes: PayloadMesh[]
  skin?: PayloadSkin
}

interface PayloadGroup { group: string; parts: PayloadPart[] }

interface BuiltPayload { groups: PayloadGroup[]; materials: BuiltMaterial[] }

// One promise per worker (and per Node process): manifold.wasm loads once, not once per asset.
let mesherReady: Promise<void> | null = null

function ensureMesherOnce(): Promise<void> {
  mesherReady ??= initMesher()
  return mesherReady
}

async function initMesher(): Promise<void> {
  // In a page/worker Vite bundles the wasm of the MAMA checkout; in Node manifold-3d finds its own.
  if ((globalThis as { process?: unknown }).process === undefined) {
    const wasm = (await import('manifold-3d/manifold.wasm?url')) as { default: string }
    setMesherWasm(wasm.default)
  }
  await ensureMesher()
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

// Resolve graph helpers with dependencies first. MAMA's shared shader prelude is supplied
// separately: graph helpers assume its noise/hash functions without listing them as dependencies.
function resolveHelpers(ids: readonly string[], material: string): { id: string; wgsl: string }[] {
  const out: { id: string; wgsl: string }[] = []
  const done = new Set<string>()
  const visit = (id: string, chain: readonly string[]): void => {
    if (done.has(id)) return
    const helper = Object.prototype.hasOwnProperty.call(HELPERS, id) ? HELPERS[id as keyof typeof HELPERS] : undefined
    if (helper === undefined || typeof helper.code !== 'string') {
      throw new RefusalError('sdf', material, `material '${material}': helper '${id}' has no WGSL source in MAMA; pick a material whose graph uses a MAMA helper`)
    }
    if (chain.includes(id)) {
      throw new RefusalError('sdf', material, `material '${material}': helper '${id}' depends on itself; fix the material graph in SDF Modeler`)
    }
    for (const dep of [...(helper.deps ?? [])].sort()) visit(dep, [...chain, id])
    done.add(id)
    // Some MAMA revisions also expose the common hash/noise code as graph helpers.
    // Only omit byte-identical source already supplied by the prelude, never by name alone.
    if (!COMMON_NO_PROGRAM_WGSL.includes(helper.code.trim())) out.push({ id, wgsl: helper.code })
  }
  for (const id of [...ids].sort()) visit(id, [])
  return out
}

async function toPayloadMaterial(built: BuiltMaterial): Promise<SdfmCompiledMaterial> {
  if (built.graph === null) {
    const why = built.error === null ? 'no compiled graph' : `${built.error.code}: ${built.error.message}`
    throw new RefusalError('sdf', built.id, `material '${built.id}' was not built by MAMA (${why}); fix the material graph in SDF Modeler`)
  }
  const body = built.graph.wgslBody
  const helpers = [
    { id: 'common', wgsl: COMMON_NO_PROGRAM_WGSL },
    { id: 'base', wgsl: BASE_WGSL },
    ...resolveHelpers(built.graph.helpers, built.id),
  ]
  const constants = Array.from(built.graph.constants)
  const fields = [...MATERIAL_FULL_FIELDS]
  const key = sha256Hex(new TextEncoder().encode(canonicalJson({ body, helpers, constants, fields })))
  return { name: built.id, key, body, helpers, constants, fields }
}

function groupName(doc: SdfDocument, group: string): string {
  const node = doc.nodes[group]
  return node !== undefined && node.name !== '' ? node.name : group
}

// First refused group in result order wins: no other mesher is ever tried.
function throwFirstRefusal(results: readonly AssetMeshResult[], doc: SdfDocument, assetId: string): void {
  for (const result of results) {
    if (result.error === null) continue
    const name = groupName(doc, result.group)
    const reason = result.error.fix !== '' ? `${result.error.message}; ${result.error.fix}` : result.error.message
    throw new RefusalError('mesher', `${assetId}#group:${name}`, reason)
  }
}

// MAMA's meshers can leave collapsed triangles and zero-length normals (the poly output's SDF-gradient
// normal is zero on some cut faces, docs/brick-gaps.md). RAA refuses a zero normal, so a sub-mesh that
// breaks its rules loses its degenerate triangles, gets those normals rebuilt from the triangles around
// the vertex and drops unused vertices; anything still invalid after that is a mesher refusal.
// A skinned sub-mesh keeps its joints and weights through the repair: the repair renumbers vertices (first use
// order), so the source vertex number rides in the uvs and the uvs, joints and weights are gathered by it.
function toPayloadMesh(sub: AssetMeshResult['parts'][number]['subMeshes'][number], where: string): { mesh: PayloadMesh; skin: PayloadSkin | null } | null {
  const mesh = { positions: sub.positions, normals: sub.normals, uvs: sub.uvs ?? null, indices: sub.indices }
  const skin = sub.skin === undefined ? null : { joints: sub.skin.joints, weights: sub.skin.weights }
  if (meshIssues(mesh).length === 0) return { mesh: { material: sub.material, ...mesh }, skin }
  const probe = skin === null ? mesh : { ...mesh, uvs: Float32Array.from({ length: (mesh.positions.length / 3) * 2 }, (_, i) => (i & 1) === 0 ? i / 2 : 0) }
  let repaired: ReturnType<typeof repairMesh>
  try {
    repaired = repairMesh(probe, where)
  } catch (e) {
    throw new RefusalError('mesher', where, e instanceof Error ? e.message : String(e))
  }
  if (repaired === null) return null
  let out = repaired.mesh
  let outSkin: PayloadSkin | null = null
  if (skin !== null) {
    const ids = out.uvs!
    const m = ids.length / 2
    const uvs = mesh.uvs === null ? null : new Float32Array(m * 2)
    outSkin = { joints: new Uint16Array(m * 4), weights: new Float32Array(m * 4) }
    for (let r = 0; r < m; r++) {
      const v = ids[2 * r]
      uvs?.set(mesh.uvs!.subarray(2 * v, 2 * v + 2), 2 * r)
      outSkin.joints.set(skin.joints.subarray(4 * v, 4 * v + 4), 4 * r)
      outSkin.weights.set(skin.weights.subarray(4 * v, 4 * v + 4), 4 * r)
    }
    out = { ...out, uvs }
  }
  const issues = meshIssues(out)
  if (issues.length > 0) {
    throw new RefusalError('mesher', where, `the mesh breaks RAA's mesh rules (${issues.join('; ')}); re-save the asset in SDF Modeler`)
  }
  return { mesh: { material: sub.material, ...out }, skin: outSkin }
}

// The part skin in apps/web/src/sdf/sdfPort.ts partMesh order: meshes grouped by material, in first-use order.
// Absent unless every mesh of the part is skinned.
function partSkin(meshes: readonly { mesh: PayloadMesh; skin: PayloadSkin | null }[]): PayloadSkin | undefined {
  if (meshes.length === 0 || meshes.some(m => m.skin === null)) return undefined
  const materials = [...new Set(meshes.map(m => m.mesh.material))]
  const ordered = materials.flatMap(material => meshes.filter(m => m.mesh.material === material))
  const vertices = ordered.reduce((n, m) => n + m.mesh.positions.length / 3, 0)
  const skin = { joints: new Uint16Array(vertices * 4), weights: new Float32Array(vertices * 4) }
  let base = 0
  for (const m of ordered) {
    skin.joints.set(m.skin!.joints, base * 4)
    skin.weights.set(m.skin!.weights, base * 4)
    base += m.mesh.positions.length / 3
  }
  return skin
}

function toPayload(results: readonly AssetMeshResult[], doc: SdfDocument, assetId: string): { data: BuiltPayload; parts: number; triangles: number } {
  const groups: PayloadGroup[] = []
  const materials = new Map<string, BuiltMaterial>()
  let parts = 0
  let triangles = 0
  for (const result of results) {
    const payloadParts: PayloadPart[] = []
    for (const part of result.parts) {
      parts += 1
      const built: { mesh: PayloadMesh; skin: PayloadSkin | null }[] = []
      for (const sub of part.subMeshes) {
        const where = `${assetId}#group:${groupName(doc, result.group)}/${part.name}/${sub.material ?? 'no material'}`
        const mesh = toPayloadMesh(sub, where)
        if (mesh === null) continue
        triangles += mesh.mesh.indices.length / 3
        built.push(mesh)
      }
      const skin = partSkin(built)
      payloadParts.push({ partId: part.partId, name: part.name, frame: part.frame, meshes: built.map(m => m.mesh), ...(skin ? { skin } : {}) })
    }
    groups.push({ group: result.group, parts: payloadParts })
    for (const built of result.materials) if (!materials.has(built.id)) materials.set(built.id, built)
  }
  return { data: { groups, materials: [...materials.values()] }, parts, triangles }
}

function transferOf(groups: readonly PayloadGroup[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  const add = (array: ArrayBufferView): void => {
    if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer)
  }
  for (const group of groups) {
    for (const part of group.parts) {
      add(part.frame)
      if (part.skin !== undefined) {
        add(part.skin.joints)
        add(part.skin.weights)
      }
      for (const mesh of part.meshes) {
        add(mesh.positions)
        add(mesh.normals)
        if (mesh.uvs !== null) add(mesh.uvs)
        add(mesh.indices)
      }
    }
  }
  return [...buffers]
}

// The asset mesher fills in the groups the document leaves without one; a declared group mesher and
// its params always win over the document settings (MAMA's resolveMesherSettings).
function applyAssetMesher(doc: SdfDocument, mesher: MeshRequest['mesher']): void {
  for (const id of Object.keys(doc.nodes)) {
    const node = doc.nodes[id]
    if (node.kind === 'group' && node.asset !== undefined && node.mesher === undefined) {
      node.mesher = mesher as unknown as GroupMesher
    }
  }
}

// A game asset with S12 physics draws each body from named document nodes. MAMA meshes a group asset as one part, so
// each requested node is meshed alone (the asset group with that one child) and becomes a part named by its node id.
// A hidden node (collider) has no triangle: it stays a part with no mesh, so the port still knows its name.
async function meshByParts(doc: SdfDocument, parts: readonly string[], assetId: string): Promise<AssetMeshResult[]> {
  const pool = inlinePool()
  const groups = Object.keys(doc.nodes).filter(id => doc.nodes[id].kind === 'group' && doc.nodes[id].asset !== undefined)
  const out: AssetMeshResult[] = []
  for (const group of groups) {
    const node = doc.nodes[group]
    const children = node.children ?? []
    const mine = parts.filter(part => children.includes(part))
    if (mine.length === 0) {
      out.push(...await meshAssets(doc, { groups: [group], pool }))
      continue
    }
    const combined: AssetMeshResult = { group, asset: node.asset ?? null, output: node.mesher?.output ?? (doc.settings.export.geometry as AssetMeshResult['output']), parts: [], materials: [], error: null }
    const materials = new Map<string, BuiltMaterial>()
    for (const part of mine) {
      if (doc.nodes[part].visible === false) {
        combined.parts.push({ partId: part, name: part, frame: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), subMeshes: [] })
        continue
      }
      const variant: SdfDocument = { ...doc, nodes: { ...doc.nodes, [group]: { ...node, children: [part] } } }
      const results = await meshAssets(variant, { groups: [group], pool })
      throwFirstRefusal(results, doc, assetId)
      for (const result of results) {
        for (const built of result.materials) materials.set(built.id, built)
        for (const p of result.parts) combined.parts.push({ ...p, partId: part, name: part })
      }
    }
    combined.materials = [...materials.values()].sort((a, b) => a.id < b.id ? -1 : 1)
    out.push(combined)
  }
  return out
}

export async function meshRequest(req: MeshRequest): Promise<MeshedAsset> {
  const doc = readSdfm(req.document)
  applyAssetMesher(doc, req.mesher)
  await ensureMesherOnce()
  const results = req.parts !== undefined && req.parts.length > 0
    ? await meshByParts(doc, req.parts, req.assetId)
    : await meshAssets(doc, { pool: inlinePool() })
  throwFirstRefusal(results, doc, req.assetId)
  if (results.length === 0) {
    throw new RefusalError('sdf', req.assetId, 'the document has no group with a game asset; save the asset from SDF Modeler or mark its group as a game asset')
  }
  const { data, parts, triangles } = toPayload(results, doc, req.assetId)
  const materials: SdfmCompiledMaterial[] = []
  for (const material of data.materials) materials.push(await toPayloadMaterial(material))
  return {
    assetId: req.assetId,
    hash: req.hash,
    mesher: req.mesher.output,
    parts,
    triangles,
    data: { groups: data.groups, materials },
    transfer: transferOf(data.groups),
  }
}

// Check the dedicated-worker constructor so shared/service workers never install this protocol.
interface MeshScope {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

function workerScope(): MeshScope | null {
  const g = globalThis as unknown as Partial<MeshScope> & {
    DedicatedWorkerGlobalScope?: { new (...args: never[]): MeshScope }
  }
  if (typeof g.DedicatedWorkerGlobalScope !== 'function' || !(g instanceof g.DedicatedWorkerGlobalScope)) return null
  return g as MeshScope
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// The protocol of apps/web/src/sdf/meshPool.ts, exactly: { id, req } in, { id, ok, ... } out.
async function answer(scope: MeshScope, data: unknown): Promise<void> {
  if (typeof data !== 'object' || data === null) return
  const message = data as { id?: unknown; req?: unknown }
  if (typeof message.id !== 'number') return
  if (typeof message.req !== 'object' || message.req === null) return
  const id = message.id
  const req = message.req as MeshRequest
  try {
    const value = await meshRequest(req)
    scope.postMessage({ id, ok: true, value }, value.transfer)
  } catch (e) {
    if (isRefusal(e)) {
      scope.postMessage({ id, ok: false, area: e.area, path: e.path, reason: e.reason })
    } else {
      scope.postMessage({ id, ok: false, area: 'sdf', path: req.assetId, reason: messageOf(e) })
    }
  }
}

const scope = workerScope()
if (scope !== null) {
  scope.onmessage = (event) => {
    void answer(scope, event.data)
  }
}
