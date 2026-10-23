import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { canonicalJson } from '@royal-fiesta/game/course'
import { loadCourseV1, migrateCourseV0 } from '@royal-fiesta/game/courseV1'
import { GAME_ASSET_CAPS, parseGameAsset } from '@royal-fiesta/game/gameAsset'
import { manifestCoverage, parseGameManifest } from '@royal-fiesta/game/gameManifest'
import { parseColliderJson, scaleColliders } from '@royal-fiesta/game/prims'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { runMatchOffline } from '@royal-fiesta/sim/match/offline'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { loadAllCoursesV1, nodeGameAssets, v1Playlist } from '@royal-fiesta/headless/contentFiles'
import { loadCourseFile, readRepoText, repoPath } from '@royal-fiesta/headless/files'
import { secretsFromEnv } from '@royal-fiesta/headless/controlsGpu'
import { publishDist, renderOp } from '@royal-fiesta/headless/gpuClient'
import type { OpResult } from '@royal-fiesta/headless/gpuClient'
import { cpuBudget, hex8, parseProofArgs, report, runProof, spawnCases } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { isAuthored, readAuthored } from '../../../tools/authored.ts'
import { repoRoot } from '../../../tools/bricks.ts'
import { leakScan, redact } from '../../../tools/guard.ts'

// M2 Course v1 on disk. QB1 here: v1 courses keep matches deterministic, and their sim colliders
// come only from asset.collision or the course override (rule 1.5).

const SEED = 16
const PLAYERS = 8
const MATCH_CASES = ['match-a', 'match-b'] as const
const CASE_FLAG = '--match-case'

let rapier: Promise<RapierModule> | null = null
function getRapier(): Promise<RapierModule> {
  if (rapier === null) rapier = initRapier()
  return rapier
}

async function sprintSetup(): Promise<MatchSetup> {
  const humans: boolean[] = []
  for (let p = 0; p < PLAYERS; p++) humans.push(false)
  return { seed: SEED, playerCount: PLAYERS, humans, profile: 'sprint', courses: await v1Playlist('sprint') }
}

// One independent match, in its own process (spawned by checkDeterminism).
async function runMatchCase(label: string): Promise<void> {
  const R = await getRapier()
  const result = runMatchOffline(R, await sprintSetup())
  console.log(`[${label}] finalHash=${hex8(result.finalHash)} ticks=${result.ticks}`)
}

// ---- manifest ------------------------------------------------------------------------------------------

const MANIFEST_FILE = 'sdfm.game.json'

async function checkManifest(): Promise<CheckResult> {
  const m = parseGameManifest(JSON.parse(await readRepoText(MANIFEST_FILE)) as unknown, MANIFEST_FILE)
  const cov = manifestCoverage(m)
  const notes: string[] = []
  for (const [list, entries] of Object.entries(cov)) {
    for (const e of entries) notes.push(`${list}: ${e}`)
  }
  report('manifest', { motions: Object.keys(m.motions).length, markers: Object.keys(m.markers).length })
  return { value: String(notes.length), threshold: '0 coverage entries', pass: notes.length === 0, notes }
}

// ---- migration -----------------------------------------------------------------------------------------

const V0_DIR = 'fixtures/courses'
const COURSE_SUFFIX = '.course.json'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Exit code and output tail of `node --experimental-strip-types <script> ...args` at the repository root.
function runNodeScript(script: string, args: string[]): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(process.execPath, ['--experimental-strip-types', script, ...args], { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { out += d })
    child.stderr.on('data', (d: string) => { out += d })
    child.on('error', (e) => resolve({ code: 1, tail: e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, tail: out.trim().split('\n').slice(-3).join(' | ') }))
  })
}

