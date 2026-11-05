import type { NetChannel } from '@gamesaloon/rollback'
import type { GroupTransport } from '@gamesaloon/rollback/zones'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { browserRtcBackend } from './rtcBackend.ts'
import type { RtcBackend, RtcChannel, RtcPeer } from './rtcBackend.ts'
import type { IceServer } from './roomsProtocol.ts'
import type { ZoneRelayClient } from './zoneRelayClient.ts'
import { MAX_ZONE_PEERS } from './zoneRelayProtocol.ts'
import type { ZoneSignal } from './zoneRelayProtocol.ts'

type Packet = { peer: number; ch: NetChannel; data: Uint8Array }
type Channels = { fast: RtcChannel; reliable: RtcChannel }
export interface MeshPeerStats { fast: 'connecting' | 'open' | 'closed'; reliable: 'connecting' | 'open' | 'closed'; rtt: number | null }
interface Link {
  rtc: RtcPeer; channels?: Channels; closed: boolean; receivedSdp: boolean; ready: boolean
  ping: { id: number; at: number } | null; lastPing: number
  parts: Map<string, { data: Uint8Array; offsets: Set<number>; size: number; at: number }>
}
const DATA = 0, PING = 1, PONG = 2, READY = 3
// Safe across browser SCTP implementations. Large snapshots are rebuilt on the same DataChannel.
const CHUNK = 16 * 1024, HEADER = 13, MAX_PACKET = 32 * 1024 * 1024
const DEFAULT_ICE: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }]

/** A direct, full WebRTC mesh. The relay is held only by the signaling callback, never by send()/sendMany(). */
export class ZoneMeshTransport implements GroupTransport {
  readonly selfPeer: number
  readonly peerIds: number[]
  readonly peers: Record<number, MeshPeerStats> = {}
  readonly rtt: Record<number, number> = {}
  readonly stats = { messagesOut: 0, messagesIn: 0, framesOut: 0, bytesOut: 0, malformed: 0 }
  private readonly clock: () => number
  private readonly links = new Map<number, Link>()
  private inbox: Packet[] = []
  private allClosed = false
  private sequence = 0
  private rejectConnect: ((e: Error) => void) | null = null
  private checkReady = (): void => {}
  private unsubscribe = (): void => {}

  private constructor(selfPeer: number, count: number, now: () => number) {
    this.selfPeer = selfPeer
    this.peerIds = Array.from({ length: count }, (_, peer) => peer)
    this.clock = now
  }

  static async connect(client: ZoneRelayClient, backend: RtcBackend | undefined, now: () => number,
    opts: { timeoutMs?: number; iceServers?: IceServer[]; onProgress?: (mesh: ZoneMeshTransport) => void } = {}): Promise<ZoneMeshTransport> {
    const matched = client.matched
    if (!matched || matched.players < 1 || matched.players > MAX_ZONE_PEERS) {
      throw new RefusalError('webrtc', 'mesh', 'await the zone room matched message before connecting')
    }
    const timeoutMs = opts.timeoutMs ?? 15000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RefusalError('webrtc', 'mesh.timeoutMs', 'supply a positive timeout')
    const mesh = new ZoneMeshTransport(matched.youAre, matched.players, now)
    opts.onProgress?.(mesh)
    // A solo lobby needs no RTC implementation (also works in headless tests).
    if (matched.players === 1) return mesh
    await mesh.open(client, backend ?? browserRtcBackend(), opts.iceServers ?? DEFAULT_ICE, timeoutMs)
    return mesh
  }

  send(peer: number, ch: NetChannel, data: Uint8Array): void {
    if (peer === this.selfPeer || this.closed(peer)) return
    if (data.length > MAX_PACKET) throw new RefusalError('webrtc', `mesh/${this.selfPeer}<->${peer}`, `packet exceeds ${MAX_PACKET} bytes`)
    const channel = this.links.get(peer)!.channels![ch]
    const id = this.sequence++ >>> 0
    for (let offset = 0; offset < data.length || offset === 0; offset += CHUNK) {
      const chunk = data.subarray(offset, offset + CHUNK)
      const frame = new Uint8Array(HEADER + chunk.length)
      const view = new DataView(frame.buffer)
      frame[0] = DATA
      view.setUint32(1, id, true)
      view.setUint32(5, offset, true)
      view.setUint32(9, data.length, true)
      frame.set(chunk, HEADER)
      try { channel.send(frame) } catch (error) { this.fail(peer, error); throw error }
      this.stats.framesOut++
      this.stats.bytesOut += frame.length
    }
    this.stats.messagesOut++
  }

