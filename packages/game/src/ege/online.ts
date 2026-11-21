import type { EngineInstance } from '@etcito/game-engine/loader'
import type { SchemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import type { EngineDomainSim } from '@etcito/game-engine/zones'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ShadowView } from '@gamesaloon/rollback/zones'
import { CONTROL_NO_CELL, packControl, ZoneSession } from '@gamesaloon/rollback/zones'
import type { DomainFactory, DomainSim, DomainSpec, GroupTransport, Roster } from '@gamesaloon/rollback/zones'
import { refuse } from '@royal-fiesta/sim/refusal'
import { cellOf } from '@royal-fiesta/sim/zones/cells'
import { seatSpawn } from '@royal-fiesta/sim/zones/seatSpawn'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZoneMatchConfig } from '../net/zoneMatch.ts'
import { RoundTransport } from '../net/roundTransport.ts'
import { FIESTA_TUNING } from '../net/tuning.ts'
import { roundRoster } from '../net/zoneRounds.ts'
import { mergeZoneTuning, peerClasses } from '../net/zoneTuning.ts'
import { engineCodeOfS1 } from './inputCodes.ts'
import { EngineVoteBarrier, onlineSeatMap, registerEngineOnlineStats } from './onlineState.ts'
import type { EngineOnlineSeatMap, EngineOnlineStats } from './onlineState.ts'
import { createEngineShowFactory } from './showFactory.ts'
import type { EngineShowFactory } from './showFactory.ts'
import { entityBytes, patchClock, patchLifecycle } from './showRuntime.ts'
import { readShowSelection, showSchemaLayout } from './showState.ts'
import type { EngineShowSelection } from './showState.ts'
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

/** One round's shared zone session, its rules tick base and the payloads captured from its live worlds. */
interface RoundPhysics {
  readonly round: number
  readonly base: number
  readonly session: ZoneSession<number>
  readonly selection: EngineShowSelection
  readonly seatOf: readonly number[]
  /** Round seats of the local peer, in the order the session samples its local inputs. */
  readonly localSeats: readonly number[]
  readonly domain: number
  readonly capture: CaptureState
}

/** The outbox payload of each executed physics tick, keyed by rules tick and replaced by a resimulation. */
interface CaptureState {
  readonly sims: Set<EngineDomainSim>
  readonly payloads: Map<number, Uint8Array>
  domain: number
  sim: EngineDomainSim | undefined
}

/** Rewrites every outbox record tick by the round's rules tick base; the one place the session tick offset is mapped. */
function rulesTicks(bytes: Uint8Array, base: number): Uint8Array {
  const out = bytes.slice()
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const count = out.byteLength < 2 ? 0 : view.getUint16(0, true)
  for (let i = 0; i < count; i++) {
    const at = 2 + i * 16 + 12
    if (at + 4 > out.byteLength) break
    view.setUint32(at, (view.getUint32(at, true) + base) >>> 0, true)
  }
  return out
}

/** Epoch-0 control words of the round seats: each peer's class and spare slots at its seat's spawn cell. */
function roundControls(
  roster: Roster,
  course: EngineShowSelection['courseData'],
  zones: ZonesFile,
  measurements: ZoneMatchConfig['measurements'],
  tuning: ReturnType<typeof mergeZoneTuning>,
): Uint32Array {
  const controls = new Uint32Array(roster.seatCount)
  for (const peer of roster.peers) {
    const m = measurements[peer.peer]
    if (!m) fail(`network.measurements/${peer.peer}`, 'missing the round peer measurement')
    const word = { ...peerClasses(m.cpuMs, m.bandwidthKbps, m.latencyMs, tuning), spareSlots: m.spareSlots, cell: CONTROL_NO_CELL }
    for (const seat of peer.seats) {
      const spawn = seatSpawn(course, seat)
      word.cell = cellOf(zones.grid, spawn.t.x, spawn.t.z)
      controls[seat] = packControl(word)
    }
  }
  return controls
}

/** The session's assignment always carries a global rules domain; the runtime owns the real rules world, so it is silent here. */
function silentDomain(tick: number): DomainSim<number> {
  let at = tick
  return {
    get tick() { return at },
    set tick(value: number) { at = value },
    step() { at++ },
    snapshot() {},
    restore() {},
    hash() { return 0 },
    exportEntities() {},
    shadowOut() {},
    events() {},
    far() {},
    seatHost() {},
    sleepEvents(out) { out.length = 0 },
    sleepPose() { return false },
  }
}

