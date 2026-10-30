// In-memory GameSaloon relay: mirrors gamesaloon src/relay/hub.ts message by message (tests, in-page hub, M6 conformance).
import { Rng } from '@gamesaloon/rollback'
import type { WsFactory, WsLike } from './ws.ts'
import { CADENCE_RATE_PER_MIN as CAD_MIN, CADENCE_RATE_PER_SEC as CAD_SEC, RELAY_MAX_ACT_DEPTH, RELAY_MAX_ACT_ITEMS } from './relayProtocol.ts'
import { RELAY_MAX_ACT_KEYS, RELAY_MAX_MSG_BYTES, RELAY_MAX_PLAYERS, RELAY_RATE_PER_SEC } from './relayProtocol.ts'

// Hub values missing from the game's protocol copy; MAX_ROOMS/MAX_SOCKETS (200/500) are never reached in memory.
const RATE_PER_MIN = 400
const MAX_INVALID = 10
const RESUME_GRACE_MS = 60_000
const SEQUENCE_MAX = 1_000_000
// The hub also knows resume, which the game's copy leaves out.
const CLIENT_TYPES: readonly unknown[] = ['create', 'join', 'act', 'bye', 'queue', 'unqueue', 'resume', 'ping']

type Obj = Record<string, unknown>
interface Client { id: number; sock: Sock; room: string | null; cadence: boolean; invalid: number; times: number[] }
interface Room {
  code: string; players: number; cadence: boolean; started: boolean; seats: (number | null)[]
  payloads: unknown[]; recv: number[]; down: (number | null)[]; gone: boolean[]
}
interface Waiter { id: number; payload: unknown; since: number }
interface Sock extends WsLike { readonly id: number; state: number }
// open/out/sclose reach the client, in/cclose the server; one FIFO keeps the order a real socket pair would.
type Item = { k: 'open' | 'in' | 'out' | 'cclose' | 'sclose'; s: Sock; data?: unknown; code?: number; reason?: string }
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
function shallowEnough(v: unknown, depth: number): boolean {
  if (depth > RELAY_MAX_ACT_DEPTH) return false
  if (v === null || typeof v !== 'object') return true
  const entries = Array.isArray(v) ? v : Object.values(v)
  if (entries.length > (Array.isArray(v) ? RELAY_MAX_ACT_ITEMS : RELAY_MAX_ACT_KEYS)) return false
  return entries.every((e) => shallowEnough(e, depth + 1))
}
// UTF-8 length like the hub's Buffer.byteLength, without Buffer (TextEncoder exists in browsers and Node).
const utf8 = new TextEncoder()
// The hub's isValidRelayMessage.
function validMsg(m: Obj): boolean {
  if (m.t === 'act') return (isObj(m.a) || Array.isArray(m.a)) && shallowEnough(m.a, 0) && (m.n === undefined || isInt(m.n, 0, SEQUENCE_MAX))
  if (m.t === 'create' || m.t === 'queue') {
    if (m.players !== undefined && !isInt(m.players, 2, RELAY_MAX_PLAYERS)) return false
    if (m.cadence !== undefined && typeof m.cadence !== 'boolean') return false
    return !(m.t === 'queue' && typeof m.payload === 'object' && m.payload !== null && !shallowEnough(m.payload, 0))
  }
  if (m.t === 'join') return typeof m.code === 'string'
  if (m.t === 'resume') return typeof m.token === 'string' && m.token.length > 0 && m.token.length <= 64
  return true
}

export class LoopbackRelay {
  readonly serverLog: { to: number; t: string }[] = []
  private rng: Rng
  private nextId = 0
  private items: Item[] = []
  private scheduled = false
  private clients = new Map<number, Client>()
  private rooms = new Map<string, Room>()
  private waitLists = new Map<string, Waiter[]>()
  private recentWaitsMs: number[] = []
  private quickSeq = 0

