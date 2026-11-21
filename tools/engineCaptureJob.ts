import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { refuse } from '../packages/sim/src/refusal.ts'
import { decodePng } from '../apps/headless/src/gpuRecord.ts'
import { publishDist } from '../apps/headless/src/gpuClient.ts'
import { gpuWaitSeconds, waitForGpuClient } from './chromeCheck.ts'
import { repoRoot } from './bricks.ts'
import { parseScore } from './judgeLoop.ts'

/** Output filename rule shared by every capture inventory (E8). */
export const CAPTURE_FILENAME = /^[a-z0-9-]+[.]png$/

/** Requirement grammar: `<fact path> <eq|gt|ge|lt|empty> [value]` (E8). */
const REQUIREMENT = /^([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s+(eq|gt|ge|lt|empty)(?:\s+(.+))?$/

export type CaptureRow<A> = {
  id: string
  stage: string
  filename: string
  args: A
  require: readonly string[]
  description: string
  held_constant: readonly string[]
}

/**
 * Describes one inventory family to the shared validator. `area` names the refusal source,
 * `stageField` is the row key holding the stage (`milestone` for engine rounds), `checkStage`
 * returns the accepted stage or refuses, and `parseArgs` returns typed arguments or refuses.
 */
export type CaptureRowRules<A> = {
  area: string
  stageField: string
  checkStage: (value: unknown, pointer: string) => string
  parseArgs: (value: unknown, pointer: string) => A
}

/**
 * Validates the inventory list at `path` and returns typed rows in file order. Pointer-specific
 * refusals name `path#/<index>/<field>`; ids and filenames must be unique within the list.
 */
export function loadCaptureRows<A>(path: string, rules: CaptureRowRules<A>): CaptureRow<A>[] {
  let input: unknown
  try { input = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    refuse(rules.area, path, `cannot read inventory: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(input)) refuse(rules.area, path, 'must be a JSON list')
  const ids = new Set<string>()
  const filenames = new Set<string>()
  return input.map((item: unknown, index: number) => {
    const base = `${path}#/${index}`
    if (!item || typeof item !== 'object' || Array.isArray(item)) refuse(rules.area, base, 'must be an object')
    const row = item as Record<string, unknown>
    const fields = ['id', rules.stageField, 'filename', 'args', 'require', 'description', 'held_constant']
    for (const field of fields) if (!Object.hasOwn(row, field)) refuse(rules.area, `${base}/${field}`, 'is required')
    if (typeof row.id !== 'string' || !row.id) refuse(rules.area, `${base}/id`, 'must be a non-empty string')
    if (ids.has(row.id)) refuse(rules.area, `${base}/id`, `duplicate id '${row.id}'`)
    ids.add(row.id)
    const stage = rules.checkStage(row[rules.stageField], `${base}/${rules.stageField}`)
    if (typeof row.filename !== 'string' || !CAPTURE_FILENAME.test(row.filename)) refuse(rules.area, `${base}/filename`, 'must match ^[a-z0-9-]+[.]png$')
    if (filenames.has(row.filename)) refuse(rules.area, `${base}/filename`, `duplicate filename '${row.filename}'`)
    filenames.add(row.filename)
    if (typeof row.args !== 'object' || row.args === null || Array.isArray(row.args)) refuse(rules.area, `${base}/args`, 'must be an object')
    const args = rules.parseArgs(row.args, `${base}/args`)
    if (!Array.isArray(row.require) || row.require.some(rule => typeof rule !== 'string' || !validRequirement(rule))) refuse(rules.area, `${base}/require`, 'contains a rule outside the E8 grammar')
    if (typeof row.description !== 'string') refuse(rules.area, `${base}/description`, 'must be a string')
    if (!Array.isArray(row.held_constant) || row.held_constant.some(value => typeof value !== 'string')) refuse(rules.area, `${base}/held_constant`, 'must be a string list')
    return { id: row.id, stage, filename: row.filename, args, require: row.require as string[], description: row.description, held_constant: row.held_constant as string[] }
  })
}

/** True when a requirement string matches the E8 operator grammar. */
export function validRequirement(rule: string): boolean {
  const match = REQUIREMENT.exec(rule)
  if (!match) return false
  if (match[2] === 'empty') return match[3] === undefined
  if (match[3] === undefined) return false
  if (match[2] !== 'eq') return Number.isFinite(Number(match[3]))
  try { JSON.parse(match[3]); return true } catch { return false }
}

/** Returns one message per failed requirement, in the order given; empty when all pass. */
export function requirementProblems(facts: unknown, require: readonly string[]): string[] {
  const problems: string[] = []
  for (const rule of require) {
    const match = REQUIREMENT.exec(rule)
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

/** Identity fields that decide whether a stored row can be reused (the stage is the store namespace). */
export type CaptureIdentity = {
  id: string
  filename: string
  args: unknown
  require: readonly string[]
  description: string
  held_constant: readonly string[]
}

/** Build identity (publication commit) recorded with every selection and run. */
export type CaptureBuild = { commit: string }

/** A row whose image and job records are reused from attempts/<attempt>. */
export type CaptureKept = { id: string; filename: string; attempt: number }

/** Selection record stored as attempts/<n>/selection.json; adapters may add fields such as `milestone`. */
export type CaptureSelection<R> = { build: CaptureBuild; rows: R[]; [field: string]: unknown }

/** One render pass stored as attempts/<n>/run.json. */
export type CaptureRun = {
  attempt: number
  build: CaptureBuild
  kept: CaptureKept[]
  rendered: string[]
  failed: { id: string; message: string }[]
}

/** Writes UTF-8 JSON with two-space indentation and a trailing newline, creating parent folders. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Copies a file or folder into a new location unless source and target are the same path. */
export function copyRecord(source: string, target: string): void {
  if (resolve(source) === resolve(target)) return
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, force: true })
}

/** Resumable store for a namespace: NMC_CACHE_DIR/<namespace>, falling back to the delivery folder. */
export function captureStore(namespace: string, out: string): string {
  return resolve(process.env.NMC_CACHE_DIR ? join(process.env.NMC_CACHE_DIR, namespace) : out)
}

/** Attempt numbers present in the store, newest first. */
export function attemptNumbers(store: string): number[] {
  const dir = join(store, 'attempts')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a)
}

/** Creates the next attempt with a copy of the selection and makes it current; retained records stay. */
export function allocateAttempt(store: string, selectionPath: string): number {
  const attempts = join(store, 'attempts')
  mkdirSync(attempts, { recursive: true })
  const attempt = Math.max(0, ...attemptNumbers(store)) + 1
  const attemptDir = join(attempts, String(attempt))
  mkdirSync(attemptDir, { recursive: true })
  copyFileSync(selectionPath, join(attemptDir, 'selection.json'))
  writeJson(join(store, 'current.json'), { attempt })
  return attempt
}

/** Reads the current attempt number, its directory and its selection record. */
export function currentAttempt<R>(store: string): { attempt: number; dir: string; selection: CaptureSelection<R> } {
  const { attempt } = JSON.parse(readFileSync(join(store, 'current.json'), 'utf8')) as { attempt: number }
  const dir = join(store, 'attempts', String(attempt))
  const selection = JSON.parse(readFileSync(join(dir, 'selection.json'), 'utf8')) as CaptureSelection<R>
  return { attempt, dir, selection }
}

/** Failed and previously rendered ids from every run record, newest attempt first. */
export function priorOutcomes(store: string): { failed: string[]; rendered: string[] } {
  const failed: string[] = []
  const rendered: string[] = []
  for (const name of attemptNumbers(store)) {
    try {
      const previous = JSON.parse(readFileSync(join(store, 'attempts', String(name), 'run.json'), 'utf8')) as CaptureRun
      for (const item of previous.failed) if (!failed.includes(item.id) && !rendered.includes(item.id)) failed.push(item.id)
      for (const id of previous.rendered) if (!failed.includes(id) && !rendered.includes(id)) rendered.push(id)
    } catch { /* An unfinished attempt may not have a run record. */ }
  }
  return { failed, rendered }
}

/** Copies kept images and job records from their originating attempts into a fresh delivery folder. */
export function restoreRetained(store: string, dir: string, delivery: string, kept: readonly CaptureKept[]): void {
  for (const item of kept) {
    const origin = join(store, 'attempts', String(item.attempt))
    copyRecord(join(origin, item.filename), join(dir, item.filename))
    copyRecord(join(origin, 'jobs', item.id), join(dir, 'jobs', item.id))
    copyRecord(join(dir, item.filename), join(delivery, item.filename))
    copyRecord(join(dir, 'jobs', item.id), join(delivery, 'jobs', item.id))
  }
}

/** Orders rows: failed first, then never rendered, then previously rendered; inventory order within each rank. */
export function renderOrder<T extends { id: string }>(rows: readonly T[], failed: readonly string[], rendered: readonly string[]): T[] {
  const priority = (id: string) => failed.includes(id) ? 0 : rendered.includes(id) ? 2 : 1
  return [...rows].sort((a, b) => priority(a.id) - priority(b.id))
}

function identitySnapshot(row: CaptureIdentity): unknown {
  return { id: row.id, filename: row.filename, args: row.args, require: row.require, description: row.description, held_constant: row.held_constant }
}

function intactRecord(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof value === 'object' && value !== null
  } catch { return false }
}

