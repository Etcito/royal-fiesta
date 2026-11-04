// Shared disk layout for local play, content checkouts and CDN uploads.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { ProfileName } from '@royal-fiesta/sim/course'
import { repoRoot } from './bricks.ts'
import { parseSeason, playableMaps } from '../packages/game/src/season.ts'
import { sharedNodeIds } from './nodeIds.ts'
import { loadCourseV1 } from '../packages/game/src/courseV1.ts'
import type { GameAssetResolver, ResolvedGameAsset } from '../packages/game/src/courseV1.ts'
import { parseGameAsset } from '../packages/game/src/gameAsset.ts'
import { refuse } from '../packages/sim/src/refusal.ts'

// S29 index: `mesh` only when the saved S24 mesh exists, `audio` from audio/*.haa.json, `thumbs` from the level
// thumbnails saved by SDF Modeler next to each course for the vote screen.
export interface ContentIndex {
  assets: { id: string; world: string; path: string; hash: string; category?: string; mesh?: string }[]
  courses: { id: string; path: string }[]
  audio: { id: string; path: string }[]
  thumbs: { map: string; path: string }[]
}

export function contentDir(root = repoRoot()): string {
  return resolve(process.env.RF_CONTENT_DIR ?? root)
}

// Meshes are keyed by asset hash, mesher and MAMA/RAA commits, so every worktree of one clone shares one
// cache in the git common dir: a fresh worktree reuses the meshes another one baked instead of meshing cold.
export function meshCacheDir(root = repoRoot()): string {
  if (process.env.RF_MESH_CACHE_DIR) return resolve(process.env.RF_MESH_CACHE_DIR)
  return join(rfCacheRoot(root) ?? join(tmpdir(), 'rf-cache'), 'meshes')
}

// The build caches (meshes, audio) live under one root, the first that can be written: RF_CACHE_DIR, then
// <git common dir>/rf-cache (shared by every worktree of the clone; read-only in a sandboxed worktree), then
// <os tmpdir>/rf-cache. Probed once per process; null when none can be written (the build goes on uncached).
const cacheRoots = new Map<string, string | null>()
export function rfCacheRoot(root = repoRoot()): string | null {
  const env = process.env.RF_CACHE_DIR ?? ''
  const memo = `${env}\0${root}`
  if (!cacheRoots.has(memo)) {
    const common = gitCommonDir(root)
    const candidates = env ? [resolve(env)] : []
    candidates.push(common === null ? join(root, '.cache') : join(common, 'rf-cache'), join(tmpdir(), 'rf-cache'))
    cacheRoots.set(memo, candidates.find(writableDir) ?? null)
  }
  return cacheRoots.get(memo)!
}

