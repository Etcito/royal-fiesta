import type { Roster } from '@gamesaloon/rollback/zones'
import { RefusalError, refuse } from '@royal-fiesta/sim/refusal'
import type { LobbyPick, LobbyServerMsg } from '../hub/lobby.ts'
import { RELAY_MAX_PLAYERS } from './relayProtocol.ts'
import type { FiestaQueuePayload } from './relayClient.ts'
import type { WsFactory, WsLike } from './ws.ts'
import { decodeZoneBinOut, decodeZoneSignal, encodeZoneBinIn, encodeZoneSignal, isZoneQueuePayload, MAX_ZONE_PEERS, parseZoneServerMsg, ZONE_GAME_ID } from './zoneRelayProtocol.ts'
import type { ZoneSignal } from './zoneRelayProtocol.ts'
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
  private factory: WsFactory
  private ws: WsLike | null = null
  private open = false
  private closedOnce = false
  private pending: Pending | null = null
  private matchedMsg: ZoneMatched | null = null
  private roomData: ZoneRoom | null = null
  private signalFn: ((sender: number, signal: ZoneSignal) => void) | null = null
  private earlySignals: { sender: number; signal: ZoneSignal }[] = []
  private seatFns: ((ev: ZoneSeatEvent) => void)[] = []
  private lobbyFns: ((m: LobbyServerMsg) => void)[] = []
  private closeFns: (() => void)[] = []
  badFrames = 0
  /** Why the socket closed: the close code and the last unsolicited relay error ('rate limited', ...), or null while open. */
  closeCause: string | null = null
  private lastError: string | null = null
  /** Round trip of the last relay ping (ms), for the lobby diagnostics; null before the first pong. */
  private rttMs: number | null = null
  private pingAt = 0
  private pinger: ReturnType<typeof setInterval> | null = null
  foreignMatches = 0

  constructor(url: string, ws: WsFactory) { this.url = url; this.factory = ws }
  get matched(): ZoneMatched | null { return this.matchedMsg }
  get seat(): number { return this.matchedMsg?.youAre ?? -1 }
  get relayRtt(): number | null { return this.rttMs }

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
          // The relay answers ping with pong: one in flight at a time, every 2 s, while the socket is open.
          this.pinger = setInterval(() => {
            if (!this.open || this.pingAt !== 0) return
            this.pingAt = performance.now()
            try { this.send({ t: 'ping' }) } catch { this.pingAt = 0 }
          }, 2000)
          resolve()
        }
        ws.onerror = () => fail('socket error before open')
        ws.onclose = e => {
          fail(`socket closed before open (code ${e.code} ${e.reason})`)
          this.closeCause = `code ${e.code}${e.reason ? ` ${e.reason}` : ''}${this.lastError ? `, relay error '${this.lastError}'` : ''}`
          this.handleClose()
        }
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

  /** Timed human lobby; the relay starts it as a binary-enabled zone room, including a lone human. */
  lobby(seats: number, payload: FiestaQueuePayload): Promise<ZoneMatched> {
    if (this.pending) refuse('relay', 'lobby', `request '${this.pending.t}' is still pending`)
    return new Promise((resolve, reject) => {
      this.pending = { t: 'lobby_enter', reject, on: m => {
        if (m.t !== 'matched') return false
        if (m.players > RELAY_MAX_PLAYERS || m.opps.some(p => {
          const other = p as Partial<FiestaQueuePayload> & { zones?: number } | null
          return !other || other.g !== payload.g || other.v !== payload.v || other.zones !== 1
        })) refuse('relay', 'lobby.matched', 'incompatible online show; reload all clients on the same build')
        this.matchedMsg = m
        resolve(m)
        return true
      } }
      try { this.lobbyAgain(seats, payload) } catch (e) { this.pending = null; reject(e) }
    })
  }

  lobbyAgain(seats: number, payload: FiestaQueuePayload, spectate = false): void {
    if (!Number.isInteger(seats) || seats < 1 || seats > RELAY_MAX_PLAYERS) {
      refuse('relay', 'lobby.seats', `supply 1..${RELAY_MAX_PLAYERS} human places`)
    }
    this.send({ t: 'lobby_enter', game: ZONE_GAME_ID, zones: true, seats, cadence: true,
      payload: { ...payload, zones: 1 }, ...(spectate ? { spectate: true } : {}) })
  }
  lobbyPick(action: LobbyPick, id: string | null): void { this.send({ t: 'lobby_pick', action, id }) }
  onLobby(fn: (m: LobbyServerMsg) => void): void { this.lobbyFns.push(fn) }
  presence(a: object): void { if (this.open && !this.matchedMsg) this.send({ t: 'lobby_presence', a }) }
  abandonLobby(): void {
    if (this.pending?.t !== 'lobby_enter') return
    const pending = this.pending
    this.pending = null
    pending.reject(new RefusalError('relay', 'lobby_enter', 'server did not answer the timed zone lobby'))
  }
  unqueue(): Promise<void> {
    const pending = this.pending
    this.pending = null
    pending?.reject(new RefusalError('relay', 'queue', 'cancelled'))
    this.send({ t: 'unqueue' })
    return Promise.resolve()
  }

  room(): ZoneRoom {
    if (!this.roomData) refuse('relay', 'room', 'no accepted zone match; await queue() first')
    return this.roomData
  }

  signal(peer: number, signal: ZoneSignal): void {
    if (!this.matchedMsg || !Number.isInteger(peer) || peer < 0 || peer >= this.matchedMsg.players || peer === this.seat) {
      refuse('relay', 'signal.peer', `peer ${peer} is not a remote member of the matched room`)
    }
    this.socket('signal').send(encodeZoneBinIn(peer < 32 ? (1 << peer) >>> 0 : 0,
      peer >= 32 ? (1 << (peer - 32)) >>> 0 : 0, encodeZoneSignal(signal)))
  }
  onSignal(fn: (sender: number, signal: ZoneSignal) => void): () => void {
    this.signalFn = fn
    for (const { sender, signal } of this.earlySignals.splice(0)) fn(sender, signal)
    return () => { if (this.signalFn === fn) this.signalFn = null }
  }
  onSeatEvent(fn: (ev: ZoneSeatEvent) => void): void { this.seatFns.push(fn) }
  onClose(fn: () => void): void { this.closeFns.push(fn) }
  bye(): void {
    if (this.open) this.send({ t: 'bye' })
    this.matchedMsg = null
    this.roomData = null
    this.earlySignals = []
  }
  close(): void { this.ws?.close() }

  private socket(path: string): WsLike {
    if (!this.ws || !this.open) refuse('relay', path, `socket to ${this.url} is not open; await connect() first`)
    return this.ws
  }
  private send(msg: ZoneClientMsg): void { this.socket(msg.t).send(JSON.stringify(msg)) }

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') {
      const frame = decodeZoneBinOut(data)
      const signal = frame && decodeZoneSignal(frame.payload)
      if (!frame || !signal || !this.matchedMsg || frame.sender === this.seat || frame.sender >= this.matchedMsg.players) { this.badFrames++; return }
      if (this.signalFn) this.signalFn(frame.sender, signal)
      else if (this.earlySignals.length < 1024) this.earlySignals.push({ sender: frame.sender, signal })
      else this.badFrames++
      return
    }
    const m = parseZoneServerMsg(data)
    if (!m) { this.badFrames++; return }
    if (m.t === 'pong' && this.pingAt !== 0) {
      this.rttMs = performance.now() - this.pingAt
      this.pingAt = 0
      return
    }
    const p = this.pending
    if (!p && m.t === 'error') this.lastError = m.reason
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
    if (m.t.startsWith('lobby_')) {
      for (const fn of this.lobbyFns) fn(m as LobbyServerMsg)
      if (m.t === 'lobby_error' && !['lobby_closed', 'unknown_lobby', 'not_entered'].includes(m.reason) && this.pending) {
        const pending = this.pending
        this.pending = null
        pending.reject(new RefusalError('relay', pending.t, m.reason))
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
    if (this.pinger !== null) clearInterval(this.pinger)
    this.pinger = null
    const p = this.pending
    this.pending = null
    p?.reject(new RefusalError('relay', p.t, `socket to ${this.url} closed before the reply; reconnect and retry`))
    for (const fn of this.closeFns) fn()
  }
}
