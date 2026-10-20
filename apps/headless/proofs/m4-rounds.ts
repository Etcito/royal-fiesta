import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { matchLogJson } from '@royal-fiesta/sim/match/log'
import type { MatchLog } from '@royal-fiesta/sim/match/log'
import { runMatchOffline } from '@royal-fiesta/sim/match/offline'
import type { OfflineOptions, OfflineResult } from '@royal-fiesta/sim/match/offline'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { loadAllCourses, repoPath } from '../src/files.ts'
import { hex8, runProof, spawnCases } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck, ProofMode } from '../src/proofkit.ts'

const RULE_TESTS = ['packages/sim/test/rules.test.ts', 'packages/sim/test/round.test.ts']
const MATCH_KINDS = ['race', 'survival'] as const
const ROLLBACKS = [
  { every: 37, back: 9, fresh: false },
  { every: 113, back: 15, fresh: true },
]

let rapier: Promise<RapierModule> | null = null
function getRapier(): Promise<RapierModule> {
  if (rapier === null) rapier = initRapier()
  return rapier
}

let courseCache: Promise<ResolvedCourse[]> | null = null
// Same profile/kind rule and message as the `rf match` CLI and game/courseSet matchCourses.
async function matchCoursesFor(profile: ProfileName): Promise<ResolvedCourse[]> {
  if (courseCache === null) courseCache = loadAllCourses()
  const courses = (await courseCache).filter(c => (c.kind === 'race' || c.kind === 'survival') && c.profiles.includes(profile))
  for (const kind of MATCH_KINDS) {
    if (!courses.some(c => c.kind === kind)) {
      refuse('course', 'courses', `no ${kind} course for profile '${profile}'; add a ${kind} course whose profiles include '${profile}'`)
    }
  }
  return courses
}

async function botSetup(seed: number, profile: ProfileName): Promise<MatchSetup> {
  const playerCount = 8
  const humans: boolean[] = []
  for (let p = 0; p < playerCount; p++) humans.push(false)
  return { seed, playerCount, humans, profile, courses: await matchCoursesFor(profile) }
}

function runNodeTests(files: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files.map(repoPath)], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', (e) => { stderr += e.message + '\n'; resolve({ code: 1, stdout, stderr }) })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function checkRules(): Promise<CheckResult> {
  const out = await runNodeTests(RULE_TESTS)
  const pass = /^# pass (\d+)$/m.exec(out.stdout)
  const fail = /^# fail (\d+)$/m.exec(out.stdout)
  const notes: string[] = []
  // TAP lists nested failures too, so a failing suite and its failing children both appear.
  for (const m of out.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)) notes.push(`failed: ${m[1]}`)
  if (pass === null || fail === null) {
    notes.push(`no node:test summary (exit ${out.code})`)
    for (const line of out.stderr.trim().split('\n').slice(-5)) notes.push(line)
    return { value: 'pass=? fail=?', threshold: 'fail=0', pass: false, notes }
  }
  const nPass = Number(pass[1])
  const nFail = Number(fail[1])
  return { value: `pass=${nPass} fail=${nFail}`, threshold: 'fail=0', pass: nFail === 0 && nPass > 0 && out.code === 0, notes }
}

function roundLine(r: MatchLog['rounds'][number]): string {
  return `round ${r.index} ${r.kind}${r.final ? ' final' : ''} ${r.course} ${r.reason} qualified=[${r.qualified.join(',')}] eliminated=[${r.eliminated.join(',')}]`
}