/** True when dir exists or can be created and a file can be written in it. */
export function writableDir(dir: string): boolean {
  const probe = join(dir, `.probe-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

export function gitCommonDir(root: string): string | null {
  const dotGit = join(root, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    // A linked worktree: .git names its private git dir, whose commondir names the shared one.
    const gitDir = resolve(root, /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'))![1].trim())
    const common = join(gitDir, 'commondir')
    return existsSync(common) ? resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir
  } catch {
    return null
  }
}

export function contentPath(rel: string, root = repoRoot()): string {
  return join(/^(assets|courses|audio)(\/|$)/.test(rel) ? contentDir(root) : root, rel)
}

export function buildContentIndex(dir = contentDir()): ContentIndex {
  const assets: ContentIndex['assets'] = []
  for (const world of readdirSync(join(dir, 'assets'), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!world.isDirectory()) continue
    for (const file of readdirSync(join(dir, 'assets', world.name)).sort()) {
      if (!file.endsWith('.asset.json')) continue
      const path = `assets/${world.name}/${file}`
      const json = JSON.parse(readFileSync(join(dir, path), 'utf8')) as { hash: string; category?: string }
      const id = file.slice(0, -'.asset.json'.length)
      const mesh = `assets/${world.name}/${id}.mesh`
      assets.push({ id, world: world.name, path, hash: json.hash, ...(json.category ? { category: json.category } : {}), ...existsSync(join(dir, mesh)) ? { mesh } : {} })
    }
  }
  const courses = readdirSync(join(dir, 'courses')).sort().filter(f => f.endsWith('.course.json'))
    .map(f => ({ id: f.slice(0, -'.course.json'.length), path: `courses/${f}` }))
  const audio = existsSync(join(dir, 'audio'))
    ? readdirSync(join(dir, 'audio')).sort().filter(f => f.endsWith('.haa.json'))
      .map(f => ({ id: f.slice(0, -'.haa.json'.length), path: `audio/${f}` }))
    : []
  const seasonPath = join(dir, 'courses/season.json')
  const maps = existsSync(seasonPath) ? playableMaps(parseSeason(JSON.parse(readFileSync(seasonPath, 'utf8')), 'courses/season.json')) : []
  const thumbs = maps.flatMap(map => {
    const path = `courses/${map.course}.thumb.avif`
    return existsSync(join(dir, path)) ? [{ map: map.id, path }] : []
  })
  for (const world of new Set(assets.map(a => a.world))) {
    for (const file of readdirSync(join(dir, 'assets', world)).sort()) {
      if (file.endsWith('.thumb.avif')) thumbs.push({ map: file.slice(0, -'.thumb.avif'.length), path: `assets/${world}/${file}` })
    }
  }
  return { assets, courses, audio, thumbs }
}

// The asset ids a page's SDF load of this profile meshes (apps/web/src/content/sdfLoad.ts), read from disk.
export async function profileAssetIds(profile: ProfileName, dir = contentDir()): Promise<string[]> {
  const { assetSet } = await import('../apps/web/src/content/assetSet.ts')
  const { loadV1Courses } = await import('../apps/web/src/content/v1Data.ts')
  const index = buildContentIndex(dir)
  const read = async (url: string | URL | Request): Promise<Response> => {
    const path = String(url).replace(/^disk:\/\//, '')
    return new Response(path === 'index.json' ? JSON.stringify(index) : readFileSync(join(dir, path), 'utf8'))
  }
  const { courses, byId } = await loadV1Courses(() => {}, { root: 'disk://', fetch: read as typeof fetch })
  return assetSet(courses, byId, profile, index.assets.map(e => e.id).filter(id => id.startsWith('costume.')))
}

// The build list SDF Modeler writes (Assets tab > Games > Levels, sdfm.build.json at the game root): the courses that
// ship. Absent: every course ships.
export const BUILD_FILE = 'sdfm.build.json'
export const CATALOG_FILE = 'economy/catalog.season1.json'

/** The ticked course ids of the build list in dir, or null when dir has no build list (every course ships). */
export function buildCourses(dir = contentDir()): string[] | null {
  const file = join(dir, BUILD_FILE)
  if (!existsSync(file)) return null
  const json = JSON.parse(readFileSync(file, 'utf8')) as { format?: unknown; version?: unknown; courses?: unknown }
  if (json.format !== 'sdfm.build' || json.version !== 1 || !Array.isArray(json.courses) || !json.courses.every(c => typeof c === 'string')) {
    refuse('content', BUILD_FILE, 'is not a build list {"format": "sdfm.build", "version": 1, "courses": [...]}; tick the levels again in SDF Modeler (Assets > Games > Levels)')
  }
  return [...new Set(json.courses as string[])].sort()
}

/** What a shipped page needs: the courses offered, the asset files they read, the assets whose meshes it loads. */
export interface ShippedContent {
  courses: Set<string>
  /** Asset files the page reads: the meshed assets plus every asset a shipped course places (a course parses them). */
  assets: Set<string>
  /** Assets the page meshes (apps/web/src/content/sdfLoad.ts): its saved .mesh, or a server mesh when it has none. */
  meshed: Set<string>
}

/**
 * The content a shipped game page uses, from its real load code: the courses of the build list (all without one),
 * then sdfLoad's set over them (assetSet: every race and survival course, the start scene, the hub, the podium, the
 * character and the wardrobe of every cosmetic in the index) plus the catalog cosmetics (economy/catalog.season1.json).
 */
export async function shippedContent(dir = contentDir(), root = repoRoot()): Promise<ShippedContent> {
  const { assetSet } = await import('../apps/web/src/content/assetSet.ts')
  const { loadV1Courses } = await import('../apps/web/src/content/v1Data.ts')
  const index = buildContentIndex(dir)
  const known = new Set(index.courses.map(c => c.id))
  const listed = buildCourses(dir)
  for (const id of listed ?? []) {
    if (!known.has(id)) refuse('content', BUILD_FILE, `lists '${id}', which has no courses/${id}.course.json; untick it in SDF Modeler (Assets > Games > Levels)`)
  }
  const ticked = listed ?? [...known]
  const read = async (url: string | URL | Request): Promise<Response> => {
    const path = String(url).replace(/^disk:\/\//, '')
    return new Response(path === 'index.json' ? JSON.stringify(index) : readFileSync(join(dir, path), 'utf8'))
  }
  const { courses, byId } = await loadV1Courses(() => {}, { root: 'disk://', fetch: read as typeof fetch }, ticked)
  const costumes = index.assets.filter(e => e.category === 'cosmetic' || e.id.startsWith('costume.')).map(e => e.id)
  const catalogPath = join(root, CATALOG_FILE)
  const catalog = existsSync(catalogPath) ? (JSON.parse(readFileSync(catalogPath, 'utf8')) as { items?: { asset?: unknown }[] }).items ?? [] : []
  const assetIds = new Set(index.assets.map(a => a.id))
  const meshed = new Set(assetSet(courses, byId, 'standard', costumes))
  for (const item of catalog) {
    if (typeof item.asset !== 'string') continue
    if (!assetIds.has(item.asset)) refuse('content', `${CATALOG_FILE}#${item.asset}`, `the catalog names asset '${item.asset}', which has no assets/*/${item.asset}.asset.json`)
    meshed.add(item.asset)
  }
  const assets = new Set(meshed)
  for (const c of courses) for (const id of c.assetIds) assets.add(id)
  return { courses: new Set(ticked), assets, meshed }
}