function reusableIn(dir: string, attempt: number, row: CaptureIdentity, build: CaptureBuild, requireJobs: boolean): CaptureKept | undefined {
  try {
    const selection = JSON.parse(readFileSync(join(dir, 'selection.json'), 'utf8')) as CaptureSelection<CaptureIdentity>
    const prior = selection.rows.find(item => item.id === row.id)
    if (selection.build.commit !== build.commit || !prior || !isDeepStrictEqual(identitySnapshot(prior), identitySnapshot(row))) return undefined
    if (statSync(join(dir, row.filename)).size === 0) return undefined
    if (requireJobs && !(intactRecord(join(dir, 'jobs', row.id, 'input.json')) && intactRecord(join(dir, 'jobs', row.id, 'result.json')))) return undefined
    return { id: row.id, filename: row.filename, attempt }
  } catch { return undefined }
}

/**
 * Reuse decision shared by every topic. `switchName` names the environment switch that disables reuse
 * when it equals '1'; `requireJobs` demands intact job records beside the image.
 */
export function keptRowsWith<R extends CaptureIdentity>(switchName: string, storeDir: string, rows: readonly R[], build: CaptureBuild, requireJobs: boolean): { kept: CaptureKept[]; render: R[] } {
  if (process.env[switchName] === '1') return { kept: [], render: [...rows] }
  const attempts = attemptNumbers(storeDir)
  const kept: CaptureKept[] = []
  const render: R[] = []
  for (const row of rows) {
    let found: CaptureKept | undefined
    for (const attempt of attempts) {
      found = reusableIn(join(storeDir, 'attempts', String(attempt)), attempt, row, build, requireJobs)
      if (found) break
    }
    if (found) kept.push(found)
    else render.push(row)
  }
  return { kept, render }
}

