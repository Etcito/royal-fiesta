// Content-capture inputs and source hashes (S22), shared by the content in-game proofs.
// runCaptureInputs lands in this module with the C5 proof card.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nodeGameAssets } from '../apps/headless/src/contentFiles.ts'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { repoRoot } from './bricks.ts'
import { loadAuthoredCourse } from './courseProbe.ts'
import { leakScan } from './guard.ts'

const AREA = 'content-capture'
const WIDTH = 1920
const HEIGHT = 1080
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
interface CaptureInput {
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

function sha256File(rel: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(repoRoot(), rel))
  } catch {
    return refuse(AREA, rel, 'cannot read the file; restore it or fix the course asset')
  }
  return createHash('sha256').update(bytes).digest('hex')
}

// Inputs are read under `root`; the source files are always the repository's committed ones.
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
