// Content-capture inputs, source hashes and the in-game capture run (S22), shared by the content proofs.
import { contentPath } from './content.ts'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { nodeGameAssets } from '../apps/headless/src/contentFiles.ts'
import { publishDist, renderOp } from '../apps/headless/src/gpuClient.ts'
import type { OpResult } from '../apps/headless/src/gpuClient.ts'
import { unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { repoRoot } from './bricks.ts'
import { loadAuthoredCourse } from './courseProbe.ts'
import { leakScan } from './guard.ts'

const AREA = 'content-capture'
const WIDTH = 1920
const HEIGHT = 1080
const OP = 'gameCapture'
const DIST_DIR = 'apps/web/dist'
const INPUT_SUFFIX = '.input.json'
const MILESTONE_RE = /^[a-z0-9-]{1,40}$/
const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/
const FLOWS = ['match', 'hub', 'podium', 'tour'] as const
const COURSE_RE = /^[a-z0-9-]{1,40}$/
const MOMENT_RE = /^(?:hub|podium|back-in-hub|loading|match-[0-9]+(?:\.[0-9]+)?s)$/
const INPUT_KEYS = ['content', 'course', 'flow', 'clients', 'width', 'height', 'captureAt']
const REQUIRED_KEYS = ['content', 'flow', 'clients', 'width', 'height', 'captureAt']
const COMMON_ASSETS = [
  'assets/common/penguin.body.asset.json',
  'assets/common/costume.propeller-hat.asset.json',
  'assets/common/costume.fish-scarf.asset.json',
  'assets/common/costume.pineapple-suit.asset.json',
]
const STALE = 'stale record; re-render: '

type Flow = (typeof FLOWS)[number]
type Obj = Record<string, unknown>
export interface CaptureInput {
  content: 'sdf'
  course?: string
  flow: Flow
  clients: 1
  width: number
  height: number
  captureAt: string[]
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function escapePointer(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1')
}

function fail(file: string, pointer: string, reason: string): never {
  return refuse(AREA, `${file}#${pointer}`, reason)
}

function readJson(file: string, base: string): unknown {
  let text: string
  try {
    text = readFileSync(resolve(base, file), 'utf8')
  } catch {
    return refuse(AREA, file, 'cannot read the file; write it under proofs/<milestone>/ or fix the path')
  }
  try {
    return JSON.parse(text) as unknown
  } catch (e) {
    return refuse(AREA, file, `invalid JSON (${(e as Error).message}); fix the file syntax`)
  }
}

function parseCaptureInput(json: unknown, file: string): CaptureInput {
  if (!isObj(json)) refuse(AREA, file, 'is not a JSON object; pass a gameCapture input')
  for (const key of Object.keys(json)) {
    if (!INPUT_KEYS.includes(key)) fail(file, `/${escapePointer(key)}`, `unknown key '${key}'; keep only ${INPUT_KEYS.join(', ')}`)
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(json, key)) fail(file, `/${key}`, `missing key '${key}'; add it`)
  }
  if (json.content !== 'sdf') fail(file, '/content', `content is ${JSON.stringify(json.content)}, not 'sdf'; set "content": "sdf"`)
  if (json.course !== undefined && (typeof json.course !== 'string' || !COURSE_RE.test(json.course))) {
    fail(file, '/course', `course is ${JSON.stringify(json.course)}, not ${COURSE_RE.source}; use a course id or drop the key`)
  }
  if (typeof json.flow !== 'string' || !FLOWS.includes(json.flow as Flow)) {
    fail(file, '/flow', `flow is ${JSON.stringify(json.flow)}, not one of ${FLOWS.join('|')}; use one of them`)
  }
  if (json.clients !== 1) fail(file, '/clients', `clients is ${JSON.stringify(json.clients)}, not 1; gameCapture takes one client`)
  if (json.width !== WIDTH) fail(file, '/width', `width is ${JSON.stringify(json.width)}, not ${WIDTH}; capture at ${WIDTH}x${HEIGHT}`)
  if (json.height !== HEIGHT) fail(file, '/height', `height is ${JSON.stringify(json.height)}, not ${HEIGHT}; capture at ${WIDTH}x${HEIGHT}`)
  if (!Array.isArray(json.captureAt) || json.captureAt.length === 0) {
    fail(file, '/captureAt', 'captureAt is not a non-empty array; list the moments to capture')
  }
  const captureAt = json.captureAt as unknown[]
  captureAt.forEach((m, i) => {
    if (typeof m !== 'string' || !MOMENT_RE.test(m)) {
      fail(file, `/captureAt/${i}`, `moment ${JSON.stringify(m)} is not hub, podium, back-in-hub, loading or match-<s>s; use a moment name`)
    }
    if (captureAt.indexOf(m) !== i) fail(file, `/captureAt/${i}`, `moment '${m}' repeats; list each moment once`)
  })
  return {
    content: 'sdf',
    course: json.course as string | undefined,
    flow: json.flow as Flow,
    clients: 1,
    width: WIDTH,
    height: HEIGHT,
    captureAt: captureAt as string[],
  }
}

// ---- capture run (S22: publish once, gameCapture per input, record from the op output) -----------------

export interface RecordCapture { name: string; width: number; height: number; sha256: string; bytes: number; nonEmpty: boolean }
export interface CaptureEvent { t: number; what: string }
interface AdapterInfo { vendor: string; architecture: string; description: string; software: boolean }
export interface CaptureRecord {
  renderer: 'raa'
  adapter: AdapterInfo
  software: boolean
  pageRef: string
  captures: RecordCapture[]
  frameTiming: null
  content: 'sdf'
  courses: Record<string, string[]>
  events: Record<string, CaptureEvent[]>
  inputs: string[]
  sources: Record<string, string>
}
export interface CaptureCaseResult { name: string; input: CaptureInput; result: OpResult }

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

function need<T>(ok: (v: unknown) => v is T, o: Obj, k: string, where: string, expect: string): T {
  const v = o[k]
  if (!ok(v)) refuse(AREA, `${where}/${k}`, `${JSON.stringify(v)} is not ${expect}; pass the unmodified ${OP} output`)
  return v
}

// One gameCapture result: validate it and translate its <moment> captures into their case names.
function readCase(c: CaptureCaseResult): { adapter: AdapterInfo; captures: RecordCapture[]; courses: string[]; events: CaptureEvent[] } {
  const { out, path } = unwrapOp(c.result, 'captures')
  const where = `${c.result.file}${path}`
  if (out.renderer !== 'raa') refuse(AREA, `${where}/renderer`, `${JSON.stringify(out.renderer)} is not 'raa'; record only RAA renders`)
  if (out.content !== c.input.content) {
    refuse(AREA, `${where}/content`, `${JSON.stringify(out.content)} is not the input content '${c.input.content}'; rerun the op with the input unchanged`)
  }
  if (out.frameTiming !== null) refuse(AREA, `${where}/frameTiming`, `${JSON.stringify(out.frameTiming)} is not null; gameCapture records no frame timing`)
  const a = need(isObj, out, 'adapter', where, 'an adapter object')
  const aw = `${where}/adapter`
  const adapter: AdapterInfo = {
    vendor: need(isStr, a, 'vendor', aw, 'a string'),
    architecture: need(isStr, a, 'architecture', aw, 'a string'),
    description: need(isStr, a, 'description', aw, 'a string'),
    software: need(isBool, a, 'software', aw, 'a boolean'),
  }
  if (out.software !== adapter.software) refuse(AREA, `${where}/software`, `${JSON.stringify(out.software)} differs from adapter.software; pass the unmodified ${OP} output`)
  const raw = need((v): v is unknown[] => Array.isArray(v) && v.length > 0, out, 'captures', where, 'a non-empty array')
  const captures = raw.map((v, i): RecordCapture => {
    const cw = `${where}/captures/${i}`
    if (!isObj(v)) return refuse(AREA, cw, `is not an object; pass the unmodified ${OP} output`)
    return {
      name: need((x): x is string => isStr(x) && NAME_RE.test(x), v, 'name', cw, 'a file-safe name'),
      width: need(isPosInt, v, 'width', cw, 'a positive integer'),
      height: need(isPosInt, v, 'height', cw, 'a positive integer'),
      sha256: need((x): x is string => isStr(x) && /^[0-9a-f]{64}$/.test(x), v, 'sha256', cw, 'a sha256 hex string'),
      bytes: need((x): x is number => Number.isInteger(x) && (x as number) > 0, v, 'bytes', cw, 'a positive byte count'),
      nonEmpty: need(isBool, v, 'nonEmpty', cw, 'a boolean'),
    }
  })
  const seen = new Set<string>()
  for (const cap of captures) {
    if (seen.has(cap.name)) refuse(AREA, `${where}/captures`, `capture '${cap.name}' repeats; the op must return each moment once`)
    seen.add(cap.name)
    if (!c.input.captureAt.includes(cap.name)) {
      refuse(AREA, `${where}/captures`, `capture '${cap.name}' is not an input captureAt moment (${c.input.captureAt.join(', ')}); rerun the op`)
    }
  }
  for (const moment of c.input.captureAt) {
    if (!seen.has(moment)) refuse(AREA, `${where}/captures`, `has no capture for the input moment '${moment}'; rerun the op`)
  }
  const courses = need((v): v is string[] => Array.isArray(v) && v.every(isStr), out, 'courses', where, 'an array of course ids')
  const events = need((v): v is unknown[] => Array.isArray(v), out, 'events', where, 'an array').map((e, i): CaptureEvent => {
    const ew = `${where}/events/${i}`
    if (!isObj(e)) return refuse(AREA, ew, `is not an object; pass the unmodified ${OP} output`)
    return { t: need(isNum, e, 't', ew, 'a finite number'), what: need(isStr, e, 'what', ew, 'a string') }
  })
  return { adapter, captures, courses, events }
}

// Pure: the S22 record from already-fetched op results. Every capture field comes from the op output.
export function buildCaptureRecord(
  cases: readonly CaptureCaseResult[],
  inputs: readonly string[],
  pageRef: string,
  sources: Record<string, string>,
): CaptureRecord {
  if (cases.length === 0) refuse(AREA, 'inputs', 'has no capture inputs; pass at least one proofs/<milestone>/<case>.input.json')
  const captures: RecordCapture[] = []
  const courses: Record<string, string[]> = {}
  const events: Record<string, CaptureEvent[]> = {}
  let adapter: AdapterInfo | null = null
  for (const c of cases) {
    if (Object.hasOwn(courses, c.name)) refuse(AREA, `${c.result.file}`, `case '${c.name}' repeats; each input needs its own <case> file stem`)
    const parsed = readCase(c)
    if (adapter === null) adapter = parsed.adapter
    else if (JSON.stringify(adapter) !== JSON.stringify(parsed.adapter)) {
      refuse(AREA, `${c.result.file}#/adapter`, 'differs from the first op result adapter; rerun every case on the published page')
    }
    const byName = new Map(parsed.captures.map(cap => [cap.name, cap]))
    for (const moment of c.input.captureAt) {
      const cap = byName.get(moment)
      if (cap === undefined) refuse(AREA, `${c.result.file}`, `has no capture '${moment}'; rerun the op`)
      captures.push({ ...cap, name: `${c.name}-${moment}` })
    }
    courses[c.name] = parsed.courses
    events[c.name] = parsed.events
  }
  if (adapter === null) refuse(AREA, 'inputs', 'has no capture inputs; pass at least one input')
  return { renderer: 'raa', adapter, software: adapter.software, pageRef, captures, frameTiming: null, content: 'sdf', courses, events, inputs: [...inputs], sources }
}

// The op's PNG must match its reported sha256 and byte count before the record can name it.
function copyCapturePng(source: string, destination: string, cap: RecordCapture): void {
  if (!existsSync(source)) refuse(AREA, source, `is missing; the ${OP} result must come with its PNG files`)
  const bytes = readFileSync(source)
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== cap.sha256 || bytes.length !== cap.bytes) {
    refuse(AREA, source, `is ${bytes.length} bytes sha256 ${sha}, the op reported ${cap.bytes} bytes sha256 ${cap.sha256}; rerun the op`)
  }
  copyFileSync(source, destination)
}

