import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { refuse, isRefusal } from '../packages/sim/src/refusal.ts'
import { parseRunArgs } from '../apps/web/src/engineRound/run.ts'
import type { RoundRunArgs } from '../apps/web/src/engineRound/run.ts'
import { buildContentIndex, packContent } from './content.ts'
import { publishDist, renderOp } from '../apps/headless/src/gpuClient.ts'
import { unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import { gpuWaitSeconds, waitForGpuClient } from './chromeCheck.ts'
import { parseScore } from './judgeLoop.ts'
import { repoRoot } from './bricks.ts'
import { harnessRound } from '../apps/headless/src/egeHarness.ts'

const INVENTORY = 'apps/web/public/engine-round/inventory.json'
const USAGE = 'usage: <check|clean|render|fresh|judge> --milestone <mN> --page <dist dir> --out <dir> [--budget-s <s>]'
type Build = { commit: string }
type Kept = { id: string; filename: string; attempt: number }

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function inventorySnapshot(row: InventoryRow): unknown {
  return { id: row.id, filename: row.filename, args: row.args, require: row.require, description: row.description, held_constant: row.held_constant }
}

/**
 * Handoff: Capture job part 3: render, fresh, judge and the milestone commands calls keptRows to
 * reuse unchanged images. It reads the engine-round-store attempts and returns kept rows today.
 */
export function keptRows(storeDir: string, rows: InventoryRow[], build: Build): { kept: Kept[]; render: InventoryRow[] } {
  if (process.env.ENGINE_ROUND_RERENDER_ALL === '1') return { kept: [], render: rows }
  const attemptsDir = join(storeDir, 'attempts')
  const attempts = existsSync(attemptsDir) ? readdirSync(attemptsDir).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a) : []
  const kept: Kept[] = []
  const render: InventoryRow[] = []
  for (const row of rows) {
    let found: Kept | undefined
    for (const attempt of attempts) {
      const dir = join(attemptsDir, String(attempt))
      try {
        const selection = JSON.parse(readFileSync(join(dir, 'selection.json'), 'utf8')) as { build: Build; rows: InventoryRow[] }
        const prior = selection.rows.find(item => item.id === row.id)
        const image = join(dir, row.filename)
        if (selection.build.commit === build.commit && prior && isDeepStrictEqual(inventorySnapshot(prior), inventorySnapshot(row)) && statSync(image).size > 0) {
          found = { id: row.id, filename: row.filename, attempt }
          break
        }
      } catch { /* An incomplete attempt cannot supply a reusable image. */ }
    }
    if (found) kept.push(found)
    else render.push(row)
  }
  return { kept, render }
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

function buildIdentity(): Build {
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(), encoding: 'utf8' }).trim() }
}

function storeFor(milestone: string, out: string): string {
  return resolve(process.env.NMC_CACHE_DIR ? join(process.env.NMC_CACHE_DIR, `engine-round-${milestone}`) : out)
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
  const build = buildIdentity()
  for (const row of rows) {
    const id = row.args.course
    const fixture = join(root, 'fixtures/ege', `${id}.course.json`)
    if (!indexIds.has(id) && !existsSync(fixture)) refuse('engine-round', `${INVENTORY}#/${row.id}/args/course`, `course '${id}' is not in content index or fixtures/ege; add it to shipped content`)
    const { course, round } = await harnessRound(id, { profile: row.args.profile, seed: row.args.seed })
    try {
      if (row.args.focus) {
        const kind = row.args.focus.slice('kind:'.length)
        const kinds = new Set(course.sim?.features?.map(feature => feature.kind) ?? [])
        if (!kinds.has(kind as never)) refuse('engine-round', `${INVENTORY}#/${row.id}/args/focus`, `feature kind '${kind}' is not present in course '${id}'`)
      }
    } finally { round.dispose() }
  }
  json(join(args.out, 'selection.json'), { milestone: args.milestone, build, rows })
  console.log(`engine-round: check ${rows.length} rows`)
}

