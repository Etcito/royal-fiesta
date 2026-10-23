// The m15 GPU run (QB10): publish apps/web/dist, run controlsProbe on game.html with
// proofs/m15/controls.input.json and write proofs/m15/controls.json (S17). PNGs stay in out/m15/.
// Every field comes from the op output; a leaking or incomplete record is refused, never written.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { repoRoot } from '../../../tools/bricks.ts'
import { leakScan, redact } from '../../../tools/guard.ts'
import { publishDist, renderOp } from './gpuClient.ts'
import type { OpResult } from './gpuClient.ts'

const AREA = 'controls-gpu'
export const INPUT_FILE = 'proofs/m15/controls.input.json'
export const RECORD_FILE = 'proofs/m15/controls.json'
export const DIST_DIR = 'apps/web/dist'
export const PNG_DIR = 'out/m15'
const OP = 'controlsProbe'
const INPUTS = ['KeyD', 'ArrowRight', 'stickRight', 'KeyA', 'ArrowLeft', 'stickLeft', 'mouseRight', 'rightStickRight'] as const
const VIEW_INPUTS: readonly string[] = ['mouseRight', 'rightStickRight']
const DEVICES = ['keyboard', 'synthetic-pad', 'pointer-lock-events'] as const

export type ControlInput = typeof INPUTS[number]
export interface ControlCase { name: string; input: ControlInput; holdMs: number }
export interface ControlsInput { width: 1280; height: 720; content: string; course: string; cases: ControlCase[] }
export interface CaseCapture { name: string; sha256: string; bytes: number; nonEmpty: boolean }
export interface ControlsCase {
  name: string; input: ControlInput; subject: 'character' | 'view'; device: typeof DEVICES[number]
  beforeX: number; afterX: number; centreX: number; captures: CaseCapture[]
}
export interface ControlsRecord {
  renderer: 'raa'; adapter: string; software: boolean; pageRef: string; content: string; course: string; cases: ControlsCase[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function need<T>(ok: (v: unknown) => v is T, o: Obj, k: string, where: string, expect: string): T {
  const v = o[k]
  if (!ok(v)) refuse(AREA, `${where}/${k}`, `${JSON.stringify(v)} is not ${expect}; pass the unmodified ${OP} output`)
  return v as T
}
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isName = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v)

// proofs/m15/controls.input.json: the declared controlsProbe example (docs/gpu-ops.md).
export function parseControlsInput(text: string, where: string = INPUT_FILE): ControlsInput {
  let raw: unknown
  try { raw = JSON.parse(text) as unknown } catch (e) { return refuse(AREA, `${where}#`, `invalid JSON (${(e as Error).message}); fix the file syntax`) }
  if (!isObj(raw)) return refuse(AREA, `${where}#`, 'is not an object; use the controlsProbe input of docs/gpu-ops.md')
  for (const k of Object.keys(raw)) {
    if (!['width', 'height', 'content', 'course', 'cases'].includes(k)) refuse(AREA, `${where}#/${k}`, 'unknown key; remove it')
  }
  if (raw.width !== 1280 || raw.height !== 720) refuse(AREA, `${where}#/width`, `is ${JSON.stringify(raw.width)}x${JSON.stringify(raw.height)}; controls-probe captures are 1280x720`)
  const content = need((v): v is string => v === 'v0' || v === 'v1' || v === 'sdf', raw, 'content', `${where}#`, "'v0', 'v1' or 'sdf'")
  const course = need(isName, raw, 'course', `${where}#`, 'a course id')
  const list = need((v): v is unknown[] => Array.isArray(v) && v.length > 0 && v.length <= 16, raw, 'cases', `${where}#`, 'an array of 1..16 cases')
  const cases = list.map((c, i): ControlCase => {
    const cw = `${where}#/cases/${i}`
    if (!isObj(c)) return refuse(AREA, cw, 'is not an object; give {name, input, holdMs}')
    const name = need(isName, c, 'name', cw, 'a case name')
    const input = need((v): v is ControlInput => INPUTS.includes(v as ControlInput), c, 'input', cw, `one of ${INPUTS.join(', ')}`)
    const holdMs = need((v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5000, c, 'holdMs', cw, 'an integer 1..5000')
    return { name, input, holdMs }
  })
  return { width: 1280, height: 720, content, course, cases }
}

// The op output is the result itself, or the single object within 3 levels holding `cases` ({json, files}).
function unwrap(res: OpResult): { out: Obj; where: string } {
  if (isObj(res.json) && 'cases' in res.json) return { out: res.json, where: `${res.file}#` }
  const found: { out: Obj; where: string }[] = []
  const walk = (v: unknown, path: string, depth: number): void => {
    if (typeof v !== 'object' || v === null || depth > 3) return
    if (depth > 0 && isObj(v) && 'cases' in v) found.push({ out: v, where: path })
    for (const k of Object.keys(v)) walk((v as Obj)[k], `${path}/${k}`, depth + 1)
  }
  walk(res.json, `${res.file}#`, 0)
  if (found.length !== 1) refuse(AREA, `${res.file}#`, `${found.length} objects with "cases" within 3 levels; pass the result of exactly one ${OP} run`)
  return found[0]
}

function adapterLabel(out: Obj, where: string): { label: string; software: boolean } {
  const a = need(isObj, out, 'adapter', where, 'an adapter object')
  const p = `${where}/adapter`
  const parts = ['vendor', 'architecture', 'description'].map(k => need(isStr, a, k, p, 'a string').trim())
  if (parts.every(s => s.length === 0)) refuse(AREA, p, 'vendor, architecture and description are all empty; the adapter must be labelled')
  return { label: parts.join(' | '), software: need(isBool, a, 'software', p, 'a boolean') }
}

function captureOf(c: unknown, where: string): CaseCapture {
  if (!isObj(c)) return refuse(AREA, where, `is not an object; pass the unmodified ${OP} output`)
  return {
    name: need((v): v is string => isStr(v) && /^[A-Za-z0-9._-]{1,80}$/.test(v), c, 'name', where, 'a file-safe name'),
    sha256: need((v): v is string => isStr(v) && /^[0-9a-f]{64}$/.test(v), c, 'sha256', where, 'a sha256 hex string'),
    bytes: need((v): v is number => Number.isInteger(v) && (v as number) > 0, c, 'bytes', where, 'a positive integer'),
    nonEmpty: need(isBool, c, 'nonEmpty', where, 'a boolean'),
  }
}

// S17 record from one controlsProbe result: one case per input case, in input order.
export function buildControlsRecord(res: OpResult, input: ControlsInput, pageRef: string): ControlsRecord {
  const { out, where } = unwrap(res)
  if (out.renderer !== 'raa') refuse(AREA, `${where}/renderer`, `${JSON.stringify(out.renderer)} is not 'raa'; record only RAA renders`)
  const adapter = adapterLabel(out, where)
  if ('software' in out && out.software !== adapter.software) refuse(AREA, `${where}/software`, 'differs from adapter.software; pass the unmodified op output')
  if (out.content !== input.content) refuse(AREA, `${where}/content`, `${JSON.stringify(out.content)} is not the input content '${input.content}'; rerun with ${INPUT_FILE}`)
  if (out.course !== input.course) refuse(AREA, `${where}/course`, `${JSON.stringify(out.course)} is not the input course '${input.course}'; rerun with ${INPUT_FILE}`)
  const list = need((v): v is unknown[] => Array.isArray(v), out, 'cases', where, 'an array')
  if (list.length !== input.cases.length) refuse(AREA, `${where}/cases`, `has ${list.length} cases for ${input.cases.length} inputs; rerun the op with ${INPUT_FILE}`)
  const cases = list.map((c, i): ControlsCase => {
    const cw = `${where}/cases/${i}`
    const want = input.cases[i]
    if (!isObj(c)) return refuse(AREA, cw, `is not an object; pass the unmodified ${OP} output`)
    if (c.name !== want.name || c.input !== want.input) {
      refuse(AREA, cw, `is ${JSON.stringify(c.name)}/${JSON.stringify(c.input)}, expected ${want.name}/${want.input}; rerun the op with ${INPUT_FILE}`)
    }
    const subject = VIEW_INPUTS.includes(want.input) ? 'view' : 'character'
    need((v): v is string => v === subject, c, 'subject', cw, `'${subject}'`)
    const captures = need((v): v is unknown[] => Array.isArray(v) && v.length > 0, c, 'captures', cw, 'a non-empty array')
    return {
      name: want.name, input: want.input, subject,
      device: need((v): v is ControlsCase['device'] => DEVICES.includes(v as ControlsCase['device']), c, 'device', cw, `one of ${DEVICES.join(', ')}`),
      beforeX: need(isNum, c, 'beforeX', cw, 'a finite number'),
      afterX: need(isNum, c, 'afterX', cw, 'a finite number'),
      centreX: need(isNum, c, 'centreX', cw, 'a finite number'),
      captures: captures.map((k, j) => captureOf(k, `${cw}/captures/${j}`)),
    }
  })
  return { renderer: 'raa', adapter: adapter.label, software: adapter.software, pageRef, content: input.content, course: input.course, cases }
}

// The GPU client writes the op's files into the output directory; each capture must be there, byte for byte.
export function checkPngs(record: ControlsRecord, dir: string): void {
  const found = new Map<string, string>()
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name.endsWith('.png') && !found.has(e.name)) found.set(e.name, join(d, e.name))
    }
  }
  if (existsSync(dir)) walk(dir)
  for (const c of record.cases) {
    for (const k of c.captures) {
      const file = found.get(`${k.name}.png`)
      if (file === undefined) refuse(AREA, `${dir}/${k.name}.png`, `is missing; the ${OP} result must come with its PNG files`)
      const bytes = readFileSync(file)
      const sha = createHash('sha256').update(bytes).digest('hex')
      if (sha !== k.sha256 || bytes.length !== k.bytes) refuse(AREA, file, `is ${bytes.length} bytes sha256 ${sha}, the op reported ${k.bytes} bytes sha256 ${k.sha256}; rerun the op`)
    }
  }
}

