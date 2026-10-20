import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetChannel } from '@gamesaloon/rollback'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { RelayClient } from '../src/net/relayClient.ts'
import type { FiestaQueuePayload } from '../src/net/relayClient.ts'
import { parseRelayServerMsg } from '../src/net/relayProtocol.ts'
import { RelayTransport } from '../src/net/relayTransport.ts'
import { b64ToBytes, bytesToB64 } from '../src/net/ws.ts'
import type { WsLike } from '../src/net/ws.ts'

// Scripted socket: records what the client sends, and the test plays the server.
class FakeWs implements WsLike {
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  send(data: string): void { this.sent.push(data) }
  close(): void {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: '' })
  }
  server(m: object): void { this.onmessage?.({ data: JSON.stringify(m) }) }
  msgs(): Record<string, unknown>[] { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>) }
}

async function connected(): Promise<{ client: RelayClient; ws: FakeWs }> {
  let ws: FakeWs | null = null
  const client = new RelayClient('ws://fake/ws', () => (ws = new FakeWs()))
  const p = client.connect(1000)
  const w = ws as unknown as FakeWs
  w.readyState = 1
  w.onopen?.()
  await p
  return { client, ws: w }
}

const PAYLOAD: FiestaQueuePayload = { g: 'royal-fiesta', v: 1, name: 'Bean', c: 2 }

function matched(youAre: number, players: number, opps: unknown[]): object {
  return { t: 'matched', seed: 42, hostStarts: youAre === 0, youAre, token: 'tok', players, opps }
}

// Forwards every act the sender wrote to the receivers, as the relay does.
function relay(from: FakeWs, seat: number, to: FakeWs[]): Record<string, unknown>[] {
  const acts = from.msgs().filter((m) => m.t === 'act')
  from.sent = []
  acts.forEach((m, n) => { for (const w of to) w.server({ t: 'act', a: m.a, n, from: seat }) })
  return acts
}

type Got = { peer: number; ch: NetChannel; data: Uint8Array }
function drainAll(t: RelayTransport): Got[] {
  const out: Got[] = []
  t.drain(out)
  return out.map((g) => ({ peer: g.peer, ch: g.ch, data: g.data }))
}

const refusesRelay = (e: unknown) => isRefusal(e) && e.message.includes('WebRTC')

test('bytesToB64/b64ToBytes round-trip lengths 0..300 and every byte value', () => {
  const all = new Uint8Array(256).map((_, i) => i)
  assert.deepEqual(b64ToBytes(bytesToB64(all)), all)
  for (let len = 0; len <= 300; len++) {
    const b = new Uint8Array(len).map((_, i) => (i * 97 + len * 13) & 255)
    const s = bytesToB64(b)
    assert.equal(s, Buffer.from(b).toString('base64'))
    assert.deepEqual(b64ToBytes(s), b)
  }
})

test('parseRelayServerMsg rejects garbage and parses matched/act', () => {
  for (const raw of ['{', 'null', '[]', '42', '{"t":"nope"}', '{"t":"matched","seed":1,"hostStarts":true,"youAre":0,"players":2,"opps":[]}']) {
    assert.equal(parseRelayServerMsg(raw), null, raw)
  }
  const m = parseRelayServerMsg(JSON.stringify(matched(1, 3, [{}, {}])))
  assert.equal(m?.t, 'matched')
  assert.equal(m?.t === 'matched' && m.youAre, 1)
  const a = parseRelayServerMsg('{"t":"act","a":{"k":"rb","m":[]},"n":3,"from":2}')
  assert.deepEqual(a, { t: 'act', a: { k: 'rb', m: [] }, n: 3, from: 2 })
})

