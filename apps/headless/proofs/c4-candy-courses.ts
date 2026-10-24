import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { nodeGameAssets } from '@royal-fiesta/headless/contentFiles'
import { cpuBudget, parseProofArgs, report, runProof, spawnCases } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { isAuthored, readAuthored } from '../../../tools/authored.ts'
import { repoRoot } from '../../../tools/bricks.ts'
import { decorProblems, generatedCourse, loadAuthoredCourse, playSprint, simDiff } from '../../../tools/courseProbe.ts'

// C4: the 4 candy courses are dressed (decor + candy sun) without touching their sims, and the redressed
// race/survival pair plays an 8-bot sprint match deterministically. Reads committed files only.

const RACE = 'race-hammer-hill'
const SURVIVAL = 'survival-hammer-ring'
const COURSES = [RACE, SURVIVAL, 'hub-plaza', 'podium']
const PLAYABLE = [RACE, SURVIVAL]
// The candy preset sun of 1.13; C4 stages `environment` as sun only (1.11).
const CANDY_ENV = { sun: { dir: [-0.35, -1, -0.45], color: [1, 0.96, 0.9], intensity: 3.2 } }
const PROFILES = ['standard', 'sprint']
const SEEDS = [11, 12]
const RUNS = ['a', 'b']
const CASE_FLAG = '--play-case'

const rel = (id: string): string => `courses/${id}.course.json`

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// A refusal becomes the note of the check that needs the course.
async function tryLoad(load: (id: string) => Promise<CourseV1>, id: string, notes: string[], what: string): Promise<CourseV1 | null> {
  try {
    return await load(id)
  } catch (e) {
    if (!isRefusal(e)) throw e
    notes.push(`${rel(id)} (${what}): ${messageOf(e)}`)
    return null
  }
}

// ---- sim-kept ------------------------------------------------------------------------------------------

async function checkSimKept(): Promise<CheckResult> {
  const notes: string[] = []
  let differences = 0
  for (const id of COURSES) {
    const authored = await tryLoad(loadAuthoredCourse, id, notes, 'authored')
    const generated = await tryLoad(generatedCourse, id, notes, 'generated')
    if (authored === null || generated === null) continue
    // Race/survival gain the sprint profile on purpose; the courses check guards its value.
    const diffs = simDiff(authored, generated, PLAYABLE.includes(id) ? ['profiles'] : [])
    differences += diffs.length
    for (const d of diffs) notes.push(`${rel(id)}: ${d}; keep the generated sim field`)
    report(`sim-kept:${id}`, { differences: diffs.length })
  }
  return { value: String(differences), threshold: '0', pass: differences === 0 && notes.length === 0, notes }
}

// ---- courses -------------------------------------------------------------------------------------------

async function checkCourses(): Promise<CheckResult> {
  const notes: string[] = []
  const registry = readAuthored(repoRoot())
  let ok = 0
  for (const id of COURSES) {
    const before = notes.length
    const c = await tryLoad(loadAuthoredCourse, id, notes, 'loadCourseV1')
    if (!isAuthored(registry, rel(id))) notes.push(`${rel(id)}: not listed in tools/authored.json; add it (sorted)`)
    if (c === null) continue
    if (c.world !== 'candy') notes.push(`${rel(id)}: world '${c.world}', expected 'candy'`)
    if (!isDeepStrictEqual(c.environment, CANDY_ENV)) {
      notes.push(`${rel(id)}: environment ${JSON.stringify(c.environment)}, expected ${JSON.stringify(CANDY_ENV)} (the candy sun, sun only in C4)`)
    }
    if (PLAYABLE.includes(id) && !isDeepStrictEqual(c.json.profiles, PROFILES)) {
      notes.push(`${rel(id)}: profiles ${JSON.stringify(c.json.profiles)}, expected ${JSON.stringify(PROFILES)}; add sprint`)
    }
    for (const p of await decorProblems(c, nodeGameAssets())) notes.push(`${rel(id)}: ${p}`)
    report(`courses:${id}`, { decor: c.decor.length })
    if (notes.length === before) ok++
  }
  const n = COURSES.length
  return { value: `${ok}/${n}`, threshold: `${n}/${n}`, pass: ok === n && notes.length === 0, notes }
}

// ---- plays ---------------------------------------------------------------------------------------------

interface PlayCase {
  label: string
  seed: number
  done: boolean
  winner: number
  finalHash: string
  raceQualified: number
  survivalQualified: number
  error: string | null
}

