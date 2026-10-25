/// <reference types="vite/client" />
// MAMA mesh worker core: one MeshRequest -> one MeshedAsset. The payload is the upload shape of
// @etcito/raa-sdfm's meshDocument (per-material mesh parts + the compiled graph materials), so the
// render path can hand it to RAA without remeshing. The MAMA calls are the ones that package makes.
import { RefusalError, isRefusal } from '@royal-fiesta/sim/refusal'
import type { MeshedAsset, MeshRequest } from '../mamaApi.ts'
import type { SdfmCompiledMaterial } from '@etcito/raa-sdfm'
import { readSdfm } from '@etcito/mama/sdfm.ts'
import type { BuiltMaterial } from '@etcito/mama/sdfm.ts'
import { meshAssets } from '@etcito/mama/core/game/mesh-assets.ts'
import type { AssetMeshResult } from '@etcito/mama/core/game/mesh-assets.ts'
import { BASE_WGSL, HELPERS } from '@etcito/mama/core/material-graph/helpers.ts'
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

interface PayloadPart {
  partId: string
  name: string
  frame: Float64Array
  meshes: PayloadMesh[]
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
    const wasm = (await import('../../../../../.bricks/MAMA/node_modules/manifold-3d/manifold.wasm?url')) as { default: string }
    setMesherWasm(wasm.default)
  }
  await ensureMesher()
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

// Same order and dedupe as @etcito/raa-sdfm's toMamaMaterial: BASE_WGSL first, then each helper
// with its dependencies first. A helper MAMA cannot render refuses, never silently disappears.
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
    for (const dep of helper.deps ?? []) visit(dep, [...chain, id])
    done.add(id)
    out.push({ id, wgsl: helper.code })
  }
  for (const id of ids) visit(id, [])
  return out
}

async function toPayloadMaterial(built: BuiltMaterial): Promise<SdfmCompiledMaterial> {
  if (built.graph === null) {
    const why = built.error === null ? 'no compiled graph' : `${built.error.code}: ${built.error.message}`
    throw new RefusalError('sdf', built.id, `material '${built.id}' was not built by MAMA (${why}); fix the material graph in SDF Modeler`)
  }
  const body = built.graph.wgslBody
  const helpers = [{ id: 'base', wgsl: BASE_WGSL }, ...resolveHelpers(built.graph.helpers, built.id)]
  const constants = Array.from(built.graph.constants)
  const fields = [...MATERIAL_FULL_FIELDS]
  const key = sha256Hex(new TextEncoder().encode(canonicalJson({ body, helpers, constants, fields })))
  return { name: built.id, key, body, helpers, constants, fields }
}

// First refused group in result order wins: no other mesher is ever tried.
function throwFirstRefusal(results: readonly AssetMeshResult[], doc: SdfDocument, assetId: string): void {
  for (const result of results) {
    if (result.error === null) continue
    const node = doc.nodes[result.group]
    const name = node !== undefined && node.name !== '' ? node.name : result.group
    const reason = result.error.fix !== '' ? `${result.error.message}; ${result.error.fix}` : result.error.message
    throw new RefusalError('mesher', `${assetId}#group:${name}`, reason)
  }
}

function toPayload(results: readonly AssetMeshResult[]): { data: BuiltPayload; parts: number; triangles: number } {
  const groups: PayloadGroup[] = []
  const materials = new Map<string, BuiltMaterial>()
  let parts = 0
  let triangles = 0
  for (const result of results) {
    const payloadParts: PayloadPart[] = []
    for (const part of result.parts) {
      parts += 1
      const meshes: PayloadMesh[] = part.subMeshes.map((sub) => {
        triangles += sub.indices.length / 3
        return {
          material: sub.material,
          positions: sub.positions,
          normals: sub.normals,
          uvs: sub.uvs ?? null,
          indices: sub.indices,
        }
      })
      payloadParts.push({ partId: part.partId, name: part.name, frame: part.frame, meshes })
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

export async function meshRequest(req: MeshRequest): Promise<MeshedAsset> {
  const doc = readSdfm(req.document)
  applyAssetMesher(doc, req.mesher)
  await ensureMesherOnce()
  const results = await meshAssets(doc, { pool: inlinePool() })
  throwFirstRefusal(results, doc, req.assetId)
  if (results.length === 0) {
    throw new RefusalError('sdf', req.assetId, 'the document has no group with a game asset; save the asset from SDF Modeler or mark its group as a game asset')
  }
  const { data, parts, triangles } = toPayload(results)
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