test('QB7: more than 4 relay seats is refused at once, before any frame', async () => {
  const { client, ws } = await connected()
  for (const n of [8, 1]) {
    const t0 = performance.now()
    assert.throws(() => client.queue(n, PAYLOAD), (e: unknown) => {
      assert.ok(isRefusal(e))
      assert.match(e.message, /capped at 4/)
      assert.match(e.message, /WebRTC/)
      return true
    })
    assert.ok(performance.now() - t0 < 50)
  }
  assert.throws(() => client.create(5), refusesRelay)
  assert.equal(ws.sent.length, 0)
  const j = client.join('ABCD')
  ws.server({ t: 'waiting', seat: 1, players: 5 })
  await assert.rejects(j, refusesRelay)
})

test('queue sends cadence and payload, re-queues after a foreign match', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { client, ws } = await connected()
  const p = client.queue(2, PAYLOAD)
  assert.deepEqual(ws.msgs(), [{ t: 'queue', players: 2, cadence: true, payload: PAYLOAD }])
  ws.server(matched(0, 2, [{ g: 'other-game', v: 1 }]))
  assert.deepEqual(ws.msgs().map((m) => m.t), ['queue', 'bye', 'queue'])
  assert.equal(client.foreignMatches, 1)
  ws.server(matched(1, 2, [{ g: 'royal-fiesta', v: 1, name: 'Opp', c: 0 }]))
  const m = await p
  assert.equal(m.youAre, 1)
  assert.equal(client.seat, 1)
})

test('two-seat room: opp_left closes the other seat', async () => {
  const { client, ws } = await connected()
  const p = client.queue(2, PAYLOAD)
  ws.server(matched(0, 2, [{ g: 'royal-fiesta', v: 1 }]))
  await p
  const seats: { t: string; seat: number }[] = []
  client.onSeatEvent((ev) => seats.push(ev))
  const tr = new RelayTransport(client, 0, 2, () => 0)
  ws.server({ t: 'opp_left' })
  assert.deepEqual(seats, [{ t: 'player_left', seat: 1 }])
  assert.equal(tr.closed(1), true)
  assert.equal(tr.closed(0), false)
})

test('framing: identical bytes merge into one mask, foreign entries are filtered, send copies', async () => {
  const a = await connected()
  const b = await connected()
  const ta = new RelayTransport(a.client, 0, 4, () => 0)
  const tb = new RelayTransport(b.client, 1, 4, () => 0)
  const same = new Uint8Array([1, 2, 3])
  for (const peer of [1, 2, 3]) ta.send(peer, 'fast', same)
  ta.endFrame()
  assert.equal(a.ws.sent.length, 0, 'flushes every 2 frames')
  ta.endFrame()
  assert.deepEqual(a.ws.msgs(), [{ t: 'act', a: { k: 'rb', m: [[0b1110, 0, 'AQID']] } }])
  a.ws.sent = []

  // Reused buffer and a duplicate to the same peer: both packets keep their own bytes.
  const buf = new Uint8Array([9, 9])
  ta.send(1, 'reliable', buf)
  buf.fill(0)
  ta.send(1, 'reliable', buf)
  ta.send(1, 'reliable', new Uint8Array([9, 9]))
  ta.endFrame(); ta.endFrame()
  relay(a.ws, 0, [b.ws])
  assert.deepEqual(drainAll(tb).map((g) => [...g.data]), [[9, 9], [0, 0], [9, 9]])

  b.ws.server({ t: 'act', a: { k: 'rb', m: [[0b0100, 0, 'AQ=='], [0b0010, 1, 'Ag==']] }, n: 0, from: 0 })
  assert.deepEqual(drainAll(tb), [{ peer: 0, ch: 'reliable', data: new Uint8Array([2]) }])
  b.ws.server({ t: 'act', a: { k: 'rb', m: [[2, 0, '!!']] }, n: 1, from: 0 })
  assert.equal(tb.malformed, 1)
  assert.deepEqual(drainAll(tb), [])
})