/** Wraps the prepared factory: records each executed tick's outbox payload and the live world it belongs to. */
function captureFactory(inner: EngineShowFactory, base: number, capture: CaptureState): DomainFactory<number> {
  const open = (sim: EngineDomainSim): DomainSim<number> => {
    capture.sims.add(sim)
    capture.domain = sim.spec.id
    capture.sim = sim
    const bound = new Map<PropertyKey, unknown>()
    return new Proxy(sim, {
      get(target, prop) {
        if (prop === 'step') {
          let step = bound.get(prop) as ((inputs: readonly number[], shadows: ShadowView) => void) | undefined
          if (step === undefined) {
            step = (inputs, shadows) => {
              const writer = new SnapWriter()
              target.events(writer)
              capture.payloads.set(base + target.tick, rulesTicks(writer.bytes(), base))
              target.step(inputs, shadows)
            }
            bound.set(prop, step)
          }
          return step
        }
        if (prop === 'view') return Reflect.get(target, prop)
        const value = Reflect.get(target, prop)
        if (typeof value !== 'function') return value
        let fn = bound.get(prop)
        if (fn === undefined) {
          fn = (value as (...args: unknown[]) => unknown).bind(target)
          bound.set(prop, fn)
        }
        return fn
      },
      set(target, prop, value) { return Reflect.set(target, prop, value) },
    }) as unknown as DomainSim<number>
  }
  const openUnlessGlobal = (spec: DomainSpec, rename: () => EngineDomainSim): DomainSim<number> =>
    spec.kind === 'global' ? silentDomain(0) : open(rename())
  return {
    create: (spec, tick) => openUnlessGlobal(spec, () => inner.create(spec, tick)),
    rebuild: (spec, tick, sources) => openUnlessGlobal(spec, () => inner.rebuild(spec, tick, sources)),
    reset: (spec, tick) => openUnlessGlobal(spec, () => inner.reset(spec, tick)),
  }
}

