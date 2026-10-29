// S24 saved mesh: assets/<world>/<id>.mesh, the meshWire bytes of a MeshedAsset plus its S16 key.
// The file is used iff key, assetId and hash match the asset and the mesh passes the mesh cache's
// shape check and RAA's mesh rules; an absent file or a stale one falls back to browser meshing.
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { MeshedAsset } from './mamaApi.ts'
import { meshIssues } from './meshValidity.ts'
import type { MeshArrays } from './meshValidity.ts'
import { decodeMesh } from './meshWire.ts'
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

/**
 * The saved mesh at url for this asset and S16 key, or null when there is none (404, network error,
 * any other non-OK answer) or it was made for another key, asset or hash (counted stale).
 * Throws RefusalError('sdf', url, ...) when the file cannot be decoded or breaks the mesh rules.
 */
export async function fetchMeshFile(url: string, key: string, asset: GameAsset, fetcher: typeof fetch = globalThis.fetch): Promise<KeyedMeshedAsset | null> {
  let response: Response
  try {
    response = await fetcher(url, { cache: 'no-cache' })
  } catch {
    return null
  }
  if (!response.ok) return null
  let value: KeyedMeshedAsset
  try {
    value = decodeMesh(new Uint8Array(await response.arrayBuffer()))
  } catch (e) {
    throw new RefusalError('sdf', url, `the saved mesh cannot be decoded (${e instanceof Error ? e.message : String(e)}); re-save the asset in SDF Modeler`)
  }
  if (typeof value !== 'object' || value === null) throw new RefusalError('sdf', url, 'the saved mesh header is not an object; re-save the asset in SDF Modeler')
  if (value.key !== key || value.assetId !== asset.id || value.hash !== asset.hash) {
    meshFileStats.stale++
    return null
  }
  const issues = validMeshed(value) ? payloadIssues(value.data) : ['the file is not a meshed asset (assetId, hash, parts, triangles, transfer)']
  if (issues.length > 0) {
    throw new RefusalError('sdf', url, `the saved mesh breaks the mesh rules (${issues.join('; ')}); re-save the asset in SDF Modeler`)
  }
  meshFileStats.hits++
  return value
}
