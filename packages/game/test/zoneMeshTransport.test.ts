import { nodeRtcBackend, closeNodeRtc } from '../../../apps/headless/src/rtcNode.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { tuningHash, type GroupTransport } from '@gamesaloon/rollback/zones'
import { parseZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { ZoneRelayClient, type ZoneWsLike } from '../src/net/zoneRelayClient.ts'
import { SIGNAL, decodeZoneSignal, type ZoneQueuePayload } from '../src/net/zoneRelayProtocol.ts'
import { ZoneMeshTransport } from '../src/net/zoneMeshTransport.ts'
import { RtcNetwork } from './rtcFake.ts'
import { mergeZoneTuning } from '../src/net/zoneTuning.ts'

// The test plays the server; retain frames as passed so copying bugs remain visible.
class FakeWs implements ZoneWsLike {
  readyState = 0
  binaryType: 'arraybuffer' | 'blob' = 'blob'
  text: string[] = []
  binary: Uint8Array[] = []
  onopen: ZoneWsLike['onopen'] = null
  onmessage: ZoneWsLike['onmessage'] = null
  onclose: ZoneWsLike['onclose'] = null
  onerror: ZoneWsLike['onerror'] = null
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.text.push(data)
    else this.binary.push(data)
  }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }) }
  server(message: object): void { this.frame(JSON.stringify(message)) }
  frame(data: unknown): void { this.onmessage?.({ data }) }
  msgs(): unknown[] { return this.text.map(s => JSON.parse(s)) }
}

async function connected() {
  const ws = new FakeWs()
  const client = new ZoneRelayClient('ws://fake/ws', () => ws)
  const opened = client.connect(1000)
  ws.readyState = 1
  ws.onopen?.()
  await opened
  assert.equal(ws.binaryType, 'arraybuffer')
  return { client, ws }
}

const course = JSON.parse(readFileSync(new URL('../../../courses/race-sprint.course.json', import.meta.url), 'utf8'))
const zones = parseZonesFile(
  JSON.parse(readFileSync(new URL('../../../courses/race-sprint.zones.json', import.meta.url), 'utf8')),
  'courses/race-sprint.zones.json', course,
)
const PAYLOAD: ZoneQueuePayload = {
  g: 'royal-fiesta', v: 1, zones: 1, name: 'Bean', seats: 2, course: zones.course,
  tuning: tuningHash(mergeZoneTuning(zones)),
  m: { cpuMs: 2, bandwidthKbps: 1000, latencyMs: 25, spareSlots: 3 },
}
function matched(youAre: number, opps: unknown[]) {
  return { t: 'matched', seed: 42, hostStarts: youAre === 0, youAre, token: 'tok', players: opps.length, opps }
}

test('queue sends the zone game, player count and payload as JSON', async () => {
  const { client, ws } = await connected()
  const queued = client.queue(8, PAYLOAD)
  assert.deepEqual(ws.msgs(), [{ t: 'queue', game: 'royal-fiesta', zones: true, players: 8, cadence: true, payload: PAYLOAD }])
  assert.equal(JSON.parse(ws.text[0]).payload.tuning, tuningHash(mergeZoneTuning(zones)))
  ws.server(matched(5, Array.from({ length: 8 }, () => PAYLOAD)))
  await queued
})

test('eight peers yield fourteen contiguous seats and measurements per peer', async () => {
  const { client, ws } = await connected()
  const opps = [2, 2, 2, 2, 2, 2, 1, 1].map((seats, peer) => ({
    ...PAYLOAD, seats, name: `Peer ${peer}`,
    m: { cpuMs: peer + 1, bandwidthKbps: 1000 + peer, latencyMs: 20 + peer, spareSlots: peer },
  }))
  const queued = client.queue(8, opps[5])
  ws.server(matched(5, opps))
  await queued
  const room = client.room()
  assert.equal(room.localPeer, 5)
  assert.equal(room.seed, 42)
  assert.equal(room.course, PAYLOAD.course)
  assert.deepEqual(room.roster, {
    seatCount: 14, live: Array(8).fill(true),
    peers: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12], [13]].map((seats, peer) => ({ peer, seats })),
  })
  assert.deepEqual(room.measurements, Object.fromEntries(opps.map((p, peer) => [peer, p.m])))
})

for (const foreign of [{ g: 'another-game' }, { course: 'another-course' }, { tuning: (PAYLOAD.tuning + 1) % 0x100000000 }]) {
  test(`foreign match ${JSON.stringify(foreign)} sends bye and requeues`, async () => {
    const { client, ws } = await connected()
    const queued = client.queue(2, PAYLOAD)
    ws.server(matched(0, [PAYLOAD, { ...PAYLOAD, ...foreign }]))
    const [first, bye, second] = ws.msgs()
    assert.equal(ws.text.length, 3)
    assert.deepEqual(bye, { t: 'bye' })
    assert.deepEqual(second, first)
    assert.equal(client.foreignMatches, 1)
    assert.equal(client.matched, null)
    assert.throws(() => client.room(), isRefusal)
    ws.server(matched(1, [PAYLOAD, PAYLOAD]))
    assert.equal((await queued).youAre, 1)
    assert.equal(client.room().localPeer, 1)
  })
}


