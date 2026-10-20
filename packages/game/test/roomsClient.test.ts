import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { RoomsClient } from '@royal-fiesta/game/net/roomsClient'
import { ROOMS_GAME_ID, fiestaLocalPlayer } from '@royal-fiesta/game/net/roomsProtocol'
import type { LocalPlayer, SignalData, Started } from '@royal-fiesta/game/net/roomsProtocol'
import type { WsFactory, WsLike } from '@royal-fiesta/game/net/ws'

// Scripted fake of the gamesaloon rooms hub (PROTOCOL.md subset), delivering asynchronously like a socket.
type Msg = Record<string, unknown>
const SETTINGS = { kind: 'cup', cupId: 'cup-1', trackId: 'track-1', cc: 100, items: false }
const ICE = [{ urls: ['stun:stun.example:3478'] }]

interface Room { code: string; owner: number; status: 'lobby' | 'racing'; members: Map<number, Conn> }

class Conn implements WsLike {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readonly sent: Msg[] = []
  name = ''; peer = -1; players: LocalPlayer[] = []; room: Room | null = null
  private readonly server: FakeRooms
  constructor(server: FakeRooms) {
    this.server = server
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }
  send(data: string): void {
    const m = JSON.parse(data) as Msg
    this.sent.push(m)
    queueMicrotask(() => this.server.handle(this, m))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.server.drop(this))
  }
  deliver(m: Msg): void {
    queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) }) })
  }
}

class FakeRooms {
  readonly conns: Conn[] = []
  private readonly rooms = new Map<string, Room>()
  private codes = 0
  readonly factory: WsFactory = () => { const c = new Conn(this); this.conns.push(c); return c }

  handle(c: Conn, m: Msg): void {
    const rid = m.rid === undefined ? {} : { rid: m.rid }
    const err = (code: string, message: string) => c.deliver({ t: 'error', ...rid, code, message })
    switch (m.t) {
      case 'hello':
        c.name = m.name as string
        return c.deliver({ t: 'welcome', v: 1, client: `cl-${this.conns.indexOf(c)}`, iceServers: ICE, maxHumans: 8, maxLocal: 4 })
      case 'create': {
        const room: Room = { code: `RM${String(++this.codes).padStart(3, '2')}`, owner: 0, status: 'lobby', members: new Map() }
        this.rooms.set(room.code, room)
        return this.enter(c, room, m, rid)
      }
      case 'join': {
        const room = this.rooms.get(String(m.code).trim().toUpperCase())
        if (!room) return err('room_not_found', 'no such room')
        return this.enter(c, room, m, rid)
      }
      case 'start': {
        const room = c.room
        if (!room) return err('not_in_room', 'not in a room')
        if (room.owner !== c.peer) return err('not_owner', 'only the owner can do that')
        room.status = 'racing'
        const members = this.members(room)
        for (const t of room.members.values()) t.deliver({ t: 'started', ...(t === c ? rid : {}), code: room.code, seed: 1234, settings: SETTINGS, members })
        return
      }
      case 'signal': {
        const target = c.room?.members.get(m.to as number)
        if (!target || target === c) return err('peer_not_found', `no peer ${String(m.to)} in this room`)
        return target.deliver({ t: 'signal', from: c.peer, data: m.data })
      }
    }
  }

  drop(c: Conn): void {
    const room = c.room
    if (!room) return
    room.members.delete(c.peer)
    if (room.owner === c.peer) room.owner = Math.min(...room.members.keys())
    for (const t of room.members.values()) { t.deliver({ t: 'peerLeft', peer: c.peer }); t.deliver(this.roomMsg(room, t, {})) }
  }

  private enter(c: Conn, room: Room, m: Msg, rid: Msg): void {
    let peer = 0
    while (room.members.has(peer)) peer++ // lowest free id in 0..7
    Object.assign(c, { peer, room, players: m.players as LocalPlayer[] })
    room.members.set(peer, c)
    for (const t of room.members.values()) t.deliver(this.roomMsg(room, t, t === c ? rid : {}))
  }

  private members(room: Room): Msg[] {
    return [...room.members.values()].map((t) => ({ peer: t.peer, name: t.name, players: t.players }))
  }

  private roomMsg(room: Room, t: Conn, rid: Msg): Msg {
    return { t: 'room', ...rid, code: room.code, you: t.peer, owner: room.owner, status: room.status, members: this.members(room), settings: SETTINGS, humans: room.members.size }
  }
}

const URL = 'ws://fake/ws'
const tick = () => new Promise((r) => setTimeout(r, 5))

async function party(n: number) {
  const srv = new FakeRooms()
  const clients: RoomsClient[] = []
  for (let i = 0; i < n; i++) {
    const c = new RoomsClient(URL, srv.factory)
    await c.hello(`bean${i}`)
    clients.push(c)
  }
  const replies = [await clients[0]!.create(fiestaLocalPlayer('bean0', 0))]
  assert.equal(clients[0]!.room, replies[0]) // set before create resolves
  for (let i = 1; i < n; i++) replies.push(await clients[i]!.join(replies[0]!.code, fiestaLocalPlayer(`bean${i}`, i)))
  return { srv, clients, code: replies[0]!.code, replies }
}

