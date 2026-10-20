import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { NetChannel } from '@gamesaloon/rollback'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { RoomsClient } from '../src/net/roomsClient.ts'
import { fiestaLocalPlayer } from '../src/net/roomsProtocol.ts'
import type { IceServer, LocalPlayer, SignalData, Started } from '../src/net/roomsProtocol.ts'
import { browserRtcBackend } from '../src/net/rtcBackend.ts'
import type { IceCandidate, RtcBackend, RtcChannel, RtcPeer } from '../src/net/rtcBackend.ts'
import { playerOfPeer, WebRtcTransport } from '../src/net/webrtcTransport.ts'
import type { WsFactory, WsLike } from '../src/net/ws.ts'

type Packet = { peer: number; ch: NetChannel; data: Uint8Array }
type Request = { t: string; rid?: number; players: LocalPlayer[]; to: number; data: SignalData }
const labels = ['fast', 'reliable'] as const
const settings = { kind: 'cup', cupId: 'cup', trackId: 'sprint', cc: 100, items: false }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

class Socket implements WsLike {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  peer: number
  players: LocalPlayer[] = []
  hub: Rooms
  constructor(hub: Rooms, peer: number) {
    this.hub = hub; this.peer = peer
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }
  send(raw: string): void { queueMicrotask(() => this.hub.handle(this, JSON.parse(raw) as Request)) }
  deliver(msg: object): void {
    queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) }) })
  }
  close(): void { this.readyState = 3; this.hub.remove(this); this.onclose?.({ code: 1000, reason: 'bye' }) }
}

class Rooms {
  sockets: Socket[] = []
  members: Socket[] = []
  signals: { from: number; to: number; data: SignalData }[] = []
  racing = false
  factory(ids: number[]): WsFactory {
    return () => { const s = new Socket(this, ids[this.sockets.length]); this.sockets.push(s); return s }
  }
  snapshot() {
    return { code: 'ROOM', settings, members: this.members.map((s) => ({ peer: s.peer, name: `Bean${s.peer}`, players: s.players })) }
  }
  room(s: Socket, rid?: number): void {
    s.deliver({ ...this.snapshot(), t: 'room', rid, you: s.peer, owner: this.members[0].peer,
      status: this.racing ? 'racing' : 'lobby', humans: this.members.length })
  }
  handle(s: Socket, m: Request): void {
    switch (m.t) {
      case 'hello': return s.deliver({ t: 'welcome', v: 1, client: String(s.peer), iceServers: [], maxHumans: 8, maxLocal: 4 })
      case 'create': case 'join':
        s.players = m.players; this.members.push(s)
        for (const member of this.members) this.room(member, member === s ? m.rid : undefined)
        return
      case 'start':
        assert.equal(s, this.members[0]); this.racing = true
        for (const member of this.members) member.deliver({ ...this.snapshot(), t: 'started', seed: 123, rid: member === s ? m.rid : undefined })
        return
      case 'signal':
        this.signals.push({ from: s.peer, to: m.to, data: m.data })
        return this.members.find((member) => member.peer === m.to)!.deliver({ t: 'signal', from: s.peer, data: m.data })
      case 'leave': this.remove(s); return s.deliver({ t: 'left' })
      default: assert.fail(`unexpected rooms message: ${m.t}`)
    }
  }
  remove(s: Socket): void {
    if (!this.members.includes(s)) return
    this.members = this.members.filter((member) => member !== s)
    for (const member of this.members) { member.deliver({ t: 'peerLeft', peer: s.peer }); this.room(member) }
  }
}

class Channel implements RtcChannel {
  label: NetChannel
  open = false
  drop = false
  other?: Channel
  messages: ((data: Uint8Array) => void)[] = []
  closes: (() => void)[] = []
  constructor(label: NetChannel) { this.label = label }
  send(data: Uint8Array): void {
    assert.ok(this.open)
    if (this.label === 'fast' && this.drop) return
    // Retain the buffer until delivery, then reuse it to expose missing copies at either end.
    queueMicrotask(() => { for (const fn of this.other!.messages) fn(data); data.fill(238) })
  }
  onMessage(fn: (data: Uint8Array) => void): void { this.messages.push(fn) }
  onClose(fn: () => void): void { this.closes.push(fn) }
  close(): void {
    if (!this.open) return
    this.open = false
    for (const fn of this.closes) fn()
    this.other?.close()
  }
}

