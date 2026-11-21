import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  captureOptions, loadCaptureRows, runEngineCaptureJob, writeJson,
} from './engineCaptureJob.ts'
import type { CaptureJobConfig, CaptureRow, CaptureResult } from './engineCaptureJob.ts'
import { refuse, isRefusal } from '../packages/sim/src/refusal.ts'
import { parseShowArgs } from '../apps/web/src/engineShow/ops.ts'
import type { ShowArgs } from '../apps/web/src/engineShow/ops.ts'
import { parseSeason, playableMaps } from '../packages/game/src/season.ts'
import { buildContentIndex } from './content.ts'
import { renderOp } from '../apps/headless/src/gpuClient.ts'
import { unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import { repoRoot } from './bricks.ts'

const INVENTORY = 'apps/web/public/engine-show/offline.inventory.json'
const TOPIC = 'engine-show'
const PAGE_FILES = ['engine-show.html', 'ege/rf-scripts.wasm', 'ege/rf-publication.json']
const PODIUM = 'engine-show-winner-podium'

/** The show's inventory rules for the shared validator; an unknown scenario or field refuses. */
export function showRows(path = join(repoRoot(), INVENTORY)): CaptureRow<ShowArgs>[] {
  return loadCaptureRows(path, {
    area: 'engine-show',
    stageField: 'stage',
    checkStage: (value, pointer) => {
      if (value !== 'offline') refuse('engine-show', pointer, "must be 'offline'; show captures are offline only")
      return value
    },
    parseArgs: (value, pointer) => {
      try { return parseShowArgs(value) } catch (error) {
        refuse('engine-show', pointer, error instanceof Error ? error.message : String(error))
      }
    },
  })
}

/** Stages the built page with its engineShow operation descriptor; the normal client page is untouched. */
export function stageShowPage(source: string, target: string): void {
  cpSync(source, target, { recursive: true })
  writeJson(join(target, 'nmc.gpu.json'), { page: 'engine-show.html', ops: ['engineShow'] })
}

interface CourseFile {
  id?: unknown
  spawns?: unknown
  obstacles?: readonly { motion?: { kind?: unknown; form?: unknown } }[]
  features?: readonly unknown[]
}

function builtCourses(): { maps: ReturnType<typeof playableMaps>; ids: string[] } {
  const root = repoRoot()
  const seasonPath = join(root, 'courses/season.json')
  if (!existsSync(seasonPath)) refuse('engine-show', seasonPath, 'is missing; build the season content first')
  const season = parseSeason(JSON.parse(readFileSync(seasonPath, 'utf8')) as unknown, 'courses/season.json')
  const maps = playableMaps(season)
  const ids = [...new Set(maps.map(map => map.course))]
  if (ids.length === 0) refuse('engine-show', seasonPath, 'has no built map; mark a course built before rendering the show')
  return { maps, ids }
}

/** Resolves every selected built course and requires at least one authored moving feature. */
function validateContent(rows: readonly CaptureRow<ShowArgs>[]): void {
  const root = repoRoot()
  const { ids } = builtCourses()
  const index = new Set(buildContentIndex().courses.map(course => course.id))
  let moving = 0
  const courses: CourseFile[] = []
  for (const id of ids) {
    const path = join(root, 'courses', `${id}.course.json`)
    if (!existsSync(path)) refuse('engine-show', path, 'is missing; add the built season course to the content pack')
    const course = JSON.parse(readFileSync(path, 'utf8')) as CourseFile
    if (course.id !== id) refuse('engine-show', path, `declares id '${String(course.id)}' but the built map needs '${id}'`)
    if (!Array.isArray(course.spawns) || course.spawns.length === 0) refuse('engine-show', path, 'has no spawn; author one before rendering')
    if (!index.has(id)) refuse('engine-show', path, 'is not in the built content selection; pack it in the web build')
    courses.push(course)
    let moves = (course.features ?? []).length > 0
    for (const obstacle of course.obstacles ?? []) {
      const form = obstacle.motion?.kind ?? obstacle.motion?.form
      if (typeof form === 'string' && form !== 'static') moves = true
    }
    if (!moves) refuse('engine-show', path, 'has no authored moving feature; add a moving obstacle or feature to the built show content')
    moving++
  }
  if (moving === 0) refuse('engine-show', 'courses/*.course.json', 'has no authored moving feature; add a moving obstacle to the built show content')
  if (rows.some(row => row.args.scenario === PODIUM) && ids.length < 2) {
    refuse('engine-show', INVENTORY, `the podium capture needs two distinct physical courses but the build selects ${ids.length}`)
  }
}

/** Checks the staged page files and every selected course before any GPU work. */
async function validateSelection(page: string, source: string | undefined, rows: readonly CaptureRow<ShowArgs>[]): Promise<void> {
  if (source !== undefined) stageShowPage(source, page)
  for (const path of PAGE_FILES) {
    if (!existsSync(join(page, path))) refuse('engine-show', join(page, path), 'missing staged page file; build the web page first')
  }
  validateContent(rows)
}

async function renderShow(row: CaptureRow<ShowArgs>, pageRef: string): Promise<CaptureResult> {
  const job = mkdtempSync(join(tmpdir(), 'engine-show-job-'))
  try {
    const rendered = await renderOp('engineShow', row.args, job, row.id, pageRef)
    return unwrapOp(rendered, 'facts').out as unknown as CaptureResult
  } finally { rmSync(job, { recursive: true, force: true }) }
}

/** The shared-job configuration; the adapter owns only staging, selection validation and the op call. */
function showConfig(page: string, source?: string): CaptureJobConfig<ShowArgs> {
  return {
    topic: TOPIC,
    inventory: join(repoRoot(), INVENTORY),
    page,
    parseArgs: value => {
      try { return parseShowArgs(value) } catch (error) {
        refuse('engine-show', 'args', error instanceof Error ? error.message : String(error))
      }
    },
    validateSelection: rows => validateSelection(page, source, rows),
    run: (row, pageRef) => renderShow(row, pageRef),
  }
}

function sharedArgs(args: ReturnType<typeof captureOptions>, page: string): string[] {
  const shared = [args.operation, '--stage', args.stage, '--page', page, '--out', args.out]
  if (Number.isFinite(args.budget)) shared.push('--budget-s', String(args.budget))
  return shared
}

/**
 * Handoff: G7-PAGE commands: register the offline build, render and judge selection calls
 * `main(argv: string[]): Promise<number>` exported by tools/engineShowCapture.ts with the generic
 * check, clean, render, fresh and judge operations. Today it parses the shared CLI, stages the built
 * engine-show page with this file's engineShow operation descriptor for render, and forwards the typed
 * show inventory, selection validation and managed op call to runEngineCaptureJob. State/keys: inventory
 * apps/web/public/engine-show/offline.inventory.json, topic engine-show, stage offline, store
 * NMC_CACHE_DIR/engine-show/offline with out/engine-show/offline as its fallback.
 */
export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof captureOptions>
  try { args = captureOptions(argv) } catch {
    return await runEngineCaptureJob(showConfig(''), argv)
  }
  if (args.operation !== 'render') return await runEngineCaptureJob(showConfig(resolve(args.page)), argv)
  const scratch = mkdtempSync(join(tmpdir(), 'engine-show-page-'))
  try {
    return await runEngineCaptureJob(showConfig(scratch, resolve(args.page)), sharedArgs(args, scratch))
  } catch (error) {
    console.error(isRefusal(error) ? error.message : error instanceof Error ? error.message : String(error))
    return 1
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2))
}
