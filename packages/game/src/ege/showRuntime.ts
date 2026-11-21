import type { EngineInstance } from '@etcito/game-engine/loader'
import type { LayoutDecl, SchemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import type { EngineDomainSim } from '@etcito/game-engine/zones'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ShadowView } from '@gamesaloon/rollback/zones'
import { refuse } from '@royal-fiesta/sim/refusal'
import { engineCodeOfS1 } from './inputCodes.ts'
import { createEngineShowFactory } from './showFactory.ts'
import type { EngineShowFactory } from './showFactory.ts'
import { readShowSelection, sameBytes, showSchemaLayout } from './showState.ts'
import type { EngineShowSelection } from './showState.ts'
import type {
  EnginePresentationWorld,
  EngineShowConfig,
  EngineShowObservation,
  EngineShowPresentation,
  EngineShowRuntime,
  EngineShowSnapshot,
  EngineWorldRef,
} from './showTypes.ts'

const TICK_RATE = 60
const MAX_TICKS_PER_FRAME = 8
const S1_NEUTRAL = 32639
const NO_SHADOW: ShadowView = { count: 0, fromDomain: () => 0, reader: () => new SnapReader(new Uint8Array(0)) }

type Screen = EngineShowSnapshot['screen']
const PLAY_SCREENS: readonly Screen[] = ['intro', 'playing', 'overtime']

function fail(path: string, problem: string): never {
  return refuse('ege-show-runtime', path, problem)
}

function isU32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

interface PhysicsRound {
  readonly sim: EngineDomainSim
  readonly round: number
  readonly seats: readonly number[]
  readonly selection: EngineShowSelection
}

type ObservationKind = EngineShowObservation['kind']

const ZONE_ID = 'ege.zone.id'

/**
 * The EGW1 snapshot bytes a world's template-to-live entity mapping is derived from: the alive entity ids and the
 * whole `ege.zone.id` component block. Equal bytes give an equal mapping. A layout without that simulation
 * component yields undefined and the mapping is then never reused.
 */
function mappingBytes(bytes: Uint8Array, layout: SchemaLayout): { entities: Uint8Array; zones: Uint8Array } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entityCount = view.getUint32(24, true)
  let at = 48 + entityCount * 4
  // The id count is part of the length; the header words between it and the ids hold per-tick values.
  const entities = bytes.subarray(48, at)
  for (const decl of layout.components.filter(entry => entry.lane === 'simulation').sort((a, b) => a.id - b.id)) {
    const count = view.getUint32(at, true)
    const recordSize = view.getUint32(at + 4, true)
    const end = at + 8 + count * 4 + count * recordSize
    if (decl.name === ZONE_ID) return { entities, zones: bytes.subarray(at, end) }
    at = end
  }
  return undefined
}

/** The live mapping of one physics incarnation with copies of the snapshot bytes it was resolved from. */
interface WorldMemo {
  readonly sim: EngineDomainSim
  readonly world: EnginePresentationWorld
  readonly entities: Uint8Array
  readonly zones: Uint8Array
}

/** A copied `show_lifecycle_input` patch: the host facts are applied before the next rules step. */
export function patchLifecycle(
  engine: EngineInstance,
  world: number,
  layout: SchemaLayout,
  readyRound: number,
  confirmedTick: number,
): void {
  patchRecord(engine, world, layout, 'show_lifecycle_input', undefined, decl => (view, at) => {
    writeField(view, at, decl, 'ready_round', readyRound)
    writeField(view, at, decl, 'confirmed_tick', confirmedTick)
  })
}

/** Patches the choice of an already imported show_vote row. */
export function patchVote(engine: EngineInstance, world: number, layout: SchemaLayout, entity: number, choice: number): void {
  patchRecord(engine, world, layout, 'show_vote', entity, decl => (view, at) => {
    writeField(view, at, decl, 'choice', choice)
  })
}

