import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { allocateAttempt, captureBuild, captureStageStore, currentAttempt, freshEngineCapture, keptRowsWith, loadCaptureRows, renderEngineCapture, requirementProblems, renderOrder as sharedRenderOrder, writeJson as json, copyRecord as copy } from './engineCaptureJob.ts'
import type { CaptureBuild, CaptureJobConfig, CaptureKept, CaptureResult, CaptureRow } from './engineCaptureJob.ts'
import { refuse, isRefusal } from '../packages/sim/src/refusal.ts'
import { focusedFeature, parseRunArgs } from '../apps/web/src/engineRound/run.ts'
import type { RoundRunArgs } from '../apps/web/src/engineRound/run.ts'
import { buildContentIndex, packContent } from './content.ts'
import { renderOp } from '../apps/headless/src/gpuClient.ts'
import { unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import { parseScore } from './judgeLoop.ts'
import { repoRoot } from './bricks.ts'
import { harnessRound } from '../apps/headless/src/egeHarness.ts'

const INVENTORY = 'apps/web/public/engine-round/inventory.json'
const USAGE = 'usage: <check|clean|render|fresh|judge> --milestone <mN> --page <dist dir> --out <dir> [--budget-s <s>]'
type Build = CaptureBuild
type Kept = CaptureKept

/**
 * Handoff: Capture job part 3: render, fresh, judge and the milestone commands calls keptRows to
 * reuse unchanged images. It reads the engine-round-store attempts and returns kept rows today.
 */
export function keptRows(storeDir: string, rows: InventoryRow[], build: Build): { kept: Kept[]; render: InventoryRow[] } {
  return keptRowsWith<InventoryRow>('ENGINE_ROUND_RERENDER_ALL', storeDir, rows, build, false)
}

function options(argv: string[]): { op: string; milestone: string; page: string; out: string; budget: number } {
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

function storeFor(milestone: string, out: string): string {
  return captureStageStore('engine-round-', milestone, out)
}

async function check(args: ReturnType<typeof options>): Promise<void> {
  const rows = selectRows(loadInventory(INVENTORY), args.milestone)
  if (!rows.length) refuse('engine-round', INVENTORY, `no rows for ${args.milestone}`)
  for (const path of ['engine-round.html', 'engine-round/inventory.json', 'ege/rf-scripts.wasm']) {
    if (!existsSync(join(args.page, path))) refuse('engine-round', join(args.page, path), 'missing staged page file; build the web page first')
  }
  const root = repoRoot()
  const index = buildContentIndex()
  const indexIds = new Set(index.courses.map(course => course.id))
  const build = captureBuild()
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
  json(join(args.out, 'selection.json'), { milestone: args.milestone, build, rows: rows.map(row => ({ ...row, stage: row.milestone })) })
  console.log(`engine-round: check ${rows.length} rows`)
}

function clean(args: ReturnType<typeof options>): void {
  const delivery = resolve(args.out)
  const selectionPath = join(delivery, 'selection.json')
  if (!existsSync(selectionPath)) refuse('engine-round', selectionPath, 'run check first')
  allocateAttempt(storeFor(args.milestone, delivery), selectionPath)
}

function current(args: ReturnType<typeof options>) {
  const delivery = resolve(args.out)
  const store = storeFor(args.milestone, delivery)
  const { attempt, dir, selection } = currentAttempt<InventoryRow>(store)
  if (selection.milestone !== args.milestone) throw new Error('selection milestone does not match; run check and clean')
  return { delivery, store, attempt, dir, selection }
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
      copy(fixture, join(content, path))
      index.courses.push({ id, path })
    }
  }
  json(join(content, 'index.json'), index)
  json(join(target, 'nmc.gpu.json'), { page: 'engine-round.html', ops: ['engineRound'] })
}

async function renderRound(row: CaptureRow<RoundRunArgs>, pageRef: string): Promise<CaptureResult> {
  const job = mkdtempSync(join(tmpdir(), 'engine-round-job-'))
  try {
    const rendered = await renderOp('engineRound', row.args, job, row.id, pageRef)
    return unwrapOp(rendered, 'facts').out as unknown as CaptureResult
  } finally { rmSync(job, { recursive: true, force: true }) }
}

