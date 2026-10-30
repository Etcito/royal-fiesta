// Builds a level pack from a content checkout (courses/ + assets/) and publishes it to an Etcito levels service.
// npm run levels:publish -- <courseId> [--title <t>] [--author <a>] [--dry]
// ETCITO_LEVELS_URL (base, e.g. https://assets.etcito.com/levels) and ETCITO_LEVELS_KEY come from the ENVIRONMENT or from
// the untracked file named by ETCITO_LEVELS_KEY_FILE; the key is never printed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadCourseV1 } from '../../packages/game/src/courseV1.ts'
import type { GameAssetResolver } from '../../packages/game/src/courseV1.ts'
import { parseGameAsset } from '../../packages/game/src/gameAsset.ts'
import { buildLevelPack, COMMUNITY_COURSE_PREFIX, validateLevelPack } from '../../packages/game/src/levelPack.ts'
import type { LevelPack } from '../../packages/game/src/levelPack.ts'
import { buildContentIndex, contentDir } from '../content.ts'

export interface PackRequest { courseId: string; title?: string; author?: string; dir?: string }

/** The course plus the assets it uses, read from a content dir. A shipped id gets the ugc- prefix (a copy; the source is untouched). */
export async function packFromContent(req: PackRequest): Promise<LevelPack> {
  const dir = req.dir ?? contentDir()
  const index = buildContentIndex(dir)
  const entry = index.courses.find(c => c.id === req.courseId)
  if (entry === undefined) throw new Error(`no course '${req.courseId}' in ${dir}/courses; use one of: ${index.courses.map(c => c.id).join(', ')}`)
  const courseText = readFileSync(join(dir, entry.path), 'utf8')
  const resolver: GameAssetResolver = {
    async resolve(id) {
      const a = index.assets.find(x => x.id === id)
      if (a === undefined) throw new Error(`unknown asset ${id}`)
      const json = JSON.parse(readFileSync(join(dir, a.path), 'utf8')) as unknown
      return { asset: await parseGameAsset(json, a.path), source: { path: a.path, json } }
    },
  }
  const loaded = await loadCourseV1(JSON.parse(courseText) as unknown, entry.path, resolver)
  const files: Record<string, string> = {}
  let courseId = loaded.id
  if (courseId.startsWith(COMMUNITY_COURSE_PREFIX)) files[`courses/${courseId}.course.json`] = courseText
  else {
    courseId = `${COMMUNITY_COURSE_PREFIX}${courseId}`.slice(0, 40)
    const json = JSON.parse(courseText) as Record<string, unknown>
    json.id = courseId
    files[`courses/${courseId}.course.json`] = JSON.stringify(json, null, 2) + '\n'
  }
  for (const id of loaded.assetIds) {
    const a = index.assets.find(x => x.id === id)!
    files[a.path] = readFileSync(join(dir, a.path), 'utf8')
  }
  return buildLevelPack({ title: req.title ?? loaded.name, author: req.author ?? 'Etcito', courseId, files })
}

export function levelsEndpoint(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } {
  const url = (env.ETCITO_LEVELS_URL ?? '').trim().replace(/\/+$/, '')
  let key = (env.ETCITO_LEVELS_KEY ?? '').trim()
  if (key === '' && env.ETCITO_LEVELS_KEY_FILE) key = readFileSync(env.ETCITO_LEVELS_KEY_FILE, 'utf8').trim()
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error('ETCITO_LEVELS_URL is not set (the levels base URL, ending in /levels)')
  if (key === '') throw new Error('ETCITO_LEVELS_KEY (or ETCITO_LEVELS_KEY_FILE) is not set')
  return { url, key }
}

export async function publishPack(pack: LevelPack, endpoint = levelsEndpoint()): Promise<{ id: string; contentHash: string; existed: boolean }> {
  const res = await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.key}` }, body: JSON.stringify(pack) })
  const body = await res.json().catch(() => ({})) as { id?: string; contentHash?: string; existed?: boolean; error?: string; reason?: string }
  if (!res.ok) throw new Error(`publish refused (HTTP ${res.status} ${body.error ?? ''}): ${body.reason ?? ''}`.trim())
  return { id: body.id!, contentHash: body.contentHash!, existed: body.existed === true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1] }
  const courseId = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'))
  if (courseId === undefined) throw new Error('usage: npm run levels:publish -- <courseId> [--title t] [--author a] [--dry]')
  const pack = await packFromContent({ courseId, title: flag('--title'), author: flag('--author') })
  await validateLevelPack(pack)
  console.log(`pack ${pack.manifest.id}: ${pack.manifest.files.length} files, contentHash ${pack.manifest.contentHash.slice(0, 12)}, strict validation ok`)
  if (!args.includes('--dry')) console.log('published', JSON.stringify(await publishPack(pack)))
}
