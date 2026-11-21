import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { refuse } from '../packages/sim/src/refusal.ts'

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