class Peer implements RtcPeer {
  chans = { fast: new Channel('fast'), reliable: new Channel('reliable') }
  remote?: Peer
  remoteSet = false
  early: IceCandidate[] = []
  applied: IceCandidate[] = []
  buffered = 0
  id: string
  self: number
  initiator: boolean
  network: Network
  iceFn?: (c: IceCandidate | null) => void
  resolve!: (channels: { fast: RtcChannel; reliable: RtcChannel }) => void
  ready = new Promise<{ fast: RtcChannel; reliable: RtcChannel }>((resolve) => { this.resolve = resolve })
  constructor(network: Network, self: number, initiator: boolean) {
    this.network = network; this.self = self; this.initiator = initiator
    this.id = `${self}:${network.peers.size}`
  }
  emitIce(): void { this.iceFn?.({ candidate: this.id, sdpMid: '0', sdpMLineIndex: 0 }); this.iceFn?.(null) }
  setRemote(): void { this.remoteSet = true; this.applied.push(...this.early.splice(0)) }
  async createOffer(): Promise<string> { assert.ok(this.initiator); this.emitIce(); return this.id }
  async acceptOffer(sdp: string): Promise<string> {
    assert.equal(this.initiator, false)
    this.remote = this.network.peers.get(sdp)!
    assert.ok(this.remote.initiator)
    this.remote.remote = this; this.setRemote(); this.emitIce()
    return this.id
  }
  async acceptAnswer(sdp: string): Promise<void> {
    assert.equal(sdp, this.remote!.id); this.setRemote()
    if (this.network.stall.includes(this.self) && this.network.stall.includes(this.remote!.self)) return
    for (const ch of labels) {
      this.chans[ch].other = this.remote!.chans[ch]; this.remote!.chans[ch].other = this.chans[ch]
      this.chans[ch].open = true; this.remote!.chans[ch].open = true
    }
    this.resolve(this.chans); this.remote!.resolve(this.remote!.chans)
  }
  addIce(c: IceCandidate): void {
    if (this.remoteSet) this.applied.push(c)
    else { this.early.push(c); this.buffered++ }
  }
  onIce(fn: (c: IceCandidate | null) => void): void { this.iceFn = fn }
  channels(): Promise<{ fast: RtcChannel; reliable: RtcChannel }> { return this.ready }
  close(): void { for (const ch of labels) this.chans[ch].close() }
}

class Network {
  peers = new Map<string, Peer>()
  stall: number[] = []
  backend(self: number): RtcBackend {
    return { createPeer: (ice: IceServer[], initiator) => {
      assert.deepEqual(ice, [])
      const peer = new Peer(this, self, initiator)
      this.peers.set(peer.id, peer)
      return peer
    } }
  }
}

async function party(t: TestContext, ids: number[]) {
  const hub = new Rooms(), network = new Network(), factory = hub.factory(ids)
  const clients = ids.map(() => new RoomsClient('ws://fake/ws', factory))
  t.after(() => { for (const p of network.peers.values()) p.close(); for (const c of clients) c.close() })
  for (const [i, c] of clients.entries()) {
    await c.hello(`Bean${ids[i]}`)
    const player = fiestaLocalPlayer(`Bean${ids[i]}`, ids[i])
    if (i === 0) await c.create(player)
    else await c.join('ROOM', player)
  }
  const waits = clients.map((c) => c.waitStarted())
  await clients[0].start()
  const started = await Promise.all(waits)
  const connect = () => clients.map((c, i) => WebRtcTransport.connect(c, started[i], network.backend(ids[i]), () => 42, { timeoutMs: 200 }))
  return { hub, network, clients, started: started[0], connect }
}

