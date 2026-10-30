import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tuningHash, type Roster } from '@gamesaloon/rollback/zones'
import { FarFeed } from '@royal-fiesta/game/net/farFeed'
import { ZoneLoopback } from '@royal-fiesta/game/net/zoneLoopback'
import { mergeZoneTuning } from '@royal-fiesta/game/net/zoneTuning'
import { parseZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { countNearFar, playLobby } from '../../web/src/zone/zoneLobbyPlay.ts'
import { runZoneBot } from '../src/zoneBot.ts'
import type { ZoneBot, ZoneBotMeasurements } from '../src/zoneBot.ts'

const PEERS = 3
const SEATS_PER_PEER = [1, 2, 1]
const FRAMES = 180
const DT = 1 / 60
const DEFAULT_MEASUREMENTS: ZoneBotMeasurements = { cpuMs: 4, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 }

function makeRoster(): Roster {
  const peers: { peer: number; seats: number[] }[] = []
  let seat = 0
  for (let p = 0; p < PEERS; p++) {
    const seats: number[] = []
    for (let i = 0; i < SEATS_PER_PEER[p]; i++) seats.push(seat++)
    peers.push({ peer: p, seats })
  }
  return { seatCount: seat, peers, live: Array.from({ length: PEERS }, () => true) }
}

function measurements(): Record<number, ZoneBotMeasurements> {
  const out: Record<number, ZoneBotMeasurements> = {}
  for (let p = 0; p < PEERS; p++) out[p] = { ...DEFAULT_MEASUREMENTS }
  return out
}

// Stands in for the browser/Node WebSocket so the relay queue path can be driven without a server.
class QueueSocket {
  static instances: QueueSocket[] = []
  static queued: (() => void) | null = null
  readonly url: string
  readonly sent: string[] = []
  readyState = 0
  binaryType: 'arraybuffer' | 'blob' = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(url: string) {
    this.url = url
    QueueSocket.instances.push(this)
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }
  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') return
    this.sent.push(data)
    const message = JSON.parse(data) as { t?: string; payload?: Record<string, unknown> }
    if (message.t !== 'queue' || message.payload === undefined) return
    if (QueueSocket.queued) { QueueSocket.queued(); return }
    const payload = message.payload
    const matched = {
      t: 'matched', seed: 7, hostStarts: true, youAre: 0, token: 'never-printed',
      players: 2, opps: [payload, { ...payload, name: 'peer-b' }],
    }
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(matched) }))
  }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }) }
}

function seatPos(bot: ZoneBot, seat: number): { x: number; z: number } | null {
  const domain = bot.match.domains.find(candidate => candidate.seats.includes(seat))
  if (domain === undefined) return null
  const pos = domain.state(seat).pos
  return { x: pos.x, z: pos.z }
}

test('zoneBot: three loopback bots drive their seats and confirm the global domain', { timeout: 120000 }, async () => {
  const loopback = new ZoneLoopback(PEERS, { seed: 1, rttMs: 60, jitterMs: 5, loss: 0 })
  const roster = makeRoster()
  const peerMeasurements = measurements()
  const bots: ZoneBot[] = []
  try {
    for (let peer = 0; peer < PEERS; peer++) {
      bots.push(await runZoneBot({
        course: 'race-sprint',
        name: `loopback-${peer}`,
        seats: SEATS_PER_PEER[peer],
        seconds: 10,
        drive: 'manual',
        net: { transport: loopback.transport(peer), roster, localPeer: peer, measurements: peerMeasurements },
      }))
    }

    const start = bots.map(bot => bot.seats.map(seat => seatPos(bot, seat)))
    const moved = bots.map(bot => bot.seats.map(() => 0))
    for (let frame = 0; frame < FRAMES; frame++) {
      loopback.advance(1000 * DT)
      for (let p = 0; p < bots.length; p++) {
        const bot = bots[p]
        bot.frame(DT)
        for (let i = 0; i < bot.seats.length; i++) {
          const pos = seatPos(bot, bot.seats[i])
          const from = start[p][i]
          if (pos === null || from === null) continue
          const distance = Math.hypot(pos.x - from.x, pos.z - from.z)
          if (distance > moved[p][i]) moved[p][i] = distance
        }
      }
    }

    for (const bot of bots) {
      assert.ok(bot.match.stats.tick >= 150,
        `peer ${bot.localPeer}: tick ${bot.match.stats.tick} after ${FRAMES} frames is not at least 150`)
    }

    for (let p = 0; p < bots.length; p++) {
      const bot = bots[p]
      for (let i = 0; i < bot.seats.length; i++) {
        assert.ok(start[p][i] !== null, `peer ${bot.localPeer}: seat ${bot.seats[i]} has a domain at tick 0`)
        assert.ok(moved[p][i] > 1,
          `peer ${bot.localPeer}: seat ${bot.seats[i]} moved ${moved[p][i].toFixed(2)} m, expected more than 1 m`)
      }
    }

    let agreedTick = -1
    const topTick = Math.min(...bots.map(bot => bot.match.stats.tick))
    for (let t = topTick; t >= 0 && agreedTick < 0; t--) {
      const hashes = bots.map(bot => bot.match.confirmedHash(0, t))
      if (hashes.every(hash => hash !== undefined) && hashes.every(hash => hash === hashes[0])) {
        agreedTick = t
      }
    }
    assert.ok(agreedTick >= 0,
      `no tick has a confirmed global-domain hash on all ${PEERS} peers up to tick ${topTick}`)
  } finally {
    for (const bot of bots) bot.stop()
  }
})