function roundConfig(page: string, source?: string): CaptureJobConfig<RoundRunArgs> {
  return {
    topic: 'engine-round-',
    inventory: INVENTORY,
    page,
    parseArgs: roundArgs,
    validateSelection: async rows => { if (source !== undefined) stageRoundPage(source, page, rows) },
    run: (row, pageRef) => renderRound(row, pageRef),
  }
}

function sharedArgv(operation: 'render' | 'fresh', args: ReturnType<typeof options>): string[] {
  return [operation, '--stage', args.milestone, '--page', args.page, '--out', args.out]
}

async function render(args: ReturnType<typeof options>): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), 'engine-round-page-'))
  try { return await renderEngineCapture(roundConfig(scratch, args.page), sharedArgv('render', args)) }
  finally { rmSync(scratch, { recursive: true, force: true }) }
}

function fresh(args: ReturnType<typeof options>): number {
  return freshEngineCapture(roundConfig(args.page), sharedArgv('fresh', args))
}

type Verdict = { filename: string; description: string; heldConstant?: string[]; attempt: number; score: number | null; pass: boolean }
type JudgeRunner = (image: string, description: string, heldConstant: string[]) => Promise<string>

export async function judgeImages(store: string, delivery: string, attempt: number, rows: InventoryRow[], budget: number, run: JudgeRunner, clock: () => number): Promise<number> {
  const start = clock()
  let missing = 0
  for (const row of rows) {
    const image = join(delivery, row.filename)
    const verdictPath = join(store, 'verdicts', `${row.filename}.json`)
    try {
      const bytes = readFileSync(image)
      if (!bytes.length) throw new Error('image is empty')
      try {
        const verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as Verdict
        if (verdict.pass && verdict.description === row.description && JSON.stringify(verdict.heldConstant ?? []) === JSON.stringify(row.held_constant) && bytes.equals(readFileSync(join(store, 'attempts', String(verdict.attempt), row.filename)))) continue
      } catch { /* No reusable verdict. */ }
      if (clock() - start >= budget * 1000) { missing++; console.error(`engine-round: ${row.id}: judge budget ${budget} s spent before this image`); continue }
      const answer = await run(image, row.description, row.held_constant)
      const score = parseScore(answer)
      const verdict: Verdict = { filename: row.filename, description: row.description, heldConstant: row.held_constant, attempt, score, pass: score !== null && score >= 6 }
      json(verdictPath, verdict)
      console.log(`engine-round: ${row.id}: judge score ${score ?? 'none'} (min 6) ${verdict.pass ? 'PASS' : 'FAIL'}`)
      if (!verdict.pass) {
        missing++
        console.error(`engine-round: ${row.id}: JUDGE FAIL ${row.filename}\n${answer.trim()}`)
      }
    } catch (error) {
      missing++
      console.error(`engine-round: ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return missing ? 1 : 0
}

async function judge(args: ReturnType<typeof options>): Promise<number> {
  const { store, delivery, attempt, selection } = current(args)
  return judgeImages(store, delivery, attempt, selection.rows, args.budget, (image, description, heldConstant) => new Promise((done, reject) => {
    const client = process.env.NMC_JUDGE_CLIENT
    if (!client) { reject(new Error('NMC_JUDGE_CLIENT is unset')); return }
    const child = spawn('python3', [client, image, '--description', description, '--min-score', '6', ...heldConstant.flatMap(item => ['--held-constant', item])])
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { process.stderr.write(chunk) })
    child.once('error', reject)
    child.once('close', () => done(stdout))
  }), Date.now)
}

/** Run the E8 command line. */
export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof options>
  try { args = options(argv) } catch { console.error(USAGE); return 2 }
  try {
    if (args.op === 'check') await check(args)
    else if (args.op === 'clean') clean(args)
    else if (args.op === 'render') return await render(args)
    else if (args.op === 'fresh') return fresh(args)
    else return await judge(args)
    return 0
  } catch (error) {
    console.error(isRefusal(error) ? error.message : error instanceof Error ? error.message : String(error))
    return 1
  }
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
