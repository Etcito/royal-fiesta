// Level thumbnails: every built Season 1 course is opened in the SDF Modeler's Node build and saved with course_save,
// which writes <course>.thumb.avif. The file is cached by the course's content (course text and every asset it draws),
// copied to thumbs/<map>.avif and packed with the content for the vote screen. course_save renders on the connected GPU
// client (NMC_GPU_URL); levelThumbs never renders in Node and refuses, naming the course and the error, when course_save
// reports {error}: no fallback renderer, no browser capture, no placeholder.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSeason, playableMaps } from '../packages/game/src/season.ts'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { repoRoot } from './bricks.ts'
import { sdfmApi, sdfmDir } from './renderViews.ts'

const AREA = 'level-thumbs'
const GAME = 'royal-fiesta'
const CACHE_REL = 'thumbs/cache.json'
const THUMB_SIZE = 256
const SLOWEST = 's1-b-butterfly-freeway'
const JOB_CEILING_MS = 300_000

/** Measured course_save time includes meshing, transport and AVIF save. */
export function measuredWaitMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error('Invalid course_save measurement')
  return Math.min(JOB_CEILING_MS, Math.ceil((elapsedMs * 1.5 + 15_000) / 1000) * 1000)
}

export function persistentThumbDir(root: string): string {
  const base = process.env.NMC_CACHE_DIR
  if (!base) refuse(AREA, 'cache', 'NMC_CACHE_DIR is required for persistent thumbnails')
  const dir = resolve(base, 'level-thumbs', 'v1')
  if (dir === root || dir.startsWith(root + sep)) refuse(AREA, 'cache', 'NMC_CACHE_DIR must be outside the checkout')
  mkdirSync(dir, { recursive: true })
  return dir
}

function atomicCopy(source: string, target: string): void {
  const temp = `${target}.${process.pid}.tmp`
  copyFileSync(source, temp)
  renameSync(temp, target)
}

interface Sdfm { call(name: string, input?: unknown): Promise<{ text: string; data?: unknown }>; close(): Promise<void> }
interface CacheEntry { course: string; key: string; path: string }
interface CacheFile { format: string; version: number; thumbs: Record<string, CacheEntry> }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Every asset id a course or an asset document names (obstacles, decor, features and nested assetRefs). */
export function assetIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) assetIds(item, out)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const ref = key === 'assetRef' && item !== null && typeof item === 'object' ? (item as { id?: unknown }).id : undefined
      if (key === 'asset' && typeof item === 'string') out.add(item)
      else if (typeof ref === 'string') out.add(ref)
      else assetIds(item, out)
    }
  }
  return out
}

function assetFile(root: string, id: string): string | null {
  const dir = join(root, 'assets')
  if (!existsSync(dir)) return null
  const hits = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, `${id}.asset.json`))
    .filter((file) => existsSync(file))
  return hits.length === 1 ? hits[0] : null
}

/** The cache key: the course text and, recursively, every asset document its expanded render draws. */
export function courseContentKey(root: string, courseId: string): string {
  const courseRel = `courses/${courseId}.course.json`
  const text = readFileSync(join(root, courseRel), 'utf8')
  const parts = [`course ${courseRel}\n${text}`]
  const seen = new Set<string>()
  const queue = [...assetIds(JSON.parse(text) as unknown)].sort()
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const file = assetFile(root, id)
    if (file === null) {
      parts.push(`asset ${id} missing`)
      continue
    }
    const assetText = readFileSync(file, 'utf8')
    parts.push(`asset ${id}\n${assetText}`)
    for (const nested of assetIds(JSON.parse(assetText) as unknown)) if (!seen.has(nested)) queue.push(nested)
  }
  return createHash('sha256').update(parts.join('\n\0\n'), 'utf8').digest('hex')
}

/** True when the file is a non-empty 256x256 AVIF without an alpha channel (course_save flattens levels). */
async function opaqueThumb(file: string): Promise<boolean> {
  try {
    if (!existsSync(file) || statSync(file).size === 0) return false
    const { default: sharp } = await import('sharp')
    const meta = await sharp(file).metadata()
    return meta.compression === 'av1' && meta.width === THUMB_SIZE && meta.height === THUMB_SIZE && meta.hasAlpha !== true
  } catch {
    return false
  }
}