test('frames stay <= 3800 chars and 500 entries; a 10 KB packet arrives as rbf fragments', async () => {
  const a = await connected()
  const b = await connected()
  const ta = new RelayTransport(a.client, 0, 2, () => 0, { flushEveryFrames: 1 })
  const tb = new RelayTransport(b.client, 1, 2, () => 0)
  const small: Uint8Array[] = []
  for (let i = 0; i < 1200; i++) small.push(new Uint8Array([i & 255, i >> 8, 7, 7]))
  for (const p of small) ta.send(1, 'reliable', p)
  const big = new Uint8Array(10240).map((_, i) => (i * 31 + 7) & 255)
  ta.send(1, 'reliable', big)
  ta.send(1, 'reliable', new Uint8Array([5]))
  ta.endFrame()
  const acts = relay(a.ws, 0, [b.ws])
  for (const raw of acts) {
    assert.ok(JSON.stringify(raw).length <= 3800)
    const body = raw.a as { k: string; m?: unknown[] }
    if (body.k === 'rb') assert.ok(body.m!.length <= 500)
  }
  assert.ok(acts.some((m) => (m.a as { k: string }).k === 'rbf'))
  assert.ok(ta.stats.fragments > 0)
  assert.ok(ta.stats.maxActBytes <= 3800)
  const got = drainAll(tb)
  assert.equal(got.length, 1202)
  for (let i = 0; i < 1200; i++) assert.deepEqual(got[i].data, small[i])
  assert.deepEqual(got[1200].data, big)
  assert.deepEqual(got[1201].data, new Uint8Array([5]))
})

test('rate budget: <= 60 acts per rolling second, fast dropped, reliable deferred in order', async () => {
  const a = await connected()
  const b = await connected()
  let now = 0
  const ta = new RelayTransport(a.client, 0, 2, () => now, { flushEveryFrames: 1 })
  const tb = new RelayTransport(b.client, 1, 2, () => now)
  // 2000-byte packets: one act each.
  const packet = (seq: number, ch: number) => new Uint8Array(2000).map((_, i) => (i < 2 ? (i ? seq >> 8 : seq & 255) : (i + seq + ch * 101) & 255))
  const times: number[] = []
  const got: Got[] = []
  let rel = 0
  for (let frame = 0; frame < 140; frame++) {
    if (frame < 40) {
      for (let k = 0; k < 4; k++) {
        ta.send(1, 'reliable', packet(rel++, 1))
        ta.send(1, 'fast', packet(frame * 4 + k, 0))
      }
    }
    ta.endFrame()
    for (const _ of relay(a.ws, 0, [b.ws])) times.push(now)
    got.push(...drainAll(tb))
    now += 50
  }
  for (const t of times) assert.ok(times.filter((x) => x > t - 1000 && x <= t).length <= 60)
  assert.ok(ta.stats.droppedFast > 0)
  assert.ok(ta.stats.deferredReliable > 0)
  assert.equal(ta.stats.acts, times.length)
  const seqs = got.filter((g) => g.ch === 'reliable').map((g) => g.data[0] | (g.data[1] << 8))
  assert.deepEqual(seqs, Array.from({ length: rel }, (_, i) => i))
  assert.ok(got.filter((g) => g.ch === 'fast').length < 160)
})

test('closed(peer) after player_left and after socket close', async () => {
  const { client, ws } = await connected()
  const tr = new RelayTransport(client, 0, 4, () => 0)
  ws.server({ t: 'player_left', seat: 2 })
  assert.deepEqual([0, 1, 2, 3].map((p) => tr.closed(p)), [false, false, true, false])
  ws.close()
  assert.deepEqual([0, 1, 2, 3].map((p) => tr.closed(p)), [true, true, true, true])
  assert.throws(() => new RelayTransport(client, 4, 4, () => 0), (e: unknown) => isRefusal(e) && e.path === 'selfPeer')
  assert.throws(() => new RelayTransport(client, 0, 5, () => 0), (e: unknown) => isRefusal(e) && e.path === 'peerCount')
})
