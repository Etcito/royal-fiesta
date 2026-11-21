import { EgeError, EgeStatus } from '@etcito/game-engine/abi'
import { SwapTimeline } from '@etcito/game-engine/hotswap'
import { RollbackBinding } from '@etcito/game-engine/rollback'
import { loadScript, schemaLayout } from '@etcito/game-engine/script'
import type { SchemaLayout, ScriptModule } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import type { WorldState } from '@etcito/game-engine/world-state'
import { EngineDomainFactory } from '@etcito/game-engine/zones'
import type { EngineDomainSim, ZoneInputCodec, ZoneGrid } from '@etcito/game-engine/zones'
import { SnapWriter } from '@gamesaloon/rollback'
import type { DomainFactory, DomainSpec, SnapReader } from '@gamesaloon/rollback/zones'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MechItem } from '@royal-fiesta/sim/mechanismSpec'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { EmittedScene } from './sceneEmitter.ts'
import { buildShowPhysicsScenes, buildShowRulesScene } from './showScene.ts'
import type { ShowPhysicsScenes } from './showScene.ts'
import { readShowState } from './showState.ts'
import type {
  EnginePresentationObstacle,
  EnginePresentationSeat,
  EnginePresentationWorld,
  EngineShowConfig,
  EngineShowSnapshot,
  EngineWorldRef,
} from './showTypes.ts'

type DomainKind = 'seat' | 'field' | 'global'

/** One prepared per-round construction: its selected course, slots, scenes and generic factory. */
interface PreparedRound {
  readonly courseData: ResolvedCourse
  readonly inputSlots: readonly number[]
  readonly scenes: ShowPhysicsScenes
  readonly generic: EngineDomainFactory
}

/** The live world handles of one prepared factory: its timeline, its binding and its ownership. */
interface LiveWorld {
  readonly sim: EngineDomainSim
  readonly timeline: SwapTimeline
  readonly binding: RollbackBinding
  readonly generic: EngineDomainFactory
  readonly context: PreparedRound | null
  readonly incarnation: number
  readonly scratch: boolean
}

/**
 * The prepared show factory (G7-SHOW-FACTORY): a `DomainFactory<number>` whose synchronous domain
 * operations run the one script module admitted by `createEngineShowFactory`, plus the rules-state
 * reader, the live-world references and the read-only presentation metadata of the physics worlds.
 */
export interface EngineShowFactory extends DomainFactory<number> {
  /** Stable identity of the show this factory serves; survives world replacement and differs per show. */
  readonly showId: string
  /** The zone input codec shared by every session of this factory. */
  readonly codec: ZoneInputCodec
  create(spec: DomainSpec, tick: number): EngineDomainSim
  rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): EngineDomainSim
  reset(spec: DomainSpec, tick: number): EngineDomainSim
  /** Frees one world this factory created; a repeated, stale or foreign release changes nothing. */
  release(sim: EngineDomainSim): void
  /** Copies the authoritative show state of the global rules world of this factory. */
  rulesState(sim: EngineDomainSim): EngineShowSnapshot
  /** Builds the synchronous per-round templates from the script-committed catalog selection. */
  prepareRound(round: number, mapIndex: number, seatOf: readonly number[]): void
  /** Copies the presentation metadata of one live physics world; the rules world has none. */
  presentationWorld(sim: EngineDomainSim): EnginePresentationWorld | null
  /** The timeline, binding and confirmation boundary of one live world. */
  worldRef(sim: EngineDomainSim): EngineWorldRef
  /** The references of every live world, in creation order. */
  worlds(): readonly EngineWorldRef[]
  /** Releases every remaining world and then the admitted module; idempotent. */
  dispose(): void
}

function fail(path: string, problem: string): never {
  return refuse('ege-show-factory', path, problem)
}

function order(problem: string): never {
  throw new EgeError(EgeStatus.ORDER, problem)
}

/** The ascending configured show roster and its input slots: humans take 0..7 in room-seat order. */
function rosterOf(config: EngineShowConfig): { seatOf: number[]; inputSlots: number[] } {
  const humans = config.humans
  if (!Array.isArray(humans) || humans.length < 1 || humans.length > 60) {
    fail('humans', `has ${humans?.length ?? 0} entries; pass one boolean per configured room seat (1..60)`)
  }
  const seatOf: number[] = []
  const inputSlots: number[] = []
  let slot = 0
  for (let roomSeat = 0; roomSeat < humans.length; roomSeat++) {
    if (typeof humans[roomSeat] !== 'boolean') fail(`humans/${roomSeat}`, 'must be a boolean; mark each room seat human or bot')
    seatOf.push(roomSeat)
    inputSlots.push(humans[roomSeat] ? slot++ : -1)
  }
  return { seatOf, inputSlots }
}

