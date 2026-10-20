import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetChannel } from '@gamesaloon/rollback'
import { LoopbackRelay } from '../src/net/loopbackRelay.ts'
import { RelayClient } from '../src/net/relayClient.ts'
import type { FiestaQueuePayload } from '../src/net/relayClient.ts'
import { RelayTransport } from '../src/net/relayTransport.ts'

type Obj = Record<string, unknown>
const URL = 'ws://loopback/relay'
const payload = (c: number): FiestaQueuePayload => ({ g: 'royal-fiesta', v: 1, name: `Bean${c}`, c })
// A macrotask lets every auto-scheduled pump microtask run.
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

async function clients(relay: LoopbackRelay, n: number): Promise<RelayClient[]> {
  const out: RelayClient[] = []
  for (let i = 0; i < n; i++) {
    const c = new RelayClient(URL, relay.factory())
    await c.connect(1000)
    out.push(c)
  }
  return out
}

// A bare socket on the loopback, for frames the RelayClient refuses to send.
function raw(relay: LoopbackRelay, log?: { to: number; t: string }[], index = 0) {
  const s = relay.factory()(URL)
  const got: Obj[] = []
  const state = { closed: false }
  s.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Obj
    got.push(m)
    log?.push({ to: index, t: m.t as string })
  }
  s.onclose = () => { state.closed = true }
  relay.pump()
  const send = (m: Obj) => s.send(JSON.stringify(m))
  return { s, got, state, send }
}

async function privateRoom(seed: number) {
  const relay = new LoopbackRelay({ seed })
  const cs = await clients(relay, 4)
  const code = await cs[0].create(4, payload(0))
  const joins = []
  for (let i = 1; i < 4; i++) joins.push(await cs[i].join(code, payload(i)))
  await settle()
  return { relay, cs, code, joins }
}

test('create(4) + 3 joins: deterministic 4-digit code, seats 0..3, room/waiting/matched as the hub sends them', async () => {
  const a = await privateRoom(7)
  const b = await privateRoom(7)
  assert.match(a.code, /^\d{4}$/)
  assert.equal(a.code, b.code)
  assert.deepEqual(a.joins.slice(0, 2), [{ seat: 1, players: 4 }, { seat: 2, players: 4 }])
  const last = a.joins[2] as Obj
  assert.equal(last.t, 'matched')
  assert.deepEqual(a.cs.map((c) => c.seat), [0, 1, 2, 3])
  assert.deepEqual(a.cs.map((c) => c.matched?.youAre), [0, 1, 2, 3])
  assert.equal(new Set(a.cs.map((c) => c.matched?.seed)).size, 1)
  assert.deepEqual(a.cs[0].matched?.opps, [0, 1, 2, 3].map(payload))
  const types = (to: number) => a.relay.serverLog.filter((e) => e.to === to).map((e) => e.t)
  assert.deepEqual(types(0), ['room', 'matched'])
  assert.deepEqual(types(1), ['waiting', 'matched'])
  assert.deepEqual(types(2), ['waiting', 'matched'])
  assert.deepEqual(types(3), ['matched'])
})

test('acts before the room is full reach seated clients, ack the sender, and count per seat', async () => {
  const relay = new LoopbackRelay({ seed: 3 })
  const cs = await clients(relay, 3)
  const code = await cs[0].create(4, payload(0))
  await cs[1].join(code, payload(1))
  const got: { who: number; a: unknown; from: number; n: number }[] = []
  cs.forEach((c, who) => c.onAct((a, from, n) => got.push({ who, a, from, n })))
  cs[0].act({ k: 'x', i: 1 })
  cs[0].act({ k: 'x', i: 2 })
  cs[1].act({ k: 'y' })
  await settle()
  assert.deepEqual(got, [
    { who: 1, a: { k: 'x', i: 1 }, from: 0, n: 1 },
    { who: 1, a: { k: 'x', i: 2 }, from: 0, n: 2 },
    { who: 0, a: { k: 'y' }, from: 1, n: 1 },
  ])
  // Client 2 is connected but not seated: it receives nothing.
  assert.equal(relay.serverLog.filter((e) => e.to === 2).length, 0)
  assert.equal(relay.serverLog.filter((e) => e.to === 0 && e.t === 'ack').length, 2)
  assert.equal(relay.serverLog.filter((e) => e.to === 1 && e.t === 'ack').length, 1)
})

test('queue(4) matches FIFO with one seed; a raw players 5 queue is ignored', async () => {
  const relay = new LoopbackRelay({ seed: 11 })
  const cs = await clients(relay, 4)
  const ms = await Promise.all(cs.map((c, i) => c.queue(4, payload(i))))
  assert.deepEqual(ms.map((m) => m.youAre), [0, 1, 2, 3])
  assert.equal(new Set(ms.map((m) => m.seed)).size, 1)
  assert.deepEqual(ms[2].opps, [0, 1, 2, 3].map(payload))
  assert.deepEqual(relay.serverLog.filter((e) => e.to === 0).map((e) => e.t), ['queued', 'matched'])
  assert.throws(() => cs[0].queue(5, payload(0)), /queue\.players/)

  const r = raw(relay)
  const before = relay.serverLog.length
  r.send({ t: 'queue', players: 5, cadence: true, payload: payload(9) })
  relay.pump()
  await settle()
  assert.deepEqual(r.got, [])
  assert.equal(relay.serverLog.length, before)
})

