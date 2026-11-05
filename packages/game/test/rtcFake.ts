import assert from 'node:assert/strict'
import type { NetChannel } from '@gamesaloon/rollback'
import type { RtcBackend, RtcChannel, RtcPeer, IceCandidate } from '../src/net/rtcBackend.ts'
import type { IceServer } from '../src/net/roomsProtocol.ts'
const labels = ['fast', 'reliable'] as const

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
  network: RtcNetwork
  iceFn?: (c: IceCandidate | null) => void
  resolve!: (channels: { fast: RtcChannel; reliable: RtcChannel }) => void
  ready = new Promise<{ fast: RtcChannel; reliable: RtcChannel }>((resolve) => { this.resolve = resolve })
  constructor(network: RtcNetwork, self: number, initiator: boolean) {
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

export class RtcNetwork {
  peers = new Map<string, Peer>()
  stall: number[] = []
  iceServers: IceServer[][] = []
  backend(self: number): RtcBackend {
    return { createPeer: (ice: IceServer[], initiator) => {
      this.iceServers.push(ice)
      const peer = new Peer(this, self, initiator)
      this.peers.set(peer.id, peer)
      return peer
    } }
  }
}

