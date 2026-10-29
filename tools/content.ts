// Shared disk layout for local play, content checkouts and CDN uploads.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

// Copies only; the content:pack CLI validates first (validateContent).
export function packContent(out: string, dir = contentDir()): ContentIndex {
  const index = buildContentIndex(dir)
  const files = [...index.assets.flatMap(a => a.mesh === undefined ? [a.path] : [a.path, a.mesh]), ...index.courses.map(c => c.path), ...index.audio.map(p => p.path)]
  for (const path of files) {
    const target = join(out, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(dir, path), target)
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