/**
 * Handoff: G7 capture extraction: share managed rendering and freshness takes the reuse decision
 * from keptRows here. Today a row is kept when an attempt under storeDir with the same build commit
 * holds an identical row snapshot, a nonempty image and intact job records; the originating attempt
 * number is returned and rows keep their input order.
 */
export function keptRows<A>(storeDir: string, rows: readonly CaptureRow<A>[], build: CaptureBuild): { kept: CaptureKept[]; render: CaptureRow<A>[] } {
  return keptRowsWith<CaptureRow<A>>('ENGINE_SHOW_RERENDER_ALL', storeDir, rows, build, true)
}

/** Width of every delivered capture (E8). */
export const CAPTURE_WIDTH = 1920
/** Height of every delivered capture (E8). */
export const CAPTURE_HEIGHT = 1080

/**
 * Result a managed operation returns for one row: the facts the requirements judge and the encoded
 * PNG the shared job validates, persists and delivers.
 */
export type CaptureResult = {
  facts: unknown
  capture: { name: string; width: number; height: number; mime: 'image/png'; base64: string }
}

/**
 * One inventory family wired to the shared lifecycle. `topic` names the store prefix (a trailing '/'
 * or '-' appends the stage directly, otherwise the stage is a child folder), `page` is the staged
 * page directory published once per render, `validateSelection` validates and may stage the rows,
 * and `run` performs only the scenario's managed operation.
 */
