import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import type { CourseEntry } from '@royal-fiesta/game/courseSet'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import { InPageHubLoop } from '../../web/src/play/inpageHub.ts'
import { raaStatus } from '../../web/src/render/raaStatus.ts'
import { loadCourseFile, nodeFixtureResolver, readRepoText, repoPath } from '../src/files.ts'
import { startGameSaloon } from '../src/gamesaloon.ts'
import { runHubLoop } from '../src/hubLoop.ts'
import type { HubLoopResult } from '../src/hubLoop.ts'
import { parseProofArgs, report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck } from '../src/proofkit.ts'

const CLIENTS = 4
const MIN_SIGHTINGS = 20
const MAX_FRAMES = 30000
const DT = 1 / 60
const RAA_ABSENT_LINE = 'RAA API v0 absent: RAA port and browser hub captures not produced (brief: stop at the null port)'
const STATUS_FILE = 'proofs/m8/raa-status.json'
const CAPTURES_FILE = 'proofs/m8/captures.json'
const CAPTURE_NAMES = ['hub-loop-hub', 'hub-loop-match', 'hub-loop-podium', 'hub-loop-back-in-hub']

// One real-server loop per process: match-consistency reuses it when the checks run in-process (NMC_CPUS=1).
let hubLoop: Promise<HubLoopResult> | null = null

function runOnce(): Promise<HubLoopResult> {
  hubLoop ??= (async () => {
    const server = await startGameSaloon()
    try {
      return await runHubLoop(server, CLIENTS)
    } finally {
      await server.stop()
    }
  })()
  return hubLoop
}

async function checkHubLoop(): Promise<CheckResult> {
  const r = await runOnce()
  const logged = (k: number, state: string) => r.events.some(e => e.client === `bot${k}` && e.state === state)
  const missing: string[] = []
  for (let k = 0; k < CLIENTS; k++) {
    for (const s of ['match', 'podium']) if (!logged(k, s)) missing.push(`bot${k} never logged ${s}`)
  }
  report('hub-loop', { wallMs: Math.round(r.wallMs), events: r.events.length })
  const pass = r.clientsBackInHub === CLIENTS && missing.length === 0 &&
    r.remoteSightings.length === CLIENTS && r.remoteSightings.every(s => s >= MIN_SIGHTINGS) &&
    r.remoteSightingsAfter.length === CLIENTS && r.remoteSightingsAfter.every(s => s >= MIN_SIGHTINGS)
  return {
    value: `backInHub=${r.clientsBackInHub} sightings=[${r.remoteSightings.join(',')}] after=[${r.remoteSightingsAfter.join(',')}]`,
    threshold: `backInHub=${CLIENTS} every sightings>=${MIN_SIGHTINGS} every after>=${MIN_SIGHTINGS} every client logged match and podium`,
    pass,
    notes: [...missing, 'event log: out/m8/loop-log.jsonl'],
  }
}

async function checkMatchConsistency(): Promise<CheckResult> {
  const r = await runOnce()
  const h = r.matchHashes
  const w = r.winners
  const sameWinner = w.length === CLIENTS && w.every(x => x === w[0]) && w[0] >= 0
  return {
    value: `mismatches=${h.mismatches} ticks=${h.ticksCompared} winners=[${w.join(',')}]`,
    threshold: 'mismatches=0 ticks>0 4 equal winners >= 0',
    pass: h.mismatches === 0 && h.ticksCompared > 0 && sameWinner,
  }
}

// Same course load as hubLoop: every course file in name order, picked for sprint.
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

