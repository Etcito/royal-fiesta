// GameSaloon relay client: one socket, request/reply over the relay protocol (gamesaloon src/relay/hub.ts).
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { WsFactory, WsLike } from './ws.ts'
import { LOBBY_GAME, RELAY_MAX_PLAYERS, parseRelayServerMsg } from './relayProtocol.ts'
import type { LobbyPick, LobbyServerMsg } from '../hub/lobby.ts'
import type { RelayClientMsg, RelayMatched, RelayServerMsg } from './relayProtocol.ts'

export interface FiestaQueuePayload { g: 'royal-fiesta'; v: 1; name: string; c: number }

type SeatEvent = { t: string; seat: number }

interface Pending {
  t: string
  // Returns true when the message settled the request.
  on(m: RelayServerMsg): boolean
  reject(e: Error): void
}

const QUEUE_REFUSAL = 'GameSaloon relay seats are capped at 4 (MAX_PLAYERS in gamesaloon src/relay/protocol.ts) and an out-of-range queue is silently ignored by the server; use the WebRTC transport for 5-8 players'

function isFiestaPayload(p: unknown): boolean {
  return typeof p === 'object' && p !== null && (p as { g?: unknown }).g === 'royal-fiesta' && (p as { v?: unknown }).v === 1
}

export class RelayClient {
  readonly url: string
  private factory: WsFactory
  private ws: WsLike | null = null
  private open = false
  private closedOnce = false
  private pending: Pending | null = null
  private actFns: ((a: unknown, from: number, n: number) => void)[] = []
  private seatFns: ((ev: SeatEvent) => void)[] = []
  private closeFns: (() => void)[] = []
  private lobbyFns: ((m: LobbyServerMsg) => void)[] = []
  private matchedMsg: RelayMatched | null = null
  private mySeat = -1
  private roomPlayers = 0
  /** Inbound frames parseRelayServerMsg rejected. */
  badFrames = 0
  /** Matches refused because an opponent was not a Royal Fiesta client. */
  foreignMatches = 0

  constructor(url: string, ws: WsFactory) {
    this.url = url
    this.factory = ws
  }

  get matched(): RelayMatched | null { return this.matchedMsg }
  get seat(): number { return this.mySeat }

  connect(timeoutMs = 5000): Promise<void> {
    if (this.ws) throw new RefusalError('relay', this.url, 'connect() was already called; create one RelayClient per socket')
    return new Promise<void>((resolve, reject) => {
      const fail = (what: string) => {
        if (this.open) return
        clearTimeout(timer)
        reject(new RefusalError('relay', this.url, `${what}; is the GameSaloon server running?`))
      }
      const timer = setTimeout(() => {
        fail(`no connection after ${timeoutMs} ms`)
        this.ws?.close()
      }, timeoutMs)
      const ws = this.factory(this.url)
      this.ws = ws
      ws.onopen = () => {
        if (this.open) return
        clearTimeout(timer)
        this.open = true
        resolve()
      }
      ws.onerror = () => fail('socket error before open')
      ws.onclose = (e) => {
        fail(`socket closed before open (code ${e.code}${e.reason ? ` ${e.reason}` : ''})`)
        this.handleClose()
      }
      ws.onmessage = (e) => this.handleFrame(e.data)
    })
  }

  create(players: number, payload?: object): Promise<string> {
    this.checkPlayers('create.players', players)
    return this.request({ t: 'create', players, payload: payload ?? null }, (m, done) => {
      if (m.t !== 'room') return false
      this.mySeat = 0
      this.roomPlayers = players
      done(m.code)
      return true
    })
  }

  join(code: string, payload?: object): Promise<{ seat: number; players: number } | RelayMatched> {
    if (typeof code !== 'string' || !code) throw new RefusalError('relay', 'join.code', 'empty room code; pass the code returned by create()')
    return this.request<{ seat: number; players: number } | RelayMatched>({ t: 'join', code, payload: payload ?? null }, (m, done, fail) => {
      if ((m.t === 'waiting' || m.t === 'matched') && !this.playersOk(m.players)) {
        fail(this.playersRefusal('join.players', m.players))
        return true
      }
      if (m.t === 'waiting') {
        this.mySeat = m.seat
        this.roomPlayers = m.players
        done({ seat: m.seat, players: m.players })
        return true
      }
      if (m.t === 'matched') { done(m); return true }
      return false
    })
  }

  queue(players: number, payload: FiestaQueuePayload): Promise<RelayMatched> {
    if (!Number.isInteger(players) || players < 2 || players > RELAY_MAX_PLAYERS) {
      throw new RefusalError('relay', 'queue.players', QUEUE_REFUSAL)
    }
    const msg: RelayClientMsg = { t: 'queue', players, cadence: true, payload }
    return this.request(msg, (m, done) => {
      if (m.t !== 'matched') return false
      for (let i = 0; i < m.opps.length; i++) {
        if (isFiestaPayload(m.opps[i])) continue
        this.foreignMatches++
        const e = new RefusalError('relay', `matched.opps/${i}`, 'matched with a non-Royal-Fiesta client; leaving with bye and queueing again')
        console.warn(e.message)
        this.matchedMsg = null
        this.mySeat = -1
        this.send({ t: 'bye' })
        this.send(msg)
        return false
      }
      done(m)
      return true
    })
  }

  /**
   * Enters a GameSaloon timed lobby of `seats` (1..4) seats; resolves on the round's `matched`, whose
   * `players` may be fewer than `seats` (the game fills with bots). Lobby messages go to onLobby.
   */
  lobby(seats: number, payload: FiestaQueuePayload): Promise<RelayMatched> {
    this.checkSeats(seats)
    return this.request<RelayMatched>(this.lobbyEnterMsg(seats, payload), (m, done) => {
      if (m.t !== 'matched') return false
      done(m)
      return true
    })
  }