export type CaptureJobConfig<A> = {
  topic: string
  inventory: string
  page: string
  parseArgs: (value: unknown) => A
  validateSelection: (rows: readonly CaptureRow<A>[]) => Promise<void>
  run: (row: CaptureRow<A>, pageRef: string) => Promise<CaptureResult>
}

/** Shared CLI operation vector: one operation, then --stage/--page/--out and optional --budget-s. */
export type CaptureOptions = {
  operation: 'check' | 'clean' | 'render' | 'fresh' | 'judge'
  stage: string
  page: string
  out: string
  budget: number
}

const CAPTURE_USAGE = 'usage: <check|clean|render|fresh|judge> --stage <stage> --page <dir> --out <dir> [--budget-s <s>]'
const OPERATIONS = ['check', 'clean', 'render', 'fresh', 'judge']

/** Parses the shared capture CLI; the caller maps a thrown error to exit status 2. */
export function captureOptions(argv: readonly string[]): CaptureOptions {
  const [operation, ...rest] = argv
  if (operation === undefined || !OPERATIONS.includes(operation) || rest.length % 2 !== 0) throw new Error(CAPTURE_USAGE)
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    if (!['--stage', '--page', '--out', '--budget-s'].includes(flag) || values.has(flag)) throw new Error(CAPTURE_USAGE)
    values.set(flag, rest[i + 1])
  }
  const stage = values.get('--stage')
  const page = values.get('--page')
  const out = values.get('--out')
  const budget = values.get('--budget-s')
  if (!stage || !page || !out) throw new Error(CAPTURE_USAGE)
  if (budget !== undefined && (!Number.isFinite(Number(budget)) || Number(budget) < 0)) throw new Error(CAPTURE_USAGE)
  return { operation: operation as CaptureOptions['operation'], stage, page, out, budget: budget === undefined ? Infinity : Number(budget) }
}

/** Stage store: `<topic>/<stage>`, or `<topic><stage>` when the topic ends with '/' or '-' (engine-round-mN). */
export function captureStageStore(topic: string, stage: string, out: string): string {
  const namespace = /[/-]$/.test(topic) ? `${topic}${stage}` : `${topic}/${stage}`
  return captureStore(namespace, out)
}

/** Current publication/build identity used for retention and freshness. */
export function captureBuild(): CaptureBuild {
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(), encoding: 'utf8' }).trim() }
}