test('oversize frames are ignored; over 90 acts/s from a cadence seat is rate limited and closed', async () => {
  const relay = new LoopbackRelay({ seed: 5 })
  const a = raw(relay)
  const b = raw(relay)
  a.send({ t: 'queue', players: 2, cadence: true, payload: payload(0) })
  b.send({ t: 'queue', players: 2, cadence: true, payload: payload(1) })
  relay.pump()
  assert.deepEqual(a.got.map((m) => m.t), ['queued', 'matched'])
  assert.deepEqual(b.got.map((m) => m.t), ['matched'])
  a.got.length = 0
  b.got.length = 0

  a.send({ t: 'act', a: { pad: 'x'.repeat(4200) } })
  relay.pump()
  assert.equal(a.got.length, 0)
  assert.equal(b.got.length, 0)

  // queue + oversize already count: the 89th act is the 91st frame of the second.
  for (let i = 0; i < 95; i++) a.send({ t: 'act', a: { i } })
  relay.pump()
  const acks = a.got.filter((m) => m.t === 'ack')
  assert.equal(acks.length, 88)
  assert.deepEqual(a.got[88], { t: 'error', reason: 'rate limited' })
  assert.equal(a.got.length, 89)
  assert.equal(a.state.closed, true)
  assert.equal(b.got.filter((m) => m.t === 'act').length, 88)
  // The disconnect holds the seat for the grace: b hears the drop, not a leave.
  assert.equal(b.got.at(-1)?.t, 'opp_dropped')
})

test('bye gives player_left to the other seats; ping gets pong', async () => {
  const relay = new LoopbackRelay({ seed: 9 })
  const cs = await clients(relay, 4)
  await Promise.all(cs.map((c, i) => c.queue(4, payload(i))))
  const events: { who: number; t: string; seat: number }[] = []
  cs.forEach((c, who) => c.onSeatEvent((ev) => events.push({ who, ...ev })))
  cs[3].bye()
  await settle()
  assert.deepEqual(events, [0, 1, 2].map((who) => ({ who, t: 'player_left', seat: 3 })))

  const r = raw(relay)
  r.send({ t: 'ping' })
  relay.pump()
  assert.deepEqual(r.got, [{ t: 'pong' }])
})

test('4 RelayTransports exchange 200 packets each on both channels with exact bytes', async () => {
  const relay = new LoopbackRelay({ seed: 21 })
  const cs = await clients(relay, 4)
  await Promise.all(cs.map((c, i) => c.queue(4, payload(i))))
  const now = () => globalThis.performance.now()
  const ts = cs.map((c) => new RelayTransport(c, c.seat, 4, now))
  const chans: NetChannel[] = ['fast', 'reliable']
  const packet = (from: number, ch: number, k: number) =>
    Uint8Array.from({ length: 3 + (k % 11) }, (_, j) => (from * 61 + ch * 17 + k * 7 + j * 3) & 255)
  const PER_FRAME = 20
  for (let f = 0; f < 10; f++) {
    ts.forEach((t, from) => {
      for (let i = 0; i < PER_FRAME; i++) {
        const k = f * PER_FRAME + i
        chans.forEach((ch, c) => { for (let p = 0; p < 4; p++) if (p !== from) t.send(p, ch, packet(from, c, k)) })
      }
      t.endFrame()
    })
    await settle()
  }
  ts.forEach((t, self) => {
    const out: { peer: number; ch: NetChannel; data: Uint8Array }[] = []
    t.drain(out)
    for (let from = 0; from < 4; from++) {
      chans.forEach((ch, c) => {
        const got = out.filter((g) => g.peer === from && g.ch === ch).map((g) => [...g.data])
        const want = from === self ? [] : Array.from({ length: 200 }, (_, k) => [...packet(from, c, k)])
        assert.deepEqual(got, want, `seat ${self} from ${from} on ${ch}`)
      })
    }
    assert.equal(t.stats.droppedFast, 0)
    assert.equal(t.stats.deferredReliable, 0)
  })
})

test('serverLog lists {to, t} in delivery order', async () => {
  const relay = new LoopbackRelay({ seed: 2 })
  const log: { to: number; t: string }[] = []
  const a = raw(relay, log, 0)
  const b = raw(relay, log, 1)
  a.send({ t: 'create', players: 2 })
  relay.pump()
  b.send({ t: 'join', code: a.got[0].code })
  b.send({ t: 'ping' })
  a.send({ t: 'act', a: { hi: 1 } })
  b.send({ t: 'act', a: { hi: 2 } })
  b.send({ t: 'bye' })
  relay.pump()
  assert.deepEqual(log.map((e) => e.t), ['room', 'matched', 'matched', 'pong', 'ack', 'act', 'ack', 'act', 'opp_left'])
  assert.deepEqual(relay.serverLog, log)
})
