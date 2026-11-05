// S24 saved mesh: assets/<world>/<id>.mesh, the meshWire bytes of a MeshedAsset plus its S16 key.
// The file is used iff key, assetId and hash match the asset and the mesh passes the mesh cache's
// shape check and RAA's mesh rules; only an absent file falls back to browser meshing.
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { MeshedAsset } from './mamaApi.ts'
import { meshIssues } from './meshValidity.ts'
import type { MeshArrays } from './meshValidity.ts'
import { decodeMeshBytes } from './meshWire.ts'
import type { KeyedMeshedAsset } from './meshWire.ts'

/** Files used (hits) and files found but made for another key, asset or hash (stale), in this page. */
export const meshFileStats: { hits: number; stale: number } = { hits: 0, stale: 0 }

// The same shape check MeshCache applies to a stored value.
function validMeshed(v: unknown): v is MeshedAsset {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return typeof m.assetId === 'string' && typeof m.hash === 'string' && Array.isArray(m.transfer) &&
    typeof m.parts === 'number' && typeof m.triangles === 'number'
}

// Every problem of the raa-sdfm payload (apps/web/src/sdf/mama/worker.ts): its groups, part frames and meshes.
function payloadIssues(data: unknown): string[] {
  const groups = (data as { groups?: unknown } | null)?.groups
  if (!Array.isArray(groups)) return ['payload: data.groups is not an array']
  const issues: string[] = []
  groups.forEach((group: { parts?: unknown }, g) => {
    if (!Array.isArray(group?.parts)) { issues.push(`payload: groups[${g}].parts is not an array`); return }
    group.parts.forEach((part: { frame?: unknown; meshes?: unknown }, p) => {
      const where = `groups[${g}].parts[${p}]`
      if (!(part?.frame instanceof Float64Array) || part.frame.length !== 16) issues.push(`payload: ${where}.frame is not 16 Float64 numbers`)
      if (!Array.isArray(part?.meshes)) { issues.push(`payload: ${where}.meshes is not an array`); return }
      part.meshes.forEach((m: Partial<MeshArrays>, i) => {
        const at = `${where}.meshes[${i}]`
        if (!(m?.positions instanceof Float32Array) || !(m.normals instanceof Float32Array) || !(m.indices instanceof Uint32Array) ||
          !(m.uvs === null || m.uvs instanceof Float32Array)) {
          issues.push(`payload: ${at} needs Float32Array positions/normals, Uint32Array indices and Float32Array or null uvs`)
          return
        }
        for (const issue of meshIssues(m as MeshArrays)) issues.push(`${at}: ${issue}`)
      })
    })
  })
  return issues
}

/** Why a decoded saved mesh cannot be used for this asset and key, the codes tools/savedMeshes.ts reports. */
export type MeshFileProblemCode = 'edited' | 'algorithm' | 'asset' | 'rules'
export interface MeshFileProblem { code: MeshFileProblemCode; message: string }

/**
 * The one check of a decoded saved mesh (fetchMeshFile and tools/savedMeshes.ts, so SDF Modeler's stale list is what
 * the page refuses): null when it is usable. Stale: made for another asset id, for an older asset hash (the asset was
 * edited since), or under another key with the same hash (mesher settings or MESH_COMPATIBILITY changed). Then the
 * mesh rules of the payload.
 */
export function meshFileProblem(value: unknown, key: string, asset: GameAsset): MeshFileProblem | null {
  if (typeof value !== 'object' || value === null) return { code: 'rules', message: 'the saved mesh header is not an object' }
  const v = value as KeyedMeshedAsset
  if (v.assetId !== asset.id) return { code: 'asset', message: `stale saved mesh (key, asset id or hash differs): made for asset '${String(v.assetId)}'` }
  if (v.hash !== asset.hash) return { code: 'edited', message: 'stale saved mesh (key, asset id or hash differs): the asset was edited since the mesh was saved' }
  if (v.key !== key) return { code: 'algorithm', message: 'stale saved mesh (key, asset id or hash differs): made with other mesher settings or an older mesh algorithm (MESH_COMPATIBILITY)' }
  const issues = validMeshed(v) ? payloadIssues(v.data) : ['the file is not a meshed asset (assetId, hash, parts, triangles, transfer)']
  if (issues.length > 0) return { code: 'rules', message: `the saved mesh breaks the mesh rules (${issues.join('; ')})` }
  return null
}

/**
 * The saved mesh at url for this asset and S16 key, or null when absent (404). Stale files, network failures and HTTP errors refuse.
 * Throws RefusalError('sdf', url, ...) when the file cannot be decoded or breaks the mesh rules.
 */
export async function fetchMeshFile(url: string, key: string, asset: GameAsset, fetcher: typeof fetch = globalThis.fetch): Promise<KeyedMeshedAsset | null> {
  let response: Response
  try {
    response = await fetcher(url, { cache: 'no-cache' })
  } catch (error) {
    throw new RefusalError('sdf', url, `cannot fetch saved mesh: ${String(error)}`)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new RefusalError('sdf', url, `saved mesh request failed: HTTP ${response.status}`)
  let value: KeyedMeshedAsset
  try {
    value = await decodeMeshBytes(new Uint8Array(await response.arrayBuffer()))
  } catch (e) {
    throw new RefusalError('sdf', url, `the saved mesh cannot be decoded (${e instanceof Error ? e.message : String(e)}); re-save the asset in SDF Modeler`)
  }
  const problem = meshFileProblem(value, key, asset)
  if (problem !== null) {
    if (problem.code !== 'rules') meshFileStats.stale++
    // A source armature can change without re-saving its cosmetics. Rebuild skin streams for that current rig.
    const nodes = (asset.document.nodes ?? {}) as Record<string, { rigRef?: unknown; asset?: { cosmetic?: { binding?: string } } }>
    if (problem.code === 'algorithm' && Object.values(nodes).some(n => n.rigRef || n.asset?.cosmetic?.binding === 'penguin')) return null
    throw new RefusalError('sdf', url, `${problem.message}; re-save the asset in SDF Modeler`)
  }
  meshFileStats.hits++
  return value
}
