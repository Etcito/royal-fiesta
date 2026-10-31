// Headless round runner: one process loads courses and zones, splits the seats over loopback peers,
// drives every seat with the mode bots and reports the settled rounds.
import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { MAX_PEERS } from '@gamesaloon/rollback/zones'
import type { Roster } from '@gamesaloon/rollback/zones'
import { modeBotInput, newModeBotMemory } from '@royal-fiesta/game/net/modeBots'
import type { ModeBotMemory } from '@royal-fiesta/game/net/modeBots'
import { createZoneFullMatch } from '@royal-fiesta/game/net/zoneFullMatch'
import type { ZoneFullMatch, ZoneFullRound } from '@royal-fiesta/game/net/zoneFullMatch'
import { ZoneLoopback } from '@royal-fiesta/game/net/zoneLoopback'
import { sameRoundResult, showMaps } from '@royal-fiesta/game/net/zoneRounds'
import type { ZoneRoundResult } from '@royal-fiesta/game/net/zoneRounds'
import { parseSeason } from '@royal-fiesta/game/season'
import type { SeasonData } from '@royal-fiesta/game/season'
import { levelOf } from '@royal-fiesta/sim/course'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import { roundTicks } from '@royal-fiesta/sim/match/rules'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { DEFAULT_PLAN, newCursor, nextSlot, nextTarget } from '@royal-fiesta/sim/season/plan'
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadCourseV1File } from './contentFiles.ts'
import { readRepoText, repoPath } from './files.ts'

export interface RoundRunOptions {
  course: string
  dir: string
  seats: number
  peers: number
  profile: 'season' | 'sprint'
  target?: number
  show?: boolean
  seed?: number
}

export interface RoundRunReport {
  ok: boolean
  problems: string[]
  rounds: ZoneRoundResult[]
  champion: number
}

interface RoundMeta {
  readonly target: number
  readonly teams: readonly number[] | null
  readonly seatOf: readonly number[]
}

const COURSE_SUFFIX = '.course.json'
const ZONES_SUFFIX = '.zones.json'
const MAX_SEATS_PER_PEER = 4
const EXTRA_TICKS = 60 * 60
const SETTLE_TICKS = 1200
const DT = 1 / 60
const BOT_MEASUREMENTS = { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 }
const PROFILE_NAMES: Readonly<Record<RoundRunOptions['profile'], ProfileName>> = { season: 'standard', sprint: 'sprint' }

let rapier: Promise<RapierModule> | null = null

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

async function listNames(dir: string, suffix: string): Promise<string[]> {
  const entries = await readdir(repoPath(dir), { withFileTypes: true })
    .catch(() => refuse('round-run', '--dir', `cannot list '${dir}'; pass a course folder such as courses or fixtures/test-courses`))
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(suffix))
    .map(entry => entry.name.slice(0, -suffix.length)).sort(byCodeUnit)
}

function zonesReader(dir: string): (rel: string) => Promise<string> {
  return rel => readRepoText(rel.startsWith('courses/') ? `${dir}/${rel.slice('courses/'.length)}` : rel)
}

async function loadCourse(dir: string, id: string): Promise<{ sim: ResolvedCourse; zones: ZonesFile } | null> {
  const course = await loadCourseV1File(`${dir}/${id}${COURSE_SUFFIX}`)
  const sim = course.sim
  if (sim === null) return null
  const zones = await loadZonesFile(sim.id, sim, zonesReader(dir))
  return { sim, zones }
}

async function readSeason(): Promise<SeasonData> {
  const rel = 'courses/season.json'
  const text = await readRepoText(rel)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    refuse('round-run', rel, 'is not valid JSON; fix the season file syntax')
  }
  return parseSeason(json, rel)
}

function defaultTarget(kind: RoundKind, seats: number): number {
  if (kind === 'team') return Math.max(1, Math.floor(seats / 2))
  if (kind === 'final') return 1
  return nextTarget(seats, DEFAULT_PLAN[0], DEFAULT_PLAN[1])
}