/** Writes the selected course's authored gameplay durations before the round is acknowledged ready. */
export function patchClock(engine: EngineInstance, world: number, layout: SchemaLayout, roundTicks: number, overtimeTicks: number): void {
  patchRecord(engine, world, layout, 'show_clock', undefined, decl => (view, at) => {
    writeField(view, at, decl, 'round_ticks', roundTicks)
    writeField(view, at, decl, 'overtime_ticks', overtimeTicks)
  })
}

/** Rewrites one simulation component row in the EGW1 snapshot and restores it; a copied, atomic write. */
function patchRecord(
  engine: EngineInstance,
  world: number,
  layout: SchemaLayout,
  name: string,
  entity: number | undefined,
  writer: (decl: LayoutDecl) => (view: DataView, at: number) => void,
): void {
  const bytes = engine.snapshot(world).slice()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entityCount = view.getUint32(24, true)
  let at = 48 + entityCount * 4
  const decls = layout.components.filter(decl => decl.lane === 'simulation').sort((a, b) => a.id - b.id)
  let found = false
  for (const decl of decls) {
    const count = view.getUint32(at, true)
    const recordSize = view.getUint32(at + 4, true)
    const first = at + 8 + count * 4
    if (decl.name === name) {
      const write = writer(decl)
      for (let i = 0; i < count; i++) {
        const id = view.getUint32(at + 8 + i * 4, true)
        if (entity === undefined || id === entity) {
          write(view, first + i * recordSize)
          found = true
          if (entity !== undefined) break
        }
      }
    }
    at = first + count * recordSize
  }
  if (!found) fail(`${name}/${entity ?? ''}`, 'stored rows are missing; repair the authoritative rules world')
  engine.restore(world, bytes)
}

function writeField(view: DataView, at: number, decl: LayoutDecl, name: string, value: number): void {
  const field = decl.fields.find(entry => entry.name === name)
  if (!field) fail(`${decl.name}.${name}`, 'the loaded schema has no such field; regenerate the engine schema')
  switch (field.type) {
    case 'i32': view.setInt32(at + field.offset, value, true); break
    case 'entity':
    case 'u32': view.setUint32(at + field.offset, value >>> 0, true); break
    default: fail(`${decl.name}.${name}`, `unsupported host-written field type ${field.type}`)
  }
}

/** The EGT1 bytes ('EGT1', version 1) of one imported component row: source id, one record, no body. */
export function entityBytes(decl: LayoutDecl, values: Readonly<Record<string, number>>): Uint8Array {
  const record = new Uint8Array(decl.size)
  const view = new DataView(record.buffer)
  for (const [name, value] of Object.entries(values)) writeField(view, 0, decl, name, value)
  const padded = Math.ceil(decl.size / 4) * 4
  const bytes = new Uint8Array(4 * 3 + 4 * 4 + padded + 4)
  const out = new DataView(bytes.buffer)
  out.setUint32(0, 0x31544745, true)
  out.setUint32(4, 1, true)
  out.setUint32(8, 1, true)
  out.setUint32(12, 0, true)
  out.setUint32(16, 1, true)
  out.setUint32(20, decl.id, true)
  out.setUint32(24, decl.size, true)
  bytes.set(record, 28)
  out.setUint32(28 + padded, 0, true)
  return bytes
}

class ShowRuntime implements EngineShowRuntime {
  readonly identity: EngineShowRuntime['identity']
  readonly mode = 'local' as const
  private readonly config: EngineShowConfig
  private readonly engine: EngineInstance
  private readonly factory: EngineShowFactory
  private readonly layout: SchemaLayout
  private readonly global: EngineDomainSim
  private readonly slots: readonly number[]
  private readonly players: number
  private physics: PhysicsRound | undefined
  private accumulator = 0
  private acknowledgedRound = -1
  private confirmedResult = -2
  private cursorEntity: number | undefined
  private worldMemo: WorldMemo | undefined
  private readonly votes = new Map<string, number>()
  private readonly listeners: ((observation: EngineShowObservation) => void)[] = []
  private disposed = false