function topicName(topic: string): string {
  return topic.replace(/[/-]+$/, '') || 'ege-capture'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function storedRows<A>(config: CaptureJobConfig<A>, selection: CaptureSelection<CaptureRow<A>>, stage: string): CaptureRow<A>[] {
  const area = topicName(config.topic)
  if (!Array.isArray(selection.rows)) refuse(area, 'selection', 'rows must be a list')
  return selection.rows.map((item: unknown, index: number) => {
    const row = item as CaptureRow<A>
    const at = `selection/rows/${index}`
    if (!row || typeof row !== 'object') refuse(area, at, 'must be a capture row')
    if (typeof row.id !== 'string' || !row.id) refuse(area, `${at}/id`, 'must be a non-empty string')
    if (typeof row.stage !== 'string') refuse(area, `${at}/stage`, 'must be a string')
    if (row.stage !== stage) refuse(area, `${at}/stage`, `'${row.stage}' is not the selected stage '${stage}'`)
    if (typeof row.filename !== 'string' || !CAPTURE_FILENAME.test(row.filename)) refuse(area, `${at}/filename`, 'must match ^[a-z0-9-]+[.]png$')
    if (!Array.isArray(row.require) || row.require.some(rule => typeof rule !== 'string' || !validRequirement(rule))) refuse(area, `${at}/require`, 'contains a rule outside the E8 grammar')
    if (typeof row.description !== 'string') refuse(area, `${at}/description`, 'must be a string')
    if (!Array.isArray(row.held_constant) || row.held_constant.some(value => typeof value !== 'string')) refuse(area, `${at}/held_constant`, 'must be a string list')
    return { ...row, args: config.parseArgs(row.args) }
  })
}

function acceptedCapture(row: CaptureRow<unknown>, result: CaptureResult): { bytes: Buffer; metadata: { name: string; width: number; height: number; mime: 'image/png' } } {
  const capture = result?.capture
  if (!capture || typeof capture !== 'object') throw new Error('managed operation returned no capture')
  if (capture.name !== row.filename) throw new Error(`capture name ${JSON.stringify(capture.name)} is not '${row.filename}'`)
  if (capture.mime !== 'image/png') throw new Error(`capture mime ${JSON.stringify(capture.mime)} is not 'image/png'`)
  if (capture.width !== CAPTURE_WIDTH || capture.height !== CAPTURE_HEIGHT) throw new Error(`capture is ${capture.width}x${capture.height}, not ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}`)
  if (typeof capture.base64 !== 'string' || capture.base64.length === 0) throw new Error('capture base64 is empty')
  const bytes = Buffer.from(capture.base64, 'base64')
  if (bytes.length === 0) throw new Error('capture PNG bytes are empty')
  decodePng(bytes, CAPTURE_WIDTH, CAPTURE_HEIGHT, row.filename)
  return { bytes, metadata: { name: capture.name, width: capture.width, height: capture.height, mime: capture.mime } }
}

function attemptRun(dir: string): CaptureRun | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as CaptureRun
  } catch { return undefined }
}

function retainedOrigins(dir: string): Map<string, number> {
  return new Map((attemptRun(dir)?.kept ?? []).map(item => [item.id, item.attempt]))
}

/**
 * Handoff: G7-CAPTURE-JOB: finish the shared lifecycle and judgment calls renderEngineCapture and
 * freshEngineCapture for the shared selection, build, current-attempt and job registry. Rendering
 * attaches the reuse decision from keptRows (tools/engineCaptureJob.ts:265) with the stage store,
 * current build and validated rows today.
 *
 * Rendering resolves the current attempt, validates its stored rows, publishes the staged page once
 * for the selected job, then runs config.run per row; each successful image and job record is saved
 * immediately and run.json is rewritten after every row, including failures. Freshness re-checks the
 * current build, the copied selection, job records, required facts and each row's retained origin
 * without running an operation.
 */
export async function renderEngineCapture<A>(config: CaptureJobConfig<A>, argv: readonly string[], execution: CaptureExecution = defaultExecution): Promise<number> {
  let args: CaptureOptions
  try { args = captureOptions(argv) } catch { console.error(CAPTURE_USAGE); return 2 }
  if (args.operation !== 'render') { console.error(CAPTURE_USAGE); return 2 }
  const area = topicName(config.topic)
  try {
    const out = resolve(args.out)
    const store = captureStageStore(config.topic, args.stage, out)
    const { attempt, dir, selection } = currentAttempt<CaptureRow<A>>(store)
    const build = captureBuild()
    if (!selection.build || selection.build.commit !== build.commit) {
      refuse(area, join(store, 'current.json'), `selection was validated at ${String(selection.build?.commit ?? 'no build')} but HEAD is ${build.commit}; run check and clean again`)
    }
    const rows = storedRows(config, selection, args.stage)
    const reusable = keptRows(store, rows, build)
    const { failed, rendered } = priorOutcomes(store)
    const run: CaptureRun = { attempt, build, kept: reusable.kept, rendered: [], failed: [] }
    const saveRun = () => {
      writeJson(join(dir, 'run.json'), run)
      copyRecord(join(dir, 'run.json'), join(out, 'run.json'))
    }
    restoreRetained(store, dir, out, reusable.kept)
    copyRecord(join(dir, 'selection.json'), join(out, 'selection.json'))
    saveRun()
    const ordered = renderOrder(reusable.render, failed, rendered)
    console.log(`${area}: kept ${reusable.kept.length}, rendering ${ordered.length}`)
    if (ordered.length === 0) return 0
    await config.validateSelection(rows)
    await execution.waitForGpu()
    const pageRef = await execution.publish(config.page)
    for (const row of ordered) {
      const job = join(dir, 'jobs', row.id)
      try {
        rmSync(join(dir, row.filename), { force: true })
        rmSync(join(out, row.filename), { force: true })
        rmSync(job, { recursive: true, force: true })
        const output = await config.run(row, pageRef)
        const capture = acceptedCapture(row, output)
        const problems = requirementProblems(output.facts, row.require)
        if (problems.length) throw new Error(problems.join('; '))
        writeJson(join(job, 'input.json'), row.args)
        writeJson(join(job, 'result.json'), { facts: output.facts, capture: capture.metadata })
        writeFileSync(join(dir, row.filename), capture.bytes)
        copyRecord(job, join(out, 'jobs', row.id))
        copyRecord(join(dir, row.filename), join(out, row.filename))
        run.rendered.push(row.id)
      } catch (error) {
        rmSync(job, { recursive: true, force: true })
        run.failed.push({ id: row.id, message: messageOf(error) })
        console.error(`${area}: ${row.id}: ${run.failed.at(-1)!.message}`)
      }
      saveRun()
    }
    return run.failed.length ? 1 : 0
  } catch (error) {
    console.error(`${area}: ${messageOf(error)}`)
    return 1
  }
}