async function checkInPageLoop(): Promise<CheckResult> {
  const R = await initRapier()
  const courses = await loadSprintCourses()
  const plaza = await loadCourseFile('fixtures/courses/hub-plaza.course.json')
  const resolver = nodeFixtureResolver()
  const loaded = new Map<string, PrimsAsset>([['bean', (await resolver.resolve('bean')).asset]])
  for (const c of [...courses, plaza]) {
    for (const o of c.obstacles) if (!loaded.has(o.asset)) loaded.set(o.asset, (await resolver.resolve(o.asset)).asset)
  }
  const assets = (name: string): PrimsAsset =>
    loaded.get(name) ?? refuse('proof', `asset ${name}`, 'not preloaded; every course and plaza asset is loaded before the loop')
  const ports: NullRenderPort[] = []
  for (let k = 0; k < CLIENTS; k++) {
    const p = new NullRenderPort()
    await p.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
    ports.push(p)
  }
  let frame = 0
  const now = () => frame * DT * 1000
  const original = Object.getOwnPropertyDescriptor(performance, 'now')
  let loop: InPageHubLoop | null = null
  try {
    // LoopbackRelay rate-limits on performance.now, so it shares deps.now's virtual clock.
    Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: now })
    loop = new InPageHubLoop(R, CLIENTS, new LoopbackRelay({ seed: 8 }), {
      R, courses, plaza, partySize: CLIENTS, now, pilot: true,
    }, ports, { assets, bean: assets('bean') })
    while (!loop.done && frame < MAX_FRAMES) {
      frame++
      loop.frame(DT)
      const failed = loop.flows.findIndex(f => f.state === 'failed')
      if (failed >= 0) {
        const ev = [...loop.events].reverse().find(e => e.state === 'failed')
        refuse('proof', `inpage-loop client ${failed}`, `flow failed: ${ev?.detail.message ?? 'no message logged'}`)
      }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const back = new Set(loop.events.filter((e, i, all) =>
      e.state === 'hub' && all.slice(0, i).some(p => p.client === e.client && p.state === 'returning')).map(e => e.client)).size
    const h = loop.hashes()
    const w = loop.flows.map(f => f.lastLog?.winner ?? -1)
    const sameWinner = w.length === CLIENTS && w.every(x => x === w[0]) && w[0] >= 0
    report('inpage-loop', { frames: frame, events: loop.events.length, ticksCompared: h.ticksCompared })
    return {
      value: `done=${loop.done} backInHub=${back} frames=${frame} mismatches=${h.mismatches} winners=[${w.join(',')}]`,
      threshold: `done within ${MAX_FRAMES} frames, backInHub=${CLIENTS}, mismatches=0, equal winners`,
      pass: loop.done && back === CLIENTS && h.mismatches === 0 && sameWinner,
      notes: loop.done ? undefined : [`states: ${loop.flows.map(f => f.state).join(' ')}`],
    }
  } finally {
    try {
      loop?.dispose()
    } finally {
      if (original) Object.defineProperty(performance, 'now', original)
      else Reflect.deleteProperty(performance, 'now')
    }
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
  frameTiming: unknown
}

async function checkCaptures(): Promise<CheckResult> {
  const live = await detectRaa()
  const rec = await readRecord(STATUS_FILE) as Partial<RaaRecord> | null
  const keys = ['available', 'reason', 'apiVersion'] as const
  const diff = rec === null ? [`${STATUS_FILE} missing`] : keys.filter(k => rec[k] !== live[k]).map(k => `${k}: record=${JSON.stringify(rec[k])} live=${JSON.stringify(live[k])}`)
  if (diff.length > 0) {
    return {
      value: 'stale record', threshold: `${STATUS_FILE} matches live detection`, pass: false,
      notes: [...diff, 'regenerate: node --experimental-strip-types apps/headless/proofs/m8-hub.ts --write-golden'],
    }
  }
  if (!live.available) {
    console.log(RAA_ABSENT_LINE)
    return { value: 'absent', threshold: 'n/a', pass: true, notes: [live.reason] }
  }
  const threshold = `${STATUS_FILE} matches live; renderer raa; non-empty 1920x1080 ${CAPTURE_NAMES.join(', ')}`
  const cap = await readRecord(CAPTURES_FILE) as CapturesRecord | null
  if (cap === null) return { value: `${CAPTURES_FILE} missing`, threshold, pass: false, notes: [] }
  const good = (cap.captures ?? []).filter(c => c.nonEmpty === true && c.bytes > 0 && c.width === 1920 && c.height === 1080)
  const absent = CAPTURE_NAMES.filter(n => !good.some(c => c.name === n))
  return {
    value: `renderer=${cap.renderer} captures=${good.length}`,
    threshold,
    pass: cap.renderer === 'raa' && good.length >= 4 && absent.length === 0,
    notes: [`adapter=${cap.adapter} software=${cap.software} pageRef=${cap.pageRef}`, ...(absent.length > 0 ? [`missing: ${absent.join(', ')}`] : [])],
  }
}

const checks: ProofCheck[] = [
  { label: 'hub-loop', inQuick: true, run: () => checkHubLoop() },
  { label: 'match-consistency', inQuick: true, run: () => checkMatchConsistency() },
  { label: 'inpage-loop', inQuick: true, run: () => checkInPageLoop() },
  { label: 'captures', inQuick: true, run: () => checkCaptures() },
]

const args = parseProofArgs(process.argv.slice(2))
if (args.writeGolden) {
  const live = await detectRaa()
  await mkdir(repoPath('proofs/m8'), { recursive: true })
  await writeFile(repoPath(STATUS_FILE), JSON.stringify({ ...live, checkedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(`wrote ${STATUS_FILE}: available=${live.available} reason=${live.reason}`)
} else {
  await runProof('m8-hub', import.meta.url, checks)
}
process.exit(process.exitCode ?? 0)
