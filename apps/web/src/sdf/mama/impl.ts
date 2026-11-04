// The real MAMA facade, resolved by vite.config.ts as virtual:rf-mama when MAMA is present.
// Meshing runs in workers (mama/worker.ts); nothing of raa-sdfm needs main-thread initialisation
// here: the worker builds its upload payload and the renderer consumes it.
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { MESH_COMPATIBILITY } from '@etcito/mama/core/game/mesh-file.ts'
import { bakeTextureSize, GAME_RENDER_OPTION_SPECS, GAME_RENDER_SECTIONS, gameRenderOptionShown, gameRenderValueLabel,
  stepGameRenderOption, validateGameRenderOptions } from '@etcito/mama/core/game/render-options.ts'
import type { GraphicsContract } from '../../game/graphicsSettings.ts'
// The field evaluator the port's one per-pixel shading interpreter embeds (sdfPort.ts fieldEvaluator).
export { FIELD_PROGRAM_WGSL } from '@etcito/mama/core/paramesh/field-program-wgsl.ts'
// The game render-options contract as the SDF port applies it (shading field | vertex | baked, the bake sizes).
export const GAME_RENDER_OPTIONS = { validate: validateGameRenderOptions, specs: GAME_RENDER_OPTION_SPECS, bakeTextureSize }
import workerUrl from './worker.ts?worker&url'
import { classicWorker } from '../classicWorker.ts'
import type { MamaFacade, MeshedAsset, MeshRequest } from '../mamaApi.ts'
import { MeshPool } from '../meshPool.ts'
import type { WorkerLike } from '../meshPool.ts'

export const MAMA_PRESENT = true

// @etcito/raa-sdfm exports no version: vite.config.ts defines the installed one (tools/bricks.ts
// raaSdfmVersion), so the mesh cache key follows every raa-sdfm upgrade.
const RAA_SDFM_VERSION: string = __RF_RAA_SDFM__

// tools/bricks.ts is Node-only, so the absent prefix is repeated here, as in mamaAbsent.ts.
const MAMA_ABSENT_PREFIX = 'MAMA not available: '

function resolvedCommit(): string {
  // Vite's define value is a JavaScript expression: the JSON becomes an object, not a string.
  const value: unknown = typeof __RF_MAMA__ === 'undefined' ? undefined : __RF_MAMA__
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RefusalError('sdf', 'MAMA', MAMA_ABSENT_PREFIX + '__RF_MAMA__ is not an object; rebuild with apps/web/vite.config.ts')
  }
  const info = value as { kind?: unknown; commit?: unknown }
  if (typeof info.commit !== 'string' || info.commit === '') {
    throw new RefusalError('sdf', 'MAMA', MAMA_ABSENT_PREFIX + `no resolved commit; the ${String(info.kind)} MAMA checkout has no readable git HEAD, run npm run bricks -- fetch mama (see docs/bricks.md)`)
  }
  return info.commit
}

function spawnWorker(): WorkerLike {
  try {
    return classicWorker(new URL(workerUrl, import.meta.url).href) as unknown as WorkerLike
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RefusalError('sdf', 'MAMA worker', `${message}; this page cannot start a mesh worker`)
  }
}

export async function loadMama(): Promise<MamaFacade> {
  const mamaVersion = resolvedCommit()
  const createPool = (size: number): MeshPool => new MeshPool(size, spawnWorker)
  const meshOnce = async (req: MeshRequest): Promise<MeshedAsset> => {
    const pool = createPool(1)
    try {
      return await pool.mesh(req)
    } finally {
      pool.close()
    }
  }
  // The saved mesh and cache key version is MAMA's own (meshCache.ts holds no copy).
  return { mamaVersion, raaSdfmVersion: RAA_SDFM_VERSION, meshCompatibility: MESH_COMPATIBILITY, createPool, meshOnce }
}

// MAMA's game render-options contract, as the Graphics settings page reads it (game/graphicsSettings.ts).
export async function loadRenderOptions(): Promise<GraphicsContract> {
  return {
    specs: GAME_RENDER_OPTION_SPECS,
    sections: GAME_RENDER_SECTIONS,
    validate: validateGameRenderOptions,
    step: stepGameRenderOption,
    label: gameRenderValueLabel,
    shown: gameRenderOptionShown,
  } as unknown as GraphicsContract
}
