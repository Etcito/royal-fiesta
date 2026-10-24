// The MAMA facade as the page sees it. MAMA itself is private: it is reached only through the
// virtual module virtual:rf-mama (real impl when present, the mamaAbsent.ts stub otherwise).
import type { GameAsset, MesherOutput } from '@royal-fiesta/game/gameAsset'
import { RefusalError, isRefusal } from '@royal-fiesta/sim/refusal'
import type { MeshPool } from './meshPool.ts'

// tools/bricks.ts is Node-only, so the absent prefix is repeated here, as in mamaAbsent.ts.
const MAMA_ABSENT_PREFIX = 'MAMA not available: '

export interface MeshRequest { assetId: string; hash: string; mesher: GameAsset['mesher']; document: Readonly<Record<string, unknown>> }
// data = the @etcito/raa-sdfm upload payload (per-material mesh parts + compiled graph materials)
export interface MeshedAsset { assetId: string; hash: string; mesher: MesherOutput; parts: number; triangles: number; data: unknown; transfer: ArrayBuffer[] }
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