async function meshParty(blockedPair: number[] = []) {
  const sockets = await Promise.all(Array.from({ length: 3 }, () => connected()))
  const signals: { from: number; to: number; kind: string }[] = []
  for (const [from, { client, ws }] of sockets.entries()) {
    const queued = client.queue(3, PAYLOAD)
    ws.server(matched(from, [PAYLOAD, PAYLOAD, PAYLOAD]))
    await queued
    const send = ws.send.bind(ws)
    ws.send = data => {
      send(data)
      if (typeof data === 'string') return
      assert.equal(data[10], SIGNAL, 'every relay binary payload is SIGNAL')
      const signal = decodeZoneSignal(data.subarray(10))!
      const mask = new DataView(data.buffer, data.byteOffset, data.length).getUint32(2, true)
      for (let to = 0; to < sockets.length; to++) if (mask & (1 << to)) {
        signals.push({ from, to, kind: signal.kind })
        const frame = new Uint8Array(data.length - 8)
        frame[0] = 0x5a; frame[1] = from; frame.set(data.subarray(10), 2)
        if (blockedPair.includes(from) && blockedPair.includes(to)) continue
        // Synchronous delivery exercises signals arriving before connect() has been called remotely.
        sockets[to].ws.frame(frame)
      }
    }
  }
  return { sockets, signals }
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }

test('three-peer mesh opens every pair, copies both channels and large snapshots, measures RTT with zero relay game frames', async () => {
  const { sockets, signals } = await meshParty()
  const rtc = new RtcNetwork()
  let now = 100
  const meshes = await Promise.all(sockets.map(({ client }, p) => ZoneMeshTransport.connect(client, rtc.backend(p), () => now)))
  try {
    assert.equal(signals.filter(s => s.kind === 'offer').length, 3)
    assert.ok(signals.filter(s => s.kind === 'offer').every(s => s.from < s.to))
    assert.ok(rtc.iceServers.every(s => s[0].urls[0] === 'stun:stun.l.google.com:19302'))
    const relayBefore = sockets.reduce((n, s) => n + s.ws.binary.length, 0)
    now += 1000
    for (const mesh of meshes) mesh.drain([])
    now += 10
    await flush()
    for (const mesh of meshes) {
      for (const [peer, link] of Object.entries(mesh.peers)) {
        assert.deepEqual([link.fast, link.reliable], ['open', 'open'])
        assert.equal(mesh.rtt[Number(peer)], 10)
      }
    }
    for (const mesh of meshes) {
      // Control, far, snapshots, votes and results are opaque bytes on either channel.
      for (const ch of ['fast', 'reliable'] as const) for (const size of [1, 23148, 4 * 1024 * 1024]) {
        const data = new Uint8Array(size).fill(mesh.selfPeer + 17)
        mesh.sendMany(mesh.peerIds, ch, data)
        data.fill(0)
      }
    }
    await flush()
    for (const mesh of meshes) {
      const out: Parameters<GroupTransport['drain']>[0] = []
      mesh.drain(out)
      assert.equal(out.length, 12)
      assert.ok(out.every(p => p.data.every(b => b === p.peer + 17)), 'caller and receiver buffer reuse is safe')
      assert.deepEqual([...new Set(out.map(p => p.data.length))], [1, 23148, 4 * 1024 * 1024])
      assert.equal(mesh.stats.malformed, 0)
    }
    assert.equal(sockets.reduce((n, s) => n + s.ws.binary.length, 0), relayBefore, 'all zone traffic stays on the DataChannels')
    meshes[1].close()
    assert.ok(meshes[0].closed(1))
    meshes[0].send(1, 'reliable', new Uint8Array([99]))
    assert.equal(sockets.reduce((n, s) => n + s.ws.binary.length, 0), relayBefore, 'channel loss never falls back')
  } finally { for (const mesh of meshes) mesh.close(); for (const { client } of sockets) client.close() }
})

test('one broken native pair refuses the entire three-peer start with named peers and no relay fallback', async () => {
  const { sockets } = await meshParty([1, 2])
  const rtc = nodeRtcBackend({ bindAddress: '127.0.0.1' })
  let observer: ZoneMeshTransport | undefined
  let started = 0
  try {
    const results = await Promise.allSettled(sockets.map(({ client }, peer) =>
      ZoneMeshTransport.connect(client, rtc, () => performance.now(), { iceServers: [], timeoutMs: peer === 1 ? 1500 : 5000,
        onProgress: mesh => { if (peer === 0) observer = mesh },
      })
        .then(mesh => { started++; mesh.close() })))
    assert.ok(observer!.rtt[1] >= 0 && observer!.rtt[2] >= 0, 'native peer 0 opened both its links before the broken pair timed out')
    assert.equal(started, 0, 'even peer 0, whose own channels opened, cannot start')
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.match(String(result.reason), /1<->2/)
    }
    console.log(JSON.stringify({ healthyPairRttMs: observer!.rtt, meshRefusal: results.map(r => r.status === 'rejected' ? String(r.reason) : 'started') }))
  } finally { for (const { client } of sockets) client.close(); closeNodeRtc() }
})