/** The confirmed outbox payload of one physics tick, delivered to the rules world as its only shadow. */
function shadowOf(domain: number, payload: Uint8Array): ShadowView {
  return { count: 1, fromDomain: () => domain, reader: index => new SnapReader(index === 0 ? payload : new Uint8Array(0)) }
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
  private readonly measurements: ZoneMatchConfig['measurements']
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
  private physics: RoundPhysics | undefined
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
    this.measurements = network.measurements
    this.rt = new RoundTransport(network.transport)
    this.barrier = new EngineVoteBarrier(this.roster.peers.map(entry => entry.peer))
    this.recipients = this.roster.peers.filter(entry => entry.peer !== this.localPeer).map(entry => entry.peer)
    this.rosterPeers = new Set(this.roster.peers.map(entry => entry.peer))
    this.rt.onVote((peer, round, choice) => this.receiveVote(peer, round, choice))
    // The fresh rules world opens its first vote before any tick ran: settle that vote so a caller never sees it empty.
    this.advance()
  }

  snapshot(): EngineShowSnapshot {
    this.assertLive()
    return this.factory.rulesState(this.global)
  }

  worlds(): readonly EngineWorldRef[] {
    this.assertLive()
    const refs = [this.factory.worldRef(this.global)]
    const sim = this.physics?.capture.sim
    if (sim !== undefined) refs.push(this.factory.worldRef(sim))
    return refs
  }

  presentation(): EngineShowPresentation {
    this.assertLive()
    const physics = this.physics
    const sim = physics?.capture.sim
    const world = sim === undefined ? null : this.factory.presentationWorld(sim)
    return {
      showId: this.factory.showId,
      tick: this.engine.tick(this.global.world),
      round: physics?.round ?? this.snapshot().round,
      map: physics?.selection.mapId ?? null,
      course: physics?.selection.courseData ?? null,
      worlds: world === null ? [] : [world],
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
      this.releasePhysics()
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
    // A live session drains the shared transport itself, where the vote listeners still run.
    if (this.physics === undefined) {
      this.scratch.length = 0
      this.rt.drain(this.scratch)
    }
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
    const now = this.engine.tick(this.global.world)
    if (before.screen === 'loading' && this.preparedRound !== before.round) this.startRound(before, now)
    if (before.screen === 'results' && this.confirmedResult !== before.round) {
      this.applyLifecycle(this.acknowledgedRound, now)
      this.confirmedResult = before.round
    }
    const physics = this.physics
    if (physics !== undefined) physics.session.frame(1 / TICK_RATE, inputs => this.sampleRound(physics, inputs, sample))
    this.advance()
  }

  /** Opens the round's one-whole-round zone session over the shared transport and the prepared factory. */
  private startRound(state: EngineShowSnapshot, tick: number): void {
    this.releasePhysics()
    this.preparedRound = state.round
    const selection = readShowSelection(this.config, this.global.world, tick, state.round)
    this.factory.prepareRound(state.round, selection.mapIndex, state.seatOf)
    patchClock(this.engine, this.global.world, this.layout, selection.level.timeCapTicks, selection.level.overtimeTicks)
    this.applyLifecycle(state.round, tick)
    this.rt.setRound(state.round)
    this.physics = this.openRound(state.round, state.seatOf, selection, tick)
  }

  private openRound(round: number, seatOf: readonly number[], selection: EngineShowSelection, base: number): RoundPhysics {
    const zones = this.config.zones.get(selection.courseData.id)
    if (!zones) fail(`zones/${selection.courseData.id}`, 'missing the selected course sidecar; load zones for every show course')
    const planned = roundRoster(this.roster, seatOf)
    const peers = this.roster.peers.map(entry => {
      const live = planned.roster.peers.find(peer => peer.peer === entry.peer)
      return { peer: entry.peer, seats: live === undefined ? [] : [...live.seats] }
    })
    const roster: Roster = {
      seatCount: planned.roster.seatCount,
      peers,
      live: this.roster.peers.map(entry => planned.roster.live[entry.peer] === true),
    }
    const tuning = mergeZoneTuning({ ...zones, tuning: { ...zones.tuning,
      replicas: peers.length, untouchedReplicas: peers.length, rEnter: 0xffff, rExit: 0xffff,
      capacityByCpuClass: zones.tuning.capacityByCpuClass.map(() => roster.seatCount) } })
    const capture: CaptureState = { sims: new Set(), payloads: new Map(), domain: -1, sim: undefined }
    const session = new ZoneSession<number>({
      ...FIESTA_TUNING, localPeer: this.localPeer, roster, tuning,
      factory: captureFactory(this.factory, base, capture), codec: this.factory.codec,
      controls: roundControls(roster, selection.courseData, zones, this.measurements, tuning),
    }, this.rt)
    const local = peers.find(entry => entry.peer === this.localPeer)
    return { round, base, session, selection, seatOf: [...seatOf],
      localSeats: local === undefined ? [] : [...local.seats], domain: capture.domain, capture }
  }

  /** Samples the local peer's human round seats; a bot seat stays at the engine neutral input. */
  private sampleRound(physics: RoundPhysics, inputs: number[], sample: (roomSeat: number) => number): void {
    for (let i = 0; i < inputs.length; i++) {
      const roomSeat = physics.seatOf[physics.localSeats[i]!]
      if (roomSeat === undefined) fail('frame.seatOf', 'the local round seat is outside the round roster')
      if (this.seatMap.inputSlotOf[roomSeat]! < 0) {
        inputs[i] = 0
        continue
      }
      const raw = sample(roomSeat)
      if (!isU32(raw)) fail(`frame.sample(${roomSeat})`, `received ${String(raw)}; return an integer S1 code in 0..4294967295`)
      inputs[i] = engineCodeOfS1(raw)
    }
  }

  /**
   * Steps the rules world only on a confirmed payload and releases the round's worlds when play closes. A vote
   * screen opens one rules tick before the season script writes its candidate rows, so the tick that opens it is
   * followed here by the one that fills them: no caller can read or vote on an empty candidate list.
   */
  private advance(): void {
    this.advanceTick()
    if (this.physics !== undefined || !this.awaitsCandidates()) return
    this.advanceTick()
    if (this.awaitsCandidates()) {
      fail('vote.candidates', 'the vote screen has no candidate rows after the season script ran; '
        + 'repair the season script or the map catalog')
    }
  }

  private awaitsCandidates(): boolean {
    const state = this.snapshot()
    return state.screen === 'vote' && state.candidates.length === 0
  }

  private advanceTick(): void {
    const physics = this.physics
    if (physics !== undefined) {
      const at = this.engine.tick(this.global.world)
      const confirmed = physics.session.stats.confirmedTick[physics.domain] ?? -1
      const payload = physics.capture.payloads.get(at)
      if (at - physics.base < 0 || confirmed < at - physics.base || payload === undefined) return
      this.global.step([], shadowOf(physics.domain, payload))
      physics.capture.payloads.delete(at)
    } else {
      this.global.step([], NO_SHADOW)
    }
    const after = this.snapshot()
    const released = physics !== undefined &&
      (after.screen === 'results' || after.screen === 'podium' || after.screen === 'done')
    try {
      this.notify('post-tick', after)
    } finally {
      if (released) this.releasePhysics()
    }
  }

  /** Notifies before-release while the physics world is readable, then releases the session's worlds once. */
  private releasePhysics(): void {
    const physics = this.physics
    if (physics === undefined) return
    try {
      this.notify('before-release', this.snapshot())
    } finally {
      this.physics = undefined
      this.sessionDesyncs += physics.session.stats.desyncs
      physics.session.dispose()
      for (const sim of physics.capture.sims) this.factory.release(sim)
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
