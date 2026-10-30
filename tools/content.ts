// Shared disk layout for local play, content checkouts and CDN uploads.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { ProfileName } from '@royal-fiesta/sim/course'
import { repoRoot } from './bricks.ts'
import { loadCourseV1 } from '../packages/game/src/courseV1.ts'
import type { GameAssetResolver, ResolvedGameAsset } from '../packages/game/src/courseV1.ts'
import { parseGameAsset } from '../packages/game/src/gameAsset.ts'

// S29 index: `mesh` only when the saved S24 mesh exists, `audio` from audio/*.haa.json.
export interface ContentIndex {
  assets: { id: string; world: string; path: string; hash: string; mesh?: string }[]
  courses: { id: string; path: string }[]
  audio: { id: string; path: string }[]
}

export function contentDir(root = repoRoot()): string {
  return resolve(process.env.RF_CONTENT_DIR ?? root)
}

// Meshes are keyed by asset hash, mesher and MAMA/RAA commits, so every worktree of one clone shares one
// cache in the git common dir: a fresh worktree reuses the meshes another one baked instead of meshing cold.
export function meshCacheDir(root = repoRoot()): string {
  if (process.env.RF_MESH_CACHE_DIR) return resolve(process.env.RF_MESH_CACHE_DIR)
  const common = gitCommonDir(root)
  return common === null ? join(root, '.cache', 'meshes') : join(common, 'rf-cache', 'meshes')
}

function gitCommonDir(root: string): string | null {
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
      const json = JSON.parse(readFileSync(join(dir, path), 'utf8')) as { hash: string }
      const id = file.slice(0, -'.asset.json'.length)
      const mesh = `assets/${world.name}/${id}.mesh`
      assets.push({ id, world: world.name, path, hash: json.hash, ...existsSync(join(dir, mesh)) ? { mesh } : {} })
    }
  }
  const courses = readdirSync(join(dir, 'courses')).sort().filter(f => f.endsWith('.course.json'))
    .map(f => ({ id: f.slice(0, -'.course.json'.length), path: `courses/${f}` }))
  const audio = existsSync(join(dir, 'audio'))
    ? readdirSync(join(dir, 'audio')).sort().filter(f => f.endsWith('.haa.json'))
      .map(f => ({ id: f.slice(0, -'.haa.json'.length), path: `audio/${f}` }))
    : []
  return { assets, courses, audio }
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
  return assetSet(courses, byId, profile)
}

// Strict validation before a pack: every asset and course loads, every haa patch has its header.
export async function validateContent(index: ContentIndex, dir = contentDir()): Promise<void> {
  const assets = new Map<string, ResolvedGameAsset>()
  for (const a of index.assets) {
    const json = JSON.parse(readFileSync(join(dir, a.path), 'utf8')) as unknown
    const asset = await parseGameAsset(json, a.path)
    if (asset.id !== a.id || asset.world !== a.world) throw new Error(`${a.path}: id/world do not match the file location`)
    assets.set(asset.id, { asset, source: { path: a.path, json } })
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
// unfiltered pack can outgrow a page upload.
export function packContent(out: string, dir = contentDir(), meshKeys?: ReadonlySet<string>): ContentIndex {
  const index = buildContentIndex(dir)
  const files = [...index.assets.flatMap(a => a.mesh === undefined ? [a.path] : [a.path, a.mesh]), ...index.courses.map(c => c.path), ...index.audio.map(p => p.path)]
  for (const path of files) {
    const target = join(out, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(dir, path), target)
  }
  // Baked successes are directly addressable by the same key on a static content host; a server refusal is
  // published as <key>.failed, so the page leaves the asset out instead of meshing it again in the browser.
  const meshes = meshCacheDir()
  if (existsSync(meshes)) {
    mkdirSync(join(out, 'meshes'), { recursive: true })
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
