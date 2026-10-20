import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { MatchLog } from '@royal-fiesta/sim/match/log'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { controlsToInput, emptyControls } from '../client/inputMap.ts'
import type { RawControls } from '../client/inputMap.ts'
import { createNetMatch } from '../net/netMatch.ts'
import type { NetMatch } from '../net/netMatch.ts'
import { Pilot } from '../net/pilot.ts'
import { RelayClient } from '../net/relayClient.ts'
import { parseRelayServerMsg } from '../net/relayProtocol.ts'
import { RelayTransport } from '../net/relayTransport.ts'
import { netSetup } from '../net/tuning.ts'
import type { WsFactory, WsLike } from '../net/ws.ts'
import { HubPilot } from './hubPilot.ts'
import { HubWorld } from './hubWorld.ts'
import { decodeHubAct, encodeState, HUB_HELLO_EVERY_MS, HUB_MATCH_RATE_HZ, HUB_MAX_ACTS_PER_MIN, HUB_RATE_HZ } from './protocol.ts'
import type { HubHello, HubState } from './protocol.ts'
import { QueuePad } from './queuePad.ts'
import { RemoteBuffer } from './remotes.ts'
import type { RemoteView } from './remotes.ts'

export type FlowState = 'connecting' | 'hub' | 'queued' | 'match' | 'podium' | 'returning' | 'failed'
export interface FlowEvent { ms: number; client: string; state: FlowState; detail: Record<string, string | number | boolean | number[]> }
export interface FlowDeps {
  R: RapierModule; relayUrl: string; ws: WsFactory; hubCode: string | 'new'; name: string; colour: number
  courses: readonly ResolvedCourse[]; plaza: ResolvedCourse; partySize: 2 | 3 | 4; now: () => number
  pilot: boolean; log: (ev: FlowEvent) => void
}

const STEP_S = 1 / 60
interface MatchRoom { seated: boolean; lastSeat: number }

