// SDF content load: v1 courses, the asset set they need, meshed by MAMA workers through the S16 cache.
// Reads courses and builds meshes only; it never touches sim state (1.5).
import type { LoadProgress } from '@royal-fiesta/game/content'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import type { ProfileName } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import { loadMamaFacade } from '../sdf/mamaApi.ts'
import type { MamaFacade, MeshedAsset } from '../sdf/mamaApi.ts'
import { idbStore, MeshCache, meshCacheKey, memoryStore } from '../sdf/meshCache.ts'
import { poolSize } from '../sdf/meshPool.ts'
import type { MeshPool } from '../sdf/meshPool.ts'
import { browserGameAssets, loadV1Courses } from './v1Data.ts'

const PODIUM_ID = 'podium'
const CHARACTER_ID = 'penguin.body'

export interface SdfContent {
  courses: { all: CourseV1[]; byId: ReadonlyMap<string, CourseV1> }
  meshed: Map<string, MeshedAsset>
  report: Record<string, number | string | readonly string[]>
}

// Module-level, so a second load in the same page answers from memory and reuses the workers.
let cache: MeshCache | null = null
let pool: MeshPool | null = null

function meshCache(): MeshCache {
  if (cache === null) {
    const persistent = globalThis.indexedDB ? idbStore() : null
    cache = new MeshCache({ memory: memoryStore(), persistent })
  }
  return cache
}

function meshPool(facade: MamaFacade): MeshPool {
  if (pool === null) pool = facade.createPool(poolSize(navigator.hardwareConcurrency))
  return pool
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return hex
}

// The playlist for the profile, the hub and the podium, plus the character, sorted.
function assetSet(courses: readonly CourseV1[], byId: ReadonlyMap<string, CourseV1>, profile: ProfileName): string[] {
  const ids = new Set<string>([CHARACTER_ID])
  for (const c of courses) {
    if ((c.kind === 'race' || c.kind === 'survival') && c.sim !== null && c.sim.profiles.includes(profile)) {
      for (const id of c.assetIds) ids.add(id)
    }
  }
  const hubs = courses.filter(c => c.kind === 'hub')
  if (hubs.length !== 1) {
    refuse('content', 'courses/*.course.json', `expected exactly one kind hub course, found ${hubs.length} (${hubs.map(c => c.id).join(', ') || 'none'}); keep one kind hub course`)
  }
  for (const id of hubs[0].assetIds) ids.add(id)
  const podium = byId.get(PODIUM_ID)
  if (podium === undefined || podium.kind !== 'podium') {
    refuse('content', `courses/${PODIUM_ID}.course.json`, `no kind podium course '${PODIUM_ID}'; add courses/${PODIUM_ID}.course.json`)
  }
  for (const id of podium.assetIds) ids.add(id)
  return [...ids].sort()
}

function playlistIds(courses: readonly CourseV1[], profile: ProfileName): string[] {
  return courses
    .filter(c => (c.kind === 'race' || c.kind === 'survival') && c.sim !== null && c.sim.profiles.includes(profile))
    .map(c => c.id)
    .sort()
}

export async function loadSdfContent(profile: ProfileName, onProgress: (p: LoadProgress) => void): Promise<SdfContent> {
  // First, so a missing MAMA refuses before any fetch.
  const facade = await loadMamaFacade()
  const { courses, byId } = await loadV1Courses(onProgress)

  const ids = assetSet(courses, byId, profile)
  const resolver = browserGameAssets()
  const assets: GameAsset[] = []
  for (let i = 0; i < ids.length; i++) {
    assets.push((await resolver.resolve(ids[i])).asset)
    onProgress({ phase: 'assets', done: i + 1, total: ids.length, label: ids[i] })
  }

  const c = meshCache()
  const before = { ...c.stats }
  const meshed = new Map<string, MeshedAsset>()
  const source = new Map<string, 'miss' | 'memory' | 'idb'>()
  let done = 0
  const step = (id: string): void => {
    done++
    onProgress({ phase: 'meshing', done, total: assets.length, label: id })
  }
  const misses: Promise<void>[] = []
  for (const a of assets) {
    const key = await meshCacheKey(a, facade.mamaVersion, facade.raaSdfmVersion, sha256Hex)
    const hit = await c.get(key)
    if (hit !== null) {
      meshed.set(a.id, hit.value)
      source.set(a.id, hit.from)
      step(a.id)
      continue
    }
    const req = { assetId: a.id, hash: a.hash, mesher: a.mesher, document: a.document }
    const miss = meshPool(facade).mesh(req).then(async (value) => {
      await c.put(key, value)
      meshed.set(a.id, value)
      source.set(a.id, 'miss')
      step(a.id)
    })
    // Handled by Promise.all below; this only avoids an unhandled rejection while lookups continue.
    miss.catch(() => {})
    misses.push(miss)
  }
  // Any refusal (mesher naming asset and group, worker crash) stops the load unchanged.
  await Promise.all(misses)
  onProgress({ phase: 'done', done: assets.length, total: assets.length, label: 'done' })

  const meshedLines = ids.map((id) => {
    const m = meshed.get(id) as MeshedAsset
    return `${id}|${m.mesher}|${m.parts}|${m.triangles}|${source.get(id)}`
  })
  return {
    courses: { all: courses, byId },
    meshed,
    report: {
      content: 'sdf',
      mamaVersion: facade.mamaVersion,
      raaSdfmVersion: facade.raaSdfmVersion,
      meshed: meshedLines,
      cacheMemory: c.stats.memory - before.memory,
      cacheIdb: c.stats.idb - before.idb,
      cacheMiss: c.stats.miss - before.miss,
      cacheEvictedCorrupt: c.stats.evictedCorrupt - before.evictedCorrupt,
      courseIds: playlistIds(courses, profile),
      assets: ids.length,
    },
  }
}
