import type { NetChannel, NetTransport } from '@gamesaloon/rollback'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { RoomsClient } from './roomsClient.ts'
import { ROOMS_MAX_PEERS } from './roomsProtocol.ts'
import type { IceServer, SignalData, Started } from './roomsProtocol.ts'
import type { RtcBackend, RtcChannel, RtcPeer } from './rtcBackend.ts'

type Packet = { peer: number; ch: NetChannel; data: Uint8Array }
type Channels = { fast: RtcChannel; reliable: RtcChannel }
interface Link { rtc: RtcPeer; channels?: Channels; closed: boolean; receivedSdp: boolean }

export class WebRtcTransport implements NetTransport {
  readonly selfPeer: number
  readonly peerIds: number[]
  private readonly clock: () => number
  private readonly links = new Map<number, Link>()
  private inbox: Packet[] = []
  private allClosed = false
  private rejectConnect: ((error: RefusalError) => void) | null = null

  private constructor(selfPeer: number, peerIds: number[], now: () => number) {
    this.selfPeer = selfPeer
    this.peerIds = peerIds
    this.clock = now
  }

  static async connect(rooms: RoomsClient, started: Started, backend: RtcBackend, now: () => number, opts: { iceServers?: IceServer[]; timeoutMs?: number } = {}): Promise<WebRtcTransport> {
    const selfPeer = rooms.room?.you
    if (selfPeer === undefined) {
      throw new RefusalError('webrtc', 'selfPeer', 'no room joined; await RoomsClient.create() or join() before connect')
    }
    const peerIds = started.members.map((member) => member.peer).sort((a, b) => a - b)
    if (!peerIds.includes(selfPeer)) {
      throw new RefusalError('webrtc', 'selfPeer', `peer ${selfPeer} is not a member of the started room; use the Started message for this client\'s room`)
    }
    if (peerIds.length < 2 || peerIds.length > ROOMS_MAX_PEERS) {
      throw new RefusalError('webrtc', 'started.members', 'a mesh needs 2..8 peers; start a room with 2..8 members')
    }
    for (let i = 0; i < peerIds.length; i++) {
      if (!Number.isInteger(peerIds[i]) || peerIds[i] < 0 || peerIds[i] >= ROOMS_MAX_PEERS || peerIds[i] === peerIds[i - 1]) {
        throw new RefusalError('webrtc', 'started.members', 'peer ids must be unique integers in 0..7; use the server\'s Started message')
      }
    }
    const timeoutMs = opts.timeoutMs ?? 15000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RefusalError('webrtc', 'opts.timeoutMs', 'must be finite and greater than zero; supply a positive timeout in milliseconds')
    }
    const iceServers = opts.iceServers ?? rooms.welcome?.iceServers
    if (!iceServers) throw new RefusalError('webrtc', 'iceServers', 'no welcome received; await RoomsClient.hello() or supply opts.iceServers')
    const transport = new WebRtcTransport(selfPeer, peerIds, now)
    await transport.open(rooms, backend, iceServers, timeoutMs)
    return transport
  }

  send(peer: number, ch: NetChannel, data: Uint8Array): void {
    if (peer === this.selfPeer || this.closed(peer)) return
    const channel = this.links.get(peer)!.channels![ch]
    // The caller may immediately reuse its packet buffer.
    channel.send(data.slice())
  }

  drain(out: Packet[]): void {
    for (let i = 0; i < this.inbox.length; i++) {
      const p = this.inbox[i]
      const e = out[i]
      if (e) { e.peer = p.peer; e.ch = p.ch; e.data = p.data } else out.push(p)
    }
    out.length = this.inbox.length
    this.inbox = []
  }

  closed(peer: number): boolean {
    return this.allClosed || (peer !== this.selfPeer && (this.links.get(peer)?.closed ?? true))
  }

  now(): number { return this.clock() }

  close(): void {
    if (this.allClosed) return
    this.allClosed = true
    for (const peer of this.links.keys()) this.closePeer(peer)
    this.inbox = []
  }

  private closePeer(peer: number): void {
    const link = this.links.get(peer)
    if (!link || link.closed) return
    link.closed = true
    link.rtc.close()
  }

  private fail(peer: number, error: unknown): void {
    if (this.allClosed || this.links.get(peer)?.closed) return
    const refusal = error instanceof RefusalError ? error : new RefusalError('webrtc', `peers/${peer}`, `${String(error)}; check the peer connection and signaling`)
    if (this.rejectConnect) {
      this.rejectConnect(refusal)
      this.close()
    } else this.closePeer(peer)
  }

  private missing(): number[] {
    return this.peerIds.filter((peer) => {
      if (peer === this.selfPeer) return false
      const link = this.links.get(peer)
      return !link || link.closed || !link.channels?.fast.open || !link.channels.reliable.open
    })
  }

  private async open(rooms: RoomsClient, backend: RtcBackend, iceServers: IceServer[], timeoutMs: number): Promise<void> {
    const failed = new Promise<never>((_, reject) => { this.rejectConnect = reject })
    failed.catch(() => {}) // Setup can fail before the race below is installed.
    const timer = setTimeout(() => {
      this.rejectConnect?.(new RefusalError('webrtc', 'connect', `timed out after ${timeoutMs} ms; missing peers: ${this.missing().join(', ')}; check that every member connects and the ICE servers are reachable`))
    }, timeoutMs)
    try {
      const opened: Promise<void>[] = []
      for (const peer of this.peerIds) {
        if (this.allClosed) break
        if (peer === this.selfPeer) continue
        const rtc = backend.createPeer(iceServers, this.selfPeer < peer)
        const link: Link = { rtc, closed: false, receivedSdp: false }
        this.links.set(peer, link)
        opened.push(rtc.channels().then((channels) => {
          if (this.allClosed || link.closed) return
          link.channels = channels
          for (const ch of ['fast', 'reliable'] as const) {
            channels[ch].onClose(() => this.fail(peer, new RefusalError('webrtc', `peers/${peer}/${ch}`, 'data channel closed; reconnect the mesh before starting another match')))
            channels[ch].onMessage((data) => {
              if (!this.allClosed && !link.closed) this.inbox.push({ peer, ch, data: data.slice() })
            })
          }
        }).catch((error: unknown) => this.fail(peer, error)))
        rtc.onIce((candidate) => {
          if (this.allClosed || link.closed) return
          try { rooms.signal(peer, candidate ? { kind: 'ice', ...candidate } : { kind: 'ice-end' }) }
          catch (error) { this.fail(peer, error) }
        })
      }
      rooms.onSignal((from, data) => {
        if (this.allClosed || this.links.get(from)?.closed) return
        void this.receiveSignal(rooms, from, data).catch((error: unknown) => this.fail(from, error))
      })
      rooms.onPeerLeft((peer) => {
        if (this.links.has(peer)) this.fail(peer, new RefusalError('webrtc', `peers/${peer}`, 'member left the room; start again with the remaining members'))
      })
      for (const [peer, link] of this.links) {
        if (this.allClosed) break
        if (this.selfPeer < peer) {
          void link.rtc.createOffer().then((sdp) => {
            if (!this.allClosed && !link.closed) rooms.signal(peer, { kind: 'offer', sdp })
          }).catch((error: unknown) => this.fail(peer, error))
        }
      }
      await Promise.race([Promise.all(opened), failed])
      if (this.missing().length > 0) {
        throw new RefusalError('webrtc', 'connect', `channels are not open to peers: ${this.missing().join(', ')}; reconnect the mesh`)
      }
    } catch (error) {
      this.close()
      if (error instanceof RefusalError) throw error
      throw new RefusalError('webrtc', 'connect', `${String(error)}; check the RTC backend and signaling connection`)
    } finally {
      clearTimeout(timer)
      this.rejectConnect = null
    }
  }

  private async receiveSignal(rooms: RoomsClient, from: number, data: SignalData): Promise<void> {
    const link = this.links.get(from)
    if (!link) throw new RefusalError('webrtc', 'signal.from', `unknown peer ${from}; signal only members of the started room`)
    if (data.kind === 'ice') {
      link.rtc.addIce({ candidate: data.candidate, sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex })
      return
    }
    // RtcPeer buffers candidates itself and has no end-of-candidates input.
    if (data.kind === 'ice-end') return
    if (link.receivedSdp || (data.kind === 'offer') !== (from < this.selfPeer)) {
      throw new RefusalError('webrtc', `peers/${from}/signal`, `unexpected ${data.kind}; the lower peer id must offer exactly once`)
    }
    link.receivedSdp = true
    if (data.kind === 'offer') {
      const sdp = await link.rtc.acceptOffer(data.sdp)
      if (!this.allClosed && !link.closed) rooms.signal(from, { kind: 'answer', sdp })
    } else await link.rtc.acceptAnswer(data.sdp)
  }
}

export function playerOfPeer(started: Started, peer: number): number {
  const peers = started.members.map((member) => member.peer).sort((a, b) => a - b)
  const player = peers.indexOf(peer)
  if (player < 0) {
    throw new RefusalError('webrtc', 'playerOfPeer', `unknown peer ${peer}; use a peer from started.members`)
  }
  return player
}