  constructor(config: EngineShowConfig, factory: EngineShowFactory, layout: SchemaLayout, global: EngineDomainSim) {
    this.config = config
    this.engine = config.engine
    this.factory = factory
    this.layout = layout
    this.global = global
    this.identity = config.identity
    this.slots = slotOf(config.humans)
    const kind = layout.world_kinds.find(entry => entry.name === 'show_seat')
    if (!kind) fail('schema.world_kinds', "the schema has no 'show_seat' kind; regenerate the engine schema")
    this.players = kind.players
  }

  snapshot(): EngineShowSnapshot {
    this.assertLive()
    return this.factory.rulesState(this.global)
  }

  worlds(): readonly EngineWorldRef[] {
    this.assertLive()
    const refs = [this.factory.worldRef(this.global)]
    if (this.physics) refs.push(this.factory.worldRef(this.physics.sim))
    return refs
  }

  presentation(): EngineShowPresentation {
    this.assertLive()
    const physics = this.physics
    const world = physics === undefined ? null : this.presentationWorld(physics.sim)
    return {
      showId: this.factory.showId,
      tick: this.engine.tick(this.global.world),
      round: physics?.round ?? this.snapshot().round,
      map: physics?.selection.mapId ?? null,
      course: physics?.selection.courseData ?? null,
      worlds: world === null ? [] : [world],
    }
  }

  /**
   * The factory's live metadata of the physics world. Resolving it decodes the whole world, so the resolved
   * mapping is kept for this incarnation while the snapshot bytes it derives from (alive ids and zone ids) are
   * unchanged; every call still reads the world reference (tick, confirmation, replay state) anew. A step,
   * rollback or resimulation that changes those bytes resolves again, and release drops the kept mapping.
   */
  private presentationWorld(sim: EngineDomainSim): EnginePresentationWorld | null {
    const key = mappingBytes(this.engine.snapshot(sim.world), this.layout)
    const memo = this.worldMemo
    if (key !== undefined && memo !== undefined && memo.sim === sim
      && sameBytes(memo.entities, key.entities) && sameBytes(memo.zones, key.zones)) {
      return { ...memo.world, ref: this.factory.worldRef(sim) }
    }
    this.worldMemo = undefined
    // Copy before the factory reads the engine again: the snapshot view is only valid until the next engine call.
    const kept = key === undefined ? undefined : { entities: key.entities.slice(), zones: key.zones.slice() }
    const world = this.factory.presentationWorld(sim)
    if (world !== null && kept !== undefined) this.worldMemo = { sim, world, ...kept }
    return world
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
    const accumulated = this.accumulator + dtS * TICK_RATE
    if (!Number.isFinite(accumulated)) fail('frame.dtS', 'accumulated time is not finite; pass a smaller elapsed time')
    this.accumulator = accumulated
    const whole = Math.floor(this.accumulator + 1e-9)
    if (whole < 1) return
    const count = Math.min(MAX_TICKS_PER_FRAME, whole)
    for (let i = 0; i < count; i++) {
      // Consume the tick before executing it: a listener or effect failure after the tick ran must
      // never leave the accumulator asking for that same executed tick again.
      this.accumulator -= 1
      this.step(sample)
    }
  }

  vote(roomSeat: number, candidate: number): void {
    this.assertLive()
    const state = this.snapshot()
    if (state.screen !== 'vote') fail('vote', `screen is '${state.screen}'; votes are accepted only while voting`)
    if (!Number.isInteger(roomSeat) || roomSeat < 0 || roomSeat >= this.slots.length) {
      fail('vote.roomSeat', `invalid room seat ${roomSeat}; use a configured stable seat`)
    }
    if (this.slots[roomSeat]! < 0) fail(`vote.roomSeat`, `room seat ${roomSeat} is a bot; only humans vote`)
    if (!state.seatOf.includes(roomSeat)) fail('vote.roomSeat', `room seat ${roomSeat} is not on the active roster`)
    if (!Number.isInteger(candidate) || candidate < 0 || candidate >= state.candidates.length) {
      fail('vote.candidate', `invalid candidate ${candidate}; use index 0..${state.candidates.length - 1}`)
    }
    const decl = this.component('show_vote')
    const key = `${state.round}:${roomSeat}`
    const existing = this.votes.get(key)
    if (existing !== undefined) {
      patchVote(this.engine, this.global.world, this.layout, existing, candidate)
      return
    }
    const bytes = entityBytes(decl, {
      owner: this.cursor(), round_index: state.round, seat: roomSeat, choice: candidate,
    })
    const [entity] = this.engine.importEntities(this.global.world, bytes)
    if (entity === undefined) fail('vote', 'the vote row was not created')
    this.votes.set(key, entity)
  }

