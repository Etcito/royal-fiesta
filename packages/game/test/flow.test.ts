import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { fixtureResolver } from '../src/assets.ts'
import { basisFromFacing } from '../src/client/cameraBasis.ts'
import { emptyControls } from '../src/client/inputMap.ts'
import type { RawControls } from '../src/client/inputMap.ts'
import { loadCourse } from '../src/course.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import { PlayFlow } from '../src/hub/flow.ts'
import type { FlowEvent, FlowState } from '../src/hub/flow.ts'
import { HUB_MAX_ACTS_PER_MIN, HUB_RATE_HZ, HUB_MATCH_RATE_HZ } from '../src/hub/protocol.ts'
import { lobbyLines } from '../src/hub/lobby.ts'
import { LoopbackRelay } from '../src/net/loopbackRelay.ts'
import type { WsFactory, WsLike } from '../src/net/ws.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')
const resolver = fixtureResolver(read)
const FRAME_MS = 1000 / 60
const realNow = performance.now.bind(performance)

let R: RapierModule
let courses: ResolvedCourse[]
let plaza: ResolvedCourse

before(async () => {
  R = await initRapier()
  const names = readdirSync(new URL('fixtures/courses/', ROOT), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name).sort()
  const entries: CourseEntry[] = []
  for (const n of names) {
    const path = `fixtures/courses/${n}`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  courses = await matchCourses(entries, resolver, 'sprint')
  const path = 'fixtures/courses/hub-plaza.course.json'
  plaza = await loadCourse(JSON.parse(await read(path)) as unknown, path, resolver)
})

// One frame a client put on a socket, with the flow state at send time.
interface Sent { ms: number; t: string; state: FlowState; a?: Record<string, unknown> }
interface SockRec { id: number; sent: Sent[]; closedByClient: boolean }
interface Client { flow: PlayFlow; socks: SockRec[]; events: FlowEvent[] }

// Virtual clock shared by PlayFlow (deps.now) and LoopbackRelay (performance.now).
class World {
  ms = 0
  logSeen = 0
  readonly relay: LoopbackRelay
  readonly clients: Client[] = []
  constructor(seed: number, lobby?: { waitMs?: number }) {
    this.relay = new LoopbackRelay({ seed, lobby })
    // A plain swap: mock.method would record every call, and Rapier reads the clock too.
    performance.now = () => this.ms
  }

  add(name: string, colour: number, hubCode: string | 'new', partySize: 2 | 3 | 4, pilot: boolean, matchmaking?: 'lobby' | 'pad'): Client {
    const inner = this.relay.factory()
    const c: Client = { flow: null as unknown as PlayFlow, socks: [], events: [] }
    const ws: WsFactory = url => {
      const s = inner(url)
      const rec: SockRec = { id: (s as WsLike & { id: number }).id, sent: [], closedByClient: false }
      c.socks.push(rec)
      const send = s.send.bind(s)
      const close = s.close.bind(s)
      s.send = data => {
        const m = JSON.parse(data) as { t: string; a?: Record<string, unknown> }
        if (s.readyState === 1) rec.sent.push({ ms: this.ms, t: m.t, state: c.flow.state, a: m.a })
        send(data)
      }
      s.close = (code, reason) => { rec.closedByClient = true; close(code, reason) }
      return s
    }
    c.flow = new PlayFlow({
      R, relayUrl: 'loopback://relay', ws, hubCode, name, colour, courses, plaza, partySize,
      now: () => this.ms, pilot, log: ev => c.events.push(ev), matchmaking,
    })
    this.clients.push(c)
    return c
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      this.relay.pump()
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  async step(controls: (c: Client) => RawControls | null = () => null): Promise<void> {
    this.ms += FRAME_MS
    for (const c of this.clients) c.flow.frame(FRAME_MS / 1000, controls(c), 0)
    await this.settle()
  }

  async until(cond: () => boolean, maxMs: number, controls?: (c: Client) => RawControls | null): Promise<void> {
    const end = this.ms + maxMs
    while (!cond()) {
      assert.ok(this.ms < end, `condition not met within ${maxMs} virtual ms; states ${this.clients.map(c => c.flow.state).join(',')}`)
      await this.step(controls)
    }
  }

  close(): void {
    for (const c of this.clients) c.flow.close()
    this.relay.pump()
    performance.now = realNow
  }

  serverReplies(sock: SockRec): string[] { return this.relay.serverLog.filter(e => e.to === sock.id).map(e => e.t) }
}

// Hub and match: 4 clients join one hub, the first creates it.
async function hubOf(w: World, n: number, partySize: 2 | 3 | 4, pilot: boolean): Promise<Client[]> {
  const host = w.add('Bean0', 0, 'new', partySize, pilot)
  void host.flow.start()
  await w.until(() => host.flow.state === 'hub', 1000)
  const code = host.flow.hubCode!
  for (let i = 1; i < n; i++) {
    const c = w.add(`Bean${i}`, i, code, partySize, pilot)
    void c.flow.start()
    await w.until(() => c.flow.state === 'hub', 1000)
  }
  return w.clients
}

// Most frames in any window of the relay's kind (t_last - t_first <= windowMs).
function maxInWindow(times: number[], windowMs: number): number {
  let best = 0
  for (let i = 0, j = 0; j < times.length; j++) {
    while (times[j] - times[i] > windowMs) i++
    best = Math.max(best, j - i + 1)
  }
  return best
}

function assertHubBudget(c: Client): void {
  const times = c.socks[0].sent.map(s => s.ms)
  assert.ok(maxInWindow(times, 60_000) <= HUB_MAX_ACTS_PER_MIN, `hub 60 s window ${maxInWindow(times, 60_000)}`)
  assert.ok(maxInWindow(times, 1000) <= 10, `hub 1 s window ${maxInWindow(times, 1000)}`)
}

// No 'rate limited' (nor any other error), no server close, never failed.
function assertClean(w: World): void {
  // Incremental: the server log grows by thousands of entries per virtual minute.
  for (; w.logSeen < w.relay.serverLog.length; w.logSeen++) assert.notEqual(w.relay.serverLog[w.logSeen].t, 'error', 'relay answered an error')
  for (const c of w.clients) {
    assert.ok(!c.events.some(e => e.state === 'failed'), `${c.flow.state}: ${JSON.stringify(c.events.find(e => e.state === 'failed'))}`)
  }
}

// Gaps between consecutive st acts sent in the given states, in ms.
function stGaps(c: Client, states: FlowState[]): number[] {
  const st = c.socks[0].sent.filter(s => s.t === 'act' && s.a?.k === 'st')
  const gaps: number[] = []
  for (let i = 1; i < st.length; i++) {
    if (states.includes(st[i - 1].state) && states.includes(st[i].state)) gaps.push(st[i].ms - st[i - 1].ms)
  }
  return gaps
}

function assertRate(gaps: number[], hz: number, what: string): void {
  assert.ok(gaps.length > 0, `${what}: no st pairs`)
  const period = 1000 / hz
  // Each gap is one period within one frame, and the mean is the period.
  for (const g of gaps) assert.ok(Math.abs(g - period) <= FRAME_MS + 1e-6, `${what}: st gap ${g} ms, expected ${period}`)
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  assert.ok(Math.abs(mean - period) <= FRAME_MS / gaps.length + 1e-6, `${what}: mean st gap ${mean} ms, expected ${period}`)
}

const LOOP: FlowState[] = ['connecting', 'hub', 'queued', 'match', 'podium', 'returning', 'hub']

async function fullLoop(n: 2 | 3 | 4): Promise<void> {
  const w = new World(100 + n)
  try {
    const clients = await hubOf(w, n, n, true)
    const sees = () => clients.every(c => c.flow.remotes(w.ms).filter(v => !v.stale).length === n - 1)
    await w.until(sees, 3000)
    // Count consecutive on-pad hub frames up to the queued transition.
    const run = clients.map(() => 0)
    const dwell = clients.map(() => -1)
    const socksAtQueue = clients.map(() => -1)
    const end = w.ms + 400_000
    while (!clients.every(c => c.flow.lastLog !== null && c.flow.state === 'hub')) {
      assert.ok(w.ms < end, `loop not done; states ${clients.map(c => c.flow.state).join(',')}`)
      const prev = clients.map(c => c.flow.state)
      await w.step()
      clients.forEach((c, i) => {
        if (prev[i] !== 'hub') return
        run[i] = c.flow.hub.onQueuePad() ? run[i] + 1 : 0
        // The last seat to queue is matched within the same step.
        if (c.events.some(e => e.state === 'queued') && dwell[i] < 0) { dwell[i] = run[i]; socksAtQueue[i] = c.socks.length }
      })
      assertClean(w)
    }
    // Back in the hub, everyone sees everyone again, and nobody twice.
    await w.until(sees, 3000)
    for (const c of clients) assert.equal(c.flow.remotes(w.ms).length, n - 1)

    const logs = clients.map(c => c.flow.lastLog!)
    for (const l of logs) {
      assert.equal(l.winner, logs[0].winner)
      assert.equal(l.finalHash, logs[0].finalHash)
    }
    const opp = clients.filter(c => w.serverReplies(c.socks[1]).includes('opp_left'))
    assert.equal(opp.length, 1, 'exactly one seat sees the room dissolve')
    clients.forEach((c, i) => {
      assert.deepEqual(c.events.map(e => e.state), LOOP)
      // Dwell: armed after 90 consecutive frames on the pad, then a second socket queues.
      assert.equal(dwell[i], 90, `client ${i} dwell`)
      assert.equal(socksAtQueue[i], 2)
      assert.equal(c.socks.length, 2, 'one hub socket and one match socket')
      const [hub, match] = c.socks
      assert.deepEqual(match.sent.filter(s => s.t === 'queue').length, 1)
      assert.equal(match.sent[0].t, 'queue')
      assert.ok(match.closedByClient, 'match socket closed after the podium')
      // The hub socket stays open through the match, with x = 1 at 1 Hz.
      assert.equal(hub.closedByClient, false)
      const inMatch = hub.sent.filter(s => s.a?.k === 'st' && s.state === 'match')
      assert.ok(inMatch.length >= 5, `st during the match: ${inMatch.length}`)
      for (const s of hub.sent) {
        if (s.a?.k !== 'st') continue
        assert.equal(s.a.x, s.state === 'match' || s.state === 'podium' || s.state === 'returning' ? 1 : 0)
      }
      assertRate(stGaps(c, ['hub']), HUB_RATE_HZ, 'hub')
      // The last seat to queue is matched at once and may send no queued pair.
      const queued = stGaps(c, ['queued'])
      if (queued.length > 0) assertRate(queued, HUB_RATE_HZ, 'queued')
      assertRate(stGaps(c, ['match']), HUB_MATCH_RATE_HZ, 'match')
      // Q2: the last seat skips the bye after opp_left; the others say bye once.
      const byes = match.sent.filter(s => s.t === 'bye').length
      assert.equal(byes, opp.includes(c) ? 0 : 1, `client ${i} match byes`)
      assertHubBudget(c)
    })
    assertClean(w)
    // Closing sends the hub bye and still stays clean.
    w.close()
    for (const c of clients) assert.equal(c.socks[0].sent.at(-1)!.t, 'bye')
    assert.deepEqual(w.relay.serverLog.filter(e => e.t === 'error'), [])
  } finally { w.close() }
}

for (const n of [2, 3, 4] as const) {
  test(`full loop, ${n} clients: hub -> queue -> match -> podium -> hub within the hub budget`, () => fullLoop(n))
}

// World-space stick toward (tx, tz): the inverse of controlsToInput's basis (stick = w . right, w . forward).
function steer(c: Client, tx: number, tz: number): RawControls {
  const st = c.flow.hub.state({
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  })
  const dx = tx - st.pos.x
  const dz = tz - st.pos.z
  const d = Math.sqrt(dx * dx + dz * dz)
  const out = emptyControls()
  if (d < 0.2) return out
  const wx = dx / d
  const wz = dz / d
  const b = basisFromFacing(st.facing)
  out.stickX = wx * b.right.x + wz * b.right.z
  out.stickY = wx * b.forward.x + wz * b.forward.z
  return out
}

test('1 client: the pad dwell queues on a second socket, leaving the pad unqueues back to the hub', async () => {
  const w = new World(7)
  try {
    const [c] = await hubOf(w, 1, 2, false)
    const pad = plaza.queuePad!
    let run = 0
    await w.until(() => {
      run = c.flow.hub.onQueuePad() ? run + 1 : 0
      return c.flow.state === 'queued'
    }, 30_000, () => steer(c, pad.center.x, pad.center.z))
    // Counted after each step, the arming frame included.
    assert.equal(run, 90, 'dwell frames')
    assert.equal(c.socks.length, 2)
    assert.equal(c.flow.hub.onQueuePad(), true)
    await w.until(() => c.socks[1].sent.length > 0, 1000, () => steer(c, pad.center.x, pad.center.z))
    assert.equal(c.socks[1].sent[0].t, 'queue')
    // Nobody else queues: hold on the pad for 5 s, still queued, st keeps 5 Hz with q = 1.
    const holdEnd = w.ms + 5000
    await w.until(() => w.ms >= holdEnd, 6000, () => steer(c, pad.center.x, pad.center.z))
    assert.equal(c.flow.state, 'queued')
    const queuedSt = c.socks[0].sent.filter(s => s.a?.k === 'st' && s.state === 'queued')
    assert.ok(queuedSt.length >= 20 && queuedSt.every(s => s.a!.q === 1), `queued st ${queuedSt.length}`)
    assertRate(stGaps(c, ['queued']), HUB_RATE_HZ, 'queued')
    // Walk back to the spawn: cancel -> unqueue -> hub; the unseated match socket sends no bye.
    const sp = plaza.spawns[0].t
    await w.until(() => c.flow.state === 'hub', 10_000, () => steer(c, sp.x, sp.z))
    assert.deepEqual(c.events.map(e => e.state), ['connecting', 'hub', 'queued', 'hub'])
    assert.deepEqual(c.socks[1].sent.map(s => s.t), ['queue', 'unqueue'])
    assert.ok(c.socks[1].closedByClient)
    assert.equal(c.socks[0].closedByClient, false)
    assertHubBudget(c)
    assertClean(w)
  } finally { w.close() }
})

test('4 clients held in the hub for 3 virtual minutes stay within the budget and are never rate limited', async () => {
  const w = new World(11)
  try {
    const clients = await hubOf(w, 4, 4, false)
    const start = w.ms
    let lastSeen = 0
    while (w.ms - start < 180_000) {
      await w.step()
      assertClean(w)
      if (w.ms - lastSeen >= 1000) {
        lastSeen = w.ms
        for (const c of clients) assert.equal(c.flow.remotes(w.ms).filter(v => !v.stale).length, 3)
      }
    }
    for (const c of clients) {
      assert.equal(c.flow.state, 'hub')
      assert.equal(c.socks.length, 1)
      assertRate(stGaps(c, ['hub']), HUB_RATE_HZ, 'hub')
      assertHubBudget(c)
      // 5 Hz for 3 minutes is about 900 states: none was skipped by the budget.
      const st = c.socks[0].sent.filter(s => s.a?.k === 'st')
      assert.ok(st.length >= 899, `st ${st.length}`)
      const seqs = st.map(s => s.a!.s as number)
      assert.deepEqual(seqs, seqs.map((_, i) => i))
      assert.ok(c.socks[0].sent.filter(s => s.a?.k === 'hi').length >= 36)
    }
    w.close()
    for (const c of clients) assert.equal(c.socks[0].sent.at(-1)!.t, 'bye')
    assertClean(w)
  } finally { w.close() }
})

// GameSaloon timed lobbies (matchmaking: lobby): no pad, no key; the server starts the round after its wait.
async function lobbyClient(w: World, name: string, colour: number): Promise<Client> {
  const c = w.add(name, colour, 'new', 4, false, 'lobby')
  void c.flow.start()
  await w.until(() => c.flow.state !== 'connecting' && c.flow.state !== 'hub', 2000)
  return c
}

test('lobby: the first player opens a lobby by itself, the next one gets the choice and joins by default; the round starts at the end of the wait with both', async () => {
  const w = new World(21, { waitMs: 20_000 })
  try {
    const a = await lobbyClient(w, 'Ann', 0)
    await w.until(() => a.flow.lobby.view.stage === 'player', 1000)
    assert.equal(a.flow.state, 'queued')
    // The shared hub: no private hub room, the lobby socket is the only one.
    assert.equal(a.socks[0].sent[0].t, 'lobby_enter')
    assert.equal(a.socks.length, 1)
    const b = await lobbyClient(w, 'Bob', 1)
    await w.until(() => b.flow.state === 'choosing', 1000)
    assert.deepEqual(b.flow.lobby.view.offer!.actions, ['join', 'spectate', 'new'])
    // Unanswered for 10 s: Bob joins; Ann sees 2/4 and the same end time.
    await w.until(() => b.flow.lobby.view.stage === 'player', 11_000)
    await w.until(() => a.flow.lobby.view.names.length === 2, 1000)
    assert.ok(Math.abs(a.flow.lobby.view.startsAt! - b.flow.lobby.view.startsAt!) < 50)
    // Nobody else comes: the round starts with 2 humans (bots fill the other 6).
    await w.until(() => a.flow.state === 'match' && b.flow.state === 'match', 12_000)
    assert.ok(w.ms >= 20_000)
    const seats = [a, b].map(c => c.events.find(e => e.state === 'match')!.detail.seat).sort()
    assert.deepEqual(seats, [0, 1])
    for (let i = 0; i < 120; i++) await w.step()
    assertClean(w)
  } finally { w.close() }
})

test('lobby: a lone player starts alone after the wait, with bots, and the round runs', async () => {
  const w = new World(22, { waitMs: 2000 })
  try {
    const a = await lobbyClient(w, 'Ann', 0)
    await w.until(() => a.flow.state === 'match', 4000)
    const tick0 = a.flow.match!.session.stats.confirmedTick
    for (let i = 0; i < 180; i++) await w.step()
    assert.ok(a.flow.match!.session.stats.confirmedTick > tick0 + 100, 'a one-peer round advances')
    // The match plays to its podium, the hub comes back (nobody to wait for) and enters a lobby again.
    await w.until(() => a.events.filter(e => e.state === 'hub').length === 2, 900_000)
    await w.until(() => a.flow.state === 'queued' && a.flow.lobby.view.stage === 'player', 2000)
    assertClean(w)
  } finally { w.close() }
})

test('lobby: arriving during a round offers spectate or new; spectating shows the round, its end enters again', async () => {
  const w = new World(23, { waitMs: 1000 })
  try {
    const a = await lobbyClient(w, 'Ann', 0)
    await w.until(() => a.flow.state === 'match', 3000)
    const b = await lobbyClient(w, 'Bob', 1)
    await w.until(() => b.flow.state === 'choosing', 1000)
    assert.deepEqual(b.flow.lobby.view.offer!.actions, ['spectate', 'new'])
    b.flow.pick('spectate')
    await w.until(() => b.flow.state === 'watching' && b.flow.lobby.view.phase === 'playing', 1000)
    assert.equal(b.flow.match, null, 'a spectator runs no rollback session')
    // Ann leaves: the round ends, Bob looks again and, with no lobby left, opens his own.
    a.flow.close()
    await w.until(() => b.flow.state === 'queued' && b.flow.lobby.view.stage === 'player', 2000)
    await w.until(() => b.flow.state === 'match', 3000)
  } finally { w.close() }
})

test('lobby: a server without lobbies falls back to the exact-size queue', async () => {
  const w = new World(24)
  try {
    const a = w.add('Ann', 0, 'new', 2, false, 'lobby')
    const b = w.add('Bob', 1, 'new', 2, false, 'lobby')
    void a.flow.start()
    void b.flow.start()
    await w.until(() => a.flow.state === 'match' && b.flow.state === 'match', 5000)
    assert.deepEqual(a.socks[0].sent.map(s => s.t).slice(0, 2), ['lobby_enter', 'queue'])
    assert.ok(w.ms >= 3000)
  } finally { w.close() }
})

test('lobby: one shared hub; every member is drawn with its name, colour and moves, a spectator apart, a leaver removed', async () => {
  const w = new World(25, { waitMs: 60_000 })
  try {
    const a = await lobbyClient(w, 'Bean', 2)
    await w.until(() => a.flow.lobby.view.stage === 'player', 1000)
    const b = await lobbyClient(w, 'Bob', 5)
    await w.until(() => b.flow.state === 'choosing', 1000)
    b.flow.pick('join')
    await w.until(() => b.flow.lobby.view.stage === 'player', 1000)
    // Both see the other once its first states arrived (one render delay later).
    await w.until(() => a.flow.remotes(w.ms).length === 1 && b.flow.remotes(w.ms).length === 1, 2000)
    const seenByA = a.flow.remotes(w.ms)[0], seenByB = b.flow.remotes(w.ms)[0]
    assert.deepEqual([seenByA.name, seenByA.colour, seenByA.spectator], ['Bob', 5, false])
    // The default name is told apart by arrival order.
    assert.deepEqual([seenByB.name, seenByB.colour], ['Bean 1', 2])
    assert.deepEqual(a.flow.lobby.view.names, ['Bean 1', 'Bob'])
    assert.ok(lobbyLines(a.flow.lobby, w.ms).includes('6 bots will fill the empty places'))
    // Each arrives on its own spawn; Bob walking is seen by Ann.
    const x0 = seenByA.pos.x, z0 = seenByA.pos.z
    assert.ok(Math.hypot(x0 - seenByB.pos.x, z0 - seenByB.pos.z) > 0.5, 'members do not share one spawn')
    const fwd: RawControls = { ...emptyControls(), forward: true }
    for (let i = 0; i < 90; i++) await w.step(c => (c === b ? fwd : null))
    for (let i = 0; i < 30; i++) await w.step()
    const moved = a.flow.remotes(w.ms)[0]
    assert.ok(Math.hypot(moved.pos.x - x0, moved.pos.z - z0) > 1, 'Bob walking is seen in Ann\'s hub')
    // Presence keeps the hub cadence (5 Hz) on the lobby socket; no hub room, no hello.
    const pres = a.socks[0].sent.filter(m => m.t === 'lobby_presence')
    const gaps = pres.slice(1).map((m, i) => m.ms - pres[i].ms)
    assert.ok(gaps.length > 5 && gaps.every(g => Math.abs(g - 1000 / HUB_RATE_HZ) <= FRAME_MS + 1e-6))
    assert.ok(!a.socks[0].sent.some(m => m.t === 'create' || m.t === 'act'))
    // A third client spectates: drawn apart in both hubs.
    const c = await lobbyClient(w, 'Cid', 1)
    await w.until(() => c.flow.state === 'choosing', 1000)
    c.flow.pick('spectate')
    await w.until(() => a.flow.remotes(w.ms).length === 2 && c.flow.remotes(w.ms).length === 2, 2000)
    const cid = a.flow.remotes(w.ms).find(r => r.name === 'Cid')!
    assert.equal(cid.spectator, true)
    assert.deepEqual(a.flow.lobby.view.members.map(m => [m.name, m.role]), [['Bean 1', 'player'], ['Bob', 'player'], ['Cid', 'spectator']])
    // Bob leaves: gone from Ann's hub and Cid's.
    b.flow.close()
    await w.until(() => a.flow.remotes(w.ms).length === 1 && c.flow.remotes(w.ms).length === 1, 2000)
    assert.equal(a.flow.remotes(w.ms)[0].name, 'Cid')
    assertClean(w)
  } finally { w.close() }
})