/** The index of a shipped pack: only its courses, asset files, the saved meshes it loads and their thumbnails. */
export function shippedIndex(index: ContentIndex, ship: ShippedContent): ContentIndex {
  const assets = index.assets.filter(a => ship.assets.has(a.id)).map(a => {
    if (a.mesh === undefined || ship.meshed.has(a.id)) return a
    const { mesh: _unused, ...rest } = a
    return rest
  })
  const thumbs = index.thumbs.filter(t => {
    const course = /^courses\/(.+)\.thumb\.avif$/.exec(t.path)
    return course !== null ? ship.courses.has(course[1]) : ship.assets.has(t.map)
  })
  return { assets, courses: index.courses.filter(c => ship.courses.has(c.id)), audio: index.audio, thumbs }
}

// Strict validation before a pack: every asset and course loads, every haa patch has its header.
const PENGUIN_ASSET = 'assets/common/penguin.body.asset.json'
const COSTUME_ASSET = /^assets\/[a-z]+\/costume\.[a-z0-9.-]+\.asset\.json$/

export async function validateContent(index: ContentIndex, dir = contentDir()): Promise<void> {
  const assets = new Map<string, ResolvedGameAsset>()
  for (const a of index.assets) {
    const json = JSON.parse(readFileSync(join(dir, a.path), 'utf8')) as unknown
    const asset = await parseGameAsset(json, a.path)
    if (asset.id !== a.id || asset.world !== a.world) throw new Error(`${a.path}: id/world do not match the file location`)
    assets.set(asset.id, { asset, source: { path: a.path, json } })
  }
  // A costume is merged into the penguin for the views render; a shared node id would overwrite the body.
  const penguin = [...assets.values()].find((resolved) => resolved.source.path === PENGUIN_ASSET)
  if (penguin !== undefined) {
    const body = penguin.source.json as Record<string, unknown>
    for (const resolved of assets.values()) {
      if (!COSTUME_ASSET.test(resolved.source.path)) continue
      const costume = resolved.source.json as Record<string, unknown>
      for (const id of sharedNodeIds(costume.document, body.document)) {
        throw new Error(`${resolved.source.path}#/document/nodes/${id}: node id also used by the penguin; re-save the costume with unique node ids`)
      }
    }
  }
  const resolver: GameAssetResolver = {
    async resolve(id) {
      const found = assets.get(id)
      if (found === undefined) throw new Error(`unknown asset ${id}`)
      return found
    },
  }
  for (const c of index.courses) {
    await loadCourseV1(JSON.parse(readFileSync(join(dir, c.path), 'utf8')) as unknown, c.path, resolver)
  }
  for (const p of index.audio) {
    const json = JSON.parse(readFileSync(join(dir, p.path), 'utf8')) as { haa?: unknown; id?: unknown }
    if (json === null || typeof json !== 'object' || json.haa !== 1 || json.id !== p.id) {
      throw new Error(`${p.path}: a haa patch needs the header {"haa": 1, "id": "${p.id}"}`)
    }
  }
}

