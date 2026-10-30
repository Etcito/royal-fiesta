// Headless zone peer: 1-4 local seats driven by the course-following takeover bot over a relay or loopback.
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
import { createZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import { globalZoneWsFactory, ZoneRelayClient } from '@royal-fiesta/game/net/zoneRelayClient'
import type { ZoneQueuePayload } from '@royal-fiesta/game/net/zoneRelayProtocol'
import { ZoneRelayTransport } from '@royal-fiesta/game/net/zoneRelayTransport'
import { mergeZoneTuning } from '@royal-fiesta/game/net/zoneTuning'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { nodeFixtureResolver, readRepoText, repoPath } from './files.ts'

export interface ZoneBotMeasurements {
  cpuMs: number
  bandwidthKbps: number
  latencyMs: number
  spareSlots: number
}

export interface ZoneBotRelayNet {
  url: string
  players: number
}

export interface ZoneBotLocalNet {
  transport: GroupTransport
  roster: Roster
  localPeer: number
  measurements: Readonly<Record<number, ZoneBotMeasurements>>
}

export interface ZoneBotOptions {
  course: string
  name: string
  seats: number
  seconds: number
  drive: 'timer' | 'manual'
  signal?: AbortSignal
  net: ZoneBotRelayNet | ZoneBotLocalNet
  /** Receives the FAR rows of the seats outside the local domains, as the browser scene does. */
  farSink?: FarSink
}

export interface ZoneBot {
  frame(dtS: number): void
  readonly match: ZoneMatch
  readonly localPeer: number
  readonly seats: readonly number[]
  stop(): void
  readonly done: Promise<void>
}

const PROFILE: ProfileName = 'sprint'
const COURSES_DIR = 'fixtures/courses'
const BOT_MEASUREMENTS: ZoneBotMeasurements = { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 }

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
    refuse('zone', 'zoneBot.course', `'${id}' is not a ${PROFILE} match course; use one of: ${courses.map(course => course.id).join(', ')}`)
  }
  return found
}

function checkOptions(options: ZoneBotOptions): void {
  if (typeof options.course !== 'string' || options.course.length === 0) {
    refuse('zone', 'zoneBot.course', 'missing course id; pass one of the sprint match courses')
  }
  if (typeof options.name !== 'string' || options.name.length === 0) {
    refuse('zone', 'zoneBot.name', 'missing name; pass a bot name')
  }
  if (!Number.isInteger(options.seats) || options.seats < 1 || options.seats > 4) {
    refuse('zone', 'zoneBot.seats', `${options.seats} is outside 1..4; pass the local seats of one peer`)
  }
  if (!Number.isFinite(options.seconds) || options.seconds < 0) {
    refuse('zone', 'zoneBot.seconds', `${options.seconds} is not a non-negative number; pass the seconds to play`)
  }
  if (options.drive !== 'timer' && options.drive !== 'manual') {
    refuse('zone', 'zoneBot.drive', `'${String(options.drive)}' is not timer or manual; pick the loop owner`)
  }
  if ('url' in options.net) {
    if (typeof options.net.url !== 'string' || options.net.url.length === 0) {
      refuse('relay', 'zoneBot.net.url', 'missing relay websocket url; pass ws://host:port/ws')
    }
    if (!Number.isInteger(options.net.players) || options.net.players < 2 || options.net.players > 64) {
      refuse('relay', 'zoneBot.net.players', `${options.net.players} is outside 2..64; pass the zone peer count`)
    }
  } else {
    if (!options.net.transport) refuse('zone', 'zoneBot.net.transport', 'missing transport; pass a GroupTransport')
    if (!options.net.roster) refuse('zone', 'zoneBot.net.roster', 'missing roster; pass the match roster')
    if (!options.net.measurements) refuse('zone', 'zoneBot.net.measurements', 'missing measurements; pass peer measurements')
  }
}

function queuePayload(options: ZoneBotOptions, course: ResolvedCourse, zones: ZonesFile): ZoneQueuePayload {
  const tuning = mergeZoneTuning(zones)
  return {
    g: 'royal-fiesta',
    v: 1,
    zones: 1,
    name: options.name,
    seats: options.seats,
    course: course.id,
    tuning: tuningHash(tuning),
    m: { ...BOT_MEASUREMENTS },
  }
}