async function migrationProblem(rel: string, id: string): Promise<string | null> {
  const json = JSON.parse(await readRepoText(rel)) as unknown
  let migrated: Record<string, unknown>
  try {
    migrated = migrateCourseV0(json, rel)
  } catch (e) {
    return `migrateCourseV0 refused: ${messageOf(e)}`
  }
  try {
    await loadCourseV1(json, rel, nodeGameAssets())
  } catch (e) {
    return `loadCourseV1 refused the v0 file: ${messageOf(e)}`
  }
  const committed = `courses/${id}${COURSE_SUFFIX}`
  if (!existsSync(repoPath(committed))) return `${committed} is missing; run tools/placeholders.ts`
  if (canonicalJson(migrated) !== canonicalJson(JSON.parse(await readRepoText(committed)) as unknown)) {
    return `the migration differs from ${committed}; run tools/placeholders.ts`
  }
  try {
    await loadCourseFile(rel)
  } catch (e) {
    return `the v0 loader refused it: ${messageOf(e)}`
  }
  return null
}

async function checkMigration(): Promise<CheckResult> {
  const notes: string[] = []
  const names = (await readdir(repoPath(V0_DIR), { withFileTypes: true }))
    .filter(e => e.isFile() && e.name.endsWith(COURSE_SUFFIX))
    .map(e => e.name)
    .sort()
  // An authored v1 course replaces its generated placeholder (1.11): placeholders.ts no longer writes it,
  // so there is nothing to migrate against it.
  const registry = readAuthored(repoRoot())
  let authored = 0
  for (const name of names) {
    const id = name.slice(0, -COURSE_SUFFIX.length)
    if (isAuthored(registry, `courses/${id}${COURSE_SUFFIX}`)) {
      authored++
      continue
    }
    const rel = `${V0_DIR}/${name}`
    const problem = await migrationProblem(rel, id)
    if (problem !== null) notes.push(`${rel}: ${problem}`)
  }
  if (names.length === 0) notes.push(`${V0_DIR} has no v0 course`)
  const placeholders = await runNodeScript('tools/placeholders.ts', ['--check'])
  if (placeholders.code !== 0) notes.push(`tools/placeholders.ts --check exit ${placeholders.code}: ${placeholders.tail}`)
  report('migration', { courses: names.length, authored, placeholdersExit: placeholders.code })
  return { value: String(notes.length), threshold: '0 problems', pass: notes.length === 0, notes }
}

// ---- refusals ------------------------------------------------------------------------------------------

const COURSE_INVALID_DIR = 'fixtures/courses-v1/invalid'
const ASSET_INVALID_DIR = 'fixtures/game-assets/invalid'
const OVERSIZE_SOURCE = 'assets/candy/candy.floor-tile.asset.json'
const OVERSIZE_PATH = 'generated:oversize-document'

interface RefusalCase { path: string; attempt(): Promise<unknown> }

async function jsonFiles(dir: string): Promise<string[]> {
  return (await readdir(repoPath(dir), { withFileTypes: true }))
    .filter(e => e.isFile() && e.name.endsWith('.json'))
    .map(e => `${dir}/${e.name}`)
    .sort()
}

async function refusalCases(): Promise<RefusalCase[]> {
  const cases: RefusalCase[] = []
  for (const path of await jsonFiles(COURSE_INVALID_DIR)) {
    cases.push({ path, attempt: async () => loadCourseV1(JSON.parse(await readRepoText(path)) as unknown, path, nodeGameAssets()) })
  }
  for (const path of await jsonFiles(ASSET_INVALID_DIR)) {
    cases.push({ path, attempt: async () => parseGameAsset(JSON.parse(await readRepoText(path)) as unknown, path) })
  }
  // A file past the cap cannot live under fixtures/ (guard 1.9), so it is built here.
  cases.push({
    path: OVERSIZE_PATH,
    attempt: async () => {
      const asset = JSON.parse(await readRepoText(OVERSIZE_SOURCE)) as Record<string, unknown>
      asset.document = { ...(asset.document as Record<string, unknown>), pad: 'x'.repeat(GAME_ASSET_CAPS.maxDocumentBytes) }
      return parseGameAsset(asset, OVERSIZE_PATH)
    },
  })
  return cases
}