function probeSeason(courses: readonly ResolvedCourse[], plan: readonly number[], seats: number): SchedMap[] {
  const maps = showMaps(courses)
  const slot = nextSlot(newCursor(plan, seats))
  if (slot === null || slot.final) return maps
  return maps.map(map => map.finalRule === null ? map : { ...map, finalRule: null })
}

function maxEndTick(sim: ResolvedCourse, profile: ProfileName): number {
  const p = PROFILES[profile]
  return p.introTicks + Math.min(levelOf(sim).timeCapTicks, roundTicks(sim, p)) + levelOf(sim).overtimeTicks + EXTRA_TICKS
}

function quotaProblem(meta: RoundMeta | undefined, result: ZoneRoundResult): string | null {
  if (!meta) return `round ${result.index}: no plan was recorded for the round`
  switch (result.kind) {
    case 'race':
      return result.qualified.length === meta.target ? null
        : `round ${result.index}: race qualified ${result.qualified.length} of target ${meta.target}`
    case 'survival':
      if (result.reason === 'overtime') {
        return result.qualified.length >= 1 ? null : `round ${result.index}: nobody survived to the cap`
      }
      return result.qualified.length >= 1 && result.qualified.length <= meta.target ? null
        : `round ${result.index}: survival qualified ${result.qualified.length} of target ${meta.target}`
    case 'team': {
      if (meta.teams === null) return `round ${result.index}: team round has no teams`
      const teamOf = new Map<number, number>()
      meta.seatOf.forEach((roomSeat, roundSeat) => teamOf.set(roomSeat, meta.teams![roundSeat]))
      const sizes = new Map<number, number>()
      for (const team of meta.teams) sizes.set(team, (sizes.get(team) ?? 0) + 1)
      const teams = new Set(result.qualified.map(seat => teamOf.get(seat)))
      if (teams.size !== 1) return `round ${result.index}: team qualifiers are not one team`
      const team = [...teams][0]
      const size = team === undefined ? 0 : sizes.get(team) ?? 0
      return result.qualified.length === size ? null
        : `round ${result.index}: team qualified ${result.qualified.length} of ${size}`
    }
    case 'final':
      return result.qualified.length === 1 ? null : `round ${result.index}: final qualified ${result.qualified.length} of 1`
    default:
      return result.qualified.length === meta.target ? null
        : `round ${result.index}: ${result.kind} qualified ${result.qualified.length} of target ${meta.target}`
  }
}