  /** Enters again while lobby() is still pending (the watched lobby closed, or a pick lost a race). */
  lobbyAgain(seats: number, payload: FiestaQueuePayload): void {
    this.checkSeats(seats)
    this.send(this.lobbyEnterMsg(seats, payload))
  }

  lobbyPick(action: LobbyPick, id: string | null): void { this.send({ t: 'lobby_pick', action, id }) }

  /** Stops waiting for a lobby round without telling the server (it never answered: no lobby support). */
  abandonLobby(): void {
    if (this.pending?.t !== 'lobby_enter') return
    const p = this.pending
    this.pending = null
    p.reject(new RefusalError('relay', 'lobby_enter', 'abandoned: the server has no lobbies'))
  }

  onLobby(fn: (m: LobbyServerMsg) => void): void { this.lobbyFns.push(fn) }

  /**
   * Shared hub presence: this client's hub avatar state to the other members of its lobby (gamesaloon
   * docs/lobby.md). Fire and forget; nothing is sent on a closed socket or once the round has matched.
   */
  presence(a: object): void {
    if (!this.open || this.matchedMsg) return
    this.send({ t: 'lobby_presence', a })
  }

  private lobbyEnterMsg(seats: number, payload: FiestaQueuePayload): RelayClientMsg {
    return { t: 'lobby_enter', game: LOBBY_GAME, seats, cadence: true, payload }
  }

  private checkSeats(seats: number): void {
    if (!Number.isInteger(seats) || seats < 1 || seats > RELAY_MAX_PLAYERS) throw new RefusalError('relay', 'lobby.seats', QUEUE_REFUSAL)
  }

  unqueue(): Promise<void> {
    // A pending queue ends here: the server drops us from its wait list.
    if (this.pending?.t === 'queue') {
      const p = this.pending
      this.pending = null
      p.reject(new RefusalError('relay', 'queue', 'cancelled by unqueue()'))
    }
    return this.request<void>({ t: 'unqueue' }, (m, done) => {
      if (m.t === 'unqueued') done()
      return m.t === 'unqueued'
    })
  }

  act(a: object | unknown[]): void { this.send({ t: 'act', a }) }

  onAct(fn: (a: unknown, from: number, n: number) => void): void { this.actFns.push(fn) }
  onSeatEvent(fn: (ev: SeatEvent) => void): void { this.seatFns.push(fn) }
  onClose(fn: () => void): void { this.closeFns.push(fn) }

  bye(): void { if (this.open) this.send({ t: 'bye' }) }
  close(): void { this.ws?.close() }

  private playersOk(players: number): boolean {
    return Number.isInteger(players) && players >= 2 && players <= RELAY_MAX_PLAYERS
  }

  private playersRefusal(path: string, players: number): RefusalError {
    return new RefusalError('relay', path, `${players} is outside 2..${RELAY_MAX_PLAYERS} (MAX_PLAYERS in gamesaloon src/relay/protocol.ts); use the WebRTC transport for 5-8 players`)
  }

  private checkPlayers(path: string, players: number): void {
    if (!this.playersOk(players)) throw this.playersRefusal(path, players)
  }

  private send(msg: RelayClientMsg): void {
    if (!this.ws || !this.open) {
      throw new RefusalError('relay', msg.t, `socket to ${this.url} is not open; await connect() first`)
    }
    this.ws.send(JSON.stringify(msg))
  }

  private request<T>(msg: RelayClientMsg, on: (m: RelayServerMsg, done: (v: T) => void, fail: (e: Error) => void) => boolean): Promise<T> {
    if (this.pending) {
      throw new RefusalError('relay', msg.t, `request '${this.pending.t}' is still pending; await it before sending another`)
    }
    this.send(msg)
    return new Promise<T>((resolve, reject) => {
      this.pending = { t: msg.t, on: (m) => on(m, resolve, reject), reject }
    })
  }

  private handleFrame(data: unknown): void {
    const m = typeof data === 'string' ? parseRelayServerMsg(data) : null
    if (!m) { this.badFrames++; return }
    if (m.t === 'matched') {
      this.matchedMsg = m
      this.mySeat = m.youAre
      this.roomPlayers = m.players
    }
    const p = this.pending
    if (p) {
      if (m.t === 'error') {
        this.pending = null
        p.reject(new RefusalError('relay', p.t, `${m.reason}: the GameSaloon relay refused the request`))
        return
      }
      if (p.on(m) && this.pending === p) this.pending = null
    }
    if (m.t.startsWith('lobby_')) {
      for (const fn of this.lobbyFns) fn(m as LobbyServerMsg)
      return
    }
    switch (m.t) {
      case 'act':
        for (const fn of this.actFns) fn(m.a, m.from, m.n)
        return
      case 'player_dropped':
      case 'player_back':
      case 'player_left':
        this.emitSeat({ t: m.t, seat: m.seat })
        return
      case 'opp_dropped':
      case 'opp_back':
      case 'opp_left':
        // Two-seat rooms name no seat: the event is about the other one.
        if (this.roomPlayers === 2 && this.mySeat >= 0) {
          this.emitSeat({ t: `player_${m.t.slice(4)}`, seat: 1 - this.mySeat })
        }
        return
    }
  }

  private emitSeat(ev: SeatEvent): void { for (const fn of this.seatFns) fn(ev) }

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