export async function runCaptureInputs(milestone: string, inputs: readonly string[], root: string = repoRoot()): Promise<void> {
  if (!MILESTONE_RE.test(milestone)) refuse(AREA, `milestone ${JSON.stringify(milestone)}`, `is not ${MILESTONE_RE.source}; use a content milestone such as c5`)
  process.chdir(root)
  if (!existsSync(join(root, DIST_DIR, 'game.html')) || !existsSync(join(root, DIST_DIR, 'nmc.gpu.json'))) {
    refuse(AREA, DIST_DIR, 'has no game.html or nmc.gpu.json; run npm run build')
  }
  if (inputs.length === 0) refuse(AREA, 'inputs', 'is empty; pass at least one proofs/<milestone>/<case>.input.json')
  const wanted = inputs.map(file => {
    const base = basename(file)
    if (!base.endsWith(INPUT_SUFFIX)) fail(file, '', `is not a ${INPUT_SUFFIX} file; name it proofs/<milestone>/<case>${INPUT_SUFFIX}`)
    const name = base.slice(0, -INPUT_SUFFIX.length)
    if (!NAME_RE.test(name)) fail(file, '', `case '${name}' is not a file-safe name; rename the input`)
    return { file, name, input: parseCaptureInput(readJson(file, root), file) }
  })
  const names = new Set<string>()
  for (const w of wanted) {
    if (names.has(w.name)) refuse(AREA, w.file, `case '${w.name}' repeats; each input needs its own <case> file stem`)
    names.add(w.name)
  }
  const pageRef = await publishDist(DIST_DIR)
  const outRoot = `out/${milestone}`
  const results: CaptureCaseResult[] = []
  for (const w of wanted) {
    console.log(`[capture-run] ${OP} ${w.file} -> ${outRoot}/${w.name}`)
    results.push({ name: w.name, input: w.input, result: await renderOp(OP, w.input, `${outRoot}/${w.name}`, w.name, pageRef) })
  }
  const record = buildCaptureRecord(results, inputs, pageRef, await sourcesOf(inputs, root))
  for (const r of results) {
    for (const cap of readCase(r).captures) copyCapturePng(`${outRoot}/${r.name}/${cap.name}.png`, `${outRoot}/${r.name}-${cap.name}.png`, cap)
  }
  const rel = `proofs/${milestone}/captures.json`
  const text = `${JSON.stringify(record, null, 2)}\n`
  const hits = leakScan(text)
  if (hits.length > 0) {
    refuse(AREA, rel, `leakScan found ${[...new Set(hits.map(h => h.pattern))].join(', ')}; the record is not written`)
  }
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
  console.log(`[report:capture-run] captures=${record.captures.length} software=${String(record.software)} out=${rel}`)
}

