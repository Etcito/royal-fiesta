// The real MAMA facade, resolved by vite.config.ts as virtual:rf-mama when MAMA is present.
// Meshing runs in workers (mama/worker.ts); nothing of raa-sdfm needs main-thread initialisation
// here: the worker builds its upload payload and the renderer consumes it.
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { MamaFacade, MeshedAsset, MeshRequest } from '../mamaApi.ts'
import { MeshPool } from '../meshPool.ts'
import type { WorkerLike } from '../meshPool.ts'

export const MAMA_PRESENT = true

// @etcito/raa-sdfm exports no version. Keep this equal to its version pinned in
// apps/web/package.json (0.1.0 is the raa-sdfm the worker payload follows; no release pin yet).
const RAA_SDFM_VERSION = '0.1.0'

// tools/bricks.ts is Node-only, so the absent prefix is repeated here, as in mamaAbsent.ts.
const MAMA_ABSENT_PREFIX = 'MAMA not available: '

function resolvedCommit(): string {
  let info: { kind?: unknown; commit?: unknown }
  try {
    info = JSON.parse(__RF_MAMA__) as { kind?: unknown; commit?: unknown }
  } catch {
    throw new RefusalError('sdf', 'MAMA', MAMA_ABSENT_PREFIX + '__RF_MAMA__ is not JSON; rebuild with apps/web/vite.config.ts')
  }
  if (typeof info.commit !== 'string' || info.commit === '') {
    throw new RefusalError('sdf', 'MAMA', MAMA_ABSENT_PREFIX + `no resolved commit; the ${String(info.kind)} MAMA checkout has no readable git HEAD, run npm run bricks -- fetch mama (see docs/bricks.md)`)
  }
  return info.commit
}

function spawnWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
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
  return { mamaVersion, raaSdfmVersion: RAA_SDFM_VERSION, createPool, meshOnce }
}
