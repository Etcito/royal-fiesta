import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { tuningHash, type GroupTransport } from '@gamesaloon/rollback/zones'
import { parseZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { ZoneRelayClient, type ZoneWsLike } from '../src/net/zoneRelayClient.ts'
import { RELAY_BIN_RATE_PER_SEC, RELAY_MAX_BIN_BYTES, type ZoneQueuePayload } from '../src/net/zoneRelayProtocol.ts'
import { ZoneRelayTransport } from '../src/net/zoneRelayTransport.ts'
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

test('send encodes a reliable packet with one destination bit and copies data', async () => {
  const { client, ws } = await connected()
  const tr = new ZoneRelayTransport(client, 0, 8, () => 0)
  const data = new Uint8Array([7, 8, 9])
  tr.send(3, 'reliable', data)
  data.fill(0)
  assert.equal(ws.binary.length, 0, 'a send waits for the frame flush')
  tr.flush()
  assert.deepEqual(ws.binary, [new Uint8Array([0x5a, 0, 8, 0, 0, 0, 0, 0, 0, 0, 1, 7, 8, 9])])
  assert.deepEqual(tr.stats, { frames: 1, bytesOut: 14, maxFrameBytes: 14, droppedFast: 0, deferredReliable: 0 })
})

test('sendMany emits exactly one fast frame across both mask words', async () => {
  const { client, ws } = await connected()
  const tr = new ZoneRelayTransport(client, 0, 64, () => 123)
  assert.equal(tr.now(), 123)
  assert.ok(tr.sendMany)
  ws.server({ t: 'player_left', seat: 2 })
  const data = new Uint8Array([42])
  tr.sendMany([0, 1, 1, 2, 40, 63], 'fast', data)
  data.fill(0)
  tr.flush()
  assert.deepEqual(ws.binary, [new Uint8Array([0x5a, 0, 2, 0, 0, 0, 0, 1, 0, 128, 0, 42])])
  tr.sendMany([0, 2], 'reliable', data)
  tr.sendMany([], 'fast', data)
  tr.flush()
  assert.equal(ws.binary.length, 1, 'an empty mask must not become a broadcast')
})

test('inbound frames drain copied packets and reject malformed frames without throwing', async () => {
  const { client, ws } = await connected()
  const tr = new ZoneRelayTransport(client, 0, 8, () => 0)
  const frame = new Uint8Array([0x5a, 2, 1, 7, 8])
  ws.frame(frame.buffer)
  frame.fill(0)
  const entry = { peer: 7, ch: 'fast' as 'fast' | 'reliable', data: new Uint8Array() }
  const out = [entry]
  tr.drain(out)
  assert.equal(out[0], entry, 'drain reuses existing entries')
  assert.deepEqual(out, [{ peer: 2, ch: 'reliable', data: new Uint8Array([7, 8]) }])
  for (const bytes of [[], [0x5a], [0x5a, 2], [0x59, 2, 1], [0x5a, 0, 1], [0x5a, 8, 1], [0x5a, 2, 9]]) {
    const before = client.badFrames + tr.malformed
    assert.doesNotThrow(() => ws.frame(new Uint8Array(bytes)))
    assert.equal(client.badFrames + tr.malformed, before + 1)
  }
  tr.drain(out)
  assert.deepEqual(out, [])
})

test('player_left closes its peer and socket close closes every peer', async () => {
  const { client, ws } = await connected()
  const tr = new ZoneRelayTransport(client, 0, 8, () => 0)
  assert.equal(tr.closed(4), false)
  ws.server({ t: 'player_left', seat: 4 })
  assert.equal(tr.closed(4), true)
  assert.equal(tr.closed(3), false)
  tr.send(4, 'reliable', new Uint8Array([1]))
  assert.equal(ws.binary.length, 0)
  ws.close()
  for (let peer = 0; peer < 8; peer++) {
    assert.equal(tr.closed(peer), true)
    tr.send(peer, 'fast', new Uint8Array([2]))
  }
  assert.equal(ws.binary.length, 0)
})

test('rate guard drops fast and defers reliable until the next window flush', async () => {
  const { client, ws } = await connected()
  let now = 0
  const tr = new ZoneRelayTransport(client, 0, 2, () => now, { batch: false })
  assert.equal(RELAY_BIN_RATE_PER_SEC, 2000)
  for (let i = 0; i < 2000; i++) tr.send(1, 'fast', new Uint8Array([i & 255]))
  assert.equal(ws.binary.length, 2000)
  tr.send(1, 'fast', new Uint8Array([99]))
  const data = new Uint8Array([11])
  tr.send(1, 'reliable', data)
  data[0] = 12
  tr.send(1, 'reliable', data)
  data.fill(0)
  assert.equal(ws.binary.length, 2000)
  assert.equal(tr.stats.droppedFast, 1)
  assert.equal(tr.stats.deferredReliable, 2)
  now = 999
  tr.flush()
  assert.equal(ws.binary.length, 2000)
  now = 1000
  assert.equal(ws.binary.length, 2000, 'clock advancement alone does not send')
  tr.flush()
  assert.deepEqual(ws.binary.slice(2000).map(f => [...f.subarray(10)]), [[1, 11], [1, 12]])
  assert.equal(tr.stats.frames, 2002)
  tr.flush()
  assert.equal(ws.binary.length, 2002, 'deferred packets are sent only once')
})

/** Delivers each frame the sender's socket emitted to the receiver as the relay would (sender id in the out header). */
function relay(from: FakeWs, start: number, sender: number, to: FakeWs): void {
  for (const f of from.binary.slice(start)) {
    const out = new Uint8Array(2 + f.byteLength - 10)
    out[0] = 0x5a; out[1] = sender
    out.set(f.subarray(10), 2)
    to.frame(out.buffer)
  }
}
function bytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255
  return b
}

