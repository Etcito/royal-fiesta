// RB1 (S7): rollback packets over GameSaloon relay acts, with coalescing, fragmentation and a rate budget.
import type { NetChannel, NetTransport } from '@gamesaloon/rollback'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { RelayClient } from './relayClient.ts'
import { b64ToBytes, bytesToB64 } from './ws.ts'

export interface RelayTransportStats { acts: number; bytesOut: number; maxActBytes: number; fragments: number; droppedFast: number; deferredReliable: number }

interface Packet { peer: number; ch: NetChannel; data: Uint8Array; b64?: string }
interface Act { a: object; len: number }
interface Entry { mask: number; ch: 0 | 1; b64: string; packets: Packet[]; idx: number }
// One budget unit: a packed act, or all the fragments of one packet (sent all or nothing).
interface Unit { frames: Act[]; fragments: boolean; entries: Entry[] }
interface Partial { n: number; ch: NetChannel; parts: (Uint8Array | undefined)[]; got: number; t: number }

const MAX_ENTRIES = 500
const MAX_PARTS = 4096
const REASSEMBLY_MS = 5000
const RB_EMPTY = JSON.stringify({ t: 'act', a: { k: 'rb', m: [] } }).length
// Fragment overhead with the widest id and 4-digit part numbers.
const RBF_EMPTY = JSON.stringify({ t: 'act', a: { k: 'rbf', id: 4294967295, i: 9999, n: 9999, to: 15, ch: 1, d: '' } }).length

function isU32(v: unknown): v is number { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff }

export class RelayTransport implements NetTransport {
  readonly stats: RelayTransportStats = { acts: 0, bytesOut: 0, maxActBytes: 0, fragments: 0, droppedFast: 0, deferredReliable: 0 }
  /** Inbound acts dropped because they were not valid RB1. */
  malformed = 0
  private client: RelayClient
  private selfPeer: number
  private peerCount: number
  private clock: () => number
  private flushEvery: number
  private maxAct: number
  private perSec: number
  private perMin: number
  private frameCount = 0
  private pending: Packet[] = []
  private inbox: Packet[] = []
  private partials = new Map<string, Partial>()
  private sentAt: number[] = []
  private fragId = 0
  private closedPeers: boolean[]
  private allClosed = false

  constructor(client: RelayClient, selfPeer: number, peerCount: number, now: () => number, opts: { flushEveryFrames?: number; maxActBytes?: number; maxActsPerSec?: number; maxActsPerMin?: number } = {}) {
    if (!Number.isInteger(peerCount) || peerCount < 2 || peerCount > 4) {
      throw new RefusalError('relay', 'peerCount', `${peerCount} is outside 2..4; the GameSaloon relay seats at most 4 players`)
    }
    if (!Number.isInteger(selfPeer) || selfPeer < 0 || selfPeer >= peerCount) {
      throw new RefusalError('relay', 'selfPeer', `${selfPeer} is outside 0..${peerCount - 1}; pass the relay seat (matched.youAre)`)
    }
    this.client = client
    this.selfPeer = selfPeer
    this.peerCount = peerCount
    this.clock = now
    this.flushEvery = opts.flushEveryFrames ?? 2
    this.maxAct = opts.maxActBytes ?? 3800
    this.perSec = opts.maxActsPerSec ?? 60
    this.perMin = opts.maxActsPerMin ?? 3900
    if (!Number.isInteger(this.flushEvery) || this.flushEvery < 1) throw new RefusalError('relay', 'opts.flushEveryFrames', `${this.flushEvery} must be an integer >= 1`)
    if (!Number.isInteger(this.maxAct) || this.maxAct < RBF_EMPTY + 8 || this.maxAct > 4096) {
      throw new RefusalError('relay', 'opts.maxActBytes', `${this.maxAct} must be an integer in ${RBF_EMPTY + 8}..4096 (the relay message cap)`)
    }
    if (!(this.perSec >= 1) || !(this.perMin >= 1)) throw new RefusalError('relay', 'opts.maxActsPerSec', 'act rates must be >= 1')
    this.closedPeers = new Array<boolean>(peerCount).fill(false)
    client.onAct((a, from) => this.receive(a, from))
    client.onSeatEvent((ev) => {
      if (ev.t === 'player_left' && ev.seat >= 0 && ev.seat < peerCount) this.closedPeers[ev.seat] = true
    })
    client.onClose(() => { this.allClosed = true })
  }

