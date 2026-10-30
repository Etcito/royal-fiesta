import type { NetChannel } from '@gamesaloon/rollback'
import type { GroupTransport } from '@gamesaloon/rollback/zones'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { ZoneRelayClient } from './zoneRelayClient.ts'
import { MAX_ZONE_PEERS, RELAY_BIN_RATE_PER_SEC, RELAY_MAX_BIN_BYTES, ZONE_BIN_IN_HEADER } from './zoneRelayProtocol.ts'

export interface ZoneRelayTransportStats {
  frames: number; bytesOut: number; maxFrameBytes: number; droppedFast: number; deferredReliable: number
}
interface Packet { peer: number; ch: NetChannel; data: Uint8Array }
interface Pending { lo: number; hi: number; payload: Uint8Array }

/** One masked binary frame per packet, with a shared rolling one-second budget. */
export class ZoneRelayTransport implements GroupTransport {
  readonly stats: ZoneRelayTransportStats = { frames: 0, bytesOut: 0, maxFrameBytes: 0, droppedFast: 0, deferredReliable: 0 }
  malformed = 0
  private client: ZoneRelayClient
  private selfPeer: number
  private peerCount: number
  private clock: () => number
  private closedPeers: boolean[]
  private allClosed = false
  private inbox: Packet[] = []
  private pending: Pending[] = []
  private sentAt: number[] = []

  constructor(client: ZoneRelayClient, selfPeer: number, peerCount: number, now: () => number) {
    if (!Number.isInteger(peerCount) || peerCount < 2 || peerCount > MAX_ZONE_PEERS) {
      refuse('relay', 'peerCount', `${peerCount} is outside 2..${MAX_ZONE_PEERS}; pass the zone peer count`)
    }
    if (!Number.isInteger(selfPeer) || selfPeer < 0 || selfPeer >= peerCount) {
      refuse('relay', 'selfPeer', `${selfPeer} is outside 0..${peerCount - 1}; pass matched.youAre`)
    }
    this.client = client
    this.selfPeer = selfPeer
    this.peerCount = peerCount
    this.clock = now
    this.closedPeers = new Array<boolean>(peerCount).fill(false)
    client.onBinary((sender, payload) => {
      const channel = payload[0]
      if (!Number.isInteger(sender) || sender < 0 || sender >= peerCount || sender === selfPeer
        || (channel !== 0 && channel !== 1)) { this.malformed++; return }
      this.inbox.push({ peer: sender, ch: channel === 0 ? 'fast' : 'reliable', data: new Uint8Array(payload.subarray(1)) })
    })
    client.onSeatEvent(ev => {
      if (ev.t === 'player_left' && Number.isInteger(ev.seat) && ev.seat >= 0 && ev.seat < peerCount) this.closedPeers[ev.seat] = true
    })
    client.onClose(() => { this.allClosed = true; this.pending = [] })
  }

  send(peer: number, ch: NetChannel, data: Uint8Array): void { this.sendMany([peer], ch, data) }

  sendMany(peers: readonly number[], ch: NetChannel, data: Uint8Array): void {
    let lo = 0, hi = 0
    for (const peer of peers) {
      if (!Number.isInteger(peer) || peer < 0 || peer >= this.peerCount || peer === this.selfPeer || this.closed(peer)) continue
      if (peer < 32) lo |= 1 << peer
      else hi |= 1 << (peer - 32)
    }
    if ((lo | hi) === 0) return
    const size = ZONE_BIN_IN_HEADER + 1 + data.byteLength
    if (size > RELAY_MAX_BIN_BYTES) {
      refuse('relay', 'binary.payload', `frame is ${size} bytes, exceeding the ${RELAY_MAX_BIN_BYTES} byte cap; split the packet before sending`)
    }
    // Older reliable packets always get the first available budget slots.
    this.flush()
    if (this.allClosed) return
    const t = this.now()
    const available = this.budget(t) > 0
    if (!available && ch === 'fast') { this.stats.droppedFast++; return }
    const payload = new Uint8Array(1 + data.byteLength)
    payload[0] = ch === 'reliable' ? 1 : 0
    payload.set(data, 1)
    const packet = { lo: lo >>> 0, hi: hi >>> 0, payload }
    if (!available) { this.pending.push(packet); this.stats.deferredReliable++; return }
    this.emit(packet, t)
  }

  /** Call once per page/bot frame to release deferred reliable packets in order. */
  flush(): void {
    if (this.allClosed) { this.pending = []; return }
    const t = this.now()
    let budget = this.budget(t)
    while (this.pending.length > 0) {
      const packet = this.pending[0]
      // Never turn an emptied mask into the protocol's broadcast-to-all mask.
      for (let peer = 0; peer < this.peerCount; peer++) {
        if (!this.closed(peer)) continue
        if (peer < 32) packet.lo &= ~(1 << peer)
        else packet.hi &= ~(1 << (peer - 32))
      }
      if ((packet.lo | packet.hi) === 0) { this.pending.shift(); continue }
      if (budget === 0) break
      this.emit(packet, t)
      this.pending.shift()
      budget--
    }
  }

  drain(out: Packet[]): void {
    for (let i = 0; i < this.inbox.length; i++) {
      const p = this.inbox[i], e = out[i]
      if (e) { e.peer = p.peer; e.ch = p.ch; e.data = p.data }
      else out.push({ peer: p.peer, ch: p.ch, data: p.data })
    }
    out.length = this.inbox.length
    this.inbox = []
  }

  closed(peer: number): boolean { return this.allClosed || this.closedPeers[peer] === true }
  now(): number { return this.clock() }

  private budget(t: number): number {
    let expired = 0
    while (expired < this.sentAt.length && t - this.sentAt[expired] >= 1000) expired++
    if (expired > 0) this.sentAt.splice(0, expired)
    return Math.max(0, RELAY_BIN_RATE_PER_SEC - this.sentAt.length)
  }

  private emit(packet: Pending, t: number): void {
    this.client.sendBinary(packet.lo >>> 0, packet.hi >>> 0, packet.payload)
    this.sentAt.push(t)
    const size = ZONE_BIN_IN_HEADER + packet.payload.byteLength
    this.stats.frames++
    this.stats.bytesOut += size
    this.stats.maxFrameBytes = Math.max(this.stats.maxFrameBytes, size)
  }
}