function clean(args: ReturnType<typeof options>): void {
  const delivery = resolve(args.out)
  const selectionPath = join(delivery, 'selection.json')
  if (!existsSync(selectionPath)) refuse('engine-round', selectionPath, 'run check first')
  const store = storeFor(args.milestone, delivery)
  const attempts = join(store, 'attempts')
  mkdirSync(attempts, { recursive: true })
  const numbers = readdirSync(attempts).filter(name => /^\d+$/.test(name)).map(Number)
  const attempt = Math.max(0, ...numbers) + 1
  const attemptDir = join(attempts, String(attempt))
  mkdirSync(attemptDir, { recursive: true })
  copyFileSync(selectionPath, join(attemptDir, 'selection.json'))
  json(join(store, 'current.json'), { attempt })
}

type Selection = { milestone: string; build: Build; rows: InventoryRow[] }
type Run = { attempt: number; build: Build; kept: Kept[]; rendered: string[]; failed: { id: string; message: string }[] }

function current(args: ReturnType<typeof options>) {
  const delivery = resolve(args.out)
  const store = storeFor(args.milestone, delivery)
  const { attempt } = JSON.parse(readFileSync(join(store, 'current.json'), 'utf8')) as { attempt: number }
  const dir = join(store, 'attempts', String(attempt))
  const selection = JSON.parse(readFileSync(join(dir, 'selection.json'), 'utf8')) as Selection
  if (selection.milestone !== args.milestone) throw new Error('selection milestone does not match; run check and clean')
  return { delivery, store, attempt, dir, selection }
}

function copy(source: string, target: string): void {
  if (resolve(source) === resolve(target)) return
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, force: true })
}

export function renderOrder(rows: InventoryRow[], failed: readonly string[], rendered: readonly string[]): InventoryRow[] {
  const priority = (id: string) => failed.includes(id) ? 0 : rendered.includes(id) ? 2 : 1
  return [...rows].sort((a, b) => priority(a.id) - priority(b.id))
}