/** Host operations the lifecycle calls; tests inject fakes, the default runs the GPU client and python3 judge. */
export type CaptureExecution = {
  waitForGpu: () => Promise<void>
  publish: (page: string) => Promise<string>
  judge: JudgeRunner
  clock: () => number
}

/** Runner that scores one image with python3 and NMC_JUDGE_CLIENT, returning the judge's stdout. */
export type JudgeRunner = (image: string, description: string, heldConstant: string[]) => Promise<string>

/** Minimum judge score a capture must reach to pass. */
export const JUDGE_MIN_SCORE = 6

/** Verdict stored at <store>/verdicts/<filename>.json; written before any later failure. */
export type CaptureVerdict = {
  filename: string
  description: string
  heldConstant?: string[]
  attempt: number
  score: number | null
  pass: boolean
}

/** Judges with python3 and NMC_JUDGE_CLIENT; the arguments carry the description and every held constant. */
export function judgeWithClient(image: string, description: string, heldConstant: string[]): Promise<string> {
  return new Promise((done, reject) => {
    const client = process.env.NMC_JUDGE_CLIENT
    if (!client) {
      reject(new Error('NMC_JUDGE_CLIENT is unset'))
      return
    }
    const args = [client, image, '--description', description, '--min-score', String(JUDGE_MIN_SCORE), ...heldConstant.flatMap(item => ['--held-constant', item])]
    const child = spawn('python3', args)
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { process.stderr.write(chunk) })
    child.once('error', reject)
    child.once('close', () => done(stdout))
  })
}

/** Production host operations: wait for the GPU client, publish the staged page, judge with python3. */
export const defaultExecution: CaptureExecution = {
  waitForGpu: () => waitForGpuClient(gpuWaitSeconds(process.env.NMC_GPU_WAIT_S)),
  publish: page => publishDist(page),
  judge: judgeWithClient,
  clock: () => Date.now(),
}

/**
 * Judges every row's delivered image within `budget` seconds. A passing verdict is reused only when the
 * image bytes equal the attempt copy and description and held constants are identical; each new verdict
 * is saved before the next row, so a later failure or an exhausted budget keeps earlier results.
 */