// Values that must never reach a record: GPU client and git tokens, the GPU URL.
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['NMC_GPU_TOKEN', 'NMC_GPU_URL', 'MAMA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']
    .map(k => env[k] ?? '').filter(v => v.length >= 4)
}

// Record text through redact, then leakScan (plus RF_GUARD_DENY); refuses instead of returning a leak.
export function recordText(record: ControlsRecord, secrets: readonly string[], deny: readonly string[] = []): string {
  const text = redact(`${JSON.stringify(record, null, 2)}\n`, secrets)
  const hits = leakScan(text, [...secrets, ...deny])
  if (hits.length > 0) {
    refuse(AREA, RECORD_FILE, `leakScan found ${hits.map(h => `${h.pattern} (${h.excerpt})`).join(', ')}; the record is not written, find where the op output picks it up`)
  }
  return text
}

// Everything the run needs before the first GPU call; each missing piece names its fix.
export function checkPrerequisites(env: NodeJS.ProcessEnv, abs: (rel: string) => string): void {
  const client = env.NMC_GPU_CLIENT
  if (!client) refuse(AREA, 'NMC_GPU_CLIENT', 'is unset; this command runs on a card or machine with the GPU client (a model card cannot run GPU jobs)')
  if (!existsSync(client) || !statSync(client).isFile()) refuse(AREA, 'NMC_GPU_CLIENT', 'does not name a file; set it to the GPU client script')
  const page = abs(`${DIST_DIR}/game.html`)
  const decl = abs(`${DIST_DIR}/nmc.gpu.json`)
  if (!existsSync(page) || !existsSync(decl)) refuse(AREA, DIST_DIR, 'has no game.html or nmc.gpu.json; run npm run build')
  let ops: unknown
  try { ops = (JSON.parse(readFileSync(decl, 'utf8')) as Obj).ops } catch (e) { refuse(AREA, `${DIST_DIR}/nmc.gpu.json`, `invalid JSON (${(e as Error).message}); run npm run build`) }
  if (!Array.isArray(ops) || !ops.includes(OP)) refuse(AREA, `${DIST_DIR}/nmc.gpu.json#/ops`, `does not list ${OP} as an op name; run npm run build on a revision that declares it`)
  if (!existsSync(abs(INPUT_FILE))) refuse(AREA, INPUT_FILE, 'is missing; commit the controlsProbe input (docs/gpu-ops.md example)')
}