// null when the case refused with `<path>#/<pointer>: ...; <fix>`.
async function refusalProblem(c: RefusalCase): Promise<string | null> {
  try {
    await c.attempt()
  } catch (e) {
    if (!isRefusal(e)) return `threw ${messageOf(e)} instead of a RefusalError`
    const at = e.message.indexOf(`${c.path}#/`)
    if (at < 0) return `the refusal does not name ${c.path}#/<pointer>: ${e.message}`
    if (e.message.indexOf('; ', at) < 0) return `the refusal has no '; <fix>': ${e.message}`
    return null
  }
  return 'loaded without a refusal'
}

async function checkRefusals(): Promise<CheckResult> {
  const notes: string[] = []
  const cases = await refusalCases()
  for (const c of cases) {
    const problem = await refusalProblem(c)
    if (problem !== null) notes.push(`${c.path}: ${problem}`)
  }
  report('refusals', { cases: cases.length })
  return { value: String(notes.length), threshold: '0 cases without a file#pointer refusal and fix', pass: notes.length === 0 && cases.length > 1, notes }
}

// ---- determinism ---------------------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function vec3Of(v: unknown, path: string): { x: number; y: number; z: number } {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number')) refuse('course', path, 'must be [x, y, z]; fix the obstacle scale')
  return { x: v[0], y: v[1], z: v[2] }
}

// Recomputed from the raw course file and the asset scan, without the course loader.
async function expectedColliders(rel: string, json: unknown, i: number): Promise<ColliderSpec[]> {
  const ptr = `${rel}#/obstacles/${i}`
  const o = isObject(json) && Array.isArray(json.obstacles) ? json.obstacles[i] : undefined
  if (!isObject(o) || typeof o.asset !== 'string') refuse('course', ptr, 'no obstacle with a string asset here; fix the course file')
  let base: ColliderSpec[]
  if (Array.isArray(o.colliders)) base = o.colliders.map((c, k) => parseColliderJson(c, `${ptr}/colliders/${k}`))
  else base = (await nodeGameAssets().resolve(o.asset)).asset.collision
  return scaleColliders(base, vec3Of(o.s, `${ptr}/s`), `${ptr}/s`)
}

async function checkDeterminism(): Promise<CheckResult> {
  const notes: string[] = []
  let mismatches = 0
  let courses = 0
  let obstacles = 0
  for (const c of await loadAllCoursesV1()) {
    if (c.sim === null) continue
    courses++
    const rel = `courses/${c.id}.course.json`
    const json = JSON.parse(await readRepoText(rel)) as unknown
    const raw = isObject(json) && Array.isArray(json.obstacles) ? json.obstacles.length : -1
    if (raw !== c.sim.obstacles.length) {
      mismatches++
      notes.push(`${rel}#/obstacles: file has ${raw} obstacles, sim has ${c.sim.obstacles.length}`)
      continue
    }
    for (let i = 0; i < raw; i++) {
      obstacles++
      const expected = await expectedColliders(rel, json, i)
      if (!isDeepStrictEqual(expected, c.sim.obstacles[i].colliders)) {
        mismatches++
        if (mismatches === 1) notes.push(`first mismatch: ${rel}#/obstacles/${i} (colliders differ from asset.collision or the course override)`)
      }
    }
  }

  // The two matches are independent cases: one process each, at most NMC_CPUS at a time.
  const outcomes = await spawnCases(fileURLToPath(import.meta.url), MATCH_CASES.map(label => ({ label, args: [CASE_FLAG, label] })), cpuBudget())
  const hashes: string[] = []
  let ticks = -1
  for (const o of outcomes) {
    const m = new RegExp(`^\\[${o.label}\\] finalHash=([0-9a-f]{8}) ticks=(\\d+)$`, 'm').exec(o.stdout)
    if (o.code !== 0 || m === null) {
      hashes.push('none')
      notes.push(`${o.label} exit ${o.code}: ${(o.stderr.trim() || o.stdout.trim()).split('\n').slice(-3).join(' | ')}`)
      continue
    }
    hashes.push(m[1])
    if (ticks < 0) ticks = Number(m[2])
  }
  const [a, b] = hashes
  const sameHash = a !== 'none' && a === b
  if (!sameHash) notes.push(`finalHash a=${a} b=${b} differ or are missing`)
  report('determinism', { courses, obstacles, finalHash: a, ticks })
  return {
    value: `${mismatches} mismatches, hash a=${a} b=${b}`,
    threshold: 'equal finalHash and 0 collider mismatches',
    pass: sameHash && mismatches === 0 && courses > 0,
    notes,
  }
}