export class PlayFlow {
  private readonly d: FlowDeps
  private current: FlowState = 'connecting'
  private code: string | null = null
  private hubSeat = 0
  private hubWorld: HubWorld | null = null
  private hubClient: RelayClient | null = null
  private matchClient: RelayClient | null = null
  private matchRoom: MatchRoom | null = null
  private netMatch: NetMatch | null = null
  private transport: RelayTransport | null = null
  private hubPilot: HubPilot | null = null
  private matchPilot: Pilot | null = null
  private savedLog: MatchLog | null = null
  private readonly buffer = new RemoteBuffer()
  private readonly greeted = new Set<number>()
  private pad = new QueuePad()
  private readonly input = neutralInput()
  private readonly idle = emptyControls()
  private readonly char: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
  private readonly matchChar: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
  private readonly view: MatchViewState = {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null, final: false, courseIndex: 0,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
  private accumulator = 0
  private lastHello = -Infinity
  private helloPending = false
  private lastState = -Infinity
  private readonly sentAt: number[] = []
  private hubFrames = 0
  private seq = 0
  private started = false
  private closed = false
  private queueRequested = false
  private cancelling = false
  droppedActs = 0

  constructor(d: FlowDeps) { this.d = d }

  get state(): FlowState { return this.current }
  get hubCode(): string | null { return this.code }
  get hub(): HubWorld {
    if (!this.hubWorld) throw new RefusalError('hub', 'PlayFlow.hub', 'hub is unavailable; await start() and read it before close()')
    return this.hubWorld
  }
  get match(): NetMatch | null { return this.netMatch }
  get lastLog(): MatchLog | null { return this.savedLog }

  async start(): Promise<void> {
    if (this.started || this.closed) return
    this.started = true
    try {
      this.transition('connecting')
      const d = this.d
      if (!Number.isInteger(d.partySize) || d.partySize < 2 || d.partySize > 4) {
        throw new RefusalError('hub', 'partySize', 'expected 2..4 players; use a party that fits the relay')
      }
      if (decodeHubAct({ k: 'hi', v: 1, name: d.name, c: d.colour }) === null) {
        throw new RefusalError('hub', 'hello', 'expected a name of 1..24 characters and a colour in 0..7; choose a valid hub identity')
      }
      const client = this.hubClient = new RelayClient(d.relayUrl, url => this.hubSocket(url))
      client.onClose(() => {
        if (!this.closed) this.fail(new RefusalError('hub', d.relayUrl, 'hub socket closed; reconnect to the hub'))
      })
      client.onAct((a, from) => {
        if (this.closed || this.current === 'failed') return
        try {
          const msg = decodeHubAct(a)
          if (msg === null) { this.droppedActs++; return }
          const now = d.now()
          this.buffer.push(from, msg, now)
          // Introduce ourselves to new seats at the next state slot.
          if (!this.greeted.has(from)) { this.greeted.add(from); this.helloPending = true }
        } catch (e) { this.fail(e) }
      })
      client.onSeatEvent(ev => {
        if (ev.t === 'player_left') { this.buffer.remove(ev.seat); this.greeted.delete(ev.seat) }
      })
      await client.connect()
      if (this.closed) return
      if (d.hubCode === 'new') this.code = await client.create(4)
      else {
        const reply = await client.join(d.hubCode)
        this.hubSeat = 'seat' in reply ? reply.seat : reply.youAre
        this.code = d.hubCode
      }
      if (this.closed) return
      this.hubWorld = new HubWorld(d.R, d.plaza, this.hubSeat)
      if (d.pilot) this.hubPilot = new HubPilot(d.plaza, this.hubSeat, d.partySize)
      this.hello(d.now())
      this.transition('hub', { seat: this.hubSeat, code: this.code! })
    } catch (e) { this.fail(e) }
  }

  frame(dtS: number, controls: RawControls | null, emote: number): void {
    if (this.closed || this.current === 'failed' || this.current === 'connecting') return
    try {
      if (!Number.isFinite(dtS) || dtS < 0) throw new RefusalError('hub', 'frame.dtS', 'expected finite nonnegative seconds; pass the elapsed frame time')
      const now = this.d.now()
      if (this.current === 'returning') {
        this.hubWorld!.free()
        this.hubWorld = null
        this.hubWorld = new HubWorld(this.d.R, this.d.plaza, this.hubSeat)
        this.pad = new QueuePad()
        this.accumulator = 0
        this.lastState = -Infinity
        this.transition('hub', { winner: this.savedLog!.winner })
      }
      if (emote !== 0) this.hub.setEmote(emote, now)
      if (this.current === 'hub' || this.current === 'queued') {
        this.accumulator = Math.min(this.accumulator + dtS, 8 * STEP_S)
        for (let ticks = 0; ticks < 8 && this.accumulator >= STEP_S; ticks++) {
          this.accumulator -= STEP_S
          const st = this.hub.state(this.char)
          if (this.hubPilot) {
            this.hubPilot.sample(now, st.pos.x, st.pos.z, this.buffer.sample(now).length, this.savedLog === null, this.input)
            const id = this.hubPilot.takeEmote(now)
            if (id !== 0) this.hub.setEmote(id, now)
          } else controlsToInput(controls ?? this.idle, st.facing, this.input)
          this.hub.step(this.input)
          const event = this.pad.update(this.hub.onQueuePad())
          if (event === 'armed' && this.current === 'hub') void this.queue()
          if (event === 'cancel' && this.current === 'queued') void this.cancelQueue()
        }
      } else if (this.current === 'match' || this.current === 'podium') {
        const match = this.netMatch!
        if (!match.done) {
          match.frame(dtS, out => {
            if (this.matchPilot) this.matchPilot.sample(match.sim, out[0])
            else controlsToInput(controls ?? this.idle, match.sim.character(this.matchClient!.seat, this.matchChar).facing, out[0])
          })
          this.transport!.endFrame()
        }
        if (this.current === 'match' && match.sim.phase(this.view).phase === Phase.podium) this.transition('podium')
        // One peer waits for dissolution so simultaneous finishes cannot race a
        // final bye against the relay clearing cadence on the remaining seat.
        const waitForDissolution = this.matchRoom!.seated && this.matchClient!.seat === this.matchRoom!.lastSeat
        if (this.current === 'podium' && match.done && !waitForDissolution) {
          this.savedLog = match.log()
          const client = this.matchClient!
          this.matchClient = null
          this.disconnect(client)
          this.matchRoom = null
          match.dispose()
          this.netMatch = null
          this.transport = null
          this.matchPilot = null
          this.transition('returning')
        }
      }
      this.broadcast(now)
    } catch (e) { this.fail(e) }
  }

  remotes(nowMs: number): RemoteView[] { return this.buffer.sample(nowMs) }

  close(): void {
    if (this.closed) return
    this.closed = true
    const clients = [this.hubClient, this.matchClient]
    const match = this.netMatch
    const hub = this.hubWorld
    this.hubClient = this.matchClient = null
    this.matchRoom = null
    this.netMatch = null
    this.hubWorld = null
    this.transport = null
    for (const release of [...clients.map(client => () => { if (client) this.disconnect(client) }), () => match?.dispose(), () => hub?.free()]) {
      try { release() } catch (e) { this.fail(e) }
    }
  }

  private async queue(): Promise<void> {
    const d = this.d
    const client = this.matchClient = new RelayClient(d.relayUrl, url => this.matchSocket(url))
    client.onClose(() => {
      if (this.active(client)) this.fail(new RefusalError('hub', d.relayUrl, 'match socket closed; reconnect and queue again'))
    })
    this.queueRequested = this.cancelling = false
    try {
      this.transition('queued')
      this.lastState = -Infinity
      await client.connect()
      if (!this.active(client) || this.cancelling) return
      this.queueRequested = true
      const m = await client.queue(d.partySize, { g: 'royal-fiesta', v: 1, name: d.name, c: d.colour })
      if (!this.active(client) || this.cancelling) return
      const setup = netSetup(m.seed, d.partySize, 'sprint', d.courses)
      this.transport = new RelayTransport(client, m.youAre, d.partySize, d.now)
      this.netMatch = createNetMatch(d.R, { setup, localPeer: m.youAre, humanPeers: d.partySize }, this.transport, { cpuMs: d.now })
      if (d.pilot) this.matchPilot = new Pilot(m.youAre, m.seed)
      this.accumulator = 0
      this.lastState = -Infinity
      this.transition('match', { seat: m.youAre, seed: m.seed })
    } catch (e) {
      // unqueue() rejects the outstanding queue promise as part of cancellation.
      if (this.active(client) && !this.cancelling) this.fail(e)
    }
  }

  private async cancelQueue(): Promise<void> {
    const client = this.matchClient
    if (!client || client.matched || this.cancelling) return
    this.cancelling = true
    try {
      if (this.queueRequested) await client.unqueue()
      if (!this.active(client)) return
      this.matchClient = null
      this.disconnect(client)
      this.matchRoom = null
      this.queueRequested = this.cancelling = false
      this.transition('hub')
    } catch (e) { if (this.active(client)) this.fail(e) }
  }

  private active(client: RelayClient): boolean {
    return !this.closed && this.current !== 'failed' && this.matchClient === client
  }

  private broadcast(now: number): void {
    const inMatch = this.current === 'match' || this.current === 'podium' || this.current === 'returning'
    const period = 1000 / (inMatch ? HUB_MATCH_RATE_HZ : HUB_RATE_HZ)
    if (now - this.lastState < period) return
    // Whole periods: frame quantisation would otherwise lower 5 Hz to 60/13 Hz.
    this.lastState = now - this.lastState < 2 * period ? this.lastState + period : now
    if (this.helloPending || now - this.lastHello >= HUB_HELLO_EVERY_MS) this.hello(now)
    const st = this.hub.state(this.char)
    if (this.sendAct(encodeState(st.pos, st.facing, st.mode, this.hub.emote(now), this.current === 'queued', inMatch, this.seq))) this.seq++
  }

  private hello(now: number): void {
    this.helloPending = true
    if (this.sendAct({ k: 'hi', v: 1, name: this.d.name, c: this.d.colour })) {
      this.lastHello = now
      this.helloPending = false
    }
  }

  private sendAct(msg: HubHello | HubState): boolean {
    const before = this.hubFrames
    this.hubClient!.act(msg)
    return this.hubFrames > before
  }

  private hubSocket(url: string): WsLike {
    const socket = this.d.ws(url)
    const send = socket.send.bind(socket)
    // This is the sole hub sender, including RelayClient's control frames.
    socket.send = data => {
      const now = this.d.now()
      const bye = (JSON.parse(data) as { t: string }).t === 'bye'
      while (this.sentAt.length > 0 && now - this.sentAt[0] > 60000) this.sentAt.shift()
      let inSecond = 0
      for (let i = this.sentAt.length - 1; i >= 0 && now - this.sentAt[i] <= 1000; i--) inSecond++
      // Reserve one frame in both windows so bye always fits on close().
      if (!bye && (this.sentAt.length >= HUB_MAX_ACTS_PER_MIN - 1 || inSecond >= 9)) return
      if (socket.readyState !== 1) return
      send(data)
      this.sentAt.push(now)
      this.hubFrames++
    }
    return socket
  }

  private matchSocket(url: string): WsLike {
    const socket = this.d.ws(url)
    const room: MatchRoom = { seated: false, lastSeat: -1 }
    this.matchRoom = room
    let remaining: boolean[] = []
    let ended = false
    const port: WsLike = {
      get readyState() { return socket.readyState },
      send: data => {
        const msg = JSON.parse(data) as { t: string }
        if (ended) {
          if (msg.t === 'queue' && this.matchRoom === room) {
            this.fail(new RefusalError('hub', 'match.queue', 'match socket has already left its room; reconnect and queue on a new socket'))
          }
          return
        }
        if (msg.t === 'bye') {
          if (!room.seated) return
          room.seated = false
          ended = true
        }
        socket.send(data)
      },
      close(code, reason) { ended = true; socket.close(code, reason) },
      onopen: null, onmessage: null, onclose: null, onerror: null,
    }
    socket.onopen = () => port.onopen?.()
    socket.onerror = e => port.onerror?.(e)
    socket.onclose = e => { ended = true; port.onclose?.(e) }
    socket.onmessage = e => {
      const msg = typeof e.data === 'string' ? parseRelayServerMsg(e.data) : null
      if (!ended && msg?.t === 'matched') {
        room.seated = true
        remaining = Array<boolean>(this.d.partySize).fill(true)
        room.lastSeat = this.d.partySize - 1
      }
      if (msg?.t === 'player_left') {
        remaining[msg.seat] = false
        room.lastSeat = remaining.lastIndexOf(true)
      }
      // The relay clears cadence on dissolution but retains its send history.
      // player_left alone leaves the room alive; opp_left ends it for every size.
      if (msg?.t === 'opp_left') { room.seated = false; ended = true }
      port.onmessage?.(e)
    }
    return port
  }

  private disconnect(client: RelayClient): void {
    try { client.bye() } finally { client.close() }
  }

  private transition(state: FlowState, detail: FlowEvent['detail'] = {}): void {
    this.current = state
    this.d.log({ ms: this.d.now(), client: this.d.name, state, detail })
  }

  private fail(e: unknown): void {
    if (this.closed || this.current === 'failed') return
    this.transition('failed', { message: e instanceof Error ? e.message : String(e) })
    this.close()
  }
}