  sendMany(peers: readonly number[], ch: NetChannel, data: Uint8Array): void {
    for (const peer of new Set(peers)) this.send(peer, ch, data)
  }

  drain(out: Packet[]): void {
    this.poll()
    for (let i = 0; i < this.inbox.length; i++) {
      const packet = this.inbox[i], entry = out[i]
      if (entry) { entry.peer = packet.peer; entry.ch = packet.ch; entry.data = packet.data }
      else out.push(packet)
    }
    out.length = this.inbox.length
    this.inbox = []
  }

  now(): number { return this.clock() }
  closed(peer: number): boolean {
    return this.allClosed || (peer !== this.selfPeer && (this.links.get(peer)?.closed ?? true))
  }

  close(): void {
    if (this.allClosed) return
    this.allClosed = true
    this.rejectConnect?.(new RefusalError('webrtc', 'mesh', `peer ${this.selfPeer} cancelled the mesh start`))
    this.unsubscribe()
    for (const peer of this.links.keys()) this.closePeer(peer)
    this.inbox = []
  }

  private closePeer(peer: number): void {
    const link = this.links.get(peer)
    if (!link || link.closed) return
    link.closed = true
    this.peers[peer].fast = this.peers[peer].reliable = 'closed'
    link.parts.clear()
    link.rtc.close()
  }

  private fail(peer: number, error: unknown): void {
    if (this.allClosed || this.links.get(peer)?.closed) return
    const refusal = new RefusalError('webrtc', `mesh/${this.selfPeer}<->${peer}`, String(error))
    if (this.rejectConnect) this.rejectConnect(refusal)
    else this.closePeer(peer)
  }

  private missing(): string[] {
    return [...this.links].filter(([, link]) => !link.channels?.fast.open || !link.channels.reliable.open)
      .map(([peer]) => `${this.selfPeer}<->${peer}`)
  }

  private async open(client: ZoneRelayClient, backend: RtcBackend, iceServers: IceServer[], timeoutMs: number): Promise<void> {
    const failed = new Promise<never>((_, reject) => { this.rejectConnect = reject })
    failed.catch(() => {})
    let resolveReady = (): void => {}
    const ready = new Promise<void>(resolve => { resolveReady = resolve })
    this.checkReady = () => { if ([...this.links.values()].every(link => link.ready)) resolveReady() }
    const timer = setTimeout(() => {
      const missing = this.missing()
      this.rejectConnect?.(new RefusalError('webrtc', 'mesh.start', `timed out after ${timeoutMs} ms; ${missing.length
        ? `channels not open for peers ${missing.join(', ')}`
        : `waiting for peers ${[...this.links].filter(([, l]) => !l.ready).map(([p]) => p).join(', ')} to open every pair`}; direct WebRTC is required; no relay fallback`))
    }, timeoutMs)
    try {
      const opened: Promise<void>[] = []
      for (const peer of this.peerIds) {
        if (peer === this.selfPeer) continue
        const rtc = backend.createPeer(iceServers, this.selfPeer < peer)
        const link: Link = { rtc, closed: false, receivedSdp: false, ready: false, ping: null, lastPing: -Infinity, parts: new Map() }
        this.links.set(peer, link)
        this.peers[peer] = { fast: 'connecting', reliable: 'connecting', rtt: null }
        rtc.onIce(candidate => {
          if (this.allClosed || link.closed) return
          try { client.signal(peer, candidate ? { kind: 'ice', ...candidate } : { kind: 'ice-end' }) }
          catch (error) { this.fail(peer, error) }
        })
        opened.push(rtc.channels().then(channels => {
          if (this.allClosed) return
          link.channels = channels
          for (const ch of ['fast', 'reliable'] as const) {
            this.peers[peer][ch] = 'open'
            channels[ch].onClose(() => this.fail(peer, `channel ${ch} closed`))
            channels[ch].onMessage(data => {
              if (this.allClosed || link.closed) return
              try { this.receive(peer, ch, data) } catch (error) { this.fail(peer, error) }
            })
          }
        }).catch(error => this.fail(peer, error)))
      }
      this.unsubscribe = client.onSignal((peer, signal) => {
        if (!this.allClosed) void this.receiveSignal(client, peer, signal).catch(error => this.fail(peer, error))
      })
      client.onClose(() => { if (this.rejectConnect) this.rejectConnect(new RefusalError('webrtc', 'mesh.start', `peer ${this.selfPeer} lost signaling before every pair opened`)) })
      client.onSeatEvent(ev => { if (ev.t === 'player_left') this.fail(ev.seat, 'peer left the room') })
      for (const [peer, link] of this.links) {
        if (this.selfPeer < peer) void link.rtc.createOffer().then(sdp => {
          if (!this.allClosed) client.signal(peer, { kind: 'offer', sdp })
        }).catch(error => this.fail(peer, error))
      }
      await Promise.race([Promise.all(opened), failed])
      if (this.missing().length) throw new Error(`channels not open for peers ${this.missing().join(', ')}`)
      // Each peer certifies all its own edges, so even peers outside a broken pair refuse to start.
      for (const link of this.links.values()) link.channels!.reliable.send(new Uint8Array([READY]))
      this.poll()
      await Promise.race([ready, failed])
    } catch (error) {
      const reason = String(error)
      for (const peer of this.links.keys()) {
        try { client.signal(peer, { kind: 'abort', reason }) } catch { /* Original refusal is more useful. */ }
      }
      this.close()
      throw error
    } finally {
      clearTimeout(timer)
      this.rejectConnect = null
    }
  }