function sha256File(rel: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(contentPath(rel))
  } catch {
    return refuse(AREA, rel, 'cannot read the file; restore it or fix the course asset')
  }
  return createHash('sha256').update(bytes).digest('hex')
}

// Inputs are read under `root`; the source files use the configured content directory.
export async function sourcesOf(inputs: readonly string[], root: string = repoRoot()): Promise<Record<string, string>> {
  const courses = new Set<string>()
  for (const file of inputs) {
    const input = parseCaptureInput(readJson(file, root), file)
    if (input.course !== undefined) courses.add(input.course)
    if (input.captureAt.some(m => m === 'hub' || m === 'back-in-hub')) courses.add('hub-plaza')
    if (input.captureAt.includes('podium')) courses.add('podium')
  }
  const assets = new Set<string>(COMMON_ASSETS)
  for (const id of [...courses].sort()) {
    const course = await loadAuthoredCourse(id)
    for (const assetId of course.assetIds) {
      assets.add((await nodeGameAssets().resolve(assetId)).source.path)
    }
  }
  const rels = new Set<string>([...courses].map(id => `courses/${id}.course.json`))
  for (const rel of assets) rels.add(rel)
  const out: Record<string, string> = {}
  for (const rel of [...rels].sort()) out[rel] = sha256File(rel)
  return out
}

