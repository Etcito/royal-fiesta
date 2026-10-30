import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tuningHash, type Roster } from '@gamesaloon/rollback/zones'
import { ZoneLoopback } from '@royal-fiesta/game/net/zoneLoopback'
import { mergeZoneTuning } from '@royal-fiesta/game/net/zoneTuning'
import { parseZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
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
