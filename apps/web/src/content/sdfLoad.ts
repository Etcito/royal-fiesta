// SDF content load: v1 courses, the asset set they need, meshed through the S16 cache, then the saved
// .mesh file (S24), then MAMA workers.
// Reads courses and builds meshes only; it never touches sim state (1.5).
import type { LoadProgress } from '@royal-fiesta/game/content'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import type { ProfileName } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import { loadMamaFacade, meshHasParts, meshRequestOf } from '../sdf/mamaApi.ts'
import type { MamaFacade, MeshedAsset } from '../sdf/mamaApi.ts'
import { idbStore, MeshCache, meshCacheKey, memoryStore } from '../sdf/meshCache.ts'
import { poolSize } from '../sdf/meshPool.ts'
import type { MeshPool } from '../sdf/meshPool.ts'
import { fetchMeshFile, meshFileStats } from '../sdf/meshFile.ts'
import { browserContentIndex, browserContentRoot, browserGameAssets, loadV1Courses } from './v1Data.ts'

const PODIUM_ID = 'podium'
const CHARACTER_ID = 'penguin.body'
/** An asset still meshing this many seconds after its worker started is left out like a refused one; the load goes on. */
const MESH_LIMIT_S = 90

export interface SdfContent {
  courses: { all: CourseV1[]; byId: ReadonlyMap<string, CourseV1> }
  meshed: Map<string, MeshedAsset>
  /** Assets the mesher refused, with the reason: drawn as nothing. */
  failed: Map<string, string>
  report: Record<string, number | string | readonly string[]>
}

// Module-level, so a second load in the same page answers from memory and reuses the workers.
let cache: MeshCache | null = null
let pool: MeshPool | null = null

function meshCache(): MeshCache {
  if (cache === null) {
    let persistent = null
    try {
      const factory = globalThis.indexedDB
      persistent = factory ? idbStore(factory) : null
    } catch {
      // Opaque origins may throw even when probing IndexedDB.
      persistent = null
    }
    cache = new MeshCache({ memory: memoryStore(), persistent })
  }
  return cache
}

// Mesh failures by mesh cache key, in this browser only (localStorage; the page works without it). `?remesh` in the
// page address ignores them for one load.
const FAILED_PREFIX = 'rf-mesh-failed:'
function knownFailure(key: string): string | null {
  try {
    if (new URLSearchParams(location.search).has('remesh')) return null
    return localStorage.getItem(FAILED_PREFIX + key)
  } catch {
    return null
  }
}
function rememberFailure(key: string, reason: string): void {
  try { localStorage.setItem(FAILED_PREFIX + key, reason) } catch { /* no storage: the next load retries */ }
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
  const timeline: string[] = []
  let previous = performance.now()
  const mark = (step: string): void => {
    const end = performance.now()
    timeline.push(JSON.stringify({ step, start: previous, end, ms: end - previous }))
    previous = end
  }
  const facade = await loadMamaFacade()
  mark('MAMA module')
  const { courses, byId } = await loadV1Courses(onProgress)

  mark('Course and referenced asset load')
  const ids = assetSet(courses, byId, profile)
  const resolver = browserGameAssets()
  const assets: GameAsset[] = []
  for (let i = 0; i < ids.length; i++) {
    assets.push((await resolver.resolve(ids[i])).asset)
    onProgress({ phase: 'assets', done: i + 1, total: ids.length, label: ids[i] })
  }

  mark('Playlist assets')
  const root = browserContentRoot().replace(/\/?$/, '/')
  const meshPaths = new Map((await browserContentIndex()).assets.flatMap(e => e.mesh === undefined ? [] : [[e.id, e.mesh] as const]))
  const c = meshCache()
  const before = { ...c.stats }
  const fileBefore = { ...meshFileStats }
  const meshed = new Map<string, MeshedAsset>()
  const failed = new Map<string, string>()
  const source = new Map<string, 'miss' | 'memory' | 'idb' | 'file'>()
  let done = 0
  const step = (id: string): void => {
    done++
    onProgress({ phase: 'meshing', done, total: assets.length, label: id })
  }
  const misses: Promise<void>[] = []
  for (const a of assets) {
    const key = await meshCacheKey(a, facade.mamaVersion, facade.raaSdfmVersion, sha256Hex)
    const request = meshRequestOf(a)
    const hit = await c.get(key)
    if (hit !== null && meshHasParts(hit.value, request.parts)) {
      meshed.set(a.id, hit.value)
      source.set(a.id, hit.from)
      step(a.id)
      continue
    }
    const meshPath = meshPaths.get(a.id)
    const load = async (): Promise<{ value: MeshedAsset; from: 'file' | 'miss' }> => {
      if (meshPath !== undefined) {
        const file = await fetchMeshFile(root + meshPath, key, a)
        if (file !== null && meshHasParts(file, request.parts)) return { value: file, from: 'file' }
      }
      const known = knownFailure(key)
      if (known !== null) throw new Error(known)
      return { value: await meshPool(facade).mesh(request, MESH_LIMIT_S * 1000), from: 'miss' }
    }
    /* Local failures are checked only after the saved file, so an old browser timeout cannot hide a saved mesh. */
    const miss = load().then(async ({ value, from }) => {
      await c.put(key, value)
      meshed.set(a.id, value)
      source.set(a.id, from)
      step(a.id)
    }, (e: unknown) => {
      // Permissive load (owner rule): an asset the mesher refuses is left out (drawn as nothing) and named in the
      // console and the report; the game still starts. The failure is remembered under the mesh cache key (asset
      // hash, mesher, MAMA commit), so the next launch does not wait for it again; a changed asset or MAMA retries.
      const reason = e instanceof Error ? e.message : String(e)
      rememberFailure(key, reason)
      failed.set(a.id, reason)
      console.warn(`[content] ${a.id} is not drawn: ${reason}`)
      step(a.id)
    })
    misses.push(miss)
  }
  await Promise.all(misses)
  mark('MAMA meshing / cache')
  onProgress({ phase: 'done', done: assets.length, total: assets.length, label: 'done' })

  const meshedLines = ids.map((id) => {
    const m = meshed.get(id)
    return m === undefined ? `${id}|failed|0|0|-` : `${id}|${m.mesher}|${m.parts}|${m.triangles}|${source.get(id)}`
  })
  return {
    courses: { all: courses, byId },
    meshed,
    failed,
    report: {
      bootTimeline: timeline,
      failed: [...failed.keys()].sort(),
      content: 'sdf',
      mamaVersion: facade.mamaVersion,
      raaSdfmVersion: facade.raaSdfmVersion,
      meshed: meshedLines,
      cacheMemory: c.stats.memory - before.memory,
      cacheIdb: c.stats.idb - before.idb,
      cacheMiss: c.stats.miss - before.miss,
      cacheEvictedCorrupt: c.stats.evictedCorrupt - before.evictedCorrupt,
      meshFile: meshFileStats.hits - fileBefore.hits,
      meshFileStale: meshFileStats.stale - fileBefore.stale,
      courseIds: playlistIds(courses, profile),
      assets: ids.length,
    },
  }
}