// The two-Chrome gate's shape: bot peers first, the browser peer last, so bots produce every domain. The browser's
// animation load (here 5 s, past lostAfterMs) runs while it plays: it once stopped framing for the load, the others
// dropped it, and the whole room froze at the next epoch boundary with the browser's seat in no local domain.
test('zoneBot: a browser-style peer plays past tick 600 with six bots while its animations load', { timeout: 300000 }, async () => {
  const seats = [2, 1, 1, 1, 1, 1, 1]
  const browser = seats.length - 1
  const loopback = new ZoneLoopback(seats.length, { seed: 3, rttMs: 60, jitterMs: 5, loss: 0 })
  let next = 0
  const roster: Roster = {
    seatCount: 8,
    peers: seats.map((count, peer) => ({ peer, seats: Array.from({ length: count }, () => next++) })),
    live: seats.map(() => true),
  }
  const peerMeasurements: Record<number, ZoneBotMeasurements> = {}
  for (let p = 0; p < seats.length; p++) peerMeasurements[p] = { ...DEFAULT_MEASUREMENTS }
  const feed = new FarFeed()
  const peers: ZoneBot[] = []
  const stepMs = 1000 * DT
  let waiters: { at: number; resolve: () => void }[] = []
  const at = (ms: number) => new Promise<void>(resolve => waiters.push({ at: loopback.now() + ms, resolve }))
  let pumping = true
  try {
    for (let peer = 0; peer < seats.length; peer++) {
      peers.push(await runZoneBot({
        course: 'race-sprint', name: `loopback-${peer}`, seats: seats[peer], seconds: 60, drive: 'manual',
        net: { transport: loopback.transport(peer), roster, localPeer: peer, measurements: peerMeasurements },
        ...(peer === browser ? { farSink: feed } : {}),
      }))
    }
    const page = peers[browser]
    // The network and the bots run on their own, as the real ones do while the page awaits.
    const pump = (async () => {
      while (pumping) {
        loopback.advance(stepMs)
        for (let p = 0; p < browser; p++) peers[p].frame(DT)
        const now = loopback.now()
        const due = waiters.filter(w => w.at <= now)
        waiters = waiters.filter(w => w.at > now)
        for (const w of due) w.resolve()
        await new Promise(resolve => setImmediate(resolve))
      }
    })()
    let homeless = 0
    const target = {
      info: { get tick() { return page.match.stats.tick } },
      frame(dtS: number) {
        page.frame(dtS)
        if (!page.match.domains.some(domain => domain.seats.includes(page.seats[0]))) homeless++
      },
    }
    await playLobby(target, { seconds: 60, captureTick: 600, frameMs: 16, maxDtS: 0.1, load: () => at(5000) },
      { now: () => loopback.now(), wait: at })
    // What the gate reads at its capture: 8 seats share one domain here, so the other racers are near, not far.
    const { near, far } = countNearFar(page.match, feed, page.match.stats.tick)
    // Let the bots reach the browser's tick (they predict up to 16 ticks past its inputs).
    for (let k = 0; k < 600 && peers.some(peer => peer.match.stats.tick < 600); k++) await at(stepMs)
    pumping = false
    await pump
    for (const peer of peers) {
      assert.ok(peer.match.stats.tick >= 600, `peer ${peer.localPeer}: tick ${peer.match.stats.tick}, 600 required`)
    }
    assert.equal(homeless, 0, `the browser seat was in no local domain on ${homeless} frames`)
    assert.ok(near >= 1, `browser peer: near ${near}, its own seat must be near`)
    assert.ok(near + far >= 3, `browser peer: near ${near} + far ${far}, other racers must be visible`)
  } finally {
    pumping = false
    for (const peer of peers) peer.stop()
  }
})

