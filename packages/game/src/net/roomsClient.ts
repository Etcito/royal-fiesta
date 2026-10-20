// Rooms signaling client: lobby and WebRTC signaling only, never game data.
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { WsFactory, WsLike } from './ws.ts'
import { ROOMS_GAME_ID, ROOMS_PROTOCOL_VERSION, ROOMS_SIGNAL_MAX_BYTES, parseRoomsServerMsg, signalBytes } from './roomsProtocol.ts'
import type { LocalPlayer, RoomMsg, RoomsServerMsg, SignalData, Started, Welcome } from './roomsProtocol.ts'

// rid is undefined only for hello, whose welcome carries no rid.
interface Pending { t: string; rid: number | undefined; reply: RoomsServerMsg['t']; resolve: (m: never) => void; reject: (e: Error) => void }

export class RoomsClient {
  private readonly url: string
  private readonly ws: WsFactory
  private sock: WsLike | null = null
  private nextRid = 1
  private pending: Pending[] = []
  private lastStarted: Started | null = null
  private lastRoom: RoomMsg | null = null
  private startedWaiters: ((s: Started) => void)[] = []
  private readonly signalFns: ((from: number, data: SignalData) => void)[] = []
  private readonly roomFns: ((r: RoomMsg) => void)[] = []
  private readonly peerLeftFns: ((peer: number) => void)[] = []
  private welcomeMsg: Welcome | null = null

  constructor(url: string, ws: WsFactory) {
    this.url = url
    this.ws = ws
  }
  get welcome(): Welcome | null { return this.welcomeMsg }
  get room(): RoomMsg | null { return this.lastRoom }

  hello(name: string, game?: string): Promise<Welcome> {
    if (this.sock) return Promise.reject(new RefusalError('rooms', 'hello', 'already connected; send hello once per client'))
    const sock = this.ws(this.url)
    this.sock = sock
    const p = this.expect<Welcome>('hello', undefined, 'welcome')
    sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', v: ROOMS_PROTOCOL_VERSION, game: game ?? ROOMS_GAME_ID, name }))
    sock.onmessage = (e) => { if (typeof e.data === 'string') this.onMessage(e.data) }
    sock.onerror = () => {}
    sock.onclose = (e) => this.onClosed(`socket closed (${e.code} ${e.reason})`)
    return p.then((w) => { this.welcomeMsg = w; return w })
  }

  create(player: LocalPlayer, priv?: boolean): Promise<RoomMsg> {
    return this.request<RoomMsg>('create', 'room', { players: [player], ...(priv ? { private: true } : {}) })
  }
  join(code: string, player: LocalPlayer): Promise<RoomMsg> {
    return this.request<RoomMsg>('join', 'room', { code, players: [player] })
  }
  start(): Promise<Started> {
    return this.request<Started>('start', 'started', {})
  }

  waitStarted(timeoutMs = 30000): Promise<Started> {
    if (this.lastStarted) return Promise.resolve(this.lastStarted)
    return new Promise((resolve, reject) => {
      const done = (s: Started) => { clearTimeout(timer); resolve(s) }
      const timer = setTimeout(() => {
        this.startedWaiters = this.startedWaiters.filter((w) => w !== done)
        reject(new RefusalError('rooms', 'waitStarted', `no started message within ${timeoutMs} ms; check that the room owner sent start`))
      }, timeoutMs)
      this.startedWaiters.push(done)
    })
  }

  signal(to: number, data: SignalData): void {
    const bytes = signalBytes(data)
    if (bytes > ROOMS_SIGNAL_MAX_BYTES) {
      throw new RefusalError('rooms', 'signal.data', `${bytes} bytes is over the ${ROOMS_SIGNAL_MAX_BYTES}-byte cap; split ICE candidates or trim the SDP`)
    }
    this.sendRaw({ t: 'signal', to, data }, 'signal')
  }

  onSignal(fn: (from: number, data: SignalData) => void): void { this.signalFns.push(fn) }
  onRoom(fn: (r: RoomMsg) => void): void { this.roomFns.push(fn) }
  onPeerLeft(fn: (peer: number) => void): void { this.peerLeftFns.push(fn) }

  // The server replies `left` and broadcasts `room` to the others; the socket stays usable for another room.
  leave(): void {
    if (this.sock && this.sock.readyState === 1) this.sock.send(JSON.stringify({ t: 'leave' }))
    this.lastStarted = null
    this.lastRoom = null
  }

  // Closing the socket removes this client from its room (the server sends peerLeft + room to the others).
  close(): void {
    const sock = this.sock
    if (!sock) return
    sock.onmessage = null
    sock.onclose = null
    sock.close(1000, 'bye')
    this.onClosed('client closed')
  }

  private request<T>(t: string, reply: RoomsServerMsg['t'], body: object): Promise<T> {
    const rid = this.nextRid++
    try { this.sendRaw({ t, rid, ...body }, t) } catch (e) { return Promise.reject(e) }
    return this.expect<T>(t, rid, reply)
  }

  private expect<T>(t: string, rid: number | undefined, reply: RoomsServerMsg['t']): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ t, rid, reply, resolve: resolve as (m: never) => void, reject })
    })
  }

  private sendRaw(msg: object, path: string): void {
    if (!this.sock || this.sock.readyState !== 1 || !this.welcomeMsg) {
      throw new RefusalError('rooms', path, 'not connected; await hello() first')
    }
    this.sock.send(JSON.stringify(msg))
  }

  private onMessage(raw: string): void {
    const m = parseRoomsServerMsg(raw)
    if (!m) return
    if (m.t === 'error') {
      // A rid-less error (rate_limited, bad_version) goes to the oldest pending request.
      const i = m.rid === undefined ? (this.pending.length > 0 ? 0 : -1) : this.pending.findIndex((p) => p.rid === m.rid)
      const p = i >= 0 ? this.pending.splice(i, 1)[0] : undefined
      p?.reject(new RefusalError('rooms', p.t, `${m.code}: ${m.message}`))
      return
    }
    const rid = 'rid' in m ? m.rid : undefined
    const i = this.pending.findIndex((p) => p.reply === m.t && p.rid === rid)
    if (m.t === 'room') this.lastRoom = m
    if (m.t === 'started') {
      this.lastStarted = m
      const ws = this.startedWaiters
      this.startedWaiters = []
      for (const w of ws) w(m)
    }
    if (i >= 0) this.pending.splice(i, 1)[0]!.resolve(m as never)
    if (m.t === 'room') for (const fn of this.roomFns) fn(m)
    else if (m.t === 'peerLeft') for (const fn of this.peerLeftFns) fn(m.peer)
    else if (m.t === 'signal') for (const fn of this.signalFns) fn(m.from, m.data)
  }

  private onClosed(why: string): void {
    this.sock = null
    this.lastRoom = null
    const ps = this.pending
    this.pending = []
    for (const p of ps) p.reject(new RefusalError('rooms', p.t, `${why}; reconnect with a new RoomsClient`))
  }
}
