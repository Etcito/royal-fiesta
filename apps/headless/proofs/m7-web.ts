import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { InPageMatch } from '@royal-fiesta/game/client/inpageMatch'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import type { CourseEntry } from '@royal-fiesta/game/courseSet'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { repoRoot } from '../../../tools/bricks.ts'
import { raaStatus } from '../../web/src/render/raaStatus.ts'
import { nodeFixtureResolver, readRepoText, repoPath } from '../src/files.ts'
import { parseProofArgs, report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck } from '../src/proofkit.ts'

const CLIENTS = 4
const SEED = 11
const RAA_ABSENT_LINE = 'RAA API v0 absent: RAA port and browser captures not produced (brief: stop at the null port)'
const STATUS_FILE = 'proofs/m7/raa-status.json'
const CAPTURES_FILE = 'proofs/m7/captures.json'

function checkWebBuild(): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', 'web:build'], { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (d: Buffer) => { tail = (tail + d.toString()).slice(-2000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const done = (code: number) => {
      const files = ['client.html', 'nmc.gpu.json'].map(f => [f, existsSync(repoPath(`apps/web/dist/${f}`))] as const)
      const missing = files.filter(([, ok]) => !ok).map(([f]) => f)
      const pass = code === 0 && missing.length === 0
      const notes = [missing.length === 0 ? 'dist has client.html and nmc.gpu.json' : `missing in apps/web/dist: ${missing.join(', ')}`]
      if (!pass) notes.push(...tail.trim().split('\n').slice(-10))
      resolve({ value: String(code), threshold: 'exit 0 + dist/client.html + dist/nmc.gpu.json', pass, notes })
    }
    child.on('error', (e) => { tail += `spawn failed: ${e.message}`; done(-1) })
    child.on('close', (code) => done(code ?? -1))
  })
}

// Same course load as netsimMatch.loadCourses: every course file in name order, picked for the profile.
async function loadSprintCourses(): Promise<ResolvedCourse[]> {
  const names = (await readdir(repoPath('fixtures/courses'), { withFileTypes: true }))
    .filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name).sort()
  const entries: CourseEntry[] = []
  for (const n of names) {
    const path = `fixtures/courses/${n}`
    entries.push({ path, json: JSON.parse(await readRepoText(path)) })
  }
  return matchCourses(entries, nodeFixtureResolver(), 'sprint')
}

async function checkInPageRound(): Promise<CheckResult> {
  const R = await initRapier()
  const courses = await loadSprintCourses()
  const resolver = nodeFixtureResolver()
  const assets = new Map<string, PrimsAsset>()
  for (const c of courses) {
    for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
  }
  const bean = (await resolver.resolve('bean')).asset
  const ports: NullRenderPort[] = []
  for (let k = 0; k < CLIENTS; k++) {
    const p = new NullRenderPort()
    await p.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
    ports.push(p)
  }
  const prof = PROFILES.sprint
  let cap = 0
  for (const co of courses) cap = Math.max(cap, co.timeLimitS)
  if (prof.timeCapS !== null) cap = Math.min(cap, prof.timeCapS)
  const expected = 4 * (prof.introTicks + prof.roundEndTicks + prof.intermissionTicks + 60 * cap) + prof.podiumTicks
  const limit = 2 * expected

  const match = new InPageMatch({
    R, clients: CLIENTS, seed: SEED, profile: 'sprint', courses, ports, bean,
    assets: (name) => assets.get(name) ?? refuse('proof', `asset ${name}`, 'not pre-resolved; every course obstacle asset is loaded before the match'),
    net: { rttMs: 100, jitterMs: 10, loss: 0.02 }, pilots: [true, true, true, true],
  })
  try {
    const perCourse = new Map<string, { instances: number; frames: number }>()
    let frames = 0
    let badFrames = 0
    let firstBad = ''
    while (!match.done) {
      if (frames >= limit) refuse('proof', 'inpage-round', `match not done after ${frames} frames; check stalls/desyncs`)
      match.frame(1 / 60)
      frames++
      const sim = match.matches[0].sim
      const course = sim.course()
      if (course === null) continue
      const got = match.views[0].instanceCount
      const want = 8 + sim.obstacleCount()
      if (got !== want) {
        badFrames++
        if (firstBad === '') firstBad = `frame ${frames} course ${course.id}: instanceCount ${got} != ${want}`
      }
      const e = perCourse.get(course.id) ?? { instances: got, frames: 0 }
      e.frames++
      perCourse.set(course.id, e)
    }
    const h = match.hashes()
    for (const [id, e] of perCourse) report('inpage-round', { course: id, instanceCount: e.instances, frames: e.frames })
    report('inpage-round', { frames, expectedFrames: expected, ticks: match.matches[0].sim.tick })
    const pass = h.mismatches === 0 && h.ticksCompared > 0 && badFrames === 0 && perCourse.size > 0
    return {
      value: `mismatches=${h.mismatches} ticks=${h.ticksCompared} badFrames=${badFrames}`,
      threshold: 'mismatches=0 ticks>0 badFrames=0 (instanceCount = 8 + obstacles)',
      pass,
      notes: firstBad === '' ? undefined : [firstBad],
    }
  } finally {
    match.dispose()
  }
}