// The two-Chrome gate's room: six 2-seat bot peers, then two 1-seat browser peers, joined in that order (14 seats on
// a course of 8 spawns). Seats 8..13 used to start inside seats 0..5, so the browsers' seats (12 and 13) raced from
// inside a bot and could finish alone; every peer, the last joiner (peer 7) too, must replicate its own seats.
test('zoneBot: eight peers in join order each replicate a domain holding their own seats, on distinct starts', { timeout: 300000 }, async () => {
  const seats = [2, 2, 2, 2, 2, 2, 1, 1]
  const loopback = new ZoneLoopback(seats.length, { seed: 5, rttMs: 60, jitterMs: 5, loss: 0 })
  let next = 0
  const roster: Roster = {
    seatCount: 14,
    peers: seats.map((count, peer) => ({ peer, seats: Array.from({ length: count }, () => next++) })),
    live: seats.map(() => true),
  }
  const peerMeasurements: Record<number, ZoneBotMeasurements> = {}
  for (let p = 0; p < seats.length; p++) peerMeasurements[p] = { ...DEFAULT_MEASUREMENTS }
  const peers: ZoneBot[] = []
  try {
    for (let peer = 0; peer < seats.length; peer++) {
      peers.push(await runZoneBot({
        course: 'race-sprint', name: `loopback-${peer}`, seats: seats[peer], seconds: 60, drive: 'manual',
        net: { transport: loopback.transport(peer), roster, localPeer: peer, measurements: peerMeasurements },
      }))
    }
    const starts = new Set<string>()
    for (const peer of peers) {
      for (const seat of peer.seats) {
        const pos = peer.match.domains.find(domain => domain.seats.includes(seat))!.state(seat).pos
        starts.add(`${pos.x.toFixed(2)},${pos.z.toFixed(2)}`)
      }
    }
    assert.equal(starts.size, 14, `14 seats start on ${starts.size} distinct ground positions`)
    const homeless = new Array<number>(seats.length).fill(0)
    for (let f = 0; f < 400; f++) {
      loopback.advance(1000 * DT)
      for (const peer of peers) {
        peer.frame(DT)
        const domains = peer.match.domains
        if (!peer.seats.every(seat => domains.some(domain => domain.seats.includes(seat)))) homeless[peer.localPeer]++
      }
    }
    for (const peer of peers) {
      assert.ok(peer.match.stats.tick >= 390, `peer ${peer.localPeer}: tick ${peer.match.stats.tick}`)
      assert.equal(homeless[peer.localPeer], 0, `peer ${peer.localPeer}: own seat in no local domain on ${homeless[peer.localPeer]} frames`)
    }
  } finally {
    for (const peer of peers) peer.stop()
  }
})

test('zoneBot: relay queue tuning is tuningHash(mergeZoneTuning(zones)) for the course', async () => {
  const sidecar = JSON.parse(readFileSync(new URL('../../../courses/race-sprint.zones.json', import.meta.url), 'utf8')) as unknown
  const zones = parseZonesFile(sidecar, 'courses/race-sprint.zones.json', { id: 'race-sprint', obstacles: [] })
  const expected = tuningHash(mergeZoneTuning(zones))
  const globals = globalThis as unknown as { WebSocket?: unknown }
  const original = globals.WebSocket
  QueueSocket.instances = []
  globals.WebSocket = QueueSocket
  let bot: ZoneBot | null = null
  try {
    bot = await runZoneBot({
      course: 'race-sprint',
      name: 'queue-bot',
      seats: 1,
      seconds: 0,
      drive: 'manual',
      net: { url: 'ws://zone.test/ws', players: 2 },
    })
    assert.equal(QueueSocket.instances.length, 1, 'the relay bot opens exactly one socket')
    const queued = QueueSocket.instances[0].sent
      .map(text => JSON.parse(text) as { t?: string; payload?: { tuning?: number } })
      .find(message => message.t === 'queue')
    assert.ok(queued !== undefined && queued.payload !== undefined, 'the bot queues a zone payload')
    assert.equal(queued.payload.tuning, expected)
  } finally {
    bot?.stop()
    globals.WebSocket = original
  }
})


test('zoneBot: cancellation closes a socket waiting for the rest of the room', async () => {
  const globals = globalThis as unknown as { WebSocket?: unknown }
  const original = globals.WebSocket
  const controller = new AbortController()
  QueueSocket.instances = []
  globals.WebSocket = QueueSocket
  QueueSocket.queued = () => controller.abort()
  try {
    await assert.rejects(runZoneBot({
      course: 'race-sprint', name: 'waiting-bot', seats: 2, seconds: 30,
      drive: 'timer', signal: controller.signal,
      net: { url: 'ws://zone.test/ws', players: 8 },
    }), error => error === controller.signal.reason)
    assert.equal(QueueSocket.instances.length, 1)
    assert.equal(QueueSocket.instances[0].readyState, 3)
  } finally {
    QueueSocket.queued = null
    globals.WebSocket = original
  }
})
