// One NetSim match: N rollback peers over a simulated network, with the QB1-QB4 measurements.
import { readdir } from 'node:fs/promises'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { NetSim } from '@gamesaloon/rollback'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import type { CourseEntry } from '@royal-fiesta/game/courseSet'
import { createNetMatch } from '@royal-fiesta/game/net/netMatch'
import type { NetMatch } from '@royal-fiesta/game/net/netMatch'
import { compareHashLogs, ConfirmedHashLog, CostStats, DisplayJumpMeter } from '@royal-fiesta/game/net/metrics'
import { Pilot } from '@royal-fiesta/game/net/pilot'
import { netSetup } from '@royal-fiesta/game/net/tuning'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { matchLogJson } from '@royal-fiesta/sim/match/log'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { nodeFixtureResolver, readRepoText, repoPath } from './files.ts'

export interface NetSimCase { label: string; peers: 2 | 4 | 8; rttMs: number; jitterMs: number; loss: number; seed: number; profile: ProfileName }
export interface NetRunResult {
  label: string; ticksCompared: number; mismatches: number; firstMismatch: number; winners: number[]; logsEqual: boolean
  frameMsMean: number; frameMsP99: number; frameMsMax: number; rollbacks: number; maxRollback: number; resimTicks: number
  resimPerTick: number; maxDelay: number; maxDisplayJump: number; visibleSnaps: number; stalls: number; ticks: number; wallMs: number
}

const sprint = (label: string, peers: 2 | 4 | 8, rttMs: number, jitterMs: number, loss: number): NetSimCase =>
  ({ label, peers, rttMs, jitterMs, loss, seed: 11, profile: 'sprint' })
const quick = [sprint('p2-rtt40', 2, 40, 5, 0), sprint('p4-rtt100', 4, 100, 10, 0.02), sprint('p8-rtt100', 8, 100, 10, 0.02)]
export const NETSIM_CASES: { quick: NetSimCase[]; full: NetSimCase[] } = {
  quick,
  full: [
    ...quick,
    sprint('p8-rtt200', 8, 200, 30, 0.05),
    { label: 'p4-std-rtt100', peers: 4, rttMs: 100, jitterMs: 10, loss: 0.02, seed: 11, profile: 'standard' },
    { label: 'p8-std-rtt100', peers: 8, rttMs: 100, jitterMs: 10, loss: 0.02, seed: 11, profile: 'standard' },
  ],
}

let rapier: ReturnType<typeof initRapier> | null = null
const courseCache = new Map<ProfileName, Promise<ResolvedCourse[]>>()

async function loadCourses(profile: ProfileName): Promise<ResolvedCourse[]> {
  let p = courseCache.get(profile)
  if (!p) {
    p = (async () => {
      const names = (await readdir(repoPath('fixtures/courses'), { withFileTypes: true }))
        .filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name).sort()
      const entries: CourseEntry[] = []
      for (const n of names) {
        const path = `fixtures/courses/${n}`
        entries.push({ path, json: JSON.parse(await readRepoText(path)) })
      }
      return matchCourses(entries, nodeFixtureResolver(), profile)
    })()
    courseCache.set(profile, p)
  }
  return p
}

export async function runNetSimCase(c: NetSimCase): Promise<NetRunResult> {
  rapier ??= initRapier()
  const R = await rapier
  const courses = await loadCourses(c.profile)
  const setup = netSetup(c.seed, c.peers, c.profile, courses)
  const prof = PROFILES[c.profile]
  let cap = 0
  for (const co of courses) cap = Math.max(cap, co.timeLimitS)
  if (prof.timeCapS !== null) cap = Math.min(cap, prof.timeCapS)
  const expected = 4 * (prof.introTicks + prof.roundEndTicks + prof.intermissionTicks + 60 * cap) + prof.podiumTicks
  const limit = 2 * expected

  const net = new NetSim(c.peers, { seed: c.seed, rttMs: c.rttMs, jitterMs: c.jitterMs, loss: c.loss })
  const peers: NetMatch[] = []
  try {
    const pilots: Pilot[] = []
    const logs: ConfirmedHashLog[] = []
    for (let k = 0; k < c.peers; k++) {
      peers.push(createNetMatch(R, { setup, localPeer: k, humanPeers: c.peers }, net.transport(k), { cpuMs: () => performance.now() }))
      pilots.push(new Pilot(k, c.seed))
      logs.push(new ConfirmedHashLog())
    }
    const meter = new DisplayJumpMeter(8)
    const cost = new CostStats()
    let maxDelay = 0
    const t0 = performance.now()
    let n = 0
    for (;;) {
      if (n >= limit) refuse('netsim', `case ${c.label}`, `match not done after ${n} frames; check stalls/desyncs (stats)`)
      n++
      net.advance(1000 / 60)
      for (let k = 0; k < c.peers; k++) {
        const m = peers[k]
        const pilot = pilots[k]
        m.frame(1 / 60, out => { pilot.sample(m.sim, out[0]) })
        cost.add(m.session.stats.lastFrameSimMs)
        logs[k].record(m.session)
        if (m.session.stats.delay > maxDelay) maxDelay = m.session.stats.delay
      }
      meter.sample(peers[0].sim, peers[0].session.smoother)
      if (peers.every(m => m.done)) break
    }
    const wallMs = performance.now() - t0
    const cmp = compareHashLogs(logs)
    const jsons = peers.map(m => matchLogJson(m.log()))
    let rollbacks = 0, maxRollback = 0, resimTicks = 0, stalls = 0
    for (const m of peers) {
      const s = m.session.stats
      rollbacks += s.rollbacks
      maxRollback = Math.max(maxRollback, s.maxRollback)
      resimTicks += s.resimTicks
      stalls += s.stallFrames
    }
    const ticks = peers[0].sim.tick
    return {
      label: c.label, ticksCompared: cmp.ticksCompared, mismatches: cmp.mismatches, firstMismatch: cmp.firstMismatch,
      winners: peers.map(m => m.log().winner), logsEqual: jsons.every(j => j === jsons[0]),
      frameMsMean: cost.mean(), frameMsP99: cost.p99(), frameMsMax: cost.max(),
      rollbacks, maxRollback, resimTicks, resimPerTick: resimTicks / (ticks * c.peers),
      maxDelay, maxDisplayJump: meter.maxJump, visibleSnaps: meter.visibleSnaps, stalls, ticks, wallMs,
    }
  } finally {
    for (const m of peers) m.dispose()
  }
}