test('a packet at the cap is one frame; a larger one splits into frames at or under the cap and is rebuilt', async () => {
  const a = await connected(), b = await connected()
  const tx = new ZoneRelayTransport(a.client, 0, 2, () => 0)
  const rx = new ZoneRelayTransport(b.client, 1, 2, () => 0)
  tx.send(1, 'reliable', new Uint8Array(RELAY_MAX_BIN_BYTES - 11))
  assert.equal(a.ws.binary.length, 1)
  assert.equal(a.ws.binary[0].byteLength, RELAY_MAX_BIN_BYTES)
  // 20256 and 23148 are the SHADOW sizes the 60-seat gate refused (frames of 20267 and 23159 bytes); 16 MiB is the
  // largest domain snapshot.
  const sizes = [RELAY_MAX_BIN_BYTES - 10, 20256, 23148, 3 * RELAY_MAX_BIN_BYTES, 16 * 1024 * 1024]
  const sent = sizes.map((n, k) => bytes(n, k))
  for (const data of sent) tx.send(1, 'reliable', data)
  for (const f of a.ws.binary) assert.ok(f.byteLength <= RELAY_MAX_BIN_BYTES, `frame of ${f.byteLength} bytes`)
  assert.ok(tx.stats.maxFrameBytes <= RELAY_MAX_BIN_BYTES)
  assert.equal(tx.stats.deferredReliable, 0)
  relay(a.ws, 0, 0, b.ws)
  const out: { peer: number; ch: 'fast' | 'reliable'; data: Uint8Array }[] = []
  rx.drain(out)
  assert.equal(rx.malformed, 0)
  assert.equal(out.length, 1 + sent.length)
  for (let k = 0; k < sent.length; k++) {
    assert.equal(out[k + 1].peer, 0)
    assert.equal(out[k + 1].ch, 'reliable')
    assert.ok(Buffer.from(out[k + 1].data).equals(Buffer.from(sent[k])), `packet ${sizes[k]} rebuilt`)
  }
})

test('60 seats over 17 peers: every zone packet size up to the worst case leaves frames at or under the cap', async () => {
  // Gate shape: 14 peers x 4 seats, one 2-seat and two 1-seat peers. A SHADOW batch is MAX_WIRE_TICKS (64) payloads
  // of up to 0xFFFF bytes each, the largest message ZoneSession emits apart from snapshots.
  const seats = [...Array(14).fill(4), 2, 1, 1]
  assert.equal(seats.reduce((x, y) => x + y, 0), 60)
  const a = await connected(), b = await connected()
  let now = 0
  const tx = new ZoneRelayTransport(a.client, 3, seats.length, () => now)
  const rx = new ZoneRelayTransport(b.client, 16, seats.length, () => now)
  const worst = 12 + 64 * (2 + 0xffff)
  const sent = [worst, 64 * (2 + 60 * 80), 23148].map((n, k) => bytes(n, k + 7))
  for (const data of sent) tx.sendMany([0, 16, 15], 'reliable', data)
  for (const f of a.ws.binary) assert.ok(f.byteLength <= RELAY_MAX_BIN_BYTES, `frame of ${f.byteLength} bytes`)
  now = 5000
  tx.flush()
  relay(a.ws, 0, 3, b.ws)
  const out: { peer: number; ch: 'fast' | 'reliable'; data: Uint8Array }[] = []
  rx.drain(out)
  assert.equal(rx.malformed, 0)
  assert.deepEqual(out.map(p => p.data.byteLength), sent.map(d => d.byteLength))
  for (let k = 0; k < sent.length; k++) assert.ok(Buffer.from(out[k].data).equals(Buffer.from(sent[k])))
})