const bytes = (from: number, to: number, ch: NetChannel, n: number) => new Uint8Array([99, from, to, ch === 'fast' ? 0 : 1, n, 0, 255]).subarray(1)
for (const ids of [[7, 1, 5, 3], [0, 1, 2, 3, 4, 5, 6, 7]]) {
  test(`${ids.length} members connect; lower ids offer; every pair exchanges 50 exact packets per channel`, async (t) => {
    const p = await party(t, ids), transports = await Promise.all(p.connect())
    const sorted = [...ids].sort((a, b) => a - b), pairs = ids.length * (ids.length - 1) / 2
    assert.deepEqual(transports.map((tr) => tr.selfPeer), ids)
    for (const tr of transports) { assert.deepEqual(tr.peerIds, sorted); assert.equal(tr.now(), 42) }
    assert.deepEqual(sorted.map((peer) => playerOfPeer(p.started, peer)), sorted.map((_, i) => i))
    assert.throws(() => playerOfPeer(p.started, 99), { name: 'RefusalError', path: 'playerOfPeer' })
    for (const kind of ['offer', 'answer', 'ice', 'ice-end']) {
      const signals = p.hub.signals.filter((s) => s.data.kind === kind)
      assert.equal(signals.length, pairs * (kind.startsWith('ice') ? 2 : 1))
      if (kind === 'offer') assert.ok(signals.every((s) => s.from < s.to))
      if (kind === 'answer') assert.ok(signals.every((s) => s.from > s.to))
    }
    for (const peer of p.network.peers.values()) {
      assert.equal(peer.buffered, 1)
      assert.deepEqual(peer.applied, [{ candidate: peer.remote!.id, sdpMid: '0', sdpMLineIndex: 0 }])
      assert.equal(peer.early.length, 0)
    }
    const signalCount = p.hub.signals.length
    for (const tr of transports) for (const to of sorted) if (to !== tr.selfPeer) for (const ch of labels) for (let n = 0; n < 50; n++) {
      const data = bytes(tr.selfPeer, to, ch, n)
      tr.send(to, ch, data); data.fill(255)
    }
    for (const tr of transports) { const out: Packet[] = []; tr.drain(out); assert.deepEqual(out, []) }
    await flush()
    for (const tr of transports) {
      const out: Packet[] = []
      tr.drain(out)
      assert.deepEqual(out, ids.filter((from) => from !== tr.selfPeer).flatMap((from) => labels.flatMap((ch) =>
        Array.from({ length: 50 }, (_, n) => ({ peer: from, ch, data: bytes(from, tr.selfPeer, ch, n) })))))
      tr.drain(out); assert.equal(out.length, 0)
    }
    assert.equal(p.hub.signals.length, signalCount)
    transports.forEach((tr) => tr.close())
  })
}

test('one unopened pair refuses after timeoutMs 200 and names exactly the missing peers', { timeout: 1500 }, async (t) => {
  const p = await party(t, [1, 3, 5, 7])
  p.network.stall = [1, 7]
  const done = Promise.allSettled(p.connect())
  await flush()
  assert.equal([...p.network.peers.values()].filter((peer) => !peer.chans.reliable.open).length, 2)
  const results = await done
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled', 'rejected'])
  for (const [index, missing] of [[0, 7], [3, 1]]) {
    const result = results[index]
    assert.ok(result.status === 'rejected' && result.reason instanceof RefusalError)
    assert.match(result.reason.message, new RegExp(`\\[webrtc\\] connect: timed out after 200 ms; missing peers: ${missing};`))
  }
})

test('fast loss preserves reliable delivery; channel close and peerLeft mark the affected peers closed', async (t) => {
  const p = await party(t, [1, 3, 5, 7]), tr = await Promise.all(p.connect())
  const peer = [...p.network.peers.values()].find((peer) => peer.self === 1 && peer.remote!.self === 3)!
  for (const ch of labels) { peer.chans[ch].drop = true; tr[0].send(3, ch, new Uint8Array([0, 255])) }
  await flush()
  const out: Packet[] = []; tr[1].drain(out)
  assert.deepEqual(out, [{ peer: 1, ch: 'reliable', data: new Uint8Array([0, 255]) }])
  peer.chans.fast.close()
  assert.ok(tr[0].closed(3) && tr[1].closed(1)); assert.equal(tr[0].closed(7), false)
  p.clients[2].leave(); await flush()
  for (const i of [0, 1, 3]) { assert.equal(tr[i].closed(5), true); assert.equal(tr[i].closed(tr[i].selfPeer), false) }
  assert.equal(tr[0].closed(7), false)
})

test('browser backend buffers ICE received before the offer and applies it after remote SDP', async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection'), applied: IceCandidate[] = []
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'RTCPeerConnection', saved); else Reflect.deleteProperty(globalThis, 'RTCPeerConnection') })
  const pc = {
    localDescription: { sdp: 'answer' }, setRemoteDescription: async () => {}, createAnswer: async () => ({ sdp: 'answer' }),
    setLocalDescription: async () => {}, addIceCandidate: async (c: IceCandidate) => { applied.push(c) }, close: () => {}
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: function () { return pc } })
  const peer = browserRtcBackend().createPeer([], false), candidate: IceCandidate = { candidate: 'early', sdpMid: null, sdpMLineIndex: null }
  peer.addIce(candidate); assert.deepEqual(applied, [])
  await peer.acceptOffer('offer'); assert.deepEqual(applied, [candidate])
  peer.close()
})
