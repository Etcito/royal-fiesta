// Headless full-match zone peer: 1-4 local seats driven by the course-following takeover bot over a relay or loopback.
import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { tuningHash } from '@gamesaloon/rollback/zones'
import type { FarSink, GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import type { CourseEntry } from '@royal-fiesta/game/courseSet'
import { takeoverInput } from '@royal-fiesta/game/net/takeoverBot'
import { createZoneFullMatch } from '@royal-fiesta/game/net/zoneFullMatch'
import type { ZoneFullMatch, ZoneFullRound } from '@royal-fiesta/game/net/zoneFullMatch'
import { globalZoneWsFactory, ZoneRelayClient } from '@royal-fiesta/game/net/zoneRelayClient'
import type { ZoneQueuePayload } from '@royal-fiesta/game/net/zoneRelayProtocol'
import { ZoneRelayTransport } from '@royal-fiesta/game/net/zoneRelayTransport'
import { mergeZoneTuning } from '@royal-fiesta/game/net/zoneTuning'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import type { BrainMemory } from '@royal-fiesta/sim/bots/brain'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { coursePool } from '@royal-fiesta/sim/match/rules'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { nodeFixtureResolver, readRepoText, repoPath } from './files.ts'

export interface ZoneMatchBotMeasurements {
  cpuMs: number
  bandwidthKbps: number
  latencyMs: number
  spareSlots: number
}

export interface ZoneMatchBotRelayNet {
  url: string
  players: number
}

export interface ZoneMatchBotLocalNet {
  transport: GroupTransport
  roster: Roster
  localPeer: number
  measurements: Readonly<Record<number, ZoneMatchBotMeasurements>>
  /** Full-match seed of the room; every local peer must pass the same one. */
  seed?: number
}

export interface ZoneMatchBotOptions {
  /** Queue label of the room: every peer must pass the same one. */
  course: string
  name: string
  seats: number
  /** Whole-match deadline in seconds. */
  seconds: number
  drive: 'timer' | 'manual'
  signal?: AbortSignal
  net: ZoneMatchBotRelayNet | ZoneMatchBotLocalNet
  /** Receives the FAR rows of the seats outside the local domains, as the browser scene does. */
  farSink?: FarSink
}

export type ZoneMatchBotStopReason = 'running' | 'done' | 'deadline' | 'stopped' | 'closed'

export interface ZoneMatchBot {
  frame(dtS: number): void
  readonly full: ZoneFullMatch
  readonly localPeer: number
  readonly seats: readonly number[]
  readonly reason: ZoneMatchBotStopReason
  stop(): void
  readonly done: Promise<void>
}

const PROFILE: ProfileName = 'sprint'
const COURSES_DIR = 'fixtures/courses'
const BOT_MEASUREMENTS: ZoneMatchBotMeasurements = { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 }
const POST_DONE_MS = 2000

let rapier: Promise<RapierModule> | null = null
let courseLoad: Promise<ResolvedCourse[]> | null = null

function rapierModule(): Promise<RapierModule> {
  rapier ??= initRapier()
  return rapier
}

// Same entries and order as browserCourses: every course file by code-unit path order.
function sprintCourses(): Promise<ResolvedCourse[]> {
  courseLoad ??= (async () => {
    const names = (await readdir(repoPath(COURSES_DIR), { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.course.json'))
      .map(entry => entry.name)
      .sort()
    const entries: CourseEntry[] = []
    for (const name of names) {
      const rel = `${COURSES_DIR}/${name}`
      entries.push({ path: rel, json: JSON.parse(await readRepoText(rel)) as unknown })
    }
    return matchCourses(entries, nodeFixtureResolver(), PROFILE)
  })()
  return courseLoad
}

function pickCourse(courses: readonly ResolvedCourse[], id: string): ResolvedCourse {
  const found = courses.find(course => course.id === id)
  if (found === undefined) {
    refuse('zone', 'zoneMatchBot.course', `'${id}' is not a ${PROFILE} match course; use one of: ${courses.map(course => course.id).join(', ')}`)
  }
  return found
}

/** Loads every sprint course sidecar the full-match planner can pick. */
async function sprintZones(courses: readonly ResolvedCourse[]): Promise<Map<string, ZonesFile>> {
  const zones = new Map<string, ZonesFile>()
  const indices = [
    ...coursePool(courses, 'race', PROFILE),
    ...coursePool(courses, 'survival', PROFILE),
  ]
  for (const index of indices) {
    const course = courses[index]
    zones.set(course.id, await loadZonesFile(course.id, course, readRepoText))
  }
  return zones
}

function checkOptions(options: ZoneMatchBotOptions): void {
  if (typeof options.course !== 'string' || options.course.length === 0) {
    refuse('zone', 'zoneMatchBot.course', 'missing course id; pass one of the sprint match courses')
  }
  if (typeof options.name !== 'string' || options.name.length === 0) {
    refuse('zone', 'zoneMatchBot.name', 'missing name; pass a bot name')
  }
  if (!Number.isInteger(options.seats) || options.seats < 1 || options.seats > 4) {
    refuse('zone', 'zoneMatchBot.seats', `${options.seats} is outside 1..4; pass the local seats of one peer`)
  }
  if (!Number.isFinite(options.seconds) || options.seconds < 0) {
    refuse('zone', 'zoneMatchBot.seconds', `${options.seconds} is not a non-negative number; pass the whole-match deadline in seconds`)
  }
  if (options.drive !== 'timer' && options.drive !== 'manual') {
    refuse('zone', 'zoneMatchBot.drive', `'${String(options.drive)}' is not timer or manual; pick the loop owner`)
  }
  if ('url' in options.net) {
    if (typeof options.net.url !== 'string' || options.net.url.length === 0) {
      refuse('relay', 'zoneMatchBot.net.url', 'missing relay websocket url; pass ws://host:port/ws')
    }
    if (!Number.isInteger(options.net.players) || options.net.players < 2 || options.net.players > 64) {
      refuse('relay', 'zoneMatchBot.net.players', `${options.net.players} is outside 2..64; pass the zone peer count`)
    }
  } else {
    if (!options.net.transport) refuse('zone', 'zoneMatchBot.net.transport', 'missing transport; pass a GroupTransport')
    if (!options.net.roster) refuse('zone', 'zoneMatchBot.net.roster', 'missing roster; pass the match roster')
    if (!options.net.measurements) refuse('zone', 'zoneMatchBot.net.measurements', 'missing measurements; pass peer measurements')
  }
}

function queuePayload(options: ZoneMatchBotOptions, label: ResolvedCourse, zones: ZonesFile): ZoneQueuePayload {
  const tuning = mergeZoneTuning(zones)
  return {
    g: 'royal-fiesta',
    v: 1,
    zones: 1,
    name: options.name,
    seats: options.seats,
    course: label.id,
    tuning: tuningHash(tuning),
    m: { ...BOT_MEASUREMENTS },
  }
}

export async function runZoneMatchBot(options: ZoneMatchBotOptions): Promise<ZoneMatchBot> {
  checkOptions(options)
  options.signal?.throwIfAborted()
  const R = await rapierModule()
  const courses = await sprintCourses()
  const label = pickCourse(courses, options.course)
  const zones = await sprintZones(courses)
  const labelZones = zones.get(label.id)
  if (labelZones === undefined) {
    refuse('zones', 'zoneMatchBot.zones', `missing sidecar for ${label.id}; load a sidecar for every sprint course`)
  }
  options.signal?.throwIfAborted()

  let client: ZoneRelayClient | null = null
  let relayTransport: ZoneRelayTransport | null = null
  let transport: GroupTransport
  let roster: Roster
  let localPeer: number
  let measurements: Readonly<Record<number, ZoneMatchBotMeasurements>>
  let seed = 0
  const cancel = (): void => { client?.close() }
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    if ('url' in options.net) {
      client = new ZoneRelayClient(options.net.url, globalZoneWsFactory())
      await client.connect()
      options.signal?.throwIfAborted()
      await client.queue(options.net.players, queuePayload(options, label, labelZones))
      options.signal?.throwIfAborted()
      const room = client.room()
      roster = room.roster
      localPeer = room.localPeer
      measurements = room.measurements
      seed = room.seed
      relayTransport = new ZoneRelayTransport(client, localPeer, options.net.players, () => performance.now())
      transport = relayTransport
    } else {
      roster = options.net.roster
      localPeer = options.net.localPeer
      measurements = options.net.measurements
      seed = options.net.seed ?? 0
      transport = options.net.transport
    }
  } catch (error) {
    client?.close()
    options.signal?.throwIfAborted()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancel)
  }

  const owner = roster.peers.find(peer => peer.peer === localPeer)
  if (owner === undefined) {
    refuse('zone', 'zoneMatchBot.localPeer', `${localPeer} is not in the roster; pass the local peer's seats`)
  }
  const seats = owner.seats.slice()

  const full = createZoneFullMatch(R, {
    localPeer,
    roster,
    seed,
    courses,
    zones,
    measurements,
    farSink: options.farSink,
  }, transport)

  let memories: BrainMemory[] = []
  let roundIndex = -1
  let tick = 0
  let stopped = false
  let reason: ZoneMatchBotStopReason = 'running'
  let playedS = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let doneAt: number | null = null
  let reported = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>(resolve => { resolveDone = resolve })

  function noteRound(): void {
    const current = full.round
    if (current === null || current.plan.index === roundIndex) return
    roundIndex = current.plan.index
    // One brain per room seat, fresh for every round.
    memories = Array.from({ length: roster.seatCount }, () => newMemory())
    console.log(`[zone-match ${options.name}] round ${current.plan.index} ${current.plan.kind} ${current.plan.course.id} peers ${current.roster.peers.length}`)
  }

  function sample(round: ZoneFullRound, out: PlayerInput[]): void {
    const domains = round.match.domains
    for (let i = 0; i < round.localSeats.length; i++) {
      const roundSeat = round.localSeats[i]
      const memory = memories[round.seatOf[roundSeat]]
      const domain = domains.find(candidate => candidate.seats.indexOf(roundSeat) >= 0)
      if (domain === undefined || memory === undefined) decodeInput(NEUTRAL_CODE, out[i])
      else takeoverInput(round.plan.course, memory, domain.state(roundSeat), tick, out[i])
    }
    tick++
  }

  function printReport(): void {
    if (reported) return
    reported = true
    const report = full.report
    const rounds = report.rounds.map(round => ({
      index: round.index,
      course: round.course,
      kind: round.kind,
      final: round.final,
      endTick: round.endTick,
      reason: round.reason,
      qualified: round.qualified,
      eliminated: round.eliminated,
    }))
    console.log(`[zone-match ${options.name}] ledger ` + JSON.stringify({ rounds, champion: report.champion }))
    console.log(`[zone-match ${options.name}] sessions desyncs=${report.desyncs} resultMismatches=${report.resultMismatches} malformed=${report.malformed}`)
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    options.signal?.removeEventListener('abort', stop)
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (client) {
      try { client.bye() } catch {}
      try { client.close() } catch {}
    }
    full.dispose()
    resolveDone()
  }

  function failDeadline(): void {
    const at = full.round?.plan.index ?? (roundIndex >= 0 ? roundIndex : 0)
    console.log(`[zone-match ${options.name}] not done after ${options.seconds} s at round ${at}`)
    reason = 'deadline'
    stop()
  }

  function frame(dtS: number): void {
    if (stopped) return
    if (!Number.isFinite(dtS) || dtS < 0) {
      refuse('zone', 'zoneMatchBot.frame.dtS', `${dtS} is not a non-negative number; pass the frame time in seconds`)
    }
    full.frame(dtS, sample)
    if (relayTransport !== null) relayTransport.flush()
    noteRound()
    playedS += dtS
    if (full.done) {
      reason = 'done'
      printReport()
      const now = performance.now()
      if (doneAt === null) doneAt = now
      else if (now - doneAt >= POST_DONE_MS) stop()
      return
    }
    if (playedS >= options.seconds) failDeadline()
  }

  noteRound()
  if (client !== null) client.onClose(() => {
    // The relay dropped this peer before the match ended: a failure, never a clean exit.
    if (!stopped && reason === 'running') {
      console.log(`[zone-match ${options.name}] relay socket closed mid-match (${client?.closeCause ?? 'no cause'})`)
      reason = 'closed'
    }
    stop()
  })

  options.signal?.addEventListener('abort', stop, { once: true })
  if (full.done) {
    // A room of one seat is already over, but the peer still frames the drain window.
    reason = 'done'
  } else if (options.seconds <= 0) failDeadline()
  else if (options.signal?.aborted) stop()
  else if (options.drive === 'timer') {
    let last = performance.now()
    timer = setInterval(() => {
      const now = performance.now()
      const dtS = Math.min(0.25, (now - last) / 1000)
      last = now
      frame(dtS)
    }, 1000 / 60)
  }

  return {
    frame,
    full,
    localPeer,
    seats,
    get reason() { return reason },
    stop,
    done,
  }
}

const USAGE = 'usage: zoneMatchBot --relay <ws url> --players <n> --seats <1..4> --course <id> --name <s> [--seconds <n>]'
const CLI_FLAGS = ['--relay', '--players', '--seats', '--course', '--name', '--seconds']

interface CliArgs {
  relay: string
  players: number
  seats: number
  course: string
  name: string
  seconds: number
}

function cliInt(flag: string, text: string): number {
  if (!/^\d+$/.test(text)) refuse('cli', flag, `'${text}' is not a non-negative integer; ${USAGE}`)
  return Number(text)
}

function parseCli(argv: string[]): CliArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!CLI_FLAGS.includes(flag)) refuse('cli', flag ?? '(none)', `unknown argument; ${USAGE}`)
    if (values.has(flag)) refuse('cli', flag, `given twice; ${USAGE}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) refuse('cli', flag, `missing value; ${USAGE}`)
    values.set(flag, value)
  }
  const get = (flag: string): string => {
    const value = values.get(flag)
    if (value === undefined) refuse('cli', flag, `required; ${USAGE}`)
    return value
  }
  const relay = get('--relay')
  const players = cliInt('--players', get('--players'))
  if (players < 2 || players > 64) refuse('cli', '--players', `${players} is outside 2..64; ${USAGE}`)
  const seats = cliInt('--seats', get('--seats'))
  if (seats < 1 || seats > 4) refuse('cli', '--seats', `${seats} is outside 1..4; ${USAGE}`)
  const secondsText = values.get('--seconds') ?? '1800'
  if (!/^\d+(?:\.\d+)?$/.test(secondsText)) refuse('cli', '--seconds', `'${secondsText}' is not a non-negative number; ${USAGE}`)
  const name = get('--name')
  if (name.length === 0) refuse('cli', '--name', `empty; ${USAGE}`)
  return { relay, players, seats, course: get('--course'), name, seconds: Number(secondsText) }
}

async function runCli(argv: string[]): Promise<number> {
  let bot: ZoneMatchBot | null = null
  const controller = new AbortController()
  const stop = (): void => { controller.abort(); bot?.stop() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    const args = parseCli(argv)
    bot = await runZoneMatchBot({
      course: args.course,
      name: args.name,
      seats: args.seats,
      seconds: args.seconds,
      drive: 'timer',
      signal: controller.signal,
      net: { url: args.relay, players: args.players },
    })
    console.log(`[zone-match ${args.name}] matched peer ${bot.localPeer} of ${args.players}, seats ${bot.seats.join(',')}`)
    await bot.done
    if (controller.signal.aborted) return 0
    if (bot.reason === 'deadline' || bot.reason === 'closed') return 1
    const report = bot.full.report
    return report.desyncs === 0 && report.resultMismatches === 0 ? 0 : 1
  } catch (error) {
    bot?.stop()
    if (controller.signal.aborted && error === controller.signal.reason) return 0
    if (!isRefusal(error)) throw error
    console.error(error.message)
    return 1
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
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