  constructor(opts?: { seed?: number }) { this.rng = new Rng(opts?.seed ?? 1) }

  factory(): WsFactory {
    return (_url) => {
      const s: Sock = {
        id: this.nextId++, state: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        get readyState() { return s.state },
        // Like a browser WebSocket: an error while connecting, a silent discard once closing.
        send: (data) => {
          if (s.state === 0) throw new Error('InvalidStateError: WebSocket is still connecting')
          if (s.state === 1) this.enqueue({ k: 'in', s, data })
        },
        close: (code, reason) => {
          if (s.state < 2) this.enqueue({ k: 'cclose', s, code: code ?? 1005, reason: reason ?? '' })
          s.state = Math.max(s.state, 2)
        },
      }
      this.enqueue({ k: 'open', s })
      this.clients.set(s.id, { id: s.id, sock: s, room: null, cadence: false, invalid: 0, times: [] })
      return s
    }
  }

  pump(): void {
    this.tick(this.now())
    for (let it = this.items.shift(); it; it = this.items.shift()) this.deliver(it)
  }
  private enqueue(item: Item): void {
    this.items.push(item)
    if (!this.scheduled) queueMicrotask(() => { this.scheduled = false; this.pump() })
    this.scheduled = true
  }
  private deliver(it: Item): void {
    const s = it.s
    if (it.k === 'in') return this.message(s.id, it.data)
    if (it.k === 'open' && s.state === 0) { s.state = 1; s.onopen?.() }
    if (it.k === 'out' && s.state === 1) s.onmessage?.({ data: it.data })
    if (it.k === 'cclose') this.disconnect(s.id)
    if ((it.k === 'cclose' || it.k === 'sclose') && s.state !== 3) { s.state = 3; s.onclose?.({ code: it.code ?? 1005, reason: it.reason ?? '' }) }
  }
  // The only clock, read at call time (rate windows, queue estimates, grace deadlines).
  private now(): number { return globalThis.performance.now() }
  private random(): number { return this.rng.next() }
  private message(id: number, raw: unknown): void {
    const c = this.clients.get(id)
    if (!c) return
    const now = this.now()
    // Over the limit the hub answers 'rate limited' and closes the socket.
    if (this.rateLimited(c, now)) { this.error(id, 'rate limited'); return this.closeClient(c) }
    // Binary, oversize, non-JSON, non-object or unknown-type frames (hub extensions; none here) are invalid.
    if (typeof raw !== 'string' || utf8.encode(raw).length > RELAY_MAX_MSG_BYTES) return this.dropInvalid(c)
    let m: unknown
    try { m = JSON.parse(raw) } catch { return this.dropInvalid(c) }
    if (!isObj(m) || !CLIENT_TYPES.includes(m.t)) return this.dropInvalid(c)
    if (!validMsg(m)) {
      // The hub coerces join codes and answers a bad queue payload instead of counting it invalid.
      if (m.t === 'join') return this.dispatch(c, { t: 'join', code: String(m.code || ''), payload: m.payload }, now)
      if (m.t === 'queue' && validMsg({ ...m, payload: null })) return this.error(id, 'bad queue payload')
      return this.dropInvalid(c)
    }
    this.dispatch(c, m, now)
  }
  private dispatch(c: Client, m: Obj, now: number): void {
    const t = m.t
    if (t === 'create') {
      const code = this.newCode()
      if (!code) return this.error(c.id, 'server full')
      this.seat(this.makeRoom(code, (m.players as number | undefined) ?? 2, !!m.cadence), 0, c, m.payload)
      return this.send(c.id, { t: 'room', code })
    }
    if (t === 'join') {
      const room = this.rooms.get(String(m.code || ''))
      if (!room) return this.error(c.id, 'room not found')
      const free = room.seats.indexOf(null)
      if (free < 0 || room.started) return this.error(c.id, 'room full')
      this.seat(room, free, c, m.payload)
      if (room.seats.includes(null)) return this.send(c.id, { t: 'waiting', seat: free, players: room.players })
      return this.startRoom(room)
    }
    if (t === 'queue') return this.queue(c, m, now)
    if (t === 'unqueue') { this.dropFromWaitLists(c.id); return this.send(c.id, { t: 'unqueued' }) }
    if (t === 'act') {
      // Acts reach the occupied seats even before the room is full; a repeated n is acked, not relayed.
      const room = this.rooms.get(c.room ?? '')
      const side = room ? room.seats.indexOf(c.id) : -1
      if (!room || side < 0) return
      const n = (m.n as number | undefined) ?? room.recv[side] + 1
      if (n <= room.recv[side]) return this.send(c.id, { t: 'ack', n })
      room.recv[side] = n
      this.send(c.id, { t: 'ack', n })
      return this.broadcast(room, { t: 'act', a: m.a, n, from: side }, side)
    }
    if (t === 'ping') return this.send(c.id, { t: 'pong' })
    // No resume here (the game never resumes): every token gets the hub's unknown-token answer.
    if (t === 'resume') return this.error(c.id, 'resume expired')
    if (t === 'bye') this.cleanup(c, true)
  }
  private queue(c: Client, m: Obj, now: number): void {
    for (const list of this.waitLists.values()) if (list.some((e) => e.id === c.id)) return
    const players = (m.players as number | undefined) ?? 2
    const key = `${players}|${m.cadence ? 1 : 0}`
    const list = (this.waitLists.get(key) ?? []).filter((e) => this.clients.has(e.id))
    this.waitLists.set(key, list)
    list.push({ id: c.id, payload: m.payload ?? null, since: now })
    if (list.length < players) {
      const w = this.recentWaitsMs.slice(-10)
      return this.send(c.id, { t: 'queued', estimateMs: w.length ? Math.round(w.reduce((a, b) => a + b, 0) / w.length) : null })
    }
    const seated = list.splice(0, players)
    if (!list.length) this.waitLists.delete(key)
    for (const e of seated) this.recentWaitsMs.push(now - e.since)
    this.recentWaitsMs.splice(0, this.recentWaitsMs.length - 50)
    const room = this.makeRoom(`q${++this.quickSeq}`, players, !!m.cadence)
    seated.forEach((e, i) => { room.seats[i] = e.id; room.payloads[i] = e.payload })
    this.startRoom(room)
  }
  private makeRoom(code: string, players: number, cadence: boolean): Room {
    const fill = <T>(v: T): T[] => new Array<T>(players).fill(v)
    const room: Room = {
      code, players, cadence, started: false, seats: fill<number | null>(null),
      payloads: fill<unknown>(null), recv: fill(0), down: fill<number | null>(null), gone: fill(false),
    }
    this.rooms.set(code, room)
    return room
  }
  private seat(room: Room, i: number, c: Client, payload: unknown): void {
    room.seats[i] = c.id
    room.payloads[i] = payload ?? null
    c.room = room.code
  }
  private startRoom(room: Room): void {
    const seed = (this.random() * 0xffffffff) >>> 0
    const hostStarts = this.random() < 0.5
    const tokens = Array.from({ length: room.players }, () => this.uuid())
    room.started = true
    room.seats.forEach((id, s) => {
      const c = id === null ? undefined : this.clients.get(id)
      if (!c) return
      Object.assign(c, { room: room.code, cadence: room.cadence })
      const msg: Obj = { t: 'matched', seed, hostStarts, youAre: s, token: tokens[s], players: room.players, opps: room.payloads }
      if (room.players === 2) msg.opp = room.payloads[1 - s]
      this.send(c.id, msg)
    })
  }
  // Grace deadlines of dropped seats, checked at each pump (the hub ticks them).
  private tick(now: number): void {
    for (const room of [...this.rooms.values()]) {
      for (let side = 0; side < room.players && this.rooms.has(room.code); side++) if (now >= (room.down[side] ?? Infinity)) this.endSeat(room, side)
    }
  }
  // The hub's windows: 1 s and 60 s, counted over every frame including invalid ones.
  private rateLimited(c: Client, now: number): boolean {
    c.times = c.times.filter((t) => now - t <= 60_000)
    c.times.push(now)
    const inSec = c.times.filter((t) => now - t <= 1000).length
    return c.times.length > (c.cadence ? CAD_MIN : RATE_PER_MIN) || inSec > (c.cadence ? CAD_SEC : RELAY_RATE_PER_SEC)
  }
  private dropInvalid(c: Client): void { if (++c.invalid >= MAX_INVALID) this.closeClient(c) }
  // Server-side close: the client sees onclose after the frames already queued to it.
  private closeClient(c: Client): void {
    this.enqueue({ k: 'sclose', s: c.sock })
    this.disconnect(c.id)
  }
  private disconnect(id: number): void {
    const c = this.clients.get(id)
    if (c) { this.clients.delete(id); this.cleanup(c) }
  }
  // A disconnect holds a started seat for the grace (dropped); a bye, or any leave before matched, ends it (left).
  private cleanup(c: Client, graceful = false): void {
    this.dropFromWaitLists(c.id)
    for (const room of [...this.rooms.values()]) {
      const side = room.seats.indexOf(c.id)
      if (side < 0) continue
      if (graceful || !room.started) { this.endSeat(room, side); continue }
      if (room.down[side] !== null) continue
      room.down[side] = this.now() + RESUME_GRACE_MS
      const graceMs = RESUME_GRACE_MS
      this.broadcast(room, room.players === 2 ? { t: 'opp_dropped', graceMs } : { t: 'player_dropped', seat: side, graceMs }, side)
    }
  }
  private endSeat(room: Room, side: number): void {
    if (room.gone[side]) return
    room.gone[side] = true
    this.unseat(room.seats[side])
    room.seats[side] = null
    if (room.players > 2) {
      this.broadcast(room, { t: 'player_left', seat: side }, side)
      if (room.gone.filter((g) => !g).length > 1) return
    }
    this.broadcast(room, { t: 'opp_left' }, side)
    room.seats.forEach((id) => this.unseat(id))
    this.rooms.delete(room.code)
  }
  private unseat(id: number | null): void {
    const c = id === null ? undefined : this.clients.get(id)
    // The send budget belongs to the seat: a fresh (or returning) connection starts a new window.
    if (c) { c.room = null; c.cadence = false; c.times = [] }
  }
  private dropFromWaitLists(id: number): void {
    for (const [key, list] of this.waitLists) {
      const rest = list.filter((e) => e.id !== id)
      if (rest.length) this.waitLists.set(key, rest)
      else this.waitLists.delete(key)
    }
  }
  private broadcast(room: Room, msg: Obj, except: number): void {
    room.seats.forEach((id, s) => { if (s !== except && id !== null) this.send(id, msg) })
  }
  private error(id: number, reason: string): void { this.send(id, { t: 'error', reason }) }
  private send(id: number, msg: Obj): void {
    const c = this.clients.get(id)
    if (!c) return
    this.serverLog.push({ to: id, t: msg.t as string })
    this.enqueue({ k: 'out', s: c.sock, data: JSON.stringify(msg) })
  }
  private newCode(): string | null {
    for (let i = 0; i < 50; i++) {
      const code = String(1000 + Math.floor(this.random() * 9000))
      if (!this.rooms.has(code)) return code
    }
    return null
  }
  private uuid(): string {
    const b = Array.from({ length: 16 }, (_, i) => {
      const x = Math.floor(this.random() * 256)
      return i === 6 ? (x & 15) | 64 : i === 8 ? (x & 63) | 128 : x
    })
    const h = b.map((x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
}
