// Node-only v1 content: the assets/<world>/ scanner and cached course v1 loads from courses/.
import { readdir } from 'node:fs/promises'
import { loadCourseV1 } from '@royal-fiesta/game/courseV1'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '@royal-fiesta/game/courseV1'
import { parseGameAsset } from '@royal-fiesta/game/gameAsset'
import type { World } from '@royal-fiesta/game/gameAsset'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import { readRepoText, repoPath } from './files.ts'

const ASSETS_DIR = 'assets'
const COURSES_DIR = 'courses'
const ASSET_SUFFIX = '.asset.json'
const WORLDS: readonly World[] = ['candy', 'ice', 'jungle', 'neon', 'common']

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

async function sortedEntries(rel: string) {
  const entries = await readdir(repoPath(rel), { withFileTypes: true })
  return entries.sort((a, b) => byCodeUnit(a.name, b.name))
}

async function scanAssets(): Promise<Map<string, ResolvedGameAsset>> {
  const found = new Map<string, ResolvedGameAsset>()
  for (const dir of await sortedEntries(ASSETS_DIR)) {
    if (!dir.isDirectory()) continue
    const folder = dir.name
    if (!WORLDS.includes(folder as World)) {
      refuse('assets', `${ASSETS_DIR}/${folder}`, `folder '${folder}' is not a world; use one of ${WORLDS.join('|')}`)
    }
    for (const file of await sortedEntries(`${ASSETS_DIR}/${folder}`)) {
      if (!file.isFile() || !file.name.endsWith(ASSET_SUFFIX)) continue
      const path = `${ASSETS_DIR}/${folder}/${file.name}`
      const stem = file.name.slice(0, -ASSET_SUFFIX.length)
      let json: unknown
      try {
        json = JSON.parse(await readRepoText(path))
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e
        refuse('assets', path, `invalid JSON: ${e.message}; fix the file syntax`)
      }
      const asset = await parseGameAsset(json, path)
      if (asset.world !== folder) {
        refuse('assets', `${path}#/world`, `world '${asset.world}' does not match the folder '${folder}'; move the file to assets/${asset.world}/`)
      }
      if (asset.id !== stem) refuse('assets', `${path}#/id`, `id '${asset.id}' does not match the file stem '${stem}'; rename the file or the id`)
      const prev = found.get(asset.id)
      if (prev) refuse('assets', path, `asset id '${asset.id}' is also ${prev.source.path}; ids are unique across assets/, rename one`)
      found.set(asset.id, { asset, source: { path, json } })
    }
  }
  return found
}

let gameAssets: GameAssetResolver | undefined

export function nodeGameAssets(): GameAssetResolver {
  if (!gameAssets) {
    let scan: Promise<Map<string, ResolvedGameAsset>> | undefined
    gameAssets = {
      async resolve(id: string): Promise<ResolvedGameAsset> {
        if (!scan) scan = scanAssets()
        const all = await scan
        const r = all.get(id)
        if (!r) refuse('assets', id, `unknown asset; available: ${[...all.keys()].sort(byCodeUnit).join(', ') || '(none)'}`)
        return r
      },
    }
  }
  return gameAssets
}

const courses = new Map<string, Promise<CourseV1>>()

async function readCourseV1(rel: string): Promise<CourseV1> {
  const text = await readRepoText(rel)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    refuse('course', rel, `invalid JSON: ${(e as Error).message}; fix the file syntax`)
  }
  return loadCourseV1(json, rel, nodeGameAssets())
}

// Not async: callers get the cached Promise itself.
export function loadCourseV1File(rel: string): Promise<CourseV1> {
  let result = courses.get(rel)
  if (!result) {
    result = readCourseV1(rel)
    courses.set(rel, result)
  }
  return result
}

export async function loadAllCoursesV1(): Promise<CourseV1[]> {
  const names = (await sortedEntries(COURSES_DIR)).filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name)
  const loaded: CourseV1[] = []
  for (const name of names) loaded.push(await loadCourseV1File(`${COURSES_DIR}/${name}`))
  // Load order is part of determinism: code-unit order by id.
  return loaded.sort((a, b) => byCodeUnit(a.id, b.id))
}

export async function v1Playlist(profile: ProfileName): Promise<ResolvedCourse[]> {
  const sims: ResolvedCourse[] = []
  for (const c of await loadAllCoursesV1()) {
    if ((c.kind === 'race' || c.kind === 'survival') && c.sim && c.sim.profiles.includes(profile)) sims.push(c.sim)
  }
  return sims
}