// ---- captures ------------------------------------------------------------------------------------------

const CAPTURES_FILE = 'proofs/m16/captures.json'

function adapterLabelled(rec: Record<string, unknown>): boolean {
  if (typeof rec.software !== 'boolean') return false
  const a = rec.adapter
  if (typeof a === 'string') return a.trim().length > 0
  if (!isObject(a)) return false
  return ['vendor', 'architecture', 'description'].some(k => typeof a[k] === 'string' && (a[k] as string).trim().length > 0)
}

async function checkCaptures(): Promise<CheckResult> {
  const threshold = '0 problems (content v1, labelled adapter, hub/match/podium non-empty, leakScan clean)'
  if (!existsSync(repoPath(CAPTURES_FILE))) {
    return { value: 'no-record', threshold, pass: false, notes: [`${CAPTURES_FILE} is missing: run the GPU card (gameCapture, proofs/m16/captures.input.json)`] }
  }
  const text = await readRepoText(CAPTURES_FILE)
  const rec = JSON.parse(text) as unknown
  if (!isObject(rec)) return { value: 'not-an-object', threshold, pass: false, notes: [`${CAPTURES_FILE} is not a JSON object`] }
  const notes: string[] = []
  if (rec.content !== 'v1') notes.push(`content is ${JSON.stringify(rec.content)}, expected 'v1'`)
  if (typeof rec.pageRef !== 'string' || rec.pageRef.trim().length === 0) notes.push('pageRef is empty')
  if (!adapterLabelled(rec)) notes.push('the adapter is not labelled (adapter name and software flag)')
  const captures = Array.isArray(rec.captures) ? rec.captures.filter(isObject) : []
  const wanted: { label: string; match: (n: string) => boolean }[] = [
    { label: 'hub', match: n => n === 'hub' },
    { label: 'match-*', match: n => n.startsWith('match-') },
    { label: 'podium', match: n => n === 'podium' },
  ]
  for (const w of wanted) {
    const found = captures.filter(c => typeof c.name === 'string' && w.match(c.name))
    if (found.length === 0) notes.push(`no ${w.label} capture`)
    for (const c of found) {
      if (c.nonEmpty !== true || typeof c.bytes !== 'number' || !(c.bytes > 0)) notes.push(`${String(c.name)} is empty (nonEmpty ${String(c.nonEmpty)}, bytes ${String(c.bytes)})`)
    }
  }
  for (const hit of leakScan(text)) notes.push(`leakScan ${hit.pattern} at ${hit.index}: ${hit.excerpt}`)
  report('captures', { captures: captures.length, software: String(rec.software) })
  return { value: String(notes.length), threshold, pass: notes.length === 0, notes }
}

// ---- GPU run (--gpu-run: writes the captures record) ---------------------------------------------------
// Run by the programmatic GPU card after npm run build: publish apps/web/dist, run gameCapture with
// proofs/m16/captures.input.json, write proofs/m16/captures.json from the op output only. PNGs stay in out/m16/.

const GPU_FLAG = '--gpu-run'
const GPU_AREA = 'm16-gpu'
const GPU_OP = 'gameCapture'
const CAPTURES_INPUT = 'proofs/m16/captures.input.json'
const DIST_DIR = 'apps/web/dist'
const PNG_DIR = 'out/m16'