  send(peer: number, ch: NetChannel, data: Uint8Array): void {
    if (peer === this.selfPeer || peer < 0 || peer >= this.peerCount || this.closed(peer)) return
    this.pending.push({ peer, ch, data: data.slice() })
  }

  drain(out: { peer: number; ch: NetChannel; data: Uint8Array }[]): void {
    this.prunePartials()
    const box = this.inbox
    for (let i = 0; i < box.length; i++) {
      const p = box[i]
      const e = out[i]
      if (e) { e.peer = p.peer; e.ch = p.ch; e.data = p.data } else out.push({ peer: p.peer, ch: p.ch, data: p.data })
    }
    out.length = box.length
    this.inbox = []
  }

  closed(peer: number): boolean { return this.allClosed || this.closedPeers[peer] === true }

  now(): number { return this.clock() }

  endFrame(): void {
    this.frameCount++
    if (this.frameCount % this.flushEvery === 0) this.flush()
  }

  /** Sends every pending packet the rate budget allows. */
  flush(): void {
    if (this.allClosed) this.pending = []
    if (this.pending.length === 0) return
    const t = this.clock()
    const budget = this.budget(t)
    let units = this.plan(this.pending)
    // Over budget: drop the oldest fast packets until the plan fits, then defer what is left.
    while (units.reduce((n, u) => n + u.frames.length, 0) > budget) {
      const i = this.pending.findIndex((p) => p.ch === 'fast')
      if (i < 0) break
      this.pending.splice(i, 1)
      this.stats.droppedFast++
      units = this.plan(this.pending)
    }
    const deferred: Packet[] = []
    let used = 0
    // Once a unit waits, every later one waits too: reliable stays ordered.
    let full = false
    for (const u of units) {
      if ((full ||= used + u.frames.length > budget)) {
        for (const e of u.entries) for (const p of e.packets) {
          if (p.ch === 'reliable') { deferred.push(p); this.stats.deferredReliable++ } else this.stats.droppedFast++
        }
        continue
      }
      used += u.frames.length
      for (const f of u.frames) this.emit(f, t, u.fragments)
    }
    this.pending = deferred
  }

  private budget(t: number): number {
    const at = this.sentAt
    let drop = 0
    while (drop < at.length && t - at[drop] >= 60000) drop++
    if (drop > 0) at.splice(0, drop)
    let inSec = 0
    for (let i = at.length - 1; i >= 0 && t - at[i] < 1000; i--) inSec++
    return Math.max(0, Math.min(this.perSec - inSec, this.perMin - at.length))
  }

  private emit(frame: Act, t: number, fragment: boolean): void {
    this.client.act(frame.a)
    this.sentAt.push(t)
    const s = this.stats
    s.acts++
    s.bytesOut += frame.len
    if (frame.len > s.maxActBytes) s.maxActBytes = frame.len
    if (fragment) s.fragments++
  }

  /** Merges identical (ch, bytes) packets into one mask, packs entries into acts, fragments what fits nowhere. */
  private plan(packets: Packet[]): Unit[] {
    const entries: Entry[] = []
    const byKey = new Map<string, Entry>()
    // Newest entry per peer: merge only behind it, so duplicates and order survive.
    const last = new Array<number>(this.peerCount).fill(-1)
    for (const p of packets) {
      p.b64 ??= bytesToB64(p.data)
      const ch = p.ch === 'reliable' ? 1 : 0
      const key = `${ch}:${p.b64}`
      const e = byKey.get(key)
      if (e && e.idx > last[p.peer]) { e.mask |= 1 << p.peer; e.packets.push(p); last[p.peer] = e.idx } else {
        const n: Entry = { mask: 1 << p.peer, ch, b64: p.b64, packets: [p], idx: entries.length }
        byKey.set(key, n)
        last[p.peer] = entries.push(n) - 1
      }
    }
    const units: Unit[] = []
    let cur: Entry[] = []
    let len = RB_EMPTY
    const close = () => {
      if (cur.length === 0) return
      units.push({ frames: [this.act({ k: 'rb', m: cur.map((e) => [e.mask, e.ch, e.b64]) })], fragments: false, entries: cur })
      cur = []
      len = RB_EMPTY
    }
    for (const e of entries) {
      const el = JSON.stringify([e.mask, e.ch, e.b64]).length
      if (RB_EMPTY + el > this.maxAct) { close(); units.push(this.fragment(e)); continue }
      if (cur.length >= MAX_ENTRIES || len + el + (cur.length > 0 ? 1 : 0) > this.maxAct) close()
      len += el + (cur.length > 0 ? 1 : 0)
      cur.push(e)
    }
    close()
    return units
  }