export async function runZoneBot(options: ZoneBotOptions): Promise<ZoneBot> {
  checkOptions(options)
  options.signal?.throwIfAborted()
  const R = await rapierModule()
  const course = pickCourse(await sprintCourses(), options.course)
  const zones = await loadZonesFile(course.id, course, readRepoText)
  options.signal?.throwIfAborted()
  const kind = course.kind === 'survival' ? 'survival' : 'race'

  let client: ZoneRelayClient | null = null
  let relayTransport: ZoneRelayTransport | null = null
  let transport: GroupTransport
  let roster: Roster
  let localPeer: number
  let measurements: Readonly<Record<number, ZoneBotMeasurements>>
  const cancel = (): void => { client?.close() }
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    if ('url' in options.net) {
      client = new ZoneRelayClient(options.net.url, globalZoneWsFactory())
      await client.connect()
      options.signal?.throwIfAborted()
      await client.queue(options.net.players, queuePayload(options, course, zones))
      options.signal?.throwIfAborted()
      const room = client.room()
      roster = room.roster
      localPeer = room.localPeer
      measurements = room.measurements
      relayTransport = new ZoneRelayTransport(client, localPeer, options.net.players, () => performance.now())
      transport = relayTransport
    } else {
      roster = options.net.roster
      localPeer = options.net.localPeer
      measurements = options.net.measurements
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
    refuse('zone', 'zoneBot.localPeer', `${localPeer} is not in the roster; pass the local peer's seats`)
  }
  const seats = owner.seats.slice()

  const match = createZoneMatch(R, {
    localPeer,
    roster,
    course,
    zones,
    profile: PROFILES.sprint,
    kind,
    measurements,
    farSink: options.farSink,
  }, transport)

  const memories = seats.map(() => newMemory())
  let tick = 0
  function sample(out: PlayerInput[]): void {
    const domains = match.domains
    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i]
      const domain = domains.find(candidate => candidate.seats.indexOf(seat) >= 0)
      if (domain === undefined) decodeInput(NEUTRAL_CODE, out[i])
      else takeoverInput(course, memories[i], domain.state(seat), tick, out[i])
    }
    tick++
  }

  let stopped = false
  let playedS = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let resolveDone: () => void = () => {}
  const done = new Promise<void>(resolve => { resolveDone = resolve })

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
    match.dispose()
    resolveDone()
  }

  function frame(dtS: number): void {
    if (stopped) return
    if (!Number.isFinite(dtS) || dtS < 0) {
      refuse('zone', 'zoneBot.frame.dtS', `${dtS} is not a non-negative number; pass the frame time in seconds`)
    }
    match.frame(dtS, sample)
    if (relayTransport !== null) relayTransport.flush()
    playedS += dtS
    if (playedS >= options.seconds) stop()
  }

  if (client !== null) client.onClose(() => stop())

  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.seconds <= 0 || options.signal?.aborted) stop()
  else if (options.drive === 'timer') {
    let last = performance.now()
    timer = setInterval(() => {
      const now = performance.now()
      const dtS = Math.min(0.25, (now - last) / 1000)
      last = now
      frame(dtS)
    }, 1000 / 60)
  }

  return { frame, match, localPeer, seats, stop, done }
}

const USAGE = 'usage: zoneBot --relay <ws url> --players <n> --seats <1..4> --course <id> --name <s> --seconds <n>'
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
  const secondsText = get('--seconds')
  if (!/^\d+(?:\.\d+)?$/.test(secondsText)) refuse('cli', '--seconds', `'${secondsText}' is not a non-negative number; ${USAGE}`)
  const name = get('--name')
  if (name.length === 0) refuse('cli', '--name', `empty; ${USAGE}`)
  return { relay, players, seats, course: get('--course'), name, seconds: Number(secondsText) }
}

async function runCli(argv: string[]): Promise<number> {
  let bot: ZoneBot | null = null
  const controller = new AbortController()
  const stop = (): void => { controller.abort(); bot?.stop() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    const args = parseCli(argv)
    bot = await runZoneBot({
      course: args.course,
      name: args.name,
      seats: args.seats,
      seconds: args.seconds,
      drive: 'timer',
      signal: controller.signal,
      net: { url: args.relay, players: args.players },
    })
    console.log(`[zone-bot ${args.name}] matched peer ${bot.localPeer} of ${args.players}, seats ${bot.seats.join(',')}`)
    const botRef = bot
    const report = setInterval(() => {
      console.log(`[zone-bot ${args.name}] tick ${botRef.match.stats.tick} domains ${botRef.match.domains.length}`)
    }, 5000)
    try {
      await botRef.done
    } finally {
      clearInterval(report)
      botRef.stop()
    }
    return 0
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