// Copies only; the content:pack CLI validates first (validateContent). meshKeys limits the baked server meshes to one
// load set (MeshBaker.keys); every cached mesh when absent. The cache is shared by every worktree and MAMA pin, so an
// unfiltered pack can outgrow a page upload. ship (shippedContent) packs only what a shipped page uses.
export function packContent(out: string, dir = contentDir(), meshKeys?: ReadonlySet<string>, ship?: ShippedContent): ContentIndex {
  const full = buildContentIndex(dir)
  const index = ship === undefined ? full : shippedIndex(full, ship)
  const files = [...index.assets.flatMap(a => a.mesh === undefined ? [a.path] : [a.path, a.mesh]), ...index.courses.map(c => c.path), ...index.audio.map(p => p.path), ...index.thumbs.map(t => t.path)]
  for (const path of files) {
    const target = join(out, path)
    mkdirSync(dirname(target), { recursive: true })
    // A packed saved mesh is gzipped under the same name (181 MB raw -> 37 MB); the page decodes every fetched mesh
    // with decodeMeshBytes (apps/web/src/sdf/meshWire.ts), which inflates by the gzip magic. Sources stay raw.
    if (path.endsWith('.mesh')) writeFileSync(target, gzipSync(readFileSync(join(dir, path)), { level: 9 }))
    else cpSync(join(dir, path), target)
  }
  // Baked successes are directly addressable by the same key on a static content host; a server refusal is
  // published as <key>.failed, so the page leaves the asset out instead of meshing it again in the browser.
  const meshes = meshCacheDir()
  if (existsSync(meshes)) {
    mkdirSync(join(out, 'meshes'), { recursive: true })
    // A pack REPLACES the meshes of its load set: the files an earlier pack left here (other MAMA pins, other load sets)
    // are orphans that only grow the page (run 11326: 785 files, 268495360 bytes, 60 KB over the 256 MiB GPU page limit).
    if (meshKeys !== undefined) {
      for (const name of readdirSync(join(out, 'meshes'))) {
        if (/^[a-f0-9]{64}(\.failed)?$/.test(name) && !meshKeys.has(name.replace(/\.failed$/, ''))) unlinkSync(join(out, 'meshes', name))
      }
    }
    for (const name of readdirSync(meshes)) {
      if (meshKeys !== undefined && !meshKeys.has(name.replace(/\.(mesh|failed)$/, ''))) continue
      // Gzipped (a third of the size; apps/web/src/sdf/serverMesh.ts inflates it) so a load's meshes fit a page upload.
      if (/^[a-f0-9]{64}\.mesh$/.test(name)) writeFileSync(join(out, 'meshes', name.slice(0, -5)), gzipSync(readFileSync(join(meshes, name))))
      if (/^[a-f0-9]{64}\.failed$/.test(name)) {
        const reason = readFileSync(join(meshes, name), 'utf8').replace(/(^|[\s('"=])(?:[A-Za-z]:)?[\\/][^\s:)'"]+/g, '$1<path>')
        writeFileSync(join(out, 'meshes', name), reason)
      }
    }
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  return index
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('usage: npm run content:pack -- <out dir>')
  await validateContent(buildContentIndex())
  const index = packContent(resolve(process.argv[2]))
  const meshes = index.assets.filter(a => a.mesh !== undefined).length
  console.log(`content:pack: ${index.assets.length} assets, ${meshes} meshes, ${index.courses.length} courses, ${index.audio.length} audio, index.json`)
}
