// Shared disk layout for local play, content checkouts and CDN uploads.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProfileName } from '@royal-fiesta/sim/course'
import { repoRoot } from './bricks.ts'

export interface ContentIndex {
  assets: { id: string; world: string; path: string; hash: string }[]
  courses: { id: string; path: string }[]
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
  return join(/^(assets|courses)(\/|$)/.test(rel) ? contentDir(root) : root, rel)
}

export function buildContentIndex(dir = contentDir()): ContentIndex {
  const assets: ContentIndex['assets'] = []
  for (const world of readdirSync(join(dir, 'assets'), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!world.isDirectory()) continue
    for (const file of readdirSync(join(dir, 'assets', world.name)).sort()) {
      if (!file.endsWith('.asset.json')) continue
      const path = `assets/${world.name}/${file}`
      const json = JSON.parse(readFileSync(join(dir, path), 'utf8')) as { hash: string }
      assets.push({ id: file.slice(0, -'.asset.json'.length), world: world.name, path, hash: json.hash })
    }
  }
  const courses = readdirSync(join(dir, 'courses')).sort().filter(f => f.endsWith('.course.json'))
    .map(f => ({ id: f.slice(0, -'.course.json'.length), path: `courses/${f}` }))
  return { assets, courses }
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

export function packContent(out: string, dir = contentDir()): ContentIndex {
  const index = buildContentIndex(dir)
  for (const { path } of [...index.assets, ...index.courses]) {
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
      if (/^[a-f0-9]{64}\.mesh$/.test(name)) cpSync(join(meshes, name), join(out, 'meshes', name.slice(0, -5)))
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
  const index = packContent(resolve(process.argv[2]))
  console.log(`content:pack: ${index.assets.length} assets, ${index.courses.length} courses, index.json`)
}