function playersOf(layout: SchemaLayout, worldKind: string): number {
  const kind = layout.world_kinds.find(entry => entry.name === worldKind)
  if (!kind) fail('schema', `the loaded schema has no '${worldKind}' world kind; regenerate the engine schema`)
  return kind.players
}

/** The configured human input slots indexed by stable room seat; bots keep -1. */
function configuredSlots(humans: readonly boolean[]): readonly number[] {
  const slots = new Array<number>(humans.length).fill(-1)
  let next = 0
  for (let roomSeat = 0; roomSeat < humans.length; roomSeat++) {
    if (humans[roomSeat] === true) slots[roomSeat] = next++
  }
  return slots
}

/**
 * The template-index to live-entity map of one zone world: zone-owned template rows resolve through their
 * stable zone id, while static rows without an identity keep their template index. Template indices are
 * never reused as enduring handles.
 */
function liveEntityMap(state: WorldState, template: EmittedScene): Map<number, number> {
  const zoneIds = new Map<number, number>()
  for (const [entity, row] of Object.entries(state.components['ege.zone.id'] ?? {})) {
    zoneIds.set(Number(row.id), Number(entity))
  }
  const alive = new Set(state.entities)
  const mapped = new Map<number, number>()
  for (let index = 0; index < template.scene.entities.length; index++) {
    const zone = template.scene.entities[index].components?.['ege.zone.id']
    if (zone && typeof zone.id === 'number') {
      const live = zoneIds.get(zone.id)
      if (live !== undefined) mapped.set(index, live)
    } else if (alive.has(index)) {
      mapped.set(index, index)
    }
  }
  return mapped
}

function publishIdentity(row: { name?: string }): string | undefined {
  return typeof row.name === 'string' && row.name.startsWith('show/publish/') ? row.name : undefined
}

class ShowFactory implements EngineShowFactory {
  readonly showId: string
  private readonly config: EngineShowConfig
  private readonly engine: EngineShowConfig['engine']
  private readonly module: ScriptModule
  private readonly layout: SchemaLayout
  private readonly rulesGeneric: EngineDomainFactory
  private readonly rulesScene: string
  private readonly roster: { seatOf: readonly number[]; inputSlots: readonly number[] }
  private readonly slots: readonly number[]
  private readonly players: Record<DomainKind, number>
  private readonly live = new Map<number, LiveWorld>()
  private readonly rounds = new Map<string, PreparedRound>()
  private readonly pendingScratch = new Map<EngineDomainFactory, number>()
  private readonly generics = new Set<EngineDomainFactory>()
  private fallback: PreparedRound | undefined
  private current: PreparedRound | undefined
  private pendingTimeline: SwapTimeline | undefined
  private incarnation = 0
  private disposed = false

  constructor(
    config: EngineShowConfig,
    module: ScriptModule,
    rulesText: string,
    layout: SchemaLayout,
  ) {
    this.config = config
    this.engine = config.engine
    this.module = module
    this.layout = layout
    this.rulesScene = rulesText
    this.roster = rosterOf(config)
    this.slots = configuredSlots(config.humans)
    this.showId = `show-${nextShowSerial()}`
    this.players = {
      seat: playersOf(layout, 'show_seat'),
      field: playersOf(layout, 'show_field'),
      global: playersOf(layout, 'show_rules'),
    }
    this.rulesGeneric = this.genericOf(rulesText, rulesText, rulesText, { cols: 1, rows: 1, cellSize: 1, originX: 0, originZ: 0 }, this.slots)
  }

  /** The active round's codec when one is prepared, else the rules codec. */
  get codec(): ZoneInputCodec {
    return (this.current ?? this.fallback)?.generic.codec ?? this.rulesGeneric.codec
  }

  create(spec: DomainSpec, tick: number): EngineDomainSim {
    this.assertLive()
    return this.open(spec, generic => generic.create(spec, tick), false)
  }

  rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): EngineDomainSim {
    this.assertLive()
    const { generic } = this.factoryOf(spec)
    this.dropScratch(generic)
    return this.open(spec, factory => factory.rebuild(spec, tick, sources), true)
  }

  reset(spec: DomainSpec, tick: number): EngineDomainSim {
    this.assertLive()
    const { generic } = this.factoryOf(spec)
    this.dropScratch(generic)
    return this.open(spec, factory => factory.reset(spec, tick), true)
  }

  release(sim: EngineDomainSim): void {
    const record = this.live.get(sim.world)
    if (record === undefined || record.sim !== sim) return
    this.live.delete(sim.world)
    if (record.scratch && this.pendingScratch.get(record.generic) === sim.world) this.pendingScratch.delete(record.generic)
    record.generic.release(sim)
  }

  rulesState(sim: EngineDomainSim): EngineShowSnapshot {
    this.recordOf(sim)
    if (sim.spec.kind !== 'global') {
      fail('rulesState.sim', `world ${sim.world} is a ${sim.spec.kind} domain; read the show state from the global rules world`)
    }
    return readShowState(this.config, sim.world, this.engine.tick(sim.world), this.module.faultCount)
  }

  /**
   * Builds both physics templates for the round's committed map selection and the surviving roster,
   * synchronously from the already-admitted module and content. Later create/rebuild/reset calls use it.
   */
  prepareRound(round: number, mapIndex: number, seatOf: readonly number[]): void {
    this.assertLive()
    if (!Number.isInteger(round) || round < 0) fail('prepareRound.round', `invalid round ${round}; pass the displayed round index`)
    if (!Array.isArray(this.config.season) || !this.config.season[mapIndex]) {
      fail(`season/${mapIndex}`, 'the committed map index is outside the configured season catalog')
    }
    const map = this.config.season[mapIndex]!
    const course = this.config.courses[map.course]
    if (!course) fail(`season/${mapIndex}/course`, `course index ${map.course} is outside config.courses`)
    if (course.sim === null) fail(`courses/${course.id}.course.json`, 'the selected course has no simulation data; select a playable course')
    const seats = [...seatOf]
    const inputSlots = seats.map(roomSeat => {
      const slot = this.slots[roomSeat]
      if (slot === undefined) fail('prepareRound.seats', `room seat ${roomSeat} has no configured human flag; extend config.humans`)
      return slot
    })
    const key = `${mapIndex}:${seats.join(',')}`
    let prepared = this.rounds.get(key)
    if (prepared === undefined) {
      const scenes = buildShowPhysicsScenes(this.config, course, seats, inputSlots, map)
      prepared = {
        courseData: course.sim, inputSlots, scenes,
        generic: this.genericOf(scenes.seat.text, scenes.field.text, this.rulesScene, scenes.grid, inputSlots),
      }
      this.rounds.set(key, prepared)
    }
    this.current = prepared
  }

  presentationWorld(sim: EngineDomainSim): EnginePresentationWorld | null {
    const record = this.recordOf(sim)
    const context = record.context
    if (context === null) return null
    const template = sim.spec.kind === 'field' ? context.scenes.field : context.scenes.seat
    const state = readWorldState(this.engine, sim.world, this.layout)
    const entities = liveEntityMap(state, template)
    const seats: EnginePresentationSeat[] = []
    for (const seat of template.show?.seats ?? []) {
      const entity = entities.get(seat.entity)
      if (entity === undefined) fail('presentation.seats', `seat ${seat.roundSeat} has no live entity; the world lost a prepared seat`)
      seats.push({ roomSeat: seat.roomSeat, roundSeat: seat.roundSeat, inputSlot: seat.inputSlot, entity })
    }
    const obstacles: EnginePresentationObstacle[] = context.courseData.obstacles.map((spec, index) => {
      const entity = entities.get(template.obstacleEntities[index]!)
      if (entity === undefined) fail('presentation.obstacles', `obstacle '${spec.id}' has no live entity; the world lost a prepared obstacle`)
      return { spec, entity }
    })
    const mechanisms: MechItem[] = context.courseData.mechanisms?.items.slice() ?? []
    const bodies = new Map<string, number>()
    for (const [name, index] of template.itemBodies) {
      const entity = entities.get(index)
      if (entity === undefined) fail('presentation.bodies', `mechanism body '${name}' has no live entity; the world lost a prepared body`)
      bodies.set(name, entity)
    }
    const features = template.featureEntities.flatMap((index, feature) => {
      const entity = entities.get(index)
      if (entity === undefined) fail('presentation.features', `feature ${feature} has no live entity; the world lost a prepared feature`)
      return [{ index: feature, entity }]
    })
    const publishers = new Map<number, string>()
    for (const [index, row] of template.scene.entities.entries()) {
      const identity = publishIdentity(row)
      const entity = entities.get(index)
      if (identity !== undefined && entity !== undefined) publishers.set(entity, identity)
    }
    const farSnapshot = (): Uint8Array => {
      const live = this.recordOf(sim)
      if (live !== record || live.incarnation !== record.incarnation) {
        order(`world ${sim.world} is not the live incarnation this presentation captured; read presentation() again`)
      }
      const writer = new SnapWriter()
      live.sim.far(writer, 1)
      return writer.bytes().slice()
    }
    return {
      ref: this.worldRef(sim), incarnation: record.incarnation, scene: template, seats,
      entities, obstacles, mechanisms, bodies, features, publishers, farSnapshot,
    }
  }

  worldRef(sim: EngineDomainSim): EngineWorldRef {
    const record = this.recordOf(sim)
    return {
      domain: sim.spec.id,
      kind: sim.spec.kind,
      world: sim.world,
      binding: record.binding,
      timeline: record.timeline,
      confirmedTick: this.engine.tick(sim.world),
      resimulating: record.binding.resimulating,
    }
  }

  worlds(): readonly EngineWorldRef[] {
    return [...this.live.values()].map(record => this.worldRef(record.sim))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const records = [...this.live.values()]
    this.live.clear()
    this.pendingScratch.clear()
    try {
      for (const record of records) record.generic.release(record.sim)
      for (const generic of this.generics) generic.dispose()
      this.rulesGeneric.dispose()
    } finally {
      this.module.dispose()
    }
  }

  /** Maps the spec's round seats to the prepared context's emitted input slots; -1 keeps a bot seat. */
  private slotsOf(spec: DomainSpec, inputSlots: readonly number[]): readonly number[] {
    // The rules domain carries the playing seats for assignment bookkeeping but has no input players.
    if (spec.kind === 'global') return spec.seats.map(() => -1)
    return spec.seats.map(roundSeat => {
      if (!Number.isInteger(roundSeat) || roundSeat < 0 || roundSeat >= inputSlots.length) {
        fail('inputPlayers.seats', `round seat ${roundSeat} is outside the prepared roster of ${inputSlots.length} seats`)
      }
      return inputSlots[roundSeat]!
    })
  }

  /** The generic factory a spec's worlds come from: the rules world or the active round context. */
  private factoryOf(spec: DomainSpec): { generic: EngineDomainFactory; context: PreparedRound | null } {
    if (spec.kind === 'global') return { generic: this.rulesGeneric, context: null }
    const context = this.current ?? this.defaultRound()
    return { generic: context.generic, context }
  }

  /** One generic factory over a prepared context's scenes; its runner records the timeline it built. */
  private genericOf(
    seat: string,
    field: string,
    global: string,
    grid: ZoneGrid,
    inputSlots: readonly number[],
  ): EngineDomainFactory {
    const generic = new EngineDomainFactory({
      engine: this.engine,
      scenes: { seat, field, global },
      grid,
      runner: world => {
        const timeline = new SwapTimeline(this.engine, world, this.module)
        this.pendingTimeline = timeline
        return timeline
      },
      inputPlayers: spec => this.slotsOf(spec, inputSlots),
    })
    this.generics.add(generic)
    return generic
  }

  /** The low-level default templates used by direct factory operations before a round is selected. */
  private defaultRound(): PreparedRound {
    if (this.fallback !== undefined) return this.fallback
    const index = this.config.courses.findIndex(course => course.sim !== null)
    if (index < 0) fail('courses', 'no configured course has simulation data; add a playable show course')
    const course = this.config.courses[index]!
    const seatOf = [...this.roster.seatOf]
    const inputSlots = [...this.roster.inputSlots]
    const scenes = buildShowPhysicsScenes(this.config, course, seatOf, inputSlots)
    this.fallback = {
      courseData: course.sim!, inputSlots, scenes,
      generic: this.genericOf(scenes.seat.text, scenes.field.text, this.rulesScene, scenes.grid, inputSlots),
    }
    return this.fallback
  }

  /** Runs one generic factory operation and keeps the timeline its runner built for the new world. */
  private open(
    spec: DomainSpec,
    operation: (generic: EngineDomainFactory) => EngineDomainSim,
    scratch: boolean,
  ): EngineDomainSim {
    const { generic, context } = this.factoryOf(spec)
    this.pendingTimeline = undefined
    let sim: EngineDomainSim
    try {
      sim = operation(generic)
    } catch (error) {
      this.pendingTimeline = undefined
      throw error
    }
    const timeline = this.pendingTimeline
    this.pendingTimeline = undefined
    if (timeline === undefined) {
      generic.release(sim)
      order(`world ${sim.world} was created without a show timeline; keep one script module per factory`)
    }
    return this.track(sim, timeline, scratch, generic, context)
  }

  /** Stores the live references and builds the binding the runtime steps and snapshots through. */
  private track(
    sim: EngineDomainSim,
    timeline: SwapTimeline,
    scratch: boolean,
    generic: EngineDomainFactory,
    context: PreparedRound | null,
  ): EngineDomainSim {
    const inputSlots = context?.inputSlots ?? this.roster.inputSlots
    let binding: RollbackBinding
    try {
      binding = new RollbackBinding(this.engine, sim.world, {
        playerCount: this.players[sim.spec.kind],
        peers: [{ peer: 0, players: this.slotsOf(sim.spec, inputSlots).filter(player => player >= 0) }],
        runner: timeline,
      })
    } catch (error) {
      generic.release(sim)
      throw error
    }
    this.live.set(sim.world, {
      sim, timeline, binding, generic, context, incarnation: ++this.incarnation, scratch,
    })
    if (scratch) this.pendingScratch.set(generic, sim.world)
    return sim
  }

  /** Forgets the scratch world the generic factory frees at the start of the next rebuild or reset. */
  private dropScratch(generic: EngineDomainFactory): void {
    const world = this.pendingScratch.get(generic)
    if (world === undefined) return
    this.pendingScratch.delete(generic)
    this.live.delete(world)
  }

  private recordOf(sim: EngineDomainSim): LiveWorld {
    this.assertLive()
    const record = this.live.get(sim.world)
    if (record === undefined || record.sim !== sim) {
      order(`world ${sim.world} is not a live world of this show factory; release it through the factory that created it`)
    }
    return record
  }

  private assertLive(): void {
    if (this.disposed) order('the show factory is disposed')
  }
}

