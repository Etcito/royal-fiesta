import type { NetChannel } from '@gamesaloon/rollback'
import type { GroupTransport } from '@gamesaloon/rollback/zones'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { ZoneRelayClient } from './zoneRelayClient.ts'
import { MAX_ZONE_PEERS, RELAY_BIN_RATE_PER_SEC, RELAY_MAX_BIN_BYTES, ZONE_BIN_IN_HEADER } from './zoneRelayProtocol.ts'

/** Packet byte 0: bit 0 is the channel (0 fast, 1 reliable); bit 1 marks one part of a packet split across frames. */
const PART_FLAG = 2
/** Part header: flags, u16 part index, u16 part count. */
export const ZONE_PART_HEADER = 5
/** Largest packet sent as one frame: the relay cap minus the relay header and the flags byte. */
export const ZONE_WHOLE_MAX_BYTES = RELAY_MAX_BIN_BYTES - ZONE_BIN_IN_HEADER - 1
/** Packet bytes carried by each part frame, so every part frame is at most RELAY_MAX_BIN_BYTES. */
export const ZONE_PART_MAX_BYTES = RELAY_MAX_BIN_BYTES - ZONE_BIN_IN_HEADER - ZONE_PART_HEADER
/** Most parts of one packet (about 20 MB, above the 16 MiB snapshot limit). */
export const ZONE_MAX_PARTS = 1024

export interface ZoneRelayTransportStats {
  frames: number; bytesOut: number; maxFrameBytes: number; droppedFast: number; deferredReliable: number
}
interface Packet { peer: number; ch: NetChannel; data: Uint8Array }
interface Pending { lo: number; hi: number; payload: Uint8Array }
interface Assembly { reliable: boolean; count: number; next: number; size: number; chunks: Uint8Array[] }

/**
 * One masked binary frame per packet, with a shared rolling one-second budget. A packet larger than one relay frame
 * goes as consecutive part frames (one budget slot each) and is rebuilt per sender; the relay keeps each sender's
 * frames in order, so a sender's parts arrive contiguous.
 */
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
  private assembling: (Assembly | null)[]

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
    this.assembling = new Array<Assembly | null>(peerCount).fill(null)
    client.onBinary((sender, payload) => this.receive(sender, payload))
    client.onSeatEvent(ev => {
      if (ev.t === 'player_left' && Number.isInteger(ev.seat) && ev.seat >= 0 && ev.seat < peerCount) {
        this.closedPeers[ev.seat] = true
        this.assembling[ev.seat] = null
      }
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
    const frames = this.split(ch, data)
    // Older reliable packets always get the first available budget slots.
    this.flush()
    if (this.allClosed) return
    const t = this.now()
    let budget = this.budget(t)
    // A fast packet goes whole or not at all: a lone part could never be rebuilt.
    if (ch === 'fast' && budget < frames.length) { this.stats.droppedFast++; return }
    for (const payload of frames) {
      const packet = { lo: lo >>> 0, hi: hi >>> 0, payload }
      if (budget === 0) { this.pending.push(packet); this.stats.deferredReliable++; continue }
      this.emit(packet, t)
      budget--
    }
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

  /** The frame payloads of one packet, each at most RELAY_MAX_BIN_BYTES with the relay header. */
  private split(ch: NetChannel, data: Uint8Array): Uint8Array[] {
    const reliable = ch === 'reliable' ? 1 : 0
    if (data.byteLength <= ZONE_WHOLE_MAX_BYTES) {
      const payload = new Uint8Array(1 + data.byteLength)
      payload[0] = reliable
      payload.set(data, 1)
      return [payload]
    }
    const count = Math.ceil(data.byteLength / ZONE_PART_MAX_BYTES)
    if (count > ZONE_MAX_PARTS) {
      refuse('relay', 'binary.payload', `packet is ${data.byteLength} bytes, over ${ZONE_MAX_PARTS} parts of ${ZONE_PART_MAX_BYTES} bytes`)
    }
    const frames: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      const chunk = data.subarray(i * ZONE_PART_MAX_BYTES, Math.min(data.byteLength, (i + 1) * ZONE_PART_MAX_BYTES))
      const payload = new Uint8Array(ZONE_PART_HEADER + chunk.byteLength)
      payload[0] = PART_FLAG | reliable
      payload[1] = i & 0xff; payload[2] = i >>> 8
      payload[3] = count & 0xff; payload[4] = count >>> 8
      payload.set(chunk, ZONE_PART_HEADER)
      frames.push(payload)
    }
    return frames
  }

  private receive(sender: number, payload: Uint8Array): void {
    if (!Number.isInteger(sender) || sender < 0 || sender >= this.peerCount || sender === this.selfPeer
      || payload.byteLength < 1 || payload[0] > (PART_FLAG | 1)) { this.malformed++; return }
    const flags = payload[0], reliable = (flags & 1) === 1
    const open = this.assembling[sender]
    if ((flags & PART_FLAG) === 0) {
      // A sender's parts are contiguous; a whole packet inside them means the split packet is broken.
      if (open) { this.assembling[sender] = null; this.malformed++ }
      this.inbox.push({ peer: sender, ch: reliable ? 'reliable' : 'fast', data: new Uint8Array(payload.subarray(1)) })
      return
    }
    if (payload.byteLength <= ZONE_PART_HEADER) { this.assembling[sender] = null; this.malformed++; return }
    const index = payload[1] | (payload[2] << 8), count = payload[3] | (payload[4] << 8)
    const chunk = new Uint8Array(payload.subarray(ZONE_PART_HEADER))
    if (index === 0) {
      if (open) this.malformed++
      if (count < 1 || count > ZONE_MAX_PARTS) { this.assembling[sender] = null; this.malformed++; return }
      this.assembling[sender] = { reliable, count, next: 1, size: chunk.byteLength, chunks: [chunk] }
    } else {
      if (!open || open.next !== index || open.count !== count || open.reliable !== reliable) {
        this.assembling[sender] = null; this.malformed++; return
      }
      open.chunks.push(chunk)
      open.size += chunk.byteLength
      open.next++
    }
    const a = this.assembling[sender]!
    if (a.next < a.count) return
    this.assembling[sender] = null
    const data = new Uint8Array(a.size)
    let off = 0
    for (const c of a.chunks) { data.set(c, off); off += c.byteLength }
    this.inbox.push({ peer: sender, ch: a.reliable ? 'reliable' : 'fast', data })
  }

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
