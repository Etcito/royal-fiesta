import type { NetChannel } from '@gamesaloon/rollback'
import type { GroupTransport } from '@gamesaloon/rollback/zones'

interface Packet { peer: number; ch: NetChannel; data: Uint8Array }
type ResultListener = (peer: number, round: number, payload: Uint8Array) => void
type VoteListener = (peer: number, round: number, choice: number) => void

/** Keeps successive round sessions isolated while sharing one relay room. */
export class RoundTransport implements GroupTransport {
  stale = 0
  malformed = 0
  overflow = 0
  private base: GroupTransport
  private round: number
  private buffer = new Uint8Array(256)
  private scratch: Packet[] = []
  private pending: Packet[] = []
  private resultListeners: ResultListener[] = []
  private voteListeners: VoteListener[] = []

  constructor(base: GroupTransport, round = 0) {
    this.base = base
    this.round = round & 0xff
  }

  setRound(round: number): void { this.round = round & 0xff }

  /** Listeners run synchronously during drain; copy the payload to retain it. */
  onResult(fn: ResultListener): void { this.resultListeners.push(fn) }

  /** Listeners run synchronously during drain. */
  onVote(fn: VoteListener): void { this.voteListeners.push(fn) }

  send(peer: number, ch: NetChannel, data: Uint8Array): void { this.sendMany([peer], ch, data) }

  sendMany(peers: readonly number[], ch: NetChannel, data: Uint8Array): void {
    this.sendFrame(peers, ch, 0, data)
  }

  sendResult(peers: readonly number[], payload: Uint8Array): void {
    this.sendFrame(peers, 'reliable', 1, payload)
  }

  sendVote(peers: readonly number[], choice: number): void {
    this.sendFrame(peers, 'reliable', 2, new Uint8Array([choice]))
  }

  drain(out: Packet[]): void {
    let count = 0
    let kept = 0
    // Pending packets precede newly arrived packets, even across skipped rounds.
    for (const packet of this.pending) {
      const delta = (packet.data[1] - this.round) & 0xff
      if (delta === 0) this.write(out, count++, packet)
      else if (delta < 128) this.pending[kept++] = packet
      else this.stale++
    }
    this.pending.length = kept

    this.base.drain(this.scratch)
    for (const packet of this.scratch) {
      const data = packet.data
      if (data.length < 2 || (data[0] !== 0 && data[0] !== 1 && data[0] !== 2)) {
        this.malformed++
        continue
      }
      if (data[0] === 1) {
        const payload = data.subarray(2)
        for (const listener of this.resultListeners) listener(packet.peer, data[1], payload)
        continue
      }
      if (data[0] === 2) {
        if (data.length !== 3) {
          this.malformed++
          continue
        }
        for (const listener of this.voteListeners) listener(packet.peer, data[1], data[2])
        continue
      }
      const delta = (data[1] - this.round) & 0xff
      if (delta === 0) this.write(out, count++, packet)
      else if (delta < 128) {
        if (this.pending.length < 8192) {
          this.pending.push({ peer: packet.peer, ch: packet.ch, data: new Uint8Array(data) })
        } else this.overflow++
      } else this.stale++
    }
    out.length = count
  }

  closed(peer: number): boolean { return this.base.closed(peer) }
  now(): number { return this.base.now() }

  private write(out: Packet[], index: number, packet: Packet): void {
    const data = packet.data.subarray(2), entry = out[index]
    if (entry) { entry.peer = packet.peer; entry.ch = packet.ch; entry.data = data }
    else out.push({ peer: packet.peer, ch: packet.ch, data })
  }

  private sendFrame(peers: readonly number[], ch: NetChannel, kind: number, data: Uint8Array): void {
    const size = data.length + 2
    if (this.buffer.length < size) this.buffer = new Uint8Array(Math.max(size, this.buffer.length * 2))
    this.buffer[0] = kind
    this.buffer[1] = this.round
    this.buffer.set(data, 2)
    const frame = this.buffer.subarray(0, size)
    if (this.base.sendMany) this.base.sendMany(peers, ch, frame)
    else for (const peer of peers) this.base.send(peer, ch, frame)
  }
}