  dispose(): void {
    if (this.disposed) return
    try {
      this.releasePhysics()
    } finally {
      this.disposed = true
      this.factory.release(this.global)
      this.factory.dispose()
    }
  }

  /** One executed tick: sample first, then step the rules world and the live physics world. */
  private step(sample: (roomSeat: number) => number): void {
    const before = this.snapshot()
    if (before.screen === 'done') return
    const batch = new Map<number, number>()
    for (const roomSeat of before.seatOf) {
      const slot = this.slots[roomSeat]
      if (slot === undefined) fail('frame.seatOf', `room seat ${roomSeat} has no configured input slot`)
      if (slot < 0) continue
      const raw = sample(roomSeat)
      if (!isU32(raw)) {
        fail(`frame.sample(${roomSeat})`, `received ${String(raw)}; return an integer S1 code in 0..4294967295`)
      }
      batch.set(roomSeat, engineCodeOfS1(raw))
    }
    const now = this.engine.tick(this.global.world)
    const created = before.screen === 'loading' && this.physics?.round !== before.round
    if (created) {
      const selection = readShowSelection(this.config, this.global.world, now, before.round)
      this.factory.prepareRound(before.round, selection.mapIndex, before.seatOf)
      patchClock(this.engine, this.global.world, this.layout, selection.level.timeCapTicks, selection.level.overtimeTicks)
      this.openPhysics(before.round, before.seatOf, selection, now)
      this.applyLifecycle(before.round, now)
    }
    if (before.screen === 'results' && this.confirmedResult !== before.round) {
      this.applyLifecycle(this.acknowledgedRound, now)
      this.confirmedResult = before.round
    }
    const physics = this.physics
    if (!physics) {
      this.global.step([], NO_SHADOW)
      this.notify('post-tick')
      return
    }
    this.global.step([], this.shadowOf(physics))
    if (created || PLAY_SCREENS.includes(before.screen)) {
      this.factory.worldRef(physics.sim).binding.stepCodes(this.codesOf(physics, batch))
    }
    const after = this.snapshot()
    const released = after.screen === 'results' || after.screen === 'podium' || after.screen === 'done'
    try {
      this.notify('post-tick', after)
    } finally {
      if (released) this.releasePhysics()
    }
  }