test('split fast packets are dropped whole over budget; split reliable parts defer in order', async () => {
  const a = await connected(), b = await connected()
  let now = 0
  const tx = new ZoneRelayTransport(a.client, 0, 2, () => now, { batch: false })
  const rx = new ZoneRelayTransport(b.client, 1, 2, () => now)
  for (let i = 0; i < RELAY_BIN_RATE_PER_SEC - 1; i++) tx.send(1, 'fast', new Uint8Array([i & 255]))
  const big = bytes(2 * RELAY_MAX_BIN_BYTES, 3)
  tx.send(1, 'fast', big)
  assert.equal(tx.stats.droppedFast, 1)
  assert.equal(a.ws.binary.length, RELAY_BIN_RATE_PER_SEC - 1)
  tx.send(1, 'reliable', big)
  assert.equal(a.ws.binary.length, RELAY_BIN_RATE_PER_SEC)
  assert.equal(tx.stats.deferredReliable, 2)
  now = 1000
  tx.flush()
  assert.equal(a.ws.binary.length, RELAY_BIN_RATE_PER_SEC + 2)
  relay(a.ws, 0, 0, b.ws)
  const out: { peer: number; ch: 'fast' | 'reliable'; data: Uint8Array }[] = []
  rx.drain(out)
  assert.equal(rx.malformed, 0)
  assert.equal(out.length, RELAY_BIN_RATE_PER_SEC)
  assert.ok(Buffer.from(out[out.length - 1].data).equals(Buffer.from(big)))
})

test('broken part sequences are counted malformed and never delivered', async () => {
  const { client, ws } = await connected()
  const rx = new ZoneRelayTransport(client, 0, 4, () => 0)
  const part = (sender: number, flags: number, index: number, count: number) =>
    ws.frame(new Uint8Array([0x5a, sender, flags, index, 0, count, 0, 9]).buffer)
  part(1, 3, 1, 2) // no part 0
  part(2, 3, 0, 2); part(2, 2, 1, 2) // channel changes
  part(3, 3, 0, 3); part(3, 3, 2, 3) // part skipped
  part(1, 3, 0, 0) // zero count
  const out: { peer: number; ch: 'fast' | 'reliable'; data: Uint8Array }[] = []
  rx.drain(out)
  assert.deepEqual(out, [])
  assert.equal(rx.malformed, 4)
  part(1, 3, 0, 2); part(1, 3, 1, 2)
  rx.drain(out)
  assert.deepEqual(out, [{ peer: 1, ch: 'reliable', data: new Uint8Array([9, 9]) }])
})

test('small packets for the same peers travel in one batch frame, in order, and arrive as separate packets', async () => {
  const a = await connected(), b = await connected()
  const tx = new ZoneRelayTransport(a.client, 0, 3, () => 0)
  const rx = new ZoneRelayTransport(b.client, 1, 3, () => 0)
  const sent: Uint8Array[] = []
  for (let i = 0; i < 100; i++) {
    const data = bytes(1 + (i % 40), i)
    sent.push(data)
    tx.send(1, i % 7 === 0 ? 'reliable' : 'fast', data)
  }
  tx.send(2, 'fast', new Uint8Array([9]))
  tx.send(1, 'fast', new Uint8Array([10]))
  assert.equal(a.ws.binary.length, 0)
  tx.flush()
  assert.equal(a.ws.binary.length, 3, 'one batch for peer 1, one frame for peer 2, one for peer 1 again')
  relay(a.ws, 0, 0, b.ws)
  const out: { peer: number; ch: 'fast' | 'reliable'; data: Uint8Array }[] = []
  rx.drain(out)
  assert.equal(rx.malformed, 0)
  assert.equal(out.length, 102, 'the fake relay hands peer 1 every frame; the mask is the relay job')
  for (let i = 0; i < 100; i++) {
    assert.ok(Buffer.from(out[i].data).equals(Buffer.from(sent[i])), `packet ${i}`)
    assert.equal(out[i].ch, i % 7 === 0 ? 'reliable' : 'fast')
  }
})

test('a truncated batch frame is counted malformed and delivers nothing', async () => {
  const { client, ws } = await connected()
  const rx = new ZoneRelayTransport(client, 0, 4, () => 0)
  ws.frame(new Uint8Array([0x5a, 1, 4, 5, 1, 2]).buffer)
  ws.frame(new Uint8Array([0x5a, 1, 4, 1, 0, 9, 0]).buffer)
  const out: { peer: number; ch: 'fast' | 'reliable'; data: Uint8Array }[] = []
  rx.drain(out)
  assert.equal(out.length, 0)
  assert.equal(rx.malformed, 2)
})
