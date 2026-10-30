// One browser peer in a relay zone room, with every local seat driven by a takeover bot.
import { initRapier } from '@gamesaloon/rollback-rapier'
import { tuningHash } from '@gamesaloon/rollback/zones'
import { takeoverInput } from '@royal-fiesta/game/net/takeoverBot'
import { createZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import { globalZoneWsFactory, ZoneRelayClient } from '@royal-fiesta/game/net/zoneRelayClient'
import type { ZoneQueuePayload } from '@royal-fiesta/game/net/zoneRelayProtocol'
import { ZoneRelayTransport } from '@royal-fiesta/game/net/zoneRelayTransport'
import { mergeZoneTuning } from '@royal-fiesta/game/net/zoneTuning'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { browserCourses } from '../client/sources.ts'
import { zoneContent } from './zoneContent.ts'
import { mountZoneNetScene } from './zoneNetScene.ts'
import type { ZoneNetScene } from './zoneNetScene.ts'

const ZONE_PREFIX = '../../../../'
const SIDECARS = import.meta.glob<string>('../../../../courses/*.zones.json', {
  query: '?raw', import: 'default', eager: true,
})
const sidecarText = new Map<string, string>()
for (const key of Object.keys(SIDECARS)) {
  if (key.startsWith(ZONE_PREFIX)) sidecarText.set(key.slice(ZONE_PREFIX.length), SIDECARS[key])
}

export interface ZoneLobbyOptions {
  canvas: HTMLCanvasElement
  width?: number
  height?: number
  relayUrl: string
  /** Machines in the room, 2..64. */
  players: number
  /** Seats owned by this browser, 1..4; all are driven by takeover bots. */
  localSeats: number
  courseId: string
  name: string
  queueTimeoutMs?: number
}

export interface ZoneLobby {
  frame(dtS: number): void
  render(): void
  ready(): Promise<void>
  capture(): Promise<Uint8Array | null>
  readonly info: {
    peers: number
    seats: number
    localPeer: number
    tick: number
    near: number
    far: number
  }
  dispose(): void
}

function checkOptions(options: ZoneLobbyOptions): number {
  let url: URL
  try { url = new URL(options.relayUrl) } catch {
    refuse('zone', 'mountZoneLobby.relayUrl', 'invalid relay URL; use ws:// or wss://')
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    refuse('zone', 'mountZoneLobby.relayUrl', 'invalid relay protocol; use ws:// or wss://')
  }
  if (!Number.isInteger(options.players) || options.players < 2 || options.players > 64) {
    refuse('zone', 'mountZoneLobby.players', 'room size must be 2..64; pass the number of peers')
  }
  if (!Number.isInteger(options.localSeats) || options.localSeats < 1 || options.localSeats > 4) {
    refuse('zone', 'mountZoneLobby.localSeats', 'local seats must be 1..4; pass this browser’s seat count')
  }
  const timeoutMs = options.queueTimeoutMs ?? 240000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    refuse('zone', 'mountZoneLobby.queueTimeoutMs', 'invalid timer duration; use 1..2147483647 ms')
  }
  return timeoutMs
}

async function loadCourse(id: string) {
  const courses = await browserCourses('sprint')
  const course = courses.find(candidate => candidate.id === id)
  if (course === undefined) {
    refuse('zone', 'mountZoneLobby.courseId', `'${id}' is unknown; use one of: ${courses.map(c => c.id).join(', ')}`)
  }
  const zones = await loadZonesFile(course.id, course, async path => {
    const text = sidecarText.get(path)
    if (text === undefined) refuse('zones', path, 'missing; add the sidecar (zone mode needs it, full-mesh mode does not)')
    return text
  })
  return { course, zones }
}

async function queueRoom(client: ZoneRelayClient, players: number, payload: ZoneQueuePayload, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        refuse('zone', 'mountZoneLobby.queue', `zone room of ${players} not filled after ${timeoutMs / 1000} s`)
      } catch (error) { reject(error) }
    }, timeoutMs)
  })
  try { await Promise.race([client.queue(players, payload), timeout]) }
  finally { clearTimeout(timer) }
}

