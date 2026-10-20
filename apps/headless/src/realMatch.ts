// Real-time headless matches over the relay or a loopback WebRTC mesh.
import { readdir } from 'node:fs/promises'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { NetTransport } from '@gamesaloon/rollback'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import type { CourseEntry } from '@royal-fiesta/game/courseSet'
import { createNetMatch } from '@royal-fiesta/game/net/netMatch'
import type { NetMatch } from '@royal-fiesta/game/net/netMatch'
import { compareHashLogs, ConfirmedHashLog, CostStats, DisplayJumpMeter } from '@royal-fiesta/game/net/metrics'
import { Pilot } from '@royal-fiesta/game/net/pilot'
import { RelayClient } from '@royal-fiesta/game/net/relayClient'
import { RelayTransport } from '@royal-fiesta/game/net/relayTransport'
import { RoomsClient } from '@royal-fiesta/game/net/roomsClient'
import { fiestaLocalPlayer } from '@royal-fiesta/game/net/roomsProtocol'
import { netSetup } from '@royal-fiesta/game/net/tuning'
import { WebRtcTransport } from '@royal-fiesta/game/net/webrtcTransport'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { matchLogJson } from '@royal-fiesta/sim/match/log'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { nodeFixtureResolver, readRepoText, repoPath } from './files.ts'
import type { LocalServer } from './gamesaloon.ts'
import type { NetRunResult } from './netsimMatch.ts'
import { closeNodeRtc, nodeRtcBackend } from './rtcNode.ts'

export interface RealCase { label: string; transport: 'relay' | 'webrtc'; clients: number; profile: ProfileName }

let rapier: ReturnType<typeof initRapier> | null = null
const courseCache = new Map<ProfileName, Promise<ResolvedCourse[]>>()
const now = () => performance.now()

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

// Settle every connection before cleanup, including siblings of a failed connection.
async function all<T>(pending: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(pending)
  return settled.map(r => {
    if (r.status === 'rejected') throw r.reason
    return r.value
  })
}