function writeCache(file: string, cache: CacheFile): void {
  mkdirSync(dirname(file), { recursive: true })
  const text = JSON.stringify(cache, null, 2) + '\n'
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return
  writeFileSync(`${file}.${process.pid}.tmp`, text)
  renameSync(`${file}.${process.pid}.tmp`, file)
}

/** Opens the game in the SDF Modeler's Node build; course_open needs no GPU, course_save routes the render to it. */
async function openSdfm(root: string): Promise<Sdfm> {
  const games = (process.env.SDFM_GAMES ?? '').split(delimiter).filter((p) => p.trim() !== '')
  if (!games.some((folder) => resolve(folder) === root)) process.env.SDFM_GAMES = [...games, root].join(delimiter)
  const { createSdfm } = await sdfmApi(sdfmDir(root))
  return createSdfm({})
}

/** Opens one course and saves it: the only thumbnail source is course_save's <course>.thumb.avif. */
async function renderCourse(sdfm: Sdfm, root: string, mapId: string, courseId: string, target: string, waitMs: number): Promise<number> {
  try {
    await sdfm.call('course_open', { game: GAME, id: courseId })
  } catch (e) {
    refuse(AREA, `${mapId} ${courseId}`, `course_open failed: ${message(e)}`)
  }
  let data: { thumbnail?: { path?: string; error?: string } } | undefined
  const previousWait = process.env.NMC_GPU_TIMEOUT_MS
  // The SDFM client reads this on each call; course_save submits exactly one render job.
  process.env.NMC_GPU_TIMEOUT_MS = String(waitMs)
  const started = performance.now()
  try {
    const saved = await sdfm.call('course_save', {})
    data = saved.data as typeof data
  } catch (e) {
    refuse(AREA, `${mapId} ${courseId}`, `course_save failed: ${message(e)}`)
  } finally {
    if (previousWait === undefined) delete process.env.NMC_GPU_TIMEOUT_MS
    else process.env.NMC_GPU_TIMEOUT_MS = previousWait
  }
  const elapsedMs = performance.now() - started
  const thumb = data?.thumbnail
  if (thumb === undefined) refuse(AREA, `${mapId} ${courseId}`, 'course_save returned no thumbnail result')
  if (typeof thumb.error === 'string') refuse(AREA, `${mapId} ${courseId}`, `course_save: ${thumb.error}`)
  if (typeof thumb.path !== 'string') refuse(AREA, `${mapId} ${courseId}`, 'course_save returned neither a thumbnail path nor an error')
  const source = resolve(root, thumb.path)
  if (!(await opaqueThumb(source))) {
    refuse(AREA, `${mapId} ${courseId}`, `course_save wrote ${thumb.path}, which is not a non-empty opaque ${THUMB_SIZE}x${THUMB_SIZE} AVIF`)
  }
  atomicCopy(source, target)
  return elapsedMs
}

function requestedLevel(): string | null {
  const args = process.argv.slice(2)
  const index = args.findIndex((arg) => arg === '--level' || arg.startsWith('--level='))
  if (index < 0) return null
  const arg = args[index]!
  const value = arg === '--level' ? args[index + 1] : arg.slice('--level='.length)
  if (value === undefined || value === '' || value.startsWith('--')) refuse(AREA, '--level', 'expected one course id or map id after --level')
  return value
}

interface ReportLevel { map: string; course: string; status: string; elapsedMs?: number; waitMs: number }

function existingRecords(file: string): ReportLevel[] {
  try {
    const report = JSON.parse(readFileSync(file, 'utf8')) as { levels?: unknown }
    return Array.isArray(report.levels) ? report.levels as ReportLevel[] : []
  } catch {
    return []
  }
}

