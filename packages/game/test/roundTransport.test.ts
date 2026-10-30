import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetChannel } from '@gamesaloon/rollback'
import type { GroupTransport } from '@gamesaloon/rollback/zones'
import { RoundTransport } from '../src/net/roundTransport.ts'

type Packet = { peer: number; ch: NetChannel; data: Uint8Array }

class FakeTransport implements GroupTransport {
  peer: number
  network: FakeTransport[]
  inbox: Packet[] = []
  received: Packet[] = []
  sentBuffers: ArrayBufferLike[] = []
  batches: number[][] = []
  closedPeers = new Set<number>()
  time = 123

  constructor(peer: number, network: FakeTransport[]) { this.peer = peer; this.network = network }

  send(peer: number, ch: NetChannel, data: Uint8Array): void {
    this.sentBuffers.push(data.buffer)
    this.network[peer].inbox.push({ peer: this.peer, ch, data: new Uint8Array(data) })
  }

  sendMany(peers: readonly number[], ch: NetChannel, data: Uint8Array): void {
    this.batches.push([...peers])
    for (const peer of peers) this.send(peer, ch, data)
  }

  drain(out: Packet[]): void {
    // Invalidate the previous drain's views, as a base with reused receive storage may do.
    for (const packet of this.received) packet.data.fill(0xee)
    this.received = this.inbox
    this.inbox = []
    for (let i = 0; i < this.received.length; i++) {
      const packet = this.received[i]
      if (out[i]) Object.assign(out[i], packet)
      else out.push({ ...packet })
    }
    out.length = this.received.length
  }

  closed(peer: number): boolean { return this.closedPeers.has(peer) }
  now(): number { return this.time }
}

function pair(batched = true) {
  const bases: FakeTransport[] = []
  for (let peer = 0; peer < 2; peer++) bases.push(new FakeTransport(peer, bases))
  const rounds = bases.map(base => new RoundTransport(batched ? base : {
    send: base.send.bind(base), drain: base.drain.bind(base),
    closed: base.closed.bind(base), now: base.now.bind(base),
  }))
  return { bases, sender: rounds[0], receiver: rounds[1] }
}

test('round 0 strips the tag and reuses output entries', () => {
  const { bases, sender, receiver } = pair()
  sender.send(1, 'fast', new Uint8Array([7, 8, 9]))
  const wire = bases[1].inbox[0].data
  assert.deepEqual([...wire], [0, 0, 7, 8, 9])
  const entry: Packet = { peer: 9, ch: 'reliable', data: new Uint8Array() }
  const out = [entry, { ...entry }]
  receiver.drain(out)
  assert.equal(out[0], entry)
  assert.deepEqual(out, [{ peer: 0, ch: 'fast', data: new Uint8Array([7, 8, 9]) }])
  assert.equal(out[0].data.buffer, wire.buffer, 'current payload is a view')
  receiver.drain(out)
  assert.equal(out.length, 0)
})

test('future frames survive sender and receiver buffer reuse and arrive before fresh frames', () => {
  const { bases, sender, receiver } = pair()
  const out: Packet[] = []
  sender.setRound(1)
  sender.send(1, 'fast', new Uint8Array([10, 11]))
  receiver.drain(out)
  assert.equal(out.length, 0)
  sender.send(1, 'reliable', new Uint8Array([20, 21]))
  receiver.drain(out)
  assert.equal(out.length, 0)
  sender.send(1, 'fast', new Uint8Array([30]))
  assert.equal(bases[0].sentBuffers[0], bases[0].sentBuffers[2])
  receiver.setRound(1)
  receiver.drain(out)
  assert.deepEqual(out.map(p => [...p.data]), [[10, 11], [20, 21], [30]])
  assert.deepEqual(out.map(p => p.ch), ['fast', 'reliable', 'fast'])
  receiver.drain(out)
  assert.equal(out.length, 0)
})

test('old frames arriving after setRound are dropped and counted', () => {
  const { sender, receiver } = pair()
  receiver.setRound(1)
  sender.send(1, 'reliable', new Uint8Array([99]))
  const out: Packet[] = []
  receiver.drain(out)
  assert.equal(out.length, 0)
  assert.equal(receiver.stale, 1)
  assert.equal(receiver.malformed, 0)
})

test('results notify every listener immediately regardless of round', () => {
  const { bases, sender, receiver } = pair()
  const seen: unknown[] = []
  let wire: Uint8Array
  for (const listener of ['a', 'b']) receiver.onResult((peer, round, payload) => {
    assert.equal(payload.buffer, wire.buffer)
    seen.push([listener, peer, round, [...payload]])
  })
  const out: Packet[] = []
  for (const round of [0, 1, 2, 255]) {
    sender.setRound(round)
    receiver.setRound(1)
    sender.sendResult([1], new Uint8Array([42]))
    wire = bases[1].inbox[0].data
    assert.equal(bases[1].inbox[0].ch, 'reliable')
    assert.deepEqual([...wire], [1, round, 42])
    seen.length = 0
    receiver.drain(out)
    assert.deepEqual(seen, [['a', 0, round, [42]], ['b', 0, round, [42]]])
    assert.equal(out.length, 0)
  }
  assert.equal(receiver.stale, 0)
})