  private fragment(e: Entry): Unit {
    const data = e.packets[0].data
    const chunk = Math.floor((this.maxAct - RBF_EMPTY) / 4) * 3
    const n = Math.ceil(data.length / chunk)
    const id = this.fragId
    this.fragId = (this.fragId + 1) >>> 0
    const frames: Act[] = []
    for (let i = 0; i < n; i++) {
      const d = bytesToB64(data.subarray(i * chunk, Math.min(data.length, (i + 1) * chunk)))
      frames.push(this.act({ k: 'rbf', id, i, n, to: e.mask, ch: e.ch, d }))
    }
    return { frames, fragments: true, entries: [e] }
  }

  private act(a: object): Act { return { a, len: JSON.stringify({ t: 'act', a }).length } }

  private receive(a: unknown, from: number): void {
    if (!Number.isInteger(from) || from < 0 || from >= this.peerCount || from === this.selfPeer ||
        typeof a !== 'object' || a === null) { this.malformed++; return }
    const o = a as Record<string, unknown>
    const bit = 1 << this.selfPeer
    try {
      if (o.k === 'rb') {
        const m = o.m
        if (!Array.isArray(m) || m.length > MAX_ENTRIES) { this.malformed++; return }
        for (const e of m) {
          if (!Array.isArray(e) || e.length !== 3 || !isU32(e[0]) || (e[1] !== 0 && e[1] !== 1) || typeof e[2] !== 'string') {
            this.malformed++
            return
          }
        }
        // Decode everything first so a bad entry drops the whole act, not a prefix of it.
        const got: Packet[] = []
        for (const e of m as [number, 0 | 1, string][]) {
          if (e[0] & bit) got.push({ peer: from, ch: e[1] === 1 ? 'reliable' : 'fast', data: b64ToBytes(e[2]) })
        }
        for (const p of got) this.inbox.push(p)
      } else if (o.k === 'rbf') {
        const { id, i, n, to, ch, d } = o
        if (!isU32(id) || !isU32(n) || n < 1 || n > MAX_PARTS || !isU32(i) || i >= n || !isU32(to) ||
            (ch !== 0 && ch !== 1) || typeof d !== 'string') { this.malformed++; return }
        if (!(to & bit)) return
        const key = `${from}:${id}`
        let p = this.partials.get(key)
        if (!p) {
          p = { n, ch: ch === 1 ? 'reliable' : 'fast', parts: new Array<Uint8Array | undefined>(n), got: 0, t: this.clock() }
          this.partials.set(key, p)
        } else if (p.n !== n) { this.malformed++; return }
        if (p.parts[i]) return
        p.parts[i] = b64ToBytes(d)
        if (++p.got < n) return
        this.partials.delete(key)
        let total = 0
        for (const part of p.parts) total += part!.length
        const data = new Uint8Array(total)
        let off = 0
        for (const part of p.parts) { data.set(part!, off); off += part!.length }
        this.inbox.push({ peer: from, ch: p.ch, data })
      } else {
        this.malformed++
      }
    } catch {
      // b64ToBytes refuses bad base64: count it, never throw out of the socket handler.
      this.malformed++
    }
  }

  private prunePartials(): void {
    const t = this.clock()
    for (const [key, p] of this.partials) if (t - p.t > REASSEMBLY_MS) this.partials.delete(key)
  }
}