interface RaaRecord { available: boolean; reason: string; apiVersion: string | null }

// Node mirror of raaStatus(): Node has no navigator.gpu, so the record is "absent" here; a browser run
// of the same page reports the WebGPU result.
async function detectRaa(): Promise<RaaRecord> {
  const live = await raaStatus()
  return { available: live.available, reason: live.reason, apiVersion: live.apiVersion }
}

async function readRecord(rel: string): Promise<unknown> {
  if (!existsSync(repoPath(rel))) return null
  return JSON.parse(await readRepoText(rel)) as unknown
}

interface CapturesRecord {
  renderer: string; adapter: string; software: boolean; pageRef: string
  captures: { name: string; width: number; height: number; sha256: string; bytes: number; nonEmpty: boolean }[]
  frameTiming: { width: number; height: number; frames: number; p50Ms: number; p95Ms: number } | null
}

async function checkRaa(): Promise<CheckResult> {
  const live = await detectRaa()
  const rec = await readRecord(STATUS_FILE) as Partial<RaaRecord> | null
  const keys = ['available', 'reason', 'apiVersion'] as const
  const diff = rec === null ? [`${STATUS_FILE} missing`] : keys.filter(k => rec[k] !== live[k]).map(k => `${k}: record=${JSON.stringify(rec[k])} live=${JSON.stringify(live[k])}`)
  if (diff.length > 0) {
    return {
      value: 'stale record', threshold: `${STATUS_FILE} matches live detection`, pass: false,
      notes: [...diff, 'regenerate: node --experimental-strip-types apps/headless/proofs/m7-web.ts --write-golden'],
    }
  }
  if (!live.available) {
    console.log(RAA_ABSENT_LINE)
    return { value: 'absent', threshold: 'n/a', pass: true, notes: [live.reason] }
  }
  const threshold = `${STATUS_FILE} matches live; >=3 non-empty raa captures at 1920x1080; frame p95<=16.7ms at 1920x1080 (not software)`
  const cap = await readRecord(CAPTURES_FILE) as CapturesRecord | null
  if (cap === null) return { value: `${CAPTURES_FILE} missing`, threshold, pass: false }
  const good = (cap.captures ?? []).filter(c => c.nonEmpty === true && c.bytes > 0 && c.width === 1920 && c.height === 1080)
  const ft = cap.frameTiming
  const timingOk = ft !== null && ft.width === 1920 && ft.height === 1080 && ft.p95Ms <= 16.7 && cap.software !== true
  const p95 = ft === null ? 'none' : `${ft.p95Ms}ms${cap.software === true ? ' (software)' : ''}`
  const pass = cap.renderer === 'raa' && good.length >= 3 && timingOk
  return {
    value: `renderer=${cap.renderer} captures=${good.length} p95=${p95}`,
    threshold,
    pass,
    notes: [`adapter=${cap.adapter} software=${cap.software} pageRef=${cap.pageRef}`, ...(cap.software === true ? ['software renderer: timing fails by rule'] : [])],
  }
}

const checks: ProofCheck[] = [
  { label: 'web-build', inQuick: true, run: () => checkWebBuild() },
  { label: 'inpage-round', inQuick: true, run: () => checkInPageRound() },
  { label: 'raa', inQuick: true, run: () => checkRaa() },
]

const args = parseProofArgs(process.argv.slice(2))
if (args.writeGolden) {
  const live = await detectRaa()
  await mkdir(repoPath('proofs/m7'), { recursive: true })
  await writeFile(repoPath(STATUS_FILE), JSON.stringify({ ...live, checkedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(`wrote ${STATUS_FILE}: available=${live.available} reason=${live.reason}`)
} else {
  await runProof('m7-web', import.meta.url, checks)
}
process.exit(process.exitCode ?? 0)