export async function main(): Promise<number> {
  try {
    const root = repoRoot()
    const season = parseSeason(JSON.parse(readFileSync(join(root, 'courses/season.json'), 'utf8')) as unknown, 'courses/season.json')
    const built = playableMaps(season)
    if (!built.some(map => map.course === SLOWEST)) refuse(AREA, SLOWEST, 'measurement course is missing')
    const level = requestedLevel()
    const maps = level === null ? built : built.filter((map) => map.id === level || map.course === level)
    if (maps.length === 0) refuse(AREA, level!, `--level ${level} matches no built course`)
    maps.sort((a, b) => Number(b.course === SLOWEST) - Number(a.course === SLOWEST))
    const persistent = persistentThumbDir(root)
    const cacheOnly = process.argv.includes('--cache-only')
    let waitMs = JOB_CEILING_MS
    if (level !== null) {
      try {
        const timing = JSON.parse(readFileSync(join(persistent, `${courseContentKey(root, SLOWEST)}.json`), 'utf8')) as { elapsedMs: number }
        waitMs = measuredWaitMs(timing.elapsedMs)
      } catch { /* Butterfly is not measured yet: its ceiling fits the first render too. */ }
    }
    const reportFile = join(root, 'out/m13/level-thumbs', cacheOnly ? 'cache-check.json' : 'render.json')
    const records: ReportLevel[] = level === null ? [] : existingRecords(reportFile).filter((entry) => entry.map !== maps[0]!.id)
    const record = (map: string, course: string, status: string, elapsedMs?: number): void => {
      records.push({ map, course, status, elapsedMs, waitMs })
      mkdirSync(dirname(reportFile), { recursive: true })
      const temp = `${reportFile}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({ measurementCourse: SLOWEST, levels: records }, null, 2) + '\n')
      renameSync(temp, reportFile)
    }
    const thumbsDir = join(root, 'thumbs')
    mkdirSync(thumbsDir, { recursive: true })
    const cacheFile = join(root, CACHE_REL)
    const cache: CacheFile = { format: 'royal-fiesta.level-thumbs', version: 0, thumbs: {} }
    let sdfm: Sdfm | null = null
    let rendered = 0
    try {
      for (const map of maps) {
        let key: string
        try {
          key = courseContentKey(root, map.course)
        } catch (e) {
          refuse(AREA, `${map.id} ${map.course}`, `cannot read the course content: ${message(e)}`)
        }
        const target = join(thumbsDir, `${map.id}.avif`)
        const stored = join(persistent, `${key}.avif`)
        const timingFile = join(persistent, `${key}.json`)
        let measured: number | undefined
        try {
          const timing = JSON.parse(readFileSync(timingFile, 'utf8')) as { elapsedMs: number }
          measuredWaitMs(timing.elapsedMs)
          measured = timing.elapsedMs
        } catch { /* Missing timing requires measuring Butterfly before choosing the wait. */ }
        if (await opaqueThumb(stored) && (map.course !== SLOWEST || measured !== undefined)) {
          atomicCopy(stored, target)
          record(map.id, map.course, 'cached', measured)
          if (map.course === SLOWEST) waitMs = measuredWaitMs(measured!)
          cache.thumbs[map.id] = { course: map.course, key, path: `thumbs/${map.id}.avif` }
          writeCache(cacheFile, cache)
          console.log(`[level-thumbs] ${map.id} ${map.course}: cached`)
          continue
        }
        if (cacheOnly) refuse(AREA, `${map.id} ${map.course}`, 'persistent thumbnail or Butterfly timing missing')
        if (!process.env.NMC_GPU_URL) {
          refuse(AREA, `${map.id} ${map.course}`, 'no GPU host is configured (NMC_GPU_URL is not set); course_save renders on the GPU client and this tool never renders in Node')
        }
        if (sdfm === null) {
          try {
            sdfm = await openSdfm(root)
          } catch (e) {
            refuse(AREA, `${map.id} ${map.course}`, `the SDF Modeler Node build did not load: ${message(e)}`)
          }
        }
        if (level !== null && measured !== undefined) waitMs = measuredWaitMs(measured)
        const elapsedMs = await renderCourse(sdfm, root, map.id, map.course, stored, waitMs)
        // Persist each result immediately, before starting another level or packing content.
        writeFileSync(`${timingFile}.${process.pid}.tmp`, JSON.stringify({ course: map.course, elapsedMs, waitMs }) + '\n')
        renameSync(`${timingFile}.${process.pid}.tmp`, timingFile)
        atomicCopy(stored, target)
        record(map.id, map.course, 'rendered', elapsedMs)
        if (map.course === SLOWEST) waitMs = measuredWaitMs(elapsedMs)
        cache.thumbs[map.id] = { course: map.course, key, path: `thumbs/${map.id}.avif` }
        writeCache(cacheFile, cache)
        rendered++
        console.log(`[level-thumbs] ${map.id} ${map.course}: rendered in ${(elapsedMs / 1000).toFixed(3)} s`)
      }
    } finally {
      await sdfm?.close()
    }
    console.log(`[level-thumbs] ${maps.length} built courses, ${rendered} rendered, ${maps.length - rendered} cached`)
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exit(await main())