for (const batched of [true, false]) {
  test(`sendMany targets only listed peers (${batched ? 'batch' : 'fallback'})`, () => {
    const { bases, sender, receiver } = pair(batched)
    sender.sendMany([1], 'fast', new Uint8Array([5]))
    sender.sendMany([], 'fast', new Uint8Array([6]))
    const out: Packet[] = []
    sender.drain(out)
    assert.equal(out.length, 0)
    receiver.drain(out)
    assert.deepEqual(out.map(p => [...p.data]), [[5]])
    sender.sendMany([0], 'reliable', new Uint8Array([7]))
    receiver.drain(out)
    assert.equal(out.length, 0)
    sender.drain(out)
    assert.deepEqual(out.map(p => [...p.data]), [[7]])
    assert.deepEqual(bases[0].batches, batched ? [[1], [], [0]] : [])
    sender.sendResult([1], new Uint8Array([8]))
    assert.deepEqual([...bases[1].inbox[0].data], [1, 0, 8])
    assert.equal(bases[1].inbox[0].ch, 'reliable')
  })
}

test('round tags wrap, retain later rounds, and discard skipped pending rounds', () => {
  const { sender, receiver } = pair()
  receiver.setRound(255)
  for (const round of [256, 257, 256, 258, 382, 383, 254]) {
    sender.setRound(round)
    sender.send(1, 'fast', new Uint8Array([round & 255]))
  }
  const out: Packet[] = []
  receiver.drain(out)
  assert.equal(out.length, 0)
  assert.equal(receiver.stale, 2, 'delta 128 and old rounds are stale')
  receiver.setRound(256)
  receiver.drain(out)
  assert.deepEqual(out.map(p => [...p.data]), [[0], [0]])
  receiver.setRound(258)
  receiver.drain(out)
  assert.deepEqual(out.map(p => [...p.data]), [[2]])
  assert.equal(receiver.stale, 3, 'skipped pending round is stale')
  receiver.setRound(382)
  receiver.drain(out)
  assert.deepEqual(out.map(p => [...p.data]), [[126]])
})

test('short and unknown frames are malformed; empty tagged payloads are valid', () => {
  const { bases, receiver } = pair()
  for (const data of [[], [0], [1], [2, 0], [255, 0], [0, 0], [1, 99]]) {
    bases[0].send(1, 'fast', new Uint8Array(data))
  }
  const results: number[] = []
  receiver.onResult((_peer, round, payload) => {
    results.push(round)
    assert.equal(payload.length, 0)
  })
  const out: Packet[] = []
  receiver.drain(out)
  assert.equal(receiver.malformed, 5)
  assert.equal(receiver.stale, 0)
  assert.deepEqual(out.map(p => [...p.data]), [[]])
  assert.deepEqual(results, [99])
})

test('pending is capped at 8192, counts overflow, and frees capacity after delivery', () => {
  const { sender, receiver } = pair()
  sender.setRound(1)
  for (let i = 0; i < 8193; i++) sender.send(1, 'fast', new Uint8Array([i & 255]))
  const out: Packet[] = []
  receiver.drain(out)
  assert.equal(out.length, 0)
  assert.equal(receiver.overflow, 1)
  receiver.setRound(1)
  sender.setRound(2)
  sender.send(1, 'fast', new Uint8Array([42]))
  receiver.drain(out)
  assert.equal(out.length, 8192)
  for (let i = 0; i < out.length; i++) assert.deepEqual([...out[i].data], [i & 255])
  receiver.setRound(2)
  receiver.drain(out)
  assert.deepEqual(out.map(p => [...p.data]), [[42]])
  assert.equal(receiver.overflow, 1)
})

test('send buffer grows without retaining trailing bytes and delegates status and time', () => {
  const { bases, sender, receiver } = pair()
  const large = new Uint8Array(4096).fill(17)
  sender.send(1, 'reliable', large)
  sender.send(1, 'fast', new Uint8Array([3]))
  assert.equal(bases[0].sentBuffers[0], bases[0].sentBuffers[1])
  const out: Packet[] = []
  receiver.drain(out)
  assert.deepEqual(out.map(p => p.data), [large, new Uint8Array([3])])
  assert.equal(sender.now(), 123)
  bases[0].time = 456
  assert.equal(sender.now(), 456)
  assert.equal(sender.closed(1), false)
  bases[0].closedPeers.add(1)
  assert.equal(sender.closed(1), true)
  assert.equal(sender.closed(0), false)
})