  private async receiveSignal(client: ZoneRelayClient, from: number, signal: ZoneSignal): Promise<void> {
    const link = this.links.get(from)
    if (!link || link.closed) return
    if (signal.kind === 'abort') { this.fail(from, signal.reason); return }
    if (signal.kind === 'ice') { link.rtc.addIce(signal); return }
    if (signal.kind === 'ice-end') return
    if (link.receivedSdp || (signal.kind === 'offer') !== (from < this.selfPeer)) throw new Error(`unexpected ${signal.kind}; the lower peer id offers once`)
    link.receivedSdp = true
    if (signal.kind === 'offer') {
      const sdp = await link.rtc.acceptOffer(signal.sdp)
      if (!this.allClosed) client.signal(from, { kind: 'answer', sdp })
    } else await link.rtc.acceptAnswer(signal.sdp)
  }

  private poll(): void {
    const now = this.now()
    for (const [peer, link] of this.links) {
      for (const [key, part] of link.parts) if (key.startsWith('fast:') && now - part.at > 3000) link.parts.delete(key)
      if (link.closed || !link.channels || now - link.lastPing < 1000) continue
      const id = this.sequence++ >>> 0
      const ping = new Uint8Array(5)
      ping[0] = PING
      new DataView(ping.buffer).setUint32(1, id, true)
      link.ping = { id, at: now }
      link.lastPing = now
      try { link.channels.fast.send(ping) } catch (error) { this.fail(peer, error) }
    }
  }

  private receive(peer: number, ch: NetChannel, frame: Uint8Array): void {
    const link = this.links.get(peer)!
    if (frame[0] === READY && frame.length === 1 && ch === 'reliable') { link.ready = true; this.checkReady(); return }
    if ((frame[0] === PING || frame[0] === PONG) && frame.length === 5 && ch === 'fast') {
      const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, true)
      if (frame[0] === PING) { const pong = frame.slice(); pong[0] = PONG; link.channels!.fast.send(pong) }
      else if (link.ping?.id === id) {
        const rtt = Math.max(0, this.now() - link.ping.at)
        this.rtt[peer] = rtt
        this.peers[peer].rtt = rtt
        link.ping = null
      }
      return
    }
    if (frame[0] !== DATA || frame.length < HEADER) { this.stats.malformed++; return }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const id = view.getUint32(1, true), offset = view.getUint32(5, true), size = view.getUint32(9, true)
    const chunk = frame.subarray(HEADER)
    if (size > MAX_PACKET || offset % CHUNK !== 0 || offset > size || chunk.length !== Math.min(CHUNK, size - offset)) { this.stats.malformed++; return }
    if (offset === 0 && chunk.length === size) { this.deliver(peer, ch, chunk.slice()); return }
    const key = `${ch}:${id}`
    let part = link.parts.get(key)
    if (!part) {
      if (link.parts.size >= 64 || [...link.parts.values()].reduce((n, p) => n + p.data.length, size) > 64 * 1024 * 1024) { this.stats.malformed++; return }
      part = { data: new Uint8Array(size), offsets: new Set(), size: 0, at: this.now() }
      link.parts.set(key, part)
    }
    if (part.data.length !== size || part.offsets.has(offset)) { this.stats.malformed++; return }
    part.data.set(chunk, offset)
    part.offsets.add(offset)
    part.size += chunk.length
    if (part.size === size) { link.parts.delete(key); this.deliver(peer, ch, part.data) }
  }

  private deliver(peer: number, ch: NetChannel, data: Uint8Array): void {
    this.inbox.push({ peer, ch, data })
    this.stats.messagesIn++
  }
}