let rapier: Promise<RapierModule> | null = null
function getRapier(): Promise<RapierModule> {
  if (rapier === null) rapier = initRapier()
  return rapier
}

// One case in its own process (spawned by checkPlays): prints one JSON line.
async function runPlayCase(label: string, seed: number): Promise<void> {
  const out: PlayCase = { label, seed, done: false, winner: -1, finalHash: '', raceQualified: 0, survivalQualified: 0, error: null }
  try {
    const R = await getRapier()
    // playSprint reports only the chosen course's round, so the same match is played once per course.
    const race = await playSprint(R, RACE, SURVIVAL, seed)
    const survival = await playSprint(R, SURVIVAL, RACE, seed)
    out.done = race.done && survival.done
    out.winner = race.winner
    out.finalHash = race.finalHash
    out.raceQualified = race.ownRoundQualified
    out.survivalQualified = survival.ownRoundQualified
    if (survival.finalHash !== race.finalHash) out.error = `the same match gave finalHash ${race.finalHash} then ${survival.finalHash}`
  } catch (e) {
    if (!isRefusal(e)) throw e
    out.error = messageOf(e)
  }
  console.log(JSON.stringify(out))
}

function parseCase(stdout: string): PlayCase | null {
  const line = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop()
  if (line === undefined) return null
  try {
    return JSON.parse(line) as PlayCase
  } catch {
    return null
  }
}

async function checkPlays(): Promise<CheckResult> {
  const notes: string[] = []
  const cases = SEEDS.flatMap(seed => RUNS.map(run => ({ label: `seed${seed}-${run}`, args: [CASE_FLAG, `seed${seed}-${run}`, String(seed)] })))
  // Independent matches: one process each, at most NMC_CPUS at a time.
  const outcomes = await spawnCases(fileURLToPath(import.meta.url), cases, cpuBudget())
  const results = new Map<string, PlayCase>()
  let ok = 0
  for (const o of outcomes) {
    const r = o.code === 0 ? parseCase(o.stdout) : null
    if (r === null) {
      notes.push(`${o.label} exit ${o.code}: ${(o.stderr.trim() || o.stdout.trim()).split('\n').slice(-3).join(' | ')}`)
      continue
    }
    results.set(o.label, r)
    const before = notes.length
    if (r.error !== null) notes.push(`${o.label}: ${r.error}`)
    else {
      if (!r.done || r.winner < 0) notes.push(`${o.label}: done=${r.done} winner=${r.winner}; the match must reach done with a winner`)
      if (r.raceQualified < 1) notes.push(`${o.label}: ${r.raceQualified} qualified in the ${RACE} round, at least 1 needed`)
      if (r.survivalQualified < 1) notes.push(`${o.label}: ${r.survivalQualified} qualified in the ${SURVIVAL} rounds, at least 1 needed`)
    }
    report(`plays:${o.label}`, { winner: r.winner, finalHash: r.finalHash || '-', race: r.raceQualified, survival: r.survivalQualified, ms: Math.round(o.ms) })
    if (notes.length === before) ok++
  }
  let sameHash = 0
  for (const seed of SEEDS) {
    const [a, b] = RUNS.map(run => results.get(`seed${seed}-${run}`)?.finalHash ?? '')
    if (a !== '' && a === b) sameHash++
    else notes.push(`seed ${seed}: finalHash a=${a || 'none'} b=${b || 'none'} differ or are missing`)
  }
  return {
    value: `cases=${ok}/${cases.length} sameHash=${sameHash}/${SEEDS.length}`,
    threshold: `cases=${cases.length}/${cases.length} sameHash=${SEEDS.length}/${SEEDS.length}`,
    pass: ok === cases.length && sameHash === SEEDS.length && notes.length === 0,
    notes,
  }
}

// sim-kept runs first: it is the gameplay guard and must report even while the dressing is pending.
const checks: ProofCheck[] = [
  { label: 'sim-kept', inQuick: true, run: checkSimKept },
  { label: 'courses', inQuick: true, run: checkCourses },
  { label: 'plays', inQuick: true, run: checkPlays },
]

const proofArgs = parseProofArgs(process.argv.slice(2))
const caseAt = proofArgs.rest.indexOf(CASE_FLAG)
if (!proofArgs.child && caseAt >= 0) await runPlayCase(proofArgs.rest[caseAt + 1] ?? 'case', Number(proofArgs.rest[caseAt + 2]))
else await runProof('c4-candy-courses', import.meta.url, checks)