export async function runRealCase(server: LocalServer, c: RealCase): Promise<NetRunResult & { transportStats: Record<string, number>; seed: number }> {
  const max = c.transport === 'relay' ? 4 : 8
  if (!Number.isInteger(c.clients) || c.clients < 2 || c.clients > max) {
    refuse('realmatch', 'clients', `${c.clients} is outside 2..${max} for ${c.transport}; use relay for 2..4 clients or WebRTC for 2..8`)
  }
  const relay: RelayClient[] = []
  const rooms: RoomsClient[] = []
  const transports: (RelayTransport | WebRtcTransport)[] = []
  const peers: NetMatch[] = []
  try {
    rapier ??= initRapier()
    const R = await rapier
    const courses = await loadCourses(c.profile)
    const ws = globalWsFactory()
    let seed: number
    if (c.transport === 'relay') {
      for (let k = 0; k < c.clients; k++) relay.push(new RelayClient(server.url, ws))
      await all(relay.map(client => client.connect()))
      const matched = await all(relay.map((client, k) => client.queue(c.clients, { g: 'royal-fiesta', v: 1, name: `bot${k}`, c: k })))
      seed = matched[0].seed
      if (matched.some(m => m.seed !== seed)) {
        refuse('relay', 'matched.seed', 'clients received different seeds; queue every client into the same match')
      }
      relay.sort((a, b) => a.seat - b.seat)
      for (let k = 0; k < relay.length; k++) {
        if (relay[k].seat !== k) refuse('relay', 'matched.youAre', 'seats are not exactly 0..clients-1; queue a fresh set of clients')
        transports.push(new RelayTransport(relay[k], relay[k].seat, c.clients, now))
      }
    } else {
      for (let k = 0; k < c.clients; k++) rooms.push(new RoomsClient(server.url, ws))
      await rooms[0].hello('bot0')
      const room = await rooms[0].create(fiestaLocalPlayer('bot0', 0), true)
      for (let k = 1; k < c.clients; k++) {
        await rooms[k].hello(`bot${k}`)
        await rooms[k].join(room.code, fiestaLocalPlayer(`bot${k}`, k))
      }
      await rooms[0].start()
      const started = await all(rooms.map(client => client.waitStarted()))
      seed = started[0].seed
      for (const s of started) {
        const ids = s.members.map(m => m.peer).sort((a, b) => a - b)
        if (ids.length !== c.clients || ids.some((id, k) => id !== k)) {
          refuse('webrtc', 'started.members', 'peers must be exactly 0..clients-1 for createNetMatch evenPeers; create a fresh room and join in order')
        }
        if (s.seed !== seed) refuse('webrtc', 'started.seed', 'clients received different seeds; start every client in the same room')
      }
      await all(rooms.map(async (client, k) => {
        const transport = await WebRtcTransport.connect(client, started[k], nodeRtcBackend(), now, { iceServers: [] })
        transports.push(transport)
      }))
      transports.sort((a, b) => (a as WebRtcTransport).selfPeer - (b as WebRtcTransport).selfPeer)
    }
    const setup = netSetup(seed, c.clients, c.profile, courses)
    const prof = PROFILES[c.profile]
    let cap = 0
    for (const co of courses) cap = Math.max(cap, co.timeLimitS)
    if (prof.timeCapS !== null) cap = Math.min(cap, prof.timeCapS)
    const expected = 4 * (prof.introTicks + prof.roundEndTicks + prof.intermissionTicks + 60 * cap) + prof.podiumTicks
    const limit = 3 * expected / 60 * 1000
    const pilots: Pilot[] = []
    const logs: ConfirmedHashLog[] = []
    let packetsSent = 0
    for (let k = 0; k < c.clients; k++) {
      const transport = transports[k]
      const localPeer = transport instanceof WebRtcTransport ? transport.selfPeer : relay[k].seat
      const net: NetTransport = transport instanceof WebRtcTransport ? {
        send(peer, ch, data) {
          if (peer === localPeer || transport.closed(peer)) return
          transport.send(peer, ch, data)
          packetsSent++
        },
        drain: out => transport.drain(out),
        closed: peer => transport.closed(peer),
        now,
      } : transport
      peers.push(createNetMatch(R, { setup, localPeer, humanPeers: c.clients }, net, { cpuMs: now }))
      pilots.push(new Pilot(localPeer, seed))
      logs.push(new ConfirmedHashLog())
    }
    const meter = new DisplayJumpMeter(8)
    const cost = new CostStats()
    let maxDelay = 0
    const t0 = now()
    let last = t0
    let next = t0 + 1000 / 60
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, next - now())))
      const t = now()
      if (t - t0 > limit) {
        refuse('realmatch', `case ${c.label}`, `match not done after ${t - t0} ms (limit ${limit} ms); check stalls/desyncs and transport connectivity`)
      }
      const dt = Math.min(0.25, (t - last) / 1000)
      last = t
      for (let k = 0; k < c.clients; k++) {
        const m = peers[k]
        m.frame(dt, out => { pilots[k].sample(m.sim, out[0]) })
        const transport = transports[k]
        if (transport instanceof RelayTransport) transport.endFrame()
        cost.add(m.session.stats.lastFrameSimMs)
        logs[k].record(m.session)
        maxDelay = Math.max(maxDelay, m.session.stats.delay)
      }
      meter.sample(peers[0].sim, peers[0].session.smoother)
      if (peers.every(m => m.done)) break
      next = Math.max(next + 1000 / 60, now())
    }
    const wallMs = now() - t0
    const wallS = wallMs / 1000
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
    const transportStats: Record<string, number> = c.transport === 'relay'
      ? { acts: 0, bytesOut: 0, maxActBytes: 0, fragments: 0, droppedFast: 0, deferredReliable: 0 }
      : { packetsSent, packetsPerSec: packetsSent / wallS }
    if (c.transport === 'relay') {
      for (const transport of transports) {
        const stats = (transport as RelayTransport).stats
        for (const key of Object.keys(stats) as (keyof typeof stats)[]) transportStats[key] += stats[key]
      }
      transportStats.actsPerSec = transportStats.acts / wallS / c.clients
    }
    const ticks = peers[0].sim.tick
    return {
      label: c.label, ...cmp, winners: peers.map(m => m.log().winner), logsEqual: jsons.every(j => j === jsons[0]),
      frameMsMean: cost.mean(), frameMsP99: cost.p99(), frameMsMax: cost.max(),
      rollbacks, maxRollback, resimTicks, resimPerTick: resimTicks / (ticks * c.clients),
      maxDelay, maxDisplayJump: meter.maxJump, visibleSnaps: meter.visibleSnaps, stalls, ticks, wallMs, transportStats, seed,
    }
  } finally {
    try {
      for (const m of peers) m.dispose()
      for (const client of relay) {
        try { client.bye() } finally { client.close() }
      }
      for (const transport of transports) if (transport instanceof WebRtcTransport) transport.close()
      for (const client of rooms) client.close()
    } finally {
      if (c.transport === 'webrtc') closeNodeRtc()
    }
  }
}
