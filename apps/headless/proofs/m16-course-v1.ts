import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { parseColliderJson, scaleColliders } from '@royal-fiesta/game/prims'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { runMatchOffline } from '@royal-fiesta/sim/match/offline'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { loadAllCoursesV1, nodeGameAssets, v1Playlist } from '@royal-fiesta/headless/contentFiles'
import { readRepoText } from '@royal-fiesta/headless/files'
import { cpuBudget, hex8, parseProofArgs, report, runProof, spawnCases } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'

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

const checks: ProofCheck[] = [
  { label: 'determinism', inQuick: true, run: checkDeterminism },
]

const proofArgs = parseProofArgs(process.argv.slice(2))
const caseAt = proofArgs.rest.indexOf(CASE_FLAG)
if (!proofArgs.child && caseAt >= 0) await runMatchCase(proofArgs.rest[caseAt + 1] ?? 'match')
else await runProof('m16-course-v1', import.meta.url, checks)