export async function mountZoneLobby(options: ZoneLobbyOptions): Promise<ZoneLobby> {
  const timeoutMs = checkOptions(options)
  const { course, zones } = await loadCourse(options.courseId)
  const content = await zoneContent('sprint')
  const R = await initRapier()
  const client = new ZoneRelayClient(options.relayUrl, globalZoneWsFactory())
  const payload: ZoneQueuePayload = {
    g: 'royal-fiesta', v: 1, zones: 1,
    name: options.name, seats: options.localSeats, course: course.id,
    tuning: tuningHash(mergeZoneTuning(zones)),
    m: { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 },
  }
  let scene: ZoneNetScene | undefined
  let match: ZoneMatch | undefined
  let disposed = false
  function dispose(): void {
    if (disposed) return
    disposed = true
    try { client.bye() } finally {
      try { match?.dispose() } finally {
        try { scene?.dispose() } finally { client.close() }
      }
    }
  }

  try {
    await client.connect()
    await queueRoom(client, options.players, payload, timeoutMs)
    const { localPeer, roster, measurements } = client.room()
    const seats = roster.peers.find(peer => peer.peer === localPeer)!.seats
    const transport = new ZoneRelayTransport(client, localPeer, roster.peers.length, () => performance.now())
    const view = scene = await mountZoneNetScene({
      ...content, canvas: options.canvas, width: options.width, height: options.height,
      course, seatCount: roster.seatCount, firstLocalSeat: seats[0],
    })
    const local = match = createZoneMatch(R, {
      localPeer, roster, course, zones, profile: PROFILES.sprint,
      kind: course.kind === 'survival' ? 'survival' : 'race',
      measurements, farSink: view.feed,
    }, transport)
    const memories = seats.map(() => newMemory())
    let sampleTick = 0
    function sample(out: PlayerInput[]): void {
      for (let i = 0; i < seats.length; i++) {
        const seat = seats[i]
        const domain = local.domains.find(candidate => candidate.seats.includes(seat))
        if (domain === undefined) decodeInput(NEUTRAL_CODE, out[i])
        else takeoverInput(course, memories[i], domain.state(seat), sampleTick, out[i])
      }
      sampleTick++
    }

    const info = { peers: roster.peers.length, seats: roster.seatCount, localPeer, tick: 0, near: 0, far: 0 }
    const nearDomains = new Map<number, FiestaDomain>()
    const holdsLocalSeat = (seat: number): boolean => nearDomains.has(seat)
    function updateInfo(): void {
      info.tick = local.stats.tick
      nearDomains.clear()
      // Match the scene adapter: the last local domain holding a seat supplies its pose.
      for (const domain of local.domains) {
        for (const seat of domain.seats) nearDomains.set(seat, domain)
      }
      info.near = 0
      for (const [seat, domain] of nearDomains) {
        if (domain.state(seat).mode !== CharMode.parked) info.near++
      }
      info.far = 0
      for (const entry of view.feed.read(info.tick, holdsLocalSeat)) {
        if (Number.isFinite(entry.x) && Number.isFinite(entry.y) &&
            Number.isFinite(entry.z) && Number.isFinite(entry.yaw)) info.far++
      }
    }
    view.update(local, 0, 0)
    updateInfo()
    return {
      info,
      frame(dtS) {
        if (disposed) return
        const alpha = local.frame(dtS, sample)
        transport.flush()
        view.update(local, alpha, dtS)
        updateInfo()
      },
      render: () => { if (!disposed) view.render() },
      ready: () => view.ready(),
      capture: () => disposed ? Promise.resolve(null) : view.capture(),
      dispose,
    }
  } catch (error) {
    try { dispose() } catch { /* Preserve the setup refusal if cleanup also fails. */ }
    throw error
  }
}
