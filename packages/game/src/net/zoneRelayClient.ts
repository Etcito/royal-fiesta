import type { Roster } from '@gamesaloon/rollback/zones'
import { RefusalError, refuse } from '@royal-fiesta/sim/refusal'
import type { WsLike } from './ws.ts'
import { decodeZoneBinOut, encodeZoneBinIn, isZoneQueuePayload, MAX_ZONE_PEERS, parseZoneServerMsg, ZONE_GAME_ID } from './zoneRelayProtocol.ts'
import type { ZoneClientMsg, ZoneMatched, ZoneQueue, ZoneQueuePayload, ZoneSeatEvent, ZoneServerMsg } from './zoneRelayProtocol.ts'

export interface ZoneWsLike extends WsLike {
  send(data: string | Uint8Array): void
  binaryType: 'arraybuffer' | 'blob'
}
export type ZoneWsFactory = (url: string) => ZoneWsLike

/** Resolve the global at call time, just like globalWsFactory; Node defaults to Blob otherwise. */
export function globalZoneWsFactory(): ZoneWsFactory {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => ZoneWsLike }).WebSocket
  if (typeof Ctor !== 'function') refuse('relay', 'globalThis.WebSocket', 'no global WebSocket; use Node >= 22 or inject a ZoneWsFactory')
  return url => {
    const sock = new Ctor(url)
    sock.binaryType = 'arraybuffer'
    const w: ZoneWsLike = {
      get readyState() { return sock.readyState },
      get binaryType() { return sock.binaryType },
      set binaryType(value) { sock.binaryType = value },
      send(data) { sock.send(data) },
      close(code, reason) { sock.close(code, reason) },
      onopen: null, onmessage: null, onclose: null, onerror: null,
    }
    sock.onopen = () => { w.onopen?.() }
    sock.onmessage = e => { w.onmessage?.({ data: e.data }) }
    sock.onclose = e => { w.onclose?.({ code: e.code, reason: e.reason }) }
    sock.onerror = e => { w.onerror?.(e) }
    return w
  }
}

export interface ZoneRoom {
  localPeer: number
  seed: number
  roster: Roster
  measurements: Record<number, ZoneQueuePayload['m']>
  course: string
}
interface Pending { t: string; on(m: ZoneServerMsg): boolean; reject(e: Error): void }

export class ZoneRelayClient {
  readonly url: string
  private factory: ZoneWsFactory
  private ws: ZoneWsLike | null = null
  private open = false
  private closedOnce = false
  private pending: Pending | null = null
  private matchedMsg: ZoneMatched | null = null
  private roomData: ZoneRoom | null = null
  private binaryFns: ((sender: number, payload: Uint8Array) => void)[] = []
  private seatFns: ((ev: ZoneSeatEvent) => void)[] = []
  private closeFns: (() => void)[] = []
  badFrames = 0
  foreignMatches = 0

  constructor(url: string, ws: ZoneWsFactory) { this.url = url; this.factory = ws }
  get matched(): ZoneMatched | null { return this.matchedMsg }
  get seat(): number { return this.matchedMsg?.youAre ?? -1 }