export async function capturesProblems(milestone: string, expected: readonly string[], root: string = repoRoot()): Promise<string[]> {
  const rel = `proofs/${milestone}/captures.json`
  const file = join(root, rel)
  if (!existsSync(file)) return [`${rel} is missing: run the --gpu-run producer`]
  let text: string
  let json: unknown
  try {
    text = readFileSync(file, 'utf8')
    json = JSON.parse(text) as unknown
  } catch (e) {
    return [`${rel} is not valid JSON (${(e as Error).message}): run the --gpu-run producer`]
  }
  if (!isObj(json)) return [`${rel} is not a JSON object: run the --gpu-run producer`]

  const problems: string[] = []
  if (json.renderer !== 'raa') problems.push(`${rel}#/renderer: ${JSON.stringify(json.renderer)}, not 'raa'; re-render with the RAA port`)
  if (json.content !== 'sdf') problems.push(`${rel}#/content: ${JSON.stringify(json.content)}, not 'sdf'; run the sdf content producer`)

  const rawInputs = json.inputs
  const inputs: string[] = []
  let inputsOk = Array.isArray(rawInputs) && rawInputs.length > 0
  if (!inputsOk) {
    problems.push(`${rel}#/inputs: not a non-empty array of input paths; re-run the --gpu-run producer`)
  } else {
    ;(rawInputs as unknown[]).forEach((p, i) => {
      if (typeof p !== 'string' || p.length === 0) {
        inputsOk = false
        problems.push(`${rel}#/inputs/${i}: ${JSON.stringify(p)}, not an input path; re-run the --gpu-run producer`)
        return
      }
      inputs.push(p)
      if (!existsSync(resolve(root, p))) {
        inputsOk = false
        problems.push(`${rel}#/inputs/${i}: ${p} does not exist; re-run the --gpu-run producer`)
      }
    })
  }

  const rawCaptures = json.captures
  const captures: Obj[] = []
  if (!Array.isArray(rawCaptures)) {
    problems.push(`${rel}#/captures: not an array; re-run the --gpu-run producer`)
  } else {
    ;(rawCaptures as unknown[]).forEach((c, i) => {
      if (!isObj(c)) {
        problems.push(`${rel}#/captures/${i}: not an object; re-run the --gpu-run producer`)
        return
      }
      captures.push(c)
      const name = typeof c.name === 'string' && c.name.length > 0 ? c.name : `captures/${i}`
      if (typeof c.name !== 'string' || c.name.length === 0) problems.push(`${rel}#/captures/${i}/name: not a capture name; re-run the --gpu-run producer`)
      if (c.width !== WIDTH || c.height !== HEIGHT) {
        problems.push(`${name}: ${String(c.width)}x${String(c.height)}, not ${WIDTH}x${HEIGHT}; capture at ${WIDTH}x${HEIGHT}`)
      }
      if (c.nonEmpty !== true) problems.push(`${name}: nonEmpty ${JSON.stringify(c.nonEmpty)}, not true; re-render the capture`)
      if (typeof c.bytes !== 'number' || !Number.isFinite(c.bytes) || c.bytes <= 0) {
        problems.push(`${name}: bytes ${JSON.stringify(c.bytes)}, not > 0; re-render the capture`)
      }
    })
  }

  const counts = new Map<string, number>()
  for (const c of captures) {
    if (typeof c.name === 'string' && c.name.length > 0) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
  }
  for (const name of expected) {
    if (!counts.has(name)) problems.push(`missing capture '${name}'; re-run the --gpu-run producer`)
  }
  for (const [name, count] of counts) {
    if (count > 1) problems.push(`duplicate capture '${name}' (${count}); keep one`)
    if (!expected.includes(name)) problems.push(`unexpected capture '${name}'; expected ${expected.join(', ') || '(none)'}`)
  }

  if (inputsOk) {
    const recorded = isObj(json.sources) ? json.sources : {}
    let computed: Record<string, string> | null = null
    try {
      computed = await sourcesOf(inputs, root)
    } catch (e) {
      if (!isRefusal(e)) throw e
      problems.push(`${STALE}cannot recompute the sources (${e.message})`)
    }
    if (computed !== null) {
      const keys = [...new Set([...Object.keys(recorded), ...Object.keys(computed)])].sort()
      for (const key of keys) {
        const was = recorded[key]
        const now = computed[key]
        if (was === now) continue
        if (now === undefined) problems.push(`${STALE}${key} is no longer a source`)
        else if (was === undefined) problems.push(`${STALE}${key} is missing`)
        else problems.push(`${STALE}${key} is ${String(was)}, now ${now}`)
      }
    }
  }

  for (const hit of leakScan(text)) problems.push(`${rel}: leakScan ${hit.pattern} at ${hit.index}: ${hit.excerpt}`)
  return problems
}