interface SizedCapture { name: string; width: number; height: number; sha256: string; bytes: number; nonEmpty: boolean }

function field<T>(ok: (v: unknown) => boolean, o: Record<string, unknown>, k: string, where: string, expect: string): T {
  if (!ok(o[k])) refuse(GPU_AREA, `${where}/${k}`, `${JSON.stringify(o[k])} is not ${expect}; pass the unmodified ${GPU_OP} output`)
  return o[k] as T
}
const isStr = (v: unknown): boolean => typeof v === 'string'
const isPosInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0

// The op output is the result itself, or the single object within 3 levels holding `captures`.
function opOutput(res: OpResult): { out: Record<string, unknown>; where: string } {
  if (isObject(res.json) && 'captures' in res.json) return { out: res.json, where: `${res.file}#` }
  const found: { out: Record<string, unknown>; where: string }[] = []
  const walk = (v: unknown, path: string, depth: number): void => {
    if (typeof v !== 'object' || v === null || depth > 3) return
    if (depth > 0 && isObject(v) && 'captures' in v) found.push({ out: v, where: path })
    for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], `${path}/${k}`, depth + 1)
  }
  walk(res.json, `${res.file}#`, 0)
  if (found.length !== 1) refuse(GPU_AREA, `${res.file}#`, `${found.length} objects with "captures" within 3 levels; pass the result of exactly one ${GPU_OP} run`)
  return found[0]
}

// S10 + S17 record; every value is copied from the op output (pageRef is the published page_ref).
function capturesRecord(res: OpResult, input: Record<string, unknown>, pageRef: string): Record<string, unknown> {
  const { out, where } = opOutput(res)
  if (out.renderer !== 'raa') refuse(GPU_AREA, `${where}/renderer`, `${JSON.stringify(out.renderer)} is not 'raa'; record only RAA renders`)
  if (out.content !== input.content) refuse(GPU_AREA, `${where}/content`, `${JSON.stringify(out.content)} is not the input content; rerun with ${CAPTURES_INPUT}`)
  const a = field<Record<string, unknown>>(isObject, out, 'adapter', where, 'an adapter object')
  const aw = `${where}/adapter`
  const adapter = {
    vendor: field<string>(isStr, a, 'vendor', aw, 'a string'),
    architecture: field<string>(isStr, a, 'architecture', aw, 'a string'),
    description: field<string>(isStr, a, 'description', aw, 'a string'),
    software: field<boolean>(v => typeof v === 'boolean', a, 'software', aw, 'a boolean'),
  }
  if (out.software !== adapter.software) refuse(GPU_AREA, `${where}/software`, 'differs from adapter.software; pass the unmodified op output')
  const list = field<unknown[]>(v => Array.isArray(v) && v.length > 0, out, 'captures', where, 'a non-empty array')
  const captures = list.map((c, i): SizedCapture => {
    const cw = `${where}/captures/${i}`
    if (!isObject(c)) return refuse(GPU_AREA, cw, `is not an object; pass the unmodified ${GPU_OP} output`)
    return {
      name: field<string>(v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(v), c, 'name', cw, 'a file-safe name'),
      width: field<number>(isPosInt, c, 'width', cw, 'a positive integer'),
      height: field<number>(isPosInt, c, 'height', cw, 'a positive integer'),
      sha256: field<string>(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v), c, 'sha256', cw, 'a sha256 hex string'),
      bytes: field<number>(v => Number.isInteger(v) && (v as number) >= 0, c, 'bytes', cw, 'a byte count'),
      nonEmpty: field<boolean>(v => typeof v === 'boolean', c, 'nonEmpty', cw, 'a boolean'),
    }
  })
  if (out.frameTiming !== null) refuse(GPU_AREA, `${where}/frameTiming`, 'is not null; gameCapture records no frame timing')
  const courses = field<string[]>(v => Array.isArray(v) && v.every(isStr), out, 'courses', where, 'an array of course ids')
  const events = field<unknown[]>(Array.isArray, out, 'events', where, 'an array').map((e, i) => {
    const ew = `${where}/events/${i}`
    if (!isObject(e)) return refuse(GPU_AREA, ew, 'is not an object; pass the unmodified op output')
    return { t: field<number>(v => typeof v === 'number' && Number.isFinite(v), e, 't', ew, 'a finite number'), what: field<string>(isStr, e, 'what', ew, 'a string') }
  })
  const rep = field<Record<string, unknown>>(isObject, out, 'report', where, 'the content report object')
  return { renderer: 'raa', adapter, software: adapter.software, pageRef, captures, frameTiming: null, content: out.content, courses, events, report: rep }
}