  connect(timeoutMs = 5000): Promise<void> {
    if (this.ws) refuse('relay', this.url, 'connect() was already called; create one ZoneRelayClient per socket')
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (what: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new RefusalError('relay', this.url, `${what}; is the GameSaloon server running?`))
      }
      const timer = setTimeout(() => { fail(`no connection after ${timeoutMs} ms`); this.ws?.close() }, timeoutMs)
      try {
        const ws = this.factory(this.url)
        this.ws = ws
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.open = true
          resolve()
        }
        ws.onerror = () => fail('socket error before open')
        ws.onclose = e => { fail(`socket closed before open (code ${e.code} ${e.reason})`); this.handleClose() }
        ws.onmessage = e => this.handleFrame(e.data)
      } catch (e) { clearTimeout(timer); settled = true; reject(e) }
    })
  }

  queue(players: number, payload: ZoneQueuePayload): Promise<ZoneMatched> {
    if (!Number.isInteger(players) || players < 2 || players > MAX_ZONE_PEERS) {
      refuse('relay', 'queue.players', `players must be in 2..${MAX_ZONE_PEERS}; pass the zone peer count`)
    }
    if (!isZoneQueuePayload(payload)) refuse('relay', 'queue.payload', 'invalid zone payload; supply course, tuning, 1–4 seats and peer measurements')
    if (this.pending) refuse('relay', 'queue', `request '${this.pending.t}' is still pending; await it before sending another`)
    const msg: ZoneQueue = { t: 'queue', players, cadence: true, payload, game: ZONE_GAME_ID, zones: true }
    return new Promise<ZoneMatched>((resolve, reject) => {
      const pending: Pending = { t: 'queue', reject, on: m => {
        if (m.t !== 'matched') return false
        if (m.opps.some(p => !isZoneQueuePayload(p) || p.course !== payload.course || p.tuning !== payload.tuning)) {
          this.foreignMatches++
          this.matchedMsg = null
          this.roomData = null
          this.send({ t: 'bye' })
          this.send(msg)
          return false
        }
        const opps = m.opps as ZoneQueuePayload[]
        const roster: Roster = { seatCount: 0, peers: [], live: new Array<boolean>(m.players).fill(true) }
        const measurements: ZoneRoom['measurements'] = {}
        let nextSeat = 0
        for (let peer = 0; peer < opps.length; peer++) {
          roster.peers.push({ peer, seats: Array.from({ length: opps[peer].seats }, () => nextSeat++) })
          measurements[peer] = { ...opps[peer].m }
        }
        this.roomData = { localPeer: m.youAre, seed: m.seed, roster: { ...roster, seatCount: nextSeat }, measurements, course: payload.course }
        this.matchedMsg = m
        resolve(m)
        return true
      } }
      // Install before sending so a synchronous socket port can deliver the reply.
      this.pending = pending
      try { this.send(msg) } catch (e) { this.pending = null; reject(e) }
    })
  }

  room(): ZoneRoom {
    if (!this.roomData) refuse('relay', 'room', 'no accepted zone match; await queue() first')
    return this.roomData
  }

  sendBinary(maskLo: number, maskHi: number, payload: Uint8Array): void {
    this.socket('binary').send(encodeZoneBinIn(maskLo, maskHi, payload))
  }
  onBinary(fn: (sender: number, payload: Uint8Array) => void): void { this.binaryFns.push(fn) }
  onSeatEvent(fn: (ev: ZoneSeatEvent) => void): void { this.seatFns.push(fn) }
  onClose(fn: () => void): void { this.closeFns.push(fn) }
  bye(): void {
    if (this.open) this.send({ t: 'bye' })
    this.matchedMsg = null
    this.roomData = null
  }
  close(): void { this.ws?.close() }

  private socket(path: string): ZoneWsLike {
    if (!this.ws || !this.open) refuse('relay', path, `socket to ${this.url} is not open; await connect() first`)
    return this.ws
  }
  private send(msg: ZoneClientMsg): void { this.socket(msg.t).send(JSON.stringify(msg)) }

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') {
      const frame = decodeZoneBinOut(data)
      if (!frame) { this.badFrames++; return }
      for (const fn of this.binaryFns) fn(frame.sender, frame.payload)
      return
    }
    const m = parseZoneServerMsg(data)
    if (!m) { this.badFrames++; return }
    const p = this.pending
    if (p) {
      if (m.t === 'error') {
        this.pending = null
        p.reject(new RefusalError('relay', p.t, `${m.reason}: the GameSaloon relay refused the request`))
        return
      }
      try { if (p.on(m) && this.pending === p) this.pending = null } catch (e) {
        if (this.pending === p) this.pending = null
        p.reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    if (m.t === 'player_dropped' || m.t === 'player_back' || m.t === 'player_left') {
      for (const fn of this.seatFns) fn(m)
    }
  }

  private handleClose(): void {
    if (this.closedOnce) return
    this.closedOnce = true
    this.open = false
    const p = this.pending
    this.pending = null
    p?.reject(new RefusalError('relay', p.t, `socket to ${this.url} closed before the reply; reconnect and retry`))
    for (const fn of this.closeFns) fn()
  }
}