export async function judgeCaptureRows(area: string, store: string, delivery: string, attempt: number, rows: readonly CaptureIdentity[], budget: number, run: JudgeRunner, clock: () => number): Promise<number> {
  const start = clock()
  let missing = 0
  for (const row of rows) {
    const image = join(delivery, row.filename)
    const verdictPath = join(store, 'verdicts', `${row.filename}.json`)
    try {
      const bytes = readFileSync(image)
      if (!bytes.length) throw new Error('image is empty')
      try {
        const verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as CaptureVerdict
        const sameFacts = verdict.pass && verdict.description === row.description && JSON.stringify(verdict.heldConstant ?? []) === JSON.stringify(row.held_constant)
        if (sameFacts && bytes.equals(readFileSync(join(store, 'attempts', String(verdict.attempt), row.filename)))) continue
      } catch { /* No reusable verdict. */ }
      if (clock() - start >= budget * 1000) {
        missing++
        console.error(`${area}: ${row.id}: judge budget ${budget} s spent before this image`)
        continue
      }
      const answer = await run(image, row.description, [...row.held_constant])
      const score = parseScore(answer)
      const verdict: CaptureVerdict = { filename: row.filename, description: row.description, heldConstant: [...row.held_constant], attempt, score, pass: score !== null && score >= JUDGE_MIN_SCORE }
      writeJson(verdictPath, verdict)
      console.log(`${area}: ${row.id}: judge score ${score ?? 'none'} (min ${JUDGE_MIN_SCORE}) ${verdict.pass ? 'PASS' : 'FAIL'}`)
      if (!verdict.pass) {
        missing++
        console.error(`${area}: ${row.id}: JUDGE FAIL ${row.filename}\n${answer.trim()}`)
      }
    } catch (error) {
      missing++
      console.error(`${area}: ${row.id}: ${messageOf(error)}`)
    }
  }
  return missing ? 1 : 0
}

/** Loads the inventory at config.inventory; its stage key is `milestone` for legacy inventories, else `stage`. */
function inventoryRows<A>(config: CaptureJobConfig<A>): CaptureRow<A>[] {
  const area = topicName(config.topic)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(config.inventory, 'utf8')) } catch (error) {
    refuse(area, config.inventory, `cannot read inventory: ${messageOf(error)}`)
  }
  const first = Array.isArray(raw) ? raw[0] : undefined
  const legacy = first !== null && typeof first === 'object' && Object.hasOwn(first, 'milestone') && !Object.hasOwn(first, 'stage')
  return loadCaptureRows(config.inventory, {
    area,
    stageField: legacy ? 'milestone' : 'stage',
    checkStage: (value, pointer) => {
      if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(value)) refuse(area, pointer, 'must be a lowercase stage name')
      return value
    },
    parseArgs: value => config.parseArgs(value),
  })
}

async function checkCapture<A>(config: CaptureJobConfig<A>, args: CaptureOptions): Promise<void> {
  const area = topicName(config.topic)
  const rows = inventoryRows(config).filter(row => row.stage === args.stage)
  if (!rows.length) refuse(area, config.inventory, `no rows for ${args.stage}`)
  await config.validateSelection(rows)
  const out = resolve(args.out)
  writeJson(join(out, 'selection.json'), { stage: args.stage, build: captureBuild(), rows })
  console.log(`${area}: check ${rows.length} rows`)
}

function cleanCapture<A>(config: CaptureJobConfig<A>, args: CaptureOptions): void {
  const out = resolve(args.out)
  const selectionPath = join(out, 'selection.json')
  if (!existsSync(selectionPath)) refuse(topicName(config.topic), selectionPath, 'run check first')
  allocateAttempt(captureStageStore(config.topic, args.stage, out), selectionPath)
}

async function judgeCapture<A>(config: CaptureJobConfig<A>, args: CaptureOptions, execution: CaptureExecution): Promise<number> {
  const out = resolve(args.out)
  const store = captureStageStore(config.topic, args.stage, out)
  const { attempt, selection } = currentAttempt<CaptureRow<A>>(store)
  if (selection.stage !== args.stage) refuse(topicName(config.topic), join(store, 'current.json'), 'selection stage does not match; run check and clean')
  const rows = storedRows(config, selection, args.stage)
  return judgeCaptureRows(topicName(config.topic), store, out, attempt, rows, args.budget, execution.judge, execution.clock)
}

/**
 * Runs one shared capture operation (check, clean, render, fresh or judge) for an inventory family.
 * Invalid CLI usage returns 2; a functional failure returns 1; success returns 0.
 */