  /** Delivers one observation synchronously; listener failures surface after every listener ran. */
  private notify(kind: ObservationKind, snapshot: EngineShowSnapshot = this.snapshot()): void {
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

  /** The outbox payload captured from the physics state before its labelled step (session shadow rule). */
  private shadowOf(physics: PhysicsRound): ShadowView {
    const writer = new SnapWriter()
    physics.sim.events(writer)
    const payload = writer.bytes()
    const domain = this.factory.worldRef(physics.sim).domain
    return {
      count: 1,
      fromDomain: () => domain,
      reader: index => new SnapReader(index === 0 ? payload : new Uint8Array(0)),
    }
  }

  /** Maps room seats to the factory's input slots and fills the dense engine-player code vector. */
  private codesOf(physics: PhysicsRound, batch: ReadonlyMap<number, number>): number[] {
    const codes = new Array<number>(this.players).fill(0)
    for (const roomSeat of physics.seats) {
      const slot = this.slots[roomSeat]
      if (slot === undefined) fail('physics.seats', `room seat ${roomSeat} has no configured input slot`)
      if (slot < 0) continue
      const code = batch.get(roomSeat)
      codes[slot] = code === undefined ? engineCodeOfS1(S1_NEUTRAL) : code
    }
    return codes
  }

  private openPhysics(round: number, seats: readonly number[], selection: EngineShowSelection, tick: number): void {
    this.releasePhysics()
    this.worldMemo = undefined
    const sim = this.factory.create(
      { id: round + 1, kind: 'seat', cells: [], seats: seats.map((_, roundSeat) => roundSeat), replicas: [0] },
      tick,
    )
    this.physics = { sim, round, seats: [...seats], selection }
    this.seedClock(sim)
  }

  /**
   * Gives the seat world the rules clock's authored durations when its template has no clock row,
   * so `rf.show.clock` places and phases the characters. A template that already seeds one is kept.
   */
  private seedClock(sim: EngineDomainSim): void {
    const physics = readWorldState(this.engine, sim.world, this.layout)
    if (Object.keys(physics.components.show_clock ?? {}).length > 0) return
    const rules = readWorldState(this.engine, this.global.world, this.layout)
    const entry = Object.values(rules.components.show_clock ?? {})[0]
    if (!entry) fail('show_clock', 'the rules world has no show clock; repair the authoritative rules scene')
    const bytes = entityBytes(this.component('show_clock'), {
      owner: this.cursor(), start_tick: -1, end_tick: -1, overtime_end_tick: -1, phase: 0, frozen: 0,
      intro_ticks: Number(entry.intro_ticks), round_ticks: Number(entry.round_ticks), overtime_ticks: Number(entry.overtime_ticks),
    })
    this.engine.importEntities(sim.world, bytes)
  }

  /** Notifies before-release while the departing world is still readable, then always releases it. */
  private releasePhysics(): void {
    const physics = this.physics
    if (!physics) return
    try {
      this.notify('before-release')
    } finally {
      this.physics = undefined
      this.worldMemo = undefined
      this.factory.release(physics.sim)
    }
  }

  private applyLifecycle(readyRound: number, confirmedTick: number): void {
    this.acknowledgedRound = readyRound
    patchLifecycle(this.engine, this.global.world, this.layout, readyRound, confirmedTick)
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

  private component(name: string): LayoutDecl {
    const decl = this.layout.components.find(entry => entry.name === name && entry.lane === 'simulation')
    if (!decl) fail(`schema.components.${name}`, 'missing required component; regenerate the engine schema')
    return decl
  }

  private assertLive(): void {
    if (this.disposed) fail('runtime', 'the show runtime is disposed')
  }
}

function slotOf(humans: readonly boolean[]): number[] {
  const slots = new Array<number>(humans.length).fill(-1)
  let next = 0
  for (let roomSeat = 0; roomSeat < humans.length; roomSeat++) {
    if (humans[roomSeat]) slots[roomSeat] = next++
  }
  return slots
}

/**
 * G7.2 Rules, season and results: run the local authoritative show.
 * Handoff: G7.2 Rules, season and results: provide the local product runner calls
 * createEngineShow(config: EngineShowConfig): Promise<EngineShowRuntime> from here for its local mode.
 * The returned runtime steps the same prepared script timelines, samples active human seats once per
 * tick, routes engine-mapped input slots and copies cumulative outbox messages into the rules world.
 * State/keys: the prepared EngineShowFactory, one global show_rules world, one per-round show_seat
 * world released when its result closes, the show_lifecycle_input host facts and the imported
 * show_vote rows. The factory share's handoff for the same runner is
 * packages/game/src/ege/showFactory.ts:295 createEngineShowFactory.
 */
export async function createEngineShow(config: EngineShowConfig): Promise<EngineShowRuntime> {
  if (!config || typeof config !== 'object') fail('config', 'missing show configuration; pass an EngineShowConfig')
  const factory = await createEngineShowFactory(config)
  let global: EngineDomainSim | undefined
  try {
    const layout = showSchemaLayout(config.engine)
    global = factory.create({ id: 0, kind: 'global', cells: [], seats: [], replicas: [0] }, 0)
    return new ShowRuntime(config, factory, layout, global)
  } catch (error) {
    if (global) factory.release(global)
    factory.dispose()
    throw error
  }
}
