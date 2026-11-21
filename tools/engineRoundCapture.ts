import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { copyRecord, judgeCaptureRows, keptRowsWith, loadCaptureRows, requirementProblems, renderOrder as sharedRenderOrder, runEngineCaptureJob, writeJson as json } from './engineCaptureJob.ts'
import type { CaptureBuild, CaptureJobConfig, CaptureKept, CaptureResult, CaptureRow, JudgeRunner } from './engineCaptureJob.ts'
import { refuse, isRefusal } from '../packages/sim/src/refusal.ts'
import { focusedFeature, parseRunArgs } from '../apps/web/src/engineRound/run.ts'
import type { RoundRunArgs } from '../apps/web/src/engineRound/run.ts'
import { buildContentIndex, packContent } from './content.ts'
import { renderOp } from '../apps/headless/src/gpuClient.ts'
import { unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import { repoRoot } from './bricks.ts'
import { harnessRound } from '../apps/headless/src/egeHarness.ts'

const INVENTORY = 'apps/web/public/engine-round/inventory.json'
const USAGE = 'usage: <check|clean|render|fresh|judge> --milestone <mN> --page <dist dir> --out <dir> [--budget-s <s>]'
const PAGE_FILES = ['engine-round.html', 'engine-round/inventory.json', 'ege/rf-scripts.wasm']
type Build = CaptureBuild
type Kept = CaptureKept

/**
 * Handoff: Capture job part 3: render, fresh, judge and the milestone commands calls keptRows to
 * reuse unchanged images. It reads the engine-round-store attempts and returns kept rows today.
 */
export function keptRows(storeDir: string, rows: InventoryRow[], build: Build): { kept: Kept[]; render: InventoryRow[] } {
  return keptRowsWith<InventoryRow>('ENGINE_ROUND_RERENDER_ALL', storeDir, rows, build, false)
}

type Options = { op: string; milestone: string; page: string; out: string; budget: number }

function options(argv: string[]): Options {
  const [op, ...rest] = argv
  if (!['check', 'clean', 'render', 'fresh', 'judge'].includes(op ?? '') || rest.length % 2 !== 0) throw new Error(USAGE)
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--milestone', '--page', '--out', '--budget-s'].includes(rest[i]) || values.has(rest[i])) throw new Error(USAGE)
    values.set(rest[i], rest[i + 1])
  }
  if (!values.has('--milestone') || !values.has('--page') || !values.has('--out') || values.has('--budget-s') && (!Number.isFinite(Number(values.get('--budget-s'))) || Number(values.get('--budget-s')) < 0)) throw new Error(USAGE)
  return { op: op!, milestone: values.get('--milestone')!, page: values.get('--page')!, out: values.get('--out')!, budget: values.has('--budget-s') ? Number(values.get('--budget-s')) : Infinity }
}

export function renderOrder(rows: InventoryRow[], failed: readonly string[], rendered: readonly string[]): InventoryRow[] {
  return sharedRenderOrder(rows, failed, rendered)
}

function roundArgs(value: unknown): RoundRunArgs {
  try { return parseRunArgs(value) } catch (error) {
    const field = error && typeof error === 'object' && 'path' in error ? String((error as { path: unknown }).path).replace(/^args\./, '') : ''
    refuse('engine-round', `args${field ? `/${field}` : ''}`, error instanceof Error ? error.message : String(error))
  }
}

/** Stages the selected built page with its engineRound operation descriptor; content packing stays here. */
function stageRoundPage(source: string, target: string, rows: readonly CaptureRow<RoundRunArgs>[]): void {
  cpSync(source, target, { recursive: true })
  const content = join(target, 'content')
  const index = packContent(content, undefined, new Set())
  for (const id of new Set(rows.map(row => row.args.course))) {
    const fixture = join(repoRoot(), 'fixtures/ege', `${id}.course.json`)
    if (!index.courses.some(course => course.id === id) && existsSync(fixture)) {
      const path = `courses/${id}.course.json`
      copyRecord(fixture, join(content, path))
      index.courses.push({ id, path })
    }
  }
  json(join(content, 'index.json'), index)
  json(join(target, 'nmc.gpu.json'), { page: 'engine-round.html', ops: ['engineRound'] })
}