// Paths are repo-relative (main runs from the repository root), so no message shows an absolute path.
export async function runControlsGpu(env: NodeJS.ProcessEnv = process.env): Promise<ControlsRecord> {
  checkPrerequisites(env, rel => rel)
  const input = parseControlsInput(readFileSync(INPUT_FILE, 'utf8'))
  const pageRef = await publishDist(DIST_DIR)
  console.log(`[controls-gpu] published ${DIST_DIR}; running ${OP} on ${input.content}/${input.course} (${input.cases.length} cases)`)
  const res = await renderOp(OP, input, PNG_DIR, 'controls', pageRef)
  const record = buildControlsRecord(res, input, pageRef)
  checkPngs(record, PNG_DIR)
  const deny = (env.RF_GUARD_DENY ?? '').split(',').map(s => s.trim()).filter(Boolean)
  writeFileSync(RECORD_FILE, recordText(record, secretsFromEnv(env), deny))
  return record
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length > 0) refuse(AREA, 'argv', `takes no arguments (reads ${INPUT_FILE}, writes ${RECORD_FILE} and ${PNG_DIR}/)`)
    process.chdir(repoRoot())
    const record = await runControlsGpu()
    const captures = record.cases.reduce((n, c) => n + c.captures.length, 0)
    console.log(`[report:controls-gpu] cases=${record.cases.length} captures=${captures} software=${record.software} out=${RECORD_FILE}`)
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
