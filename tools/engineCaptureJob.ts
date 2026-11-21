import { readFileSync } from 'node:fs'
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