export async function runRound(o: RoundRunOptions): Promise<RoundRunReport> {
  if (typeof o.course !== 'string' || o.course.length === 0) {
    refuse('round-run', '--course', 'missing course id; pass --course <id>')
  }
  if (!Number.isInteger(o.seats) || o.seats < 1) {
    refuse('round-run', '--seats', `${o.seats} is not a positive integer; pass the seat count`)
  }
  if (!Number.isInteger(o.peers) || o.peers < 1) {
    refuse('round-run', '--peers', `${o.peers} is not a positive integer; pass the peer count`)
  }
  if (o.profile !== 'season' && o.profile !== 'sprint') {
    refuse('round-run', '--profile', `'${String(o.profile)}' is not season or sprint; pass --profile season|sprint`)
  }
  if (o.target !== undefined && (!Number.isInteger(o.target) || o.target < 1)) {
    refuse('round-run', '--target', `${o.target} is not a positive integer; pass the round target`)
  }
  if (o.seed !== undefined && (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff)) {
    refuse('round-run', '--seed', `${o.seed} is not a u32; pass the match seed`)
  }
  const seatCount = o.seats
  const peerCount = Math.max(o.peers, Math.ceil(seatCount / MAX_SEATS_PER_PEER))
  if (peerCount > seatCount) {
    refuse('round-run', '--peers', `${peerCount} peers for ${seatCount} seats would leave a peer with no seat`)
  }
  if (peerCount > MAX_PEERS) {
    refuse('round-run', '--peers', `${peerCount} peers exceed the ${MAX_PEERS} transport limit`)
  }
  const profileName = PROFILE_NAMES[o.profile]
  const seed = o.seed ?? 1
  const single = o.show !== true

  const ids = await listNames(o.dir, COURSE_SUFFIX)
  const seasonData = o.dir === 'courses' ? await readSeason() : null
  const sims: ResolvedCourse[] = []
  const zones = new Map<string, ZonesFile>()
  if (single) {
    if (!ids.includes(o.course)) {
      refuse('round-run', '--course', `'${o.course}' has no ${o.course}${COURSE_SUFFIX} in '${o.dir}'; use one of: ${ids.join(', ') || '(none)'}`)
    }
    const loaded = await loadCourse(o.dir, o.course)
    if (loaded === null) {
      refuse('round-run', `${o.dir}/${o.course}${COURSE_SUFFIX}`, 'has no playable sim course; pick a race, survival or team course')
    }
    sims.push(loaded.sim)
    zones.set(loaded.sim.id, loaded.zones)
  } else {
    const withZones = new Set(await listNames(o.dir, ZONES_SUFFIX))
    for (const id of ids) {
      if (!withZones.has(id)) continue
      const loaded = await loadCourse(o.dir, id)
      if (loaded === null) continue
      sims.push(loaded.sim)
      zones.set(loaded.sim.id, loaded.zones)
    }
    if (sims.length === 0) {
      refuse('round-run', '--dir', `no course with a zones file in '${o.dir}'; add a sidecar or pass another --dir`)
    }
  }

  const kind = levelOf(sims[0]).kind
  if (single && kind === 'team' && seatCount % 2 !== 0) {
    refuse('round-run', '--seats', `a team round needs an even seat count; ${seatCount} is odd`)
  }
  const singlePlan: readonly number[] = [seatCount, o.target ?? defaultTarget(kind, seatCount)]
  const plan: readonly number[] | undefined = single ? singlePlan : undefined
  const maps: SchedMap[] = single ? probeSeason(sims, singlePlan, seatCount) : showMaps(sims, seasonData)
  if (!single) {
    const index = sims.findIndex(sim => sim.id === o.course)
    if (index < 0 || !maps.some(map => map.course === index)) {
      refuse('round-run', '--course', `'${o.course}' is not one of the show maps; use one of: ${maps.map(map => sims[map.course].id).join(', ') || '(none)'}`)
    }
  }

  const peers = Array.from({ length: peerCount }, (_, peer) => ({ peer, seats: [] as number[] }))
  for (let seat = 0; seat < seatCount; seat++) peers[seat % peerCount].seats.push(seat)
  const roster: Roster = { seatCount, peers, live: peers.map(() => true) }
  const measurements: Record<number, typeof BOT_MEASUREMENTS> = {}
  for (const peer of peers) measurements[peer.peer] = { ...BOT_MEASUREMENTS }

  rapier ??= initRapier()
  const R = await rapier
  const loopback = new ZoneLoopback(peerCount, { seed, rttMs: 40, jitterMs: 0, loss: 0 })
  const memories: ModeBotMemory[] = Array.from({ length: seatCount }, () => newModeBotMemory())
  const sampleTicks = peers.map(() => 0)
  const checked = new Set<string>()
  const metas = new Map<number, RoundMeta>()
  const problems: string[] = []

  function sampleFor(peer: number): (round: ZoneFullRound, out: PlayerInput[]) => void {
    return (round, out) => {
      const index = round.plan.index
      if (!metas.has(index)) {
        metas.set(index, {
          target: round.plan.target,
          teams: round.plan.teams === null ? null : Array.from(round.plan.teams),
          seatOf: [...round.seatOf],
        })
      }
      const domains = round.match.domains
      for (let i = 0; i < round.localSeats.length; i++) {
        const seat = round.localSeats[i]
        const domain = domains.find(candidate => candidate.seats.indexOf(seat) >= 0)
        if (domain === undefined) {
          decodeInput(NEUTRAL_CODE, out[i])
          continue
        }
        const key = `${peer}:${index}:${seat}`
        if (!checked.has(key)) {
          checked.add(key)
          if (domain.status(seat) !== PlayerStatus.alive) {
            problems.push(`round ${index}: seat ${round.seatOf[seat]} is not alive at intro`)
          }
        }
        modeBotInput(domain, memories[round.seatOf[seat]], seat, sampleTicks[peer], out[i])
      }
      sampleTicks[peer]++
    }
  }

  const samples = peers.map((_, peer) => sampleFor(peer))
  const fulls: ZoneFullMatch[] = []
  let printed = 0

  function roundProblems(index: number): string[] {
    return problems.filter(problem => problem.startsWith(`round ${index}:`))
  }

  function checkRound(index: number): void {
    const results = fulls.map(full => full.report.rounds[index])
    if (results.some(result => result === undefined)) return
    const first = results[0]
    for (let peer = 1; peer < results.length; peer++) {
      if (!sameRoundResult(first, results[peer])) {
        problems.push(`round ${index}: peer ${peer} settled a different result`)
      }
    }
    const meta = metas.get(index)
    if (meta === undefined) {
      problems.push(`round ${index}: no plan was recorded for the round`)
    } else {
      if (single || first.reason !== 'playoff') {
        const quota = quotaProblem(meta, first)
        if (quota !== null) problems.push(quota)
      }
      const sim = sims.find(candidate => candidate.id === first.course)
      if (sim === undefined) {
        problems.push(`round ${index}: course '${first.course}' was not loaded`)
      } else {
        const cap = maxEndTick(sim, profileName)
        if (first.endTick > cap) {
          problems.push(`round ${index}: ended at tick ${first.endTick}, after cap + overtime + 60 s (${cap})`)
        }
      }
      if (meta.seatOf.length !== first.ranking.length) {
        problems.push(`round ${index}: ${first.ranking.length} entrants for ${meta.seatOf.length} round seats`)
      }
    }
    const ok = roundProblems(index).length === 0
    console.log(`[round-run] course=${first.course} seats=${first.ranking.length} kind=${first.kind}` +
      ` target=${meta === undefined ? 0 : meta.target} reason=${first.reason}` +
      ` qualified=${first.qualified.length} eliminated=${first.eliminated.length} ${ok ? 'OK' : 'FAIL'}`)
  }

  const roundLimit = single
    ? maxEndTick(sims[0], profileName) + SETTLE_TICKS
    : (DEFAULT_PLAN.length + 2) * (Math.max(...sims.map(sim => maxEndTick(sim, profileName))) + SETTLE_TICKS)
  let frames = 0

  try {
    for (const peer of peers) {
      fulls.push(createZoneFullMatch(R, {
        localPeer: peer.peer, roster, seed, courses: sims, season: maps, plan, zones,
        profile: profileName, voteMs: 0, measurements,
      }, loopback.transport(peer.peer)))
    }
    for (; frames < roundLimit; frames++) {
      loopback.advance(DT * 1000)
      for (let peer = 0; peer < fulls.length; peer++) fulls[peer].frame(DT, samples[peer])
      let ready = Infinity
      for (const full of fulls) ready = Math.min(ready, full.report.rounds.length)
      while (printed < ready) {
        checkRound(printed)
        printed++
      }
      if (single) {
        if (fulls.every(full => full.report.rounds.length >= 1)) break
      } else if (fulls.every(full => full.done)) break
    }
    if (single && !fulls.every(full => full.report.rounds.length >= 1)) {
      problems.push(`round 0: did not settle within ${frames} frames; check the course, spawns and target`)
    }
    if (!single && !fulls.every(full => full.done)) {
      problems.push(`show: did not finish within ${frames} frames; check the season maps and targets`)
    }
  } finally {
    for (const full of fulls) full.dispose()
  }

  const rounds = fulls[0].report.rounds
  for (let peer = 0; peer < fulls.length; peer++) {
    const report = fulls[peer].report
    if (report.resultMismatches !== 0) {
      problems.push(`peer ${peer}: ${report.resultMismatches} result mismatches`)
    }
    if (report.rounds.length !== rounds.length) {
      problems.push(`peer ${peer}: ${report.rounds.length} rounds, expected ${rounds.length}`)
      continue
    }
    for (let index = 0; index < rounds.length; index++) {
      if (!sameRoundResult(rounds[index], report.rounds[index])) {
        problems.push(`peer ${peer}: round ${index} differs from peer 0`)
      }
    }
  }
  if (single && rounds.length !== 1) problems.push(`round-run: expected one round, got ${rounds.length}`)

  const last = rounds.length === 0 ? undefined : rounds[rounds.length - 1]
  const reported = fulls[0].report.champion
  let champion = -1
  if (reported !== null && reported >= 0) champion = reported
  else if (last !== undefined) {
    champion = last.champion >= 0 ? last.champion
      : last.qualified.length === 1 ? last.qualified[0]
        : last.ranking.length === 0 ? -1 : last.ranking[0]
  }
  return { ok: problems.length === 0, problems, rounds: [...rounds], champion }
}