// The GPU client writes the op's files into the output directory; each capture must be there, byte for byte.
function checkCapturePngs(captures: SizedCapture[]): void {
  for (const c of captures) {
    const file = `${PNG_DIR}/${c.name}.png`
    if (!existsSync(file)) refuse(GPU_AREA, file, `is missing; the ${GPU_OP} result must come with its PNG files`)
    const bytes = readFileSync(file)
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== c.sha256 || bytes.length !== c.bytes) refuse(GPU_AREA, file, `is ${bytes.length} bytes sha256 ${sha}, the op reported ${c.bytes} bytes sha256 ${c.sha256}; rerun the op`)
  }
}

async function runGpuCaptures(): Promise<number> {
  try {
    process.chdir(repoRoot())
    if (!existsSync(`${DIST_DIR}/game.html`) || !existsSync(`${DIST_DIR}/nmc.gpu.json`)) refuse(GPU_AREA, DIST_DIR, 'has no game.html or nmc.gpu.json; run npm run build')
    const input = JSON.parse(readFileSync(CAPTURES_INPUT, 'utf8')) as unknown
    if (!isObject(input)) return refuse(GPU_AREA, `${CAPTURES_INPUT}#`, 'is not an object; use the gameCapture input of docs/gpu-ops.md')
    const pageRef = await publishDist(DIST_DIR)
    console.log(`[m16-gpu] published ${DIST_DIR}; running ${GPU_OP} with ${CAPTURES_INPUT}`)
    const record = capturesRecord(await renderOp(GPU_OP, input, PNG_DIR, 'captures', pageRef), input, pageRef)
    checkCapturePngs(record.captures as SizedCapture[])
    const secrets = secretsFromEnv()
    const deny = (process.env.RF_GUARD_DENY ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const text = redact(`${JSON.stringify(record, null, 2)}\n`, secrets)
    const hits = leakScan(text, [...secrets, ...deny])
    if (hits.length > 0) refuse(GPU_AREA, CAPTURES_FILE, `leakScan found ${hits.map(h => `${h.pattern} (${h.excerpt})`).join(', ')}; the record is not written`)
    writeFileSync(CAPTURES_FILE, text)
    console.log(`[report:m16-gpu] captures=${(record.captures as SizedCapture[]).length} software=${String(record.software)} out=${CAPTURES_FILE}`)
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

const checks: ProofCheck[] = [
  { label: 'manifest', inQuick: true, run: checkManifest },
  { label: 'migration', inQuick: true, run: checkMigration },
  { label: 'refusals', inQuick: true, run: checkRefusals },
  { label: 'determinism', inQuick: true, run: checkDeterminism },
  { label: 'captures', inQuick: true, run: checkCaptures },
]

const proofArgs = parseProofArgs(process.argv.slice(2))
const caseAt = proofArgs.rest.indexOf(CASE_FLAG)
if (!proofArgs.child && caseAt >= 0) await runMatchCase(proofArgs.rest[caseAt + 1] ?? 'match')
else if (proofArgs.rest.includes(GPU_FLAG)) process.exitCode = await runGpuCaptures()
else await runProof('m16-course-v1', import.meta.url, checks)
