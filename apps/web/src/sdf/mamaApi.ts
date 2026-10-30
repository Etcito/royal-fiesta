// The MAMA facade as the page sees it. MAMA itself is private: it is reached only through the
// virtual module virtual:rf-mama (real impl when present, the mamaAbsent.ts stub otherwise).
import type { GameAsset, MesherOutput } from '@royal-fiesta/game/gameAsset'
import { RefusalError, isRefusal } from '@royal-fiesta/sim/refusal'
import type { MeshPool } from './meshPool.ts'

// tools/bricks.ts is Node-only, so the absent prefix is repeated here, as in mamaAbsent.ts.
const MAMA_ABSENT_PREFIX = 'MAMA not available: '

// parts: the document nodes (direct children of the asset group) that S12 physics bodies draw apart. When given,
// the payload holds one part per id, named by the id, so the port's part filter can address them.
export interface MeshRequest { assetId: string; hash: string; mesher: GameAsset['mesher']; document: Readonly<Record<string, unknown>>; parts?: readonly string[] }
// data = the @etcito/raa-sdfm upload payload (per-material mesh parts + compiled graph materials)
export interface MeshedAsset { assetId: string; hash: string; mesher: MesherOutput; parts: number; triangles: number; data: unknown; transfer: ArrayBuffer[] }
export function meshRequestOf(asset: GameAsset): MeshRequest {
  const parts = [...new Set((asset.physics?.bodies ?? []).flatMap(body => body.parts))]
  return { assetId: asset.id, hash: asset.hash, mesher: asset.mesher, document: asset.document, ...(parts.length > 0 ? { parts } : {}) }
}

// False for a mesh made before the asset's physics parts existed (an old cache entry or a saved single-part mesh).
export function meshHasParts(meshed: MeshedAsset, parts: readonly string[] | undefined): boolean {
  if (parts === undefined || parts.length === 0) return true
  const data = meshed.data as { groups?: { parts?: { name?: unknown }[] }[] } | null
  const names = new Set((data?.groups ?? []).flatMap(g => (g.parts ?? []).map(p => p.name)))
  return parts.every(part => names.has(part))
}

export interface MamaFacade { readonly mamaVersion: string; readonly raaSdfmVersion: string; createPool(size: number): MeshPool; meshOnce(req: MeshRequest): Promise<MeshedAsset> }

function absent(reason: string): RefusalError {
  return new RefusalError('sdf', 'MAMA', MAMA_ABSENT_PREFIX + reason + '; see docs/bricks.md')
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function shapeProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'loadMama() did not return an object'
  const f = v as Record<string, unknown>
  for (const k of ['mamaVersion', 'raaSdfmVersion']) {
    if (typeof f[k] !== 'string' || f[k] === '') return `loadMama() facade has no non-empty string ${k}`
  }
  for (const k of ['createPool', 'meshOnce']) {
    if (typeof f[k] !== 'function') return `loadMama() facade has no function ${k}`
  }
  return null
}

export async function loadMamaFacade(): Promise<MamaFacade> {
  let mod: { loadMama(): Promise<unknown> }
  try {
    // Imported here, not at the top, so Node tests can import this module.
    mod = await import('virtual:rf-mama')
  } catch (e) {
    throw absent(`virtual:rf-mama cannot be imported (${message(e)})`)
  }
  let facade: unknown
  try {
    facade = await mod.loadMama()
  } catch (e) {
    if (isRefusal(e)) throw e
    throw absent(`loadMama() failed (${message(e)})`)
  }
  const problem = shapeProblem(facade)
  if (problem !== null) throw absent(problem)
  return facade as MamaFacade
}
