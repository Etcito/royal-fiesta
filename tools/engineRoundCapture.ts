import { readFileSync } from 'node:fs'
import { refuse } from '../packages/sim/src/refusal.ts'
import { parseRunArgs } from '../apps/web/src/engineRound/run.ts'
import type { RoundRunArgs } from '../apps/web/src/engineRound/run.ts'

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