test('hello sends v:1 and the royal-fiesta game id, and exposes welcome', async () => {
  const srv = new FakeRooms()
  const c = new RoomsClient(URL, srv.factory)
  assert.equal(c.welcome, null)
  assert.equal(c.room, null)
  const w = await c.hello('Bean')
  assert.deepEqual(srv.conns[0]!.sent[0], { t: 'hello', v: 1, game: 'royal-fiesta-1', name: 'Bean' })
  assert.equal(ROOMS_GAME_ID, 'royal-fiesta-1')
  assert.deepEqual(w.iceServers, ICE)
  assert.equal(c.welcome, w)
  c.close()
})

test('create/join carry rid and fiestaLocalPlayer builds the bean', async () => {
  assert.deepEqual(fiestaLocalPlayer('Bob', 3), { name: 'Bob', build: { characterId: 'bean', bodyId: 'c3', wheelId: 'none', gliderId: 'none' } })
  const { srv, clients, code, replies } = await party(2)
  const [create, join] = [srv.conns[0]!.sent[1]!, srv.conns[1]!.sent[1]!]
  assert.deepEqual([create.t, join.t, join.code], ['create', 'join', code])
  assert.ok(create.rid !== undefined && join.rid !== undefined)
  assert.deepEqual(join.players, [fiestaLocalPlayer('bean1', 1)])
  assert.equal(clients[1]!.room, replies[1])
  clients[1]!.leave()
  assert.equal(clients[1]!.room, null)
  for (const c of clients) c.close()
})

test('room is current before create/join resolve and onRoom runs, then clears on leave/close', async () => {
  const srv = new FakeRooms()
  const a = new RoomsClient(URL, srv.factory)
  const b = new RoomsClient(URL, srv.factory)
  for (const c of [a, b]) {
    assert.equal(c.room, null)
    await c.hello('Bean')
    assert.equal(c.room, null)
    c.onRoom((r) => assert.equal(c.room, r))
  }
  const created = await a.create(fiestaLocalPlayer('A', 0))
  assert.equal(a.room, created)
  const joined = await b.join(created.code, fiestaLocalPlayer('B', 1))
  assert.equal(b.room, joined)
  assert.notEqual(a.room, created)
  assert.deepEqual(a.room?.members.map((m) => m.peer), [0, 1])
  b.close()
  assert.equal(b.room, null)
  await tick()
  assert.deepEqual(a.room?.members.map((m) => m.peer), [0])
  a.leave()
  assert.equal(a.room, null)
  a.close()
})

test('socket close resets the current room', async () => {
  const { srv, clients } = await party(2)
  assert.ok(clients[0]!.room)
  srv.conns[0]!.onclose?.({ code: 1006, reason: 'network lost' })
  assert.equal(clients[0]!.room, null)
  for (const c of clients) c.close()
})

test('the owner start resolves waitStarted on every client with members sorted by peer', async () => {
  const { clients } = await party(3)
  const waits = clients.map((c) => c.waitStarted(1000))
  const own = await clients[0]!.start()
  const all: Started[] = await Promise.all(waits)
  for (const s of [own, ...all]) assert.deepEqual([s.seed, s.members.map((m) => m.peer)], [1234, [0, 1, 2]])
  // Started already arrived: a late waitStarted still resolves.
  const late = await clients[2]!.waitStarted(50)
  assert.deepEqual(late.members.map((m) => m.name), ['bean0', 'bean1', 'bean2'])
  for (const c of clients) c.close()
})

test('signal reaches only its target with the sender as from', async () => {
  const { clients } = await party(3)
  const got: [number, number, SignalData][] = []
  clients.forEach((c, i) => c.onSignal((from, data) => got.push([i, from, data])))
  const data: SignalData = { kind: 'offer', sdp: 'v=0' }
  clients[0]!.signal(2, data)
  await tick()
  assert.deepEqual(got, [[2, 0, data]])
  for (const c of clients) c.close()
})

test('a server error rejects with a RefusalError carrying the code', async () => {
  const srv = new FakeRooms()
  const c = new RoomsClient(URL, srv.factory)
  await c.hello('Bean')
  await assert.rejects(c.join('ZZZZZ', fiestaLocalPlayer('Bean', 0)), (e: unknown) => e instanceof RefusalError && e.message === '[rooms] join: room_not_found: no such room')
  c.close()
})

test('waitStarted refuses when no start arrives in time', async () => {
  const { clients } = await party(2)
  await assert.rejects(clients[1]!.waitStarted(50), (e: unknown) => e instanceof RefusalError && e.message.startsWith('[rooms] waitStarted: '))
  for (const c of clients) c.close()
})

test('peerLeft calls onPeerLeft, and room follows the broadcast', async () => {
  const { clients } = await party(3)
  const events: string[] = []
  clients[0]!.onPeerLeft((p) => events.push(`left:${p}`))
  clients[0]!.onRoom((r) => events.push(`room:${r.members.map((m) => m.peer).join(',')}`))
  clients[1]!.close()
  await tick()
  assert.deepEqual(events, ['left:1', 'room:0,2'])
  assert.deepEqual(clients[0]!.room?.members.map((m) => m.peer), [0, 2]) // room follows broadcasts
  for (const c of clients) c.close()
})