const USAGE = 'usage: round:run --course <id> [--dir courses] [--seats 60] [--peers 2] [--profile season|sprint] [--target n] [--show] [--seed n]'

async function runCli(argv: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ options: {
      course: { type: 'string' },
      dir: { type: 'string', default: 'courses' },
      seats: { type: 'string', default: '60' },
      peers: { type: 'string', default: '2' },
      profile: { type: 'string', default: 'season' },
      target: { type: 'string' },
      show: { type: 'boolean', default: false },
      seed: { type: 'string' },
    } })
    if (values.course === undefined || values.course.length === 0) {
      refuse('cli', '--course', `required; ${USAGE}`)
    }
    const seats = Number(values.seats)
    if (!/^\d+$/.test(values.seats)) refuse('cli', '--seats', `'${values.seats}' is not a non-negative integer; ${USAGE}`)
    const peers = Number(values.peers)
    if (!/^\d+$/.test(values.peers)) refuse('cli', '--peers', `'${values.peers}' is not a non-negative integer; ${USAGE}`)
    if (values.target !== undefined && !/^\d+$/.test(values.target)) {
      refuse('cli', '--target', `'${values.target}' is not a non-negative integer; ${USAGE}`)
    }
    if (values.seed !== undefined && !/^\d+$/.test(values.seed)) {
      refuse('cli', '--seed', `'${values.seed}' is not a non-negative integer; ${USAGE}`)
    }
    if (values.profile !== 'season' && values.profile !== 'sprint') {
      refuse('cli', '--profile', `'${values.profile}' is not season or sprint; ${USAGE}`)
    }
    const report = await runRound({
      course: values.course, dir: values.dir, seats, peers, profile: values.profile,
      target: values.target === undefined ? undefined : Number(values.target),
      show: values.show, seed: values.seed === undefined ? undefined : Number(values.seed),
    })
    for (const problem of report.problems) console.error(`[round-run] ${problem}`)
    console.log(`[round-run] champion=${report.champion}`)
    return report.ok ? 0 : 1
  } catch (error) {
    if (!isRefusal(error)) throw error
    console.error(error.message)
    return 1
  }
}

function isMain(): boolean {
  const argv = process.argv[1]
  if (!argv) return false
  try {
    return realpathSync(path.resolve(argv)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) process.exitCode = await runCli(process.argv.slice(2))
