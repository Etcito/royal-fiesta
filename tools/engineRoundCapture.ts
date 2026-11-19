import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { refuse, isRefusal } from '../packages/sim/src/refusal.ts'
import { parseRunArgs } from '../apps/web/src/engineRound/run.ts'
import type { RoundRunArgs } from '../apps/web/src/engineRound/run.ts'
import { buildContentIndex } from './content.ts'
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

function options(argv: string[]): { op: string; milestone: string; page: string; out: string } {
  const [op, ...rest] = argv
  if (!['check', 'clean', 'render', 'fresh', 'judge'].includes(op ?? '') || rest.length % 2 !== 0) throw new Error(USAGE)
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--milestone', '--page', '--out', '--budget-s'].includes(rest[i]) || values.has(rest[i])) throw new Error(USAGE)
    values.set(rest[i], rest[i + 1])
  }
  if (!values.has('--milestone') || !values.has('--page') || !values.has('--out') || values.has('--budget-s') && !Number.isFinite(Number(values.get('--budget-s')))) throw new Error(USAGE)
  return { op: op!, milestone: values.get('--milestone')!, page: values.get('--page')!, out: values.get('--out')! }
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

/** Run the E8 command line. */
export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof options>
  try { args = options(argv) } catch { console.error(USAGE); return 2 }
  try {
    if (args.op === 'check') await check(args)
    else if (args.op === 'clean') clean(args)
    else { console.error('not implemented in this build'); return 2 }
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