async function checkMatches(mode: ProofMode): Promise<CheckResult> {
  const profile: ProfileName = mode === 'quick' ? 'sprint' : 'standard'
  const seeds = mode === 'quick' ? [1, 2] : [1, 2, 3, 4]
  const cases = seeds.map(s => ({
    label: `${profile}-${s}`,
    out: `out/m4/match-${profile}-${s}.json`,
    args: ['match', '--seed', String(s), '--profile', profile],
  }))
  const outcomes = await spawnCases(repoPath('apps/headless/src/cli.ts'), cases.map(c => ({ label: c.label, args: [...c.args, '--out', c.out] })))
  const notes: string[] = []
  const problems: string[] = []
  let done = 0
  let races = 0
  let survivals = 0
  let notByTarget = 0
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    const o = outcomes[i]
    if (o.code !== 0) {
      problems.push(`${c.label}: exit ${o.code}`)
      notes.push(`${c.label} exit ${o.code}: ${(o.stderr.trim() || o.stdout.trim()).split('\n').slice(-3).join(' | ')}`)
      continue
    }
    const log = JSON.parse(await readFile(repoPath(c.out), 'utf8')) as MatchLog
    notes.push(`${c.label} (${(o.ms / 1000).toFixed(1)} s) winner ${log.winner} podium [${log.podium.join(',')}] finalHash ${log.finalHash}`)
    for (const r of log.rounds) notes.push(`  ${roundLine(r)}`)
    const last = log.rounds[log.rounds.length - 1]
    const distinct = new Set(log.podium).size === log.podium.length
    let ok = true
    if (log.winner < 0) { problems.push(`${c.label}: no winner`); ok = false }
    if (log.podium.length === 0 || log.podium[0] !== log.winner || !distinct) { problems.push(`${c.label}: bad podium`); ok = false }
    if (last === undefined || !last.final) { problems.push(`${c.label}: last round not final`); ok = false }
    if (ok) done++
    for (const r of log.rounds) {
      if (r.kind === 'survival') survivals++
      if (r.kind === 'race' && !r.final) {
        races++
        if (r.reason !== 'target') notByTarget++
      }
    }
  }
  if (races === 0) problems.push('no non-final race played')
  if (survivals === 0) problems.push('no survival round played')
  if (profile === 'standard' && notByTarget > 0) problems.push(`${notByTarget} standard races not ended by target`)
  if (problems.length > 0) notes.unshift(`problems: ${problems.join('; ')}`)
  const threshold = `done=${seeds.length}/${seeds.length} races>=1 survival>=1${profile === 'standard' ? ' notByTarget=0' : ''}`
  return {
    value: `done=${done}/${seeds.length} races=${races} survival=${survivals} notByTarget=${notByTarget} profile=${profile}`,
    threshold,
    pass: problems.length === 0,
    notes,
  }
}

async function runSprint1(opts: OfflineOptions = {}): Promise<{ json: string; result: OfflineResult }> {
  const R = await getRapier()
  const result = runMatchOffline(R, await botSetup(1, 'sprint'), opts)
  return { json: matchLogJson(result.log), result }
}

async function checkRepeat(): Promise<CheckResult> {
  const a = await runSprint1()
  const b = await runSprint1()
  const same = a.json === b.json && a.result.finalHash === b.result.finalHash
  return {
    value: `identical=${same ? 'yes' : 'no'} hash=${hex8(a.result.finalHash)}`,
    threshold: 'identical=yes',
    pass: same,
    notes: same ? [] : [`second hash=${hex8(b.result.finalHash)}`],
  }
}

async function checkRollback(): Promise<CheckResult> {
  const plain = await runSprint1()
  const parts: string[] = []
  const notes: string[] = [`plain hash=${hex8(plain.result.finalHash)} ticks=${plain.result.ticks}`]
  let pass = true
  for (const fr of ROLLBACKS) {
    const run = await runSprint1({ forcedRollback: fr })
    const same = run.json === plain.json && run.result.finalHash === plain.result.finalHash
    const tag = `${fr.every},${fr.back}${fr.fresh ? ',fresh' : ''}`
    parts.push(`[${tag}] identical=${same ? 'yes' : 'no'} rollbacks=${run.result.rollbacks}`)
    if (!same || run.result.rollbacks === 0) pass = false
    notes.push(`${tag}: hash=${hex8(run.result.finalHash)} rollbacks=${run.result.rollbacks}`)
  }
  return { value: parts.join(' '), threshold: 'identical=yes rollbacks>0', pass, notes }
}

const checks: ProofCheck[] = [
  { label: 'rules', inQuick: true, run: () => checkRules() },
  { label: 'match-8-bots', inQuick: true, run: (mode) => checkMatches(mode) },
  { label: 'repeat', inQuick: true, run: () => checkRepeat() },
  { label: 'rollback', inQuick: true, run: () => checkRollback() },
]

await runProof('m4-rounds', import.meta.url, checks)