export async function runEngineCaptureJob<A>(config: CaptureJobConfig<A>, argv: readonly string[], execution: CaptureExecution = defaultExecution): Promise<number> {
  let args: CaptureOptions
  try { args = captureOptions(argv) } catch { console.error(CAPTURE_USAGE); return 2 }
  if (args.operation === 'render') return renderEngineCapture(config, argv, execution)
  if (args.operation === 'fresh') return freshEngineCapture(config, argv)
  const area = topicName(config.topic)
  try {
    if (args.operation === 'check') await checkCapture(config, args)
    else if (args.operation === 'clean') cleanCapture(config, args)
    else return await judgeCapture(config, args, execution)
    return 0
  } catch (error) {
    console.error(`${area}: ${messageOf(error)}`)
    return 1
  }
}

/** Re-checks the current attempt's copied and retained records; see renderEngineCapture for the shared registry. */
export function freshEngineCapture<A>(config: CaptureJobConfig<A>, argv: readonly string[]): number {
  let args: CaptureOptions
  try { args = captureOptions(argv) } catch { console.error(CAPTURE_USAGE); return 2 }
  if (args.operation !== 'fresh') { console.error(CAPTURE_USAGE); return 2 }
  const area = topicName(config.topic)
  try {
    const out = resolve(args.out)
    const store = captureStageStore(config.topic, args.stage, out)
    const { attempt, dir, selection } = currentAttempt<CaptureRow<A>>(store)
    const build = captureBuild()
    if (!selection.build || selection.build.commit !== build.commit) {
      refuse(area, join(store, 'current.json'), `selection was validated at ${String(selection.build?.commit ?? 'no build')} but HEAD is ${build.commit}; run check and clean again`)
    }
    const rows = storedRows(config, selection, args.stage)
    const run = attemptRun(dir)
    if (run && (!run.build || run.build.commit !== build.commit)) refuse(area, join(dir, 'run.json'), `run record was written for another build; rerun render`)
    const deliverySelection = join(out, 'selection.json')
    if (!existsSync(deliverySelection) || !readFileSync(deliverySelection).equals(readFileSync(join(dir, 'selection.json')))) {
      throw new Error('delivery selection differs from the current attempt; rerun render')
    }
    const origins = retainedOrigins(dir)
    let failures = 0
    for (const row of rows) {
      try {
        const retained = origins.get(row.id)
        const origin = retained === undefined ? dir : join(store, 'attempts', String(retained))
        const image = join(out, row.filename)
        const bytes = readFileSync(image)
        if (bytes.length === 0) throw new Error('image is empty')
        decodePng(bytes, CAPTURE_WIDTH, CAPTURE_HEIGHT, image)
        if (!bytes.equals(readFileSync(join(origin, row.filename)))) throw new Error(`image differs from attempt ${retained ?? attempt}`)
        const job = join(out, 'jobs', row.id)
        const source = join(origin, 'jobs', row.id)
        for (const file of ['input.json', 'result.json']) {
          if (!readFileSync(join(job, file)).equals(readFileSync(join(source, file)))) throw new Error(`${file} differs from attempt ${retained ?? attempt}`)
        }
        const result = JSON.parse(readFileSync(join(job, 'result.json'), 'utf8')) as { facts?: unknown; capture?: { name?: unknown; width?: unknown; height?: unknown; mime?: unknown } }
        const capture = result.capture
        if (!capture || capture.name !== row.filename || capture.mime !== 'image/png' || capture.width !== CAPTURE_WIDTH || capture.height !== CAPTURE_HEIGHT) {
          throw new Error('job capture metadata does not match the row')
        }
        const problems = requirementProblems(result.facts, row.require)
        for (const problem of problems) {
          failures++
          console.error(`${area}: ${row.id}: ${problem}`)
        }
      } catch (error) {
        failures++
        console.error(`${area}: ${row.id}: ${messageOf(error)}`)
      }
    }
    return failures ? 1 : 0
  } catch (error) {
    console.error(`${area}: ${messageOf(error)}`)
    return 1
  }
}