let showSerial = 0
function nextShowSerial(): number {
  showSerial += 1
  return showSerial
}

/**
 * Handoff: G7.2 Rules, season and results: run the local authoritative show calls
 * createEngineShowFactory(config: EngineShowConfig): Promise<EngineShowFactory> from here, awaits it
 * before session construction, calls the returned create/rebuild/reset for the seat, field and global
 * domains, steps the EngineWorldRef binding and reads rulesState from the global world. State/keys: the
 * admitted ScriptModule (faultCount), the per-round seat/field templates of
 * showScene.buildShowPhysicsScenes, the show_rules scene of showScene.buildShowRulesScene, the ZoneGrid,
 * and the per-world SwapTimeline/RollbackBinding. The runtime selects each round with prepareRound from
 * the script-committed show_used_map/catalog record and reads presentationWorld for its live mappings.
 * Handoff: G7.2 Rules, season and results: provide the local product runner awaits
 * createEngineShowFactory(config: EngineShowConfig): Promise<EngineShowFactory> through createEngineShow
 * before it constructs a local show and consumes the returned factory's prepared worlds and rules-state
 * snapshots. State/keys: the same admitted module, templates, grid and per-world timeline/binding registry.
 */
export async function createEngineShowFactory(config: EngineShowConfig): Promise<EngineShowFactory> {
  if (!config || typeof config !== 'object') fail('config', 'missing show configuration; pass an EngineShowConfig')
  if (!config.engine) fail('config.engine', 'missing engine instance; load the engine before preparing a show factory')
  rosterOf(config)
  const rules = buildShowRulesScene(config)
  const module = await loadScript(config.engine, config.scriptBytes, { name: 'rf-scripts' })
  try {
    const layout = schemaLayout(config.engine)
    return new ShowFactory(config, module, JSON.stringify(rules), layout)
  } catch (error) {
    module.dispose()
    throw error
  }
}