/** Checks the staged page files and every row's course, focus and construction before any GPU work. */
async function validateRounds(page: string, rows: readonly CaptureRow<RoundRunArgs>[]): Promise<void> {
  for (const path of PAGE_FILES) {
    if (!existsSync(join(page, path))) refuse('engine-round', join(page, path), 'missing staged page file; build the web page first')
  }
  const root = repoRoot()
  const index = buildContentIndex()
  const indexIds = new Set(index.courses.map(course => course.id))
  for (const row of rows) {
    const id = row.args.course
    const fixture = join(root, 'fixtures/ege', `${id}.course.json`)
    if (!indexIds.has(id) && !existsSync(fixture)) refuse('engine-round', `${INVENTORY}#/${row.id}/args/course`, `course '${id}' is not in content index or fixtures/ege; add it to shipped content`)
    const { course, round } = await harnessRound(id, { profile: row.args.profile, seed: row.args.seed })
    try {
      if (row.args.focus && !focusedFeature(course, row.args.focus)) {
        refuse('engine-round', `${INVENTORY}#/${row.id}/args/focus`, `'${row.args.focus}' matches no feature of course '${id}'`)
      }
    } finally { round.dispose() }
  }
}

async function renderRound(row: CaptureRow<RoundRunArgs>, pageRef: string): Promise<CaptureResult> {
  const job = mkdtempSync(join(tmpdir(), 'engine-round-job-'))
  try {
    const rendered = await renderOp('engineRound', row.args, job, row.id, pageRef)
    return unwrapOp(rendered, 'facts').out as unknown as CaptureResult
  } finally { rmSync(job, { recursive: true, force: true }) }
}

/**
 * Engine-round configuration for the shared job. `page` is the directory the operation publishes or
 * checks; `source` is the built page to stage into it for a render.
 */
function roundConfig(page: string, source?: string): CaptureJobConfig<RoundRunArgs> {
  return {
    topic: 'engine-round-',
    inventory: INVENTORY,
    page,
    parseArgs: roundArgs,
    validateSelection: async rows => {
      if (source !== undefined) stageRoundPage(source, page, rows)
      await validateRounds(page, rows)
    },
    run: (row, pageRef) => renderRound(row, pageRef),
  }
}

/** Judges with the shared lifecycle; legacy callers keep this forwarding entry point. */
export function judgeImages(store: string, delivery: string, attempt: number, rows: InventoryRow[], budget: number, run: JudgeRunner, clock: () => number): Promise<number> {
  return judgeCaptureRows('engine-round', store, delivery, attempt, rows, budget, run, clock)
}

/** Run the E8 command line: validate the legacy options, then dispatch the shared operation. */
export async function main(argv: string[]): Promise<number> {
  let args: Options
  try { args = options(argv) } catch { console.error(USAGE); return 2 }
  const scratch = mkdtempSync(join(tmpdir(), 'engine-round-page-'))
  try {
    const render = args.op === 'render'
    const config = roundConfig(render ? scratch : args.page, render ? args.page : undefined)
    const shared = [args.op, '--stage', args.milestone, '--page', config.page, '--out', args.out]
    if (Number.isFinite(args.budget)) shared.push('--budget-s', String(args.budget))
    return await runEngineCaptureJob(config, shared)
  } catch (error) {
    console.error(isRefusal(error) ? error.message : error instanceof Error ? error.message : String(error))
    return 1
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

export interface InventoryRow {
  id: string
  milestone: string
  filename: string
  args: RoundRunArgs
  require: string[]
  description: string
  held_constant: string[]
}

/**
 * Handoff: Capture job part 2: check, clean and the resumable store consumes the validated
 * InventoryRow values from this loader; Capture job part 3: render, fresh, judge and the milestone
 * commands uses the same selection and require rules. This loader reads and validates JSON today.
 */
export function loadInventory(path: string): InventoryRow[] {
  return loadCaptureRows(path, {
    area: 'engine-round',
    stageField: 'milestone',
    checkStage: (value, pointer) => {
      if (typeof value !== 'string' || !/^m[2-7]$/.test(value)) refuse('engine-round', pointer, 'must match ^m[2-7]$')
      return value
    },
    parseArgs: (value, pointer) => {
      try { return parseRunArgs(value) } catch (error) {
        const field = error && typeof error === 'object' && 'path' in error ? String((error as { path: unknown }).path).replace(/^args\./, '') : ''
        refuse('engine-round', `${pointer}${field ? `/${field}` : ''}`, error instanceof Error ? error.message : String(error))
      }
    },
  }).map(row => ({ id: row.id, milestone: row.stage, filename: row.filename, args: row.args, require: row.require as string[], description: row.description, held_constant: row.held_constant as string[] }))
}

export function selectRows(rows: InventoryRow[], milestone: string): InventoryRow[] {
  return rows.filter(row => row.milestone === milestone)
}

export function requireProblems(facts: unknown, require: readonly string[]): string[] {
  return requirementProblems(facts, require)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2))
}