async function render(args: ReturnType<typeof options>): Promise<number> {
  const ctx = current(args)
  const { selection, store, dir, delivery, attempt } = ctx
  const reusable = keptRows(store, selection.rows, selection.build)
  const failed: string[] = []
  const rendered: string[] = []
  for (const name of readdirSync(join(store, 'attempts')).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a)) {
    try {
      const previous = JSON.parse(readFileSync(join(store, 'attempts', String(name), 'run.json'), 'utf8')) as Run
      for (const item of previous.failed) if (!failed.includes(item.id) && !rendered.includes(item.id)) failed.push(item.id)
      for (const id of previous.rendered) if (!failed.includes(id) && !rendered.includes(id)) rendered.push(id)
    } catch { /* An unfinished attempt may not have a run record. */ }
  }
  const run: Run = { attempt, build: selection.build, kept: reusable.kept, rendered: [], failed: [] }
  const saveRun = () => { json(join(dir, 'run.json'), run); copy(join(dir, 'run.json'), join(delivery, 'run.json')) }
  for (const item of reusable.kept) {
    const origin = join(store, 'attempts', String(item.attempt))
    copy(join(origin, item.filename), join(dir, item.filename))
    copy(join(origin, 'jobs', item.id), join(dir, 'jobs', item.id))
    copy(join(dir, item.filename), join(delivery, item.filename))
    copy(join(dir, 'jobs', item.id), join(delivery, 'jobs', item.id))
  }
  copy(join(dir, 'selection.json'), join(delivery, 'selection.json'))
  saveRun()
  const ordered = renderOrder(reusable.render, failed, rendered)
  console.log(`engine-round: kept ${reusable.kept.length}, rendering ${ordered.length}`)
  if (!ordered.length) return 0
  await waitForGpuClient(gpuWaitSeconds(process.env.NMC_GPU_WAIT_S))
  const scratch = mkdtempSync(join(tmpdir(), 'engine-round-page-'))
  try {
    cpSync(args.page, scratch, { recursive: true })
    const content = join(scratch, 'content')
    const index = packContent(content, undefined, new Set())
    for (const id of new Set(selection.rows.map(row => row.args.course))) {
      const fixture = join(repoRoot(), 'fixtures/ege', `${id}.course.json`)
      if (!index.courses.some(course => course.id === id) && existsSync(fixture)) {
        const path = `courses/${id}.course.json`
        copy(fixture, join(content, path))
        index.courses.push({ id, path })
      }
    }
    json(join(content, 'index.json'), index)
    json(join(scratch, 'nmc.gpu.json'), { page: 'engine-round.html', ops: ['engineRound'] })
    const pageRef = await publishDist(scratch)
    for (const row of ordered) {
      const job = join(dir, 'jobs', row.id)
      try {
        rmSync(join(dir, row.filename), { force: true })
        rmSync(join(delivery, row.filename), { force: true })
        rmSync(job, { recursive: true, force: true })
        const result = await renderOp('engineRound', row.args, job, row.id, pageRef)
        const output = unwrapOp(result, 'facts').out
        const capture = output.capture as Record<string, unknown> | undefined
        if (!capture || capture.name !== row.filename || typeof capture.base64 !== 'string') throw new Error('invalid capture output')
        const image = Buffer.from(capture.base64, 'base64')
        if (!image.length) throw new Error('empty capture')
        const problems = requireProblems(output.facts, row.require)
        if (problems.length) throw new Error(problems.join('; '))
        const { base64: _base64, ...metadata } = capture
        json(join(job, 'input.json'), row.args)
        json(join(job, 'result.json'), { facts: output.facts, capture: metadata })
        writeFileSync(join(dir, row.filename), image)
        copy(job, join(delivery, 'jobs', row.id))
        copy(join(dir, row.filename), join(delivery, row.filename))
        run.rendered.push(row.id)
      } catch (error) {
        rmSync(job, { recursive: true, force: true })
        run.failed.push({ id: row.id, message: error instanceof Error ? error.message : String(error) })
        console.error(`engine-round: ${row.id}: ${run.failed.at(-1)!.message}`)
      }
      saveRun()
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
  return run.failed.length ? 1 : 0
}

function fresh(args: ReturnType<typeof options>): number {
  const { selection, delivery, dir } = current(args)
  let failures = 0
  for (const row of selection.rows) {
    try {
      const image = join(delivery, row.filename)
      if (statSync(image).size === 0) throw new Error('image is empty')
      const job = join(delivery, 'jobs', row.id)
      const origin = join(dir, 'jobs', row.id)
      for (const file of ['input.json', 'result.json']) {
        if (!readFileSync(join(job, file)).equals(readFileSync(join(origin, file)))) throw new Error(`${file} differs from attempt`)
      }
      const result = JSON.parse(readFileSync(join(job, 'result.json'), 'utf8')) as { facts: unknown }
      const problems = requireProblems(result.facts, row.require)
      for (const problem of problems) {
        failures++
        console.error(`engine-round: ${row.id}: ${problem}`)
      }
    } catch (error) {
      failures++
      console.error(`engine-round: ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures ? 1 : 0
}

type Verdict = { filename: string; description: string; attempt: number; score: number | null; pass: boolean }
type JudgeRunner = (image: string, description: string) => Promise<string>

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
        if (verdict.pass && verdict.description === row.description && bytes.equals(readFileSync(join(store, 'attempts', String(verdict.attempt), row.filename)))) continue
      } catch { /* No reusable verdict. */ }
      if (clock() - start >= budget * 1000) { missing++; continue }
      const score = parseScore(await run(image, row.description))
      const verdict: Verdict = { filename: row.filename, description: row.description, attempt, score, pass: score !== null && score >= 6 }
      json(verdictPath, verdict)
      if (!verdict.pass) missing++
    } catch (error) {
      missing++
      console.error(`engine-round: ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return missing ? 1 : 0
}

async function judge(args: ReturnType<typeof options>): Promise<number> {
  const { store, delivery, attempt, selection } = current(args)
  return judgeImages(store, delivery, attempt, selection.rows, args.budget, (image, description) => new Promise((done, reject) => {
    const client = process.env.NMC_JUDGE_CLIENT
    if (!client) { reject(new Error('NMC_JUDGE_CLIENT is unset')); return }
    const child = spawn('python3', [client, image, '--description', description, '--min-score', '6'])
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
  let input: unknown
  try { input = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    refuse('engine-round', path, `cannot read inventory: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(input)) refuse('engine-round', path, 'must be a JSON list')
  const ids = new Set<string>()
  const filenames = new Set<string>()
  return input.map((item: unknown, index: number) => {
    const base = `${path}#/${index}`
    if (!item || typeof item !== 'object' || Array.isArray(item)) refuse('engine-round', base, 'must be an object')
    const row = item as Record<string, unknown>
    const fields = ['id', 'milestone', 'filename', 'args', 'require', 'description', 'held_constant']
    for (const field of fields) if (!Object.hasOwn(row, field)) refuse('engine-round', `${base}/${field}`, 'is required')
    if (typeof row.id !== 'string' || !row.id) refuse('engine-round', `${base}/id`, 'must be a non-empty string')
    if (ids.has(row.id)) refuse('engine-round', `${base}/id`, `duplicate id '${row.id}'`)
    ids.add(row.id)
    if (typeof row.milestone !== 'string' || !/^m[2-7]$/.test(row.milestone)) refuse('engine-round', `${base}/milestone`, 'must match ^m[2-7]$')
    if (typeof row.filename !== 'string' || !/^[a-z0-9-]+[.]png$/.test(row.filename)) refuse('engine-round', `${base}/filename`, 'must match ^[a-z0-9-]+[.]png$')
    if (filenames.has(row.filename)) refuse('engine-round', `${base}/filename`, `duplicate filename '${row.filename}'`)
    filenames.add(row.filename)
    if (typeof row.args !== 'object' || row.args === null || Array.isArray(row.args)) refuse('engine-round', `${base}/args`, 'must be an object')
    try { parseRunArgs(row.args) } catch (error) {
      const field = error && typeof error === 'object' && 'path' in error ? String((error as { path: unknown }).path).replace(/^args\./, '') : ''
      refuse('engine-round', `${base}/args${field ? `/${field}` : ''}`, error instanceof Error ? error.message : String(error))
    }
    if (!Array.isArray(row.require) || row.require.some(rule => typeof rule !== 'string' || !validRule(rule))) refuse('engine-round', `${base}/require`, 'contains a rule outside the E8 grammar')
    if (typeof row.description !== 'string') refuse('engine-round', `${base}/description`, 'must be a string')
    if (!Array.isArray(row.held_constant) || row.held_constant.some(value => typeof value !== 'string')) refuse('engine-round', `${base}/held_constant`, 'must be a string list')
    return { id: row.id, milestone: row.milestone, filename: row.filename, args: parseRunArgs(row.args), require: row.require, description: row.description, held_constant: row.held_constant } as InventoryRow
  })
}

function validRule(rule: string): boolean {
  const match = /^([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s+(eq|gt|ge|lt|empty)(?:\s+(.+))?$/.exec(rule)
  if (!match) return false
  if (match[2] === 'empty') return match[3] === undefined
  if (match[3] === undefined) return false
  if (match[2] !== 'eq') return Number.isFinite(Number(match[3]))
  try { JSON.parse(match[3]); return true } catch { return false }
}

export function selectRows(rows: InventoryRow[], milestone: string): InventoryRow[] {
  return rows.filter(row => row.milestone === milestone)
}

export function requireProblems(facts: unknown, require: readonly string[]): string[] {
  const problems: string[] = []
  for (const rule of require) {
    const match = /^([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s+(eq|gt|ge|lt|empty)(?:\s+(.+))?$/.exec(rule)
    if (!match || (match[2] === 'empty' ? match[3] !== undefined : match[3] === undefined)) {
      problems.push(`${rule}: not '${rule}'`)
      continue
    }
    const [, path, op, raw] = match
    let value: unknown = facts
    for (const part of path.split('.')) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) { value = undefined; break }
      value = (value as Record<string, unknown>)[part]
    }
    if (value === undefined) { problems.push(`${rule}: fact ${path} is absent`); continue }
    let pass = false
    if (op === 'eq') {
      try { pass = value === JSON.parse(raw!) } catch { pass = false }
    } else if (op === 'empty') pass = Array.isArray(value) ? value.length === 0 : !!value && typeof value === 'object' && Object.keys(value).length === 0
    else if (typeof value === 'number' && Number.isFinite(value)) {
      const target = Number(raw)
      pass = Number.isFinite(target) && (op === 'gt' ? value > target : op === 'ge' ? value >= target : value < target)
    }
    if (!pass) problems.push(`${rule}: got ${JSON.stringify(value)}`)
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2))
}
