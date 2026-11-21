import type { EngineInstance } from '@etcito/game-engine/loader'
import type { SchemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import type { EngineDomainSim } from '@etcito/game-engine/zones'
import { SnapReader } from '@gamesaloon/rollback'
import type { ShadowView } from '@gamesaloon/rollback/zones'
import type { GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { ZoneMatchConfig } from '../net/zoneMatch.ts'
import { RoundTransport } from '../net/roundTransport.ts'
import { engineCodeOfS1 } from './inputCodes.ts'
import { EngineVoteBarrier, onlineSeatMap, registerEngineOnlineStats } from './onlineState.ts'
import type { EngineOnlineSeatMap, EngineOnlineStats } from './onlineState.ts'
import { createEngineShowFactory } from './showFactory.ts'
import type { EngineShowFactory } from './showFactory.ts'
import { entityBytes, patchClock, patchLifecycle } from './showRuntime.ts'
import { readShowSelection, showSchemaLayout } from './showState.ts'
import type {
  EngineShowConfig,
  EngineShowObservation,
  EngineShowPresentation,
  EngineShowRuntime,
  EngineShowSnapshot,
  EngineWorldRef,
} from './showTypes.ts'

const TICK_RATE = 60
const MAX_TICKS_PER_FRAME = 8
const AREA = 'ege-online'
const NO_SHADOW: ShadowView = { count: 0, fromDomain: () => 0, reader: () => new SnapReader(new Uint8Array(0)) }

type ObservationKind = EngineShowObservation['kind']

function fail(path: string, problem: string): never {
  return refuse(AREA, path, problem)
}

function isU32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

interface OnlineNetwork {
  readonly localPeer: number
  readonly roster: Roster
  readonly transport: GroupTransport
  readonly measurements: ZoneMatchConfig['measurements']
}

function validateNetwork(config: EngineShowConfig, network: OnlineNetwork): EngineOnlineSeatMap {
  if (!config || typeof config !== 'object') fail('config', 'missing show configuration; pass an EngineShowConfig')
  if (!network || typeof network !== 'object') {
    fail('network', 'missing online network; pass localPeer, roster, transport and measurements')
  }
  const seatMap = onlineSeatMap(config.humans, network.roster, network.localPeer)
  for (const entry of network.roster.peers) {
    if (network.measurements?.[entry.peer] === undefined) {
      fail(`network.measurements/${entry.peer}`, `peer ${entry.peer} has no measurement; pass one for every roster peer`)
    }
  }
  return seatMap
}

/**
 * Handoff: Engine online share 4/5: per-round zone sessions and one confirmed online round takes over
 * createEngineOnlineShow(config: EngineShowConfig, network: OnlineNetwork): Promise<EngineShowRuntime> in this file.
 * Today it validates the network, awaits the prepared EngineShowFactory, owns one global show_rules world and
 * holds that world at the vote deadline until EngineVoteBarrier.complete(round); it then imports every peer's
 * choice as show_vote rows at that same tick, steps the rules world on confirmed empty shadows and reports
 * snapshot, presentation, observations and idempotent disposal with no physics world. It passes the session share
 * the prepared factory, the global rules world, the shared RoundTransport, the EngineOnlineSeatMap and the
 * cumulative stats read through packages/game/src/ege/onlineState.ts:38 registerEngineOnlineStats.
 */
export async function createEngineOnlineShow(
  config: EngineShowConfig,
  network: OnlineNetwork,
): Promise<EngineShowRuntime> {
  const seatMap = validateNetwork(config, network)
  const factory = await createEngineShowFactory(config)
  let global: EngineDomainSim | undefined
  try {
    const layout = showSchemaLayout(config.engine)
    global = factory.create({ id: 0, kind: 'global', cells: [], seats: [], replicas: [0] }, 0)
    const runtime = new OnlineShowRuntime(config, factory, layout, global, seatMap, network)
    registerEngineOnlineStats(runtime, () => runtime.stats())
    return runtime
  } catch (error) {
    if (global) factory.release(global)
    factory.dispose()
    throw error
  }
}

class OnlineShowRuntime implements EngineShowRuntime {
  readonly identity: EngineShowRuntime['identity']
  readonly mode = 'online' as const
  private readonly config: EngineShowConfig
  private readonly engine: EngineInstance
  private readonly factory: EngineShowFactory
  private readonly layout: SchemaLayout
  private readonly global: EngineDomainSim
  private readonly seatMap: EngineOnlineSeatMap
  private readonly roster: Roster
  private readonly localPeer: number
  private readonly transport: GroupTransport
  private readonly rt: RoundTransport
  private readonly barrier: EngineVoteBarrier
  private readonly recipients: readonly number[]
  private readonly rosterPeers: ReadonlySet<number>
  private readonly scratch: Parameters<RoundTransport['drain']>[0] = []
  private readonly imported = new Set<number>()
  private readonly listeners: ((observation: EngineShowObservation) => void)[] = []
  private accumulator = 0
  private voteRound = -1
  private choice = -1
  private finalSent = false
  private preparedRound = -1
  private acknowledgedRound = -1
  private confirmedResult = -2
  private cursorEntity: number | undefined
  private sessionDesyncs = 0
  private disposed = false

  constructor(
    config: EngineShowConfig,
    factory: EngineShowFactory,
    layout: SchemaLayout,
    global: EngineDomainSim,
    seatMap: EngineOnlineSeatMap,
    network: OnlineNetwork,
  ) {
    this.config = config
    this.engine = config.engine
    this.factory = factory
    this.layout = layout
    this.global = global
    this.seatMap = seatMap
    this.identity = config.identity
    this.roster = network.roster
    this.localPeer = network.localPeer
    this.transport = network.transport
    this.rt = new RoundTransport(network.transport)
    this.barrier = new EngineVoteBarrier(this.roster.peers.map(entry => entry.peer))
    this.recipients = this.roster.peers.filter(entry => entry.peer !== this.localPeer).map(entry => entry.peer)
    this.rosterPeers = new Set(this.roster.peers.map(entry => entry.peer))
    this.rt.onVote((peer, round, choice) => this.receiveVote(peer, round, choice))
  }

  snapshot(): EngineShowSnapshot {
    this.assertLive()
    return this.factory.rulesState(this.global)
  }

  worlds(): readonly EngineWorldRef[] {
    this.assertLive()
    return [this.factory.worldRef(this.global)]
  }

  presentation(): EngineShowPresentation {
    this.assertLive()
    return {
      showId: this.factory.showId,
      tick: this.engine.tick(this.global.world),
      round: this.snapshot().round,
      map: null,
      course: null,
      worlds: [],
    }
  }

  onPresentation(listener: (observation: EngineShowObservation) => void): () => void {
    this.assertLive()
    if (typeof listener !== 'function') fail('onPresentation', 'missing listener; pass (observation) => void')
    this.listeners.push(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      const at = this.listeners.indexOf(listener)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  frame(dtS: number, sample: (roomSeat: number) => number): void {
    this.assertLive()
    if (typeof sample !== 'function') fail('frame.sample', 'missing input sampler; pass (roomSeat) => S1 code')
    if (typeof dtS !== 'number' || !Number.isFinite(dtS) || dtS < 0) {
      fail('frame.dtS', `received ${String(dtS)}; pass finite elapsed seconds of zero or more`)
    }
    if (this.snapshot().screen === 'done') return
    this.pump()
    // A held vote deadline pauses the show: elapsed time while waiting only keeps its sub-tick remainder.
    if (!this.canAdvance()) {
      this.accumulator -= Math.floor(this.accumulator + 1e-9)
      return
    }
    const accumulated = this.accumulator + dtS * TICK_RATE
    if (!Number.isFinite(accumulated)) fail('frame.dtS', 'accumulated time is not finite; pass a smaller elapsed time')
    this.accumulator = accumulated
    const whole = Math.floor(this.accumulator + 1e-9)
    if (whole < 1) return
    const count = Math.min(MAX_TICKS_PER_FRAME, whole)
    for (let i = 0; i < count; i++) {
      if (!this.canAdvance()) break
      this.accumulator -= 1
      this.step(sample)
    }
  }

  vote(roomSeat: number, candidate: number): void {
    this.assertLive()
    const state = this.snapshot()
    if (state.screen !== 'vote') fail('vote', `screen is '${state.screen}'; votes are accepted only while voting`)
    if (!Number.isInteger(roomSeat) || roomSeat < 0 || roomSeat >= this.seatMap.inputSlotOf.length) {
      fail('vote.roomSeat', `invalid room seat ${roomSeat}; use a configured stable seat`)
    }
    if (this.seatMap.inputSlotOf[roomSeat]! < 0) fail('vote.roomSeat', `room seat ${roomSeat} is a bot; only humans vote`)
    if (!this.seatMap.localHumanSeats.includes(roomSeat)) {
      fail('vote.roomSeat', `room seat ${roomSeat} is not a local human seat; only the local peer votes`)
    }
    if (!state.seatOf.includes(roomSeat)) fail('vote.roomSeat', `room seat ${roomSeat} is not on the active roster`)
    if (!Number.isInteger(candidate) || candidate < 0 || candidate >= state.candidates.length) {
      fail('vote.candidate', `invalid candidate ${candidate}; use index 0..${state.candidates.length - 1}`)
    }
    this.syncVoteRound(state.round)
    this.choice = candidate
    this.barrier.offer(state.round, this.localPeer, candidate)
    this.rt.setRound(state.round)
    this.rt.sendVote(this.recipients, candidate)
  }

  stats(): EngineOnlineStats {
    const state = this.disposed ? undefined : this.snapshot()
    const owned = state?.seatOf.some(seat => this.seatMap.peerOfSeat[seat] === this.localPeer) ?? false
    let livePeers = 0
    for (const entry of this.roster.peers) {
      if (entry.peer === this.localPeer || !this.transport.closed(entry.peer)) livePeers++
    }
    return {
      desyncs: this.sessionDesyncs,
      confirmedTick: this.disposed ? -1 : this.engine.tick(this.global.world),
      peers: this.roster.peers.length,
      livePeers,
      spectator: !owned,
    }
  }

  dispose(): void {
    if (this.disposed) return
    try {
      this.factory.release(this.global)
    } finally {
      this.disposed = true
      this.factory.dispose()
    }
  }

  private pump(): void {
    const state = this.snapshot()
    this.rt.setRound(state.round)
    if (state.screen === 'vote') this.syncVoteRound(state.round)
    this.scratch.length = 0
    this.rt.drain(this.scratch)
    for (const entry of this.roster.peers) {
      if (entry.peer !== this.localPeer && this.transport.closed(entry.peer)) this.barrier.drop(entry.peer)
    }
  }

  private syncVoteRound(round: number): void {
    if (this.voteRound === round) return
    this.voteRound = round
    this.choice = -1
    this.finalSent = false
  }

  private receiveVote(peer: number, round: number, raw: number): void {
    if (this.disposed || !this.rosterPeers.has(peer)) return
    if (this.voteRound < 0 || round !== (this.voteRound & 0xff)) return
    this.barrier.offer(this.voteRound, peer, raw === 255 ? -1 : raw)
  }

  /** False while the vote deadline is reached but the barrier is still waiting for a peer's choice. */
  private canAdvance(): boolean {
    const state = this.snapshot()
    if (state.screen !== 'vote' || state.candidates.length <= 1) return true
    if (this.engine.tick(this.global.world) < this.voteDeadline()) return true
    if (!this.finalSent) {
      this.finalSent = true
      this.barrier.offer(state.round, this.localPeer, this.choice)
      this.rt.setRound(state.round)
      this.rt.sendVote(this.recipients, this.choice)
      this.pump()
    }
    if (!this.barrier.complete(state.round)) return false
    if (!this.imported.has(state.round)) {
      this.importVotes(state.round)
      this.imported.add(state.round)
    }
    return true
  }

  private importVotes(round: number): void {
    const decl = this.component('show_vote')
    const owner = this.cursor()
    for (const entry of this.barrier.choices(round)) {
      const bytes = entityBytes(decl, { owner, round_index: round, seat: entry.peer, choice: entry.choice })
      const [entity] = this.engine.importEntities(this.global.world, bytes)
      if (entity === undefined) fail('vote', 'the vote row was not created')
    }
  }

  private step(sample: (roomSeat: number) => number): void {
    const before = this.snapshot()
    if (before.screen === 'done') return
    this.sample(before, sample)
    const now = this.engine.tick(this.global.world)
    if (before.screen === 'loading' && this.preparedRound !== before.round) {
      const selection = readShowSelection(this.config, this.global.world, now, before.round)
      this.preparedRound = before.round
      patchClock(this.engine, this.global.world, this.layout, selection.level.timeCapTicks, selection.level.overtimeTicks)
      this.applyLifecycle(before.round, now)
    }
    if (before.screen === 'results' && this.confirmedResult !== before.round) {
      this.applyLifecycle(this.acknowledgedRound, now)
      this.confirmedResult = before.round
    }
    this.global.step([], NO_SHADOW)
    this.notify('post-tick', this.snapshot())
  }

  private sample(state: EngineShowSnapshot, sample: (roomSeat: number) => number): void {
    const locals = new Set(this.seatMap.localHumanSeats)
    for (const roomSeat of state.seatOf) {
      if (!locals.has(roomSeat)) continue
      const raw = sample(roomSeat)
      if (!isU32(raw)) {
        fail(`frame.sample(${roomSeat})`, `received ${String(raw)}; return an integer S1 code in 0..4294967295`)
      }
      engineCodeOfS1(raw)
    }
  }

  private notify(kind: ObservationKind, snapshot: EngineShowSnapshot): void {
    if (this.listeners.length === 0) return
    const observation: EngineShowObservation = {
      kind, tick: this.engine.tick(this.global.world), snapshot, presentation: this.presentation(),
    }
    let failure: unknown
    for (const listener of [...this.listeners]) {
      try {
        listener(observation)
      } catch (error) {
        if (failure === undefined) failure = error
      }
    }
    if (failure !== undefined) throw failure
  }

  private applyLifecycle(readyRound: number, confirmedTick: number): void {
    this.acknowledgedRound = readyRound
    patchLifecycle(this.engine, this.global.world, this.layout, readyRound, confirmedTick)
  }

  /** The first rules tick at which the current vote screen may close, read from the rules world. */
  private voteDeadline(): number {
    const state = readWorldState(this.engine, this.global.world, this.layout)
    const rows = state.components.show_presentation
    const entries = rows ? Object.values(rows) : []
    if (entries.length !== 1) {
      fail('show_presentation', `found ${entries.length} rows; repair the authoritative rules world`)
    }
    const entered = entries[0]!.entered_tick
    const voteTicks = entries[0]!.vote_ticks
    if (typeof entered !== 'number' || typeof voteTicks !== 'number') {
      fail('show_presentation', 'the stored vote window is malformed; repair the authoritative rules world')
    }
    return entered + voteTicks
  }

  private cursor(): number {
    if (this.cursorEntity !== undefined) return this.cursorEntity
    const state = readWorldState(this.engine, this.global.world, this.layout)
    const rows = state.components.show_season_cursor
    const ids = rows ? Object.keys(rows) : []
    if (ids.length !== 1) fail('show_season_cursor', `found ${ids.length} rows; repair the authoritative rules world`)
    this.cursorEntity = Number(ids[0])
    return this.cursorEntity
  }

  private component(name: string) {
    const decl = this.layout.components.find(entry => entry.name === name && entry.lane === 'simulation')
    if (!decl) fail(`schema.components.${name}`, 'missing required component; regenerate the engine schema')
    return decl
  }

  private assertLive(): void {
    if (this.disposed) fail('runtime', 'the show runtime is disposed')
  }
}
