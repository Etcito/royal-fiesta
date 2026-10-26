// Shared disk layout for local play, content checkouts and CDN uploads.
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './bricks.ts'

export interface ContentIndex {
  assets: { id: string; world: string; path: string; hash: string }[]
  courses: { id: string; path: string }[]
}

export function contentDir(root = repoRoot()): string {
  return resolve(process.env.RF_CONTENT_DIR ?? root)
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

export function packContent(out: string, dir = contentDir()): ContentIndex {
  const index = buildContentIndex(dir)
  for (const { path } of [...index.assets, ...index.courses]) {
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
  const index = packContent(resolve(process.argv[2]))
  console.log(`content:pack: ${index.assets.length} assets, ${index.courses.length} courses, index.json`)
}
