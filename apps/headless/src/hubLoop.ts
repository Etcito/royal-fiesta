// Headless hub loop: N piloted PlayFlows in one process against the local GameSaloon, at real time.
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import type { CourseEntry } from '@royal-fiesta/game/courseSet'
import { PlayFlow } from '@royal-fiesta/game/hub/flow'
import type { FlowEvent } from '@royal-fiesta/game/hub/flow'
import { compareHashLogs, ConfirmedHashLog } from '@royal-fiesta/game/net/metrics'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import { loadCourseFile, nodeFixtureResolver, readRepoText, repoPath } from './files.ts'
import type { LocalServer } from './gamesaloon.ts'
import { outDir } from './proofkit.ts'

export interface HubLoopResult {
  events: FlowEvent[]; clientsBackInHub: number; remoteSightings: number[]; remoteSightingsAfter: number[]
  matchHashes: { ticksCompared: number; mismatches: number }; winners: number[]; wallMs: number
}

const WALL_LIMIT_MS = 240_000
const AFTER_FRAMES = 240
const FRAME_MS = 1000 / 60
const now = () => performance.now()

let rapier: ReturnType<typeof initRapier> | null = null
let sprintCourses: Promise<ResolvedCourse[]> | null = null

// Same course load as realMatch.loadCourses: every course file in name order, picked for sprint.
function loadSprintCourses(): Promise<ResolvedCourse[]> {
  sprintCourses ??= (async () => {
    const names = (await readdir(repoPath('fixtures/courses'), { withFileTypes: true }))
      .filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name).sort()
    const entries: CourseEntry[] = []
    for (const n of names) {
      const path = `fixtures/courses/${n}`
      entries.push({ path, json: JSON.parse(await readRepoText(path)) })
    }
    return matchCourses(entries, nodeFixtureResolver(), 'sprint')
  })()
  return sprintCourses
}

// Distinct centimetre (x, z) keys per remote seat, for non-stale remotes only.
type Sightings = Map<number, Set<string>>

function sight(flow: PlayFlow, seen: Sightings, t: number): void {
  for (const r of flow.remotes(t)) {
    if (r.stale) continue
    let s = seen.get(r.seat)
    if (!s) seen.set(r.seat, s = new Set())
    s.add(`${Math.round(r.pos.x * 100)},${Math.round(r.pos.z * 100)}`)
  }
}

// Min over the other N-1 seats; a seat never seen counts as 0.
function minSeen(seen: Sightings, others: number): number {
  if (seen.size < others) return 0
  let min = Infinity
  for (const s of seen.values()) min = Math.min(min, s.size)
  return min
}

export async function runHubLoop(server: LocalServer, clients: number): Promise<HubLoopResult> {
  if (!Number.isInteger(clients) || clients < 2 || clients > 4) {
    refuse('hubloop', 'clients', `${clients} is outside 2..4; a hub loop holds 2 to 4 clients on one relay room`)
  }
  const n = clients as 2 | 3 | 4
  const events: FlowEvent[] = []
  const flows: PlayFlow[] = []
  try {
    rapier ??= initRapier()
    const R = await rapier
    const courses = await loadSprintCourses()
    const plaza = await loadCourseFile('fixtures/courses/hub-plaza.course.json')
    const ws = globalWsFactory()
    const queued: boolean[] = []
    const returning: boolean[] = []
    const back: boolean[] = []
    const logs: ConfirmedHashLog[] = []
    const inMatch: boolean[] = []
    const before: Sightings[] = []
    const after: Sightings[] = []
    const spawn = (hubCode: string) => {
      const k = flows.length
      queued.push(false); returning.push(false); back.push(false); inMatch.push(false)
      logs.push(new ConfirmedHashLog()); before.push(new Map()); after.push(new Map())
      const flow = new PlayFlow({
        R, relayUrl: server.url, ws, hubCode, name: `bot${k}`, colour: k, courses, plaza, partySize: n, now, pilot: true,
        log: ev => {
          events.push(ev)
          if (ev.state === 'queued') queued[k] = true
          if (ev.state === 'returning') returning[k] = true
          if (ev.state === 'hub' && returning[k]) back[k] = true
        },
      })
      flows.push(flow)
      void flow.start()
    }
    spawn('new')
    const t0 = now()
    let last = t0
    let next = t0 + FRAME_MS
    let afterFrames = -1
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, next - now())))
      const t = now()
      for (let k = 0; k < flows.length; k++) {
        if (flows[k].state !== 'failed') continue
        const ev = events.filter(e => e.client === `bot${k}` && e.state === 'failed').pop()
        refuse('hubloop', `bot${k}`, `flow failed: ${ev?.detail.message ?? 'no message logged'}`)
      }
      if (t - t0 > WALL_LIMIT_MS) {
        const states = flows.map((f, k) => `bot${k}=${f.state}`).join(' ')
        refuse('hubloop', 'wall', `loop not done after ${Math.round(t - t0)} ms (limit ${WALL_LIMIT_MS} ms): ${states}; check the relay and the flows`)
      }
      const code = flows[0].hubCode
      const tail = flows[flows.length - 1]
      if (code !== null && flows.length < n && tail.state !== 'connecting') spawn(code)
      const dt = Math.min(0.25, (t - last) / 1000)
      last = t
      for (const f of flows) f.frame(dt, null, 0)
      const ms = now()
      for (let k = 0; k < flows.length; k++) {
        const m = flows[k].match
        if (m !== null) {
          // A new match starts a fresh log; the last match's log is kept after it ends.
          if (!inMatch[k]) logs[k] = new ConfirmedHashLog()
          inMatch[k] = true
          logs[k].record(m.session)
        } else inMatch[k] = false
        if (!queued[k]) sight(flows[k], before[k], ms)
        if (afterFrames >= 0) sight(flows[k], after[k], ms)
      }
      if (afterFrames < 0 && flows.length === n && back.every(b => b)) afterFrames = 0
      else if (afterFrames >= 0 && ++afterFrames >= AFTER_FRAMES) break
      next = Math.max(next + FRAME_MS, now())
    }
    const wallMs = now() - t0
    const cmp = compareHashLogs(logs)
    return {
      events,
      clientsBackInHub: back.filter(b => b).length,
      remoteSightings: before.map(s => minSeen(s, n - 1)),
      remoteSightingsAfter: after.map(s => minSeen(s, n - 1)),
      matchHashes: { ticksCompared: cmp.ticksCompared, mismatches: cmp.mismatches },
      winners: flows.map(f => f.lastLog?.winner ?? -1),
      wallMs,
    }
  } finally {
    try {
      for (const f of flows) f.close()
    } finally {
      const lines = events.map(e => JSON.stringify(e)).join('\n')
      await writeFile(join(outDir('m8'), 'loop-log.jsonl'), lines.length > 0 ? lines + '\n' : '')
    }
  }
}
