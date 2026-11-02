// Owner regeneration helper: re-save courses through SDF Modeler. No build cache or rendering here.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './bricks.ts'
import { sdfmApi, sdfmDir } from './renderViews.ts'
import { parseSeason, playableMaps } from '../packages/game/src/season.ts'

interface CourseClient { call(name: string, input?: unknown): Promise<{ data?: unknown }>; close(): Promise<void> }
async function openModeler(root: string): Promise<CourseClient> {
  process.env.SDFM_GAMES = root
  const { createSdfm } = await sdfmApi(sdfmDir(root))
  return createSdfm({})
}

export async function saveLevelThumbnails(root = repoRoot(), level?: string, open = openModeler): Promise<void> {
  const sdfm = await open(root)
  try {
    const maps = playableMaps(parseSeason(JSON.parse(readFileSync(join(root, 'courses/season.json'), 'utf8')), 'courses/season.json'))
    const selected = maps.filter(map => !level || map.course === level || map.id === level)
    if (!selected.length) throw new Error(`No built course matches ${level}`)
    for (const map of selected) {
      await sdfm.call('course_open', { game: 'royal-fiesta', id: map.course })
      const saved = await sdfm.call('course_save', {}) as { data?: { thumbnail?: { path?: string; error?: string } } }
      if (!saved.data?.thumbnail?.path) throw new Error(`${map.course}: ${saved.data?.thumbnail?.error ?? 'No saved thumbnail'}`)
      console.log(JSON.stringify({ course: map.course, ...saved.data }))
    }
  } finally { await sdfm.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  saveLevelThumbnails(repoRoot(), process.argv.includes('--level') ? process.argv[process.argv.indexOf('--level') + 1] : undefined).catch(error => { console.error(error); process.exitCode = 1 })
}
