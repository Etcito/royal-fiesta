import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
import { cpuBudget, hex8, parseProofArgs, report, runProof, spawnCases } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { repoRoot } from '../../../tools/bricks.ts'
import { leakScan } from '../../../tools/guard.ts'

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
  for (const name of names) {
    const rel = `${V0_DIR}/${name}`
    const problem = await migrationProblem(rel, name.slice(0, -COURSE_SUFFIX.length))
    if (problem !== null) notes.push(`${rel}: ${problem}`)
  }
  if (names.length === 0) notes.push(`${V0_DIR} has no v0 course`)
  const placeholders = await runNodeScript('tools/placeholders.ts', ['--check'])
  if (placeholders.code !== 0) notes.push(`tools/placeholders.ts --check exit ${placeholders.code}: ${placeholders.tail}`)
  report('migration', { courses: names.length, placeholdersExit: placeholders.code })
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
else await runProof('m16-course-v1', import.meta.url, checks)
