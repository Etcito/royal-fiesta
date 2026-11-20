import { EgeError, EgeStatus } from '@etcito/game-engine/abi'
import { SwapTimeline } from '@etcito/game-engine/hotswap'
import { RollbackBinding } from '@etcito/game-engine/rollback'
import { loadScript, schemaLayout } from '@etcito/game-engine/script'
import type { SchemaLayout, ScriptModule } from '@etcito/game-engine/script'
import { EngineDomainFactory } from '@etcito/game-engine/zones'
import type { EngineDomainSim, ZoneInputCodec, ZoneGrid } from '@etcito/game-engine/zones'
import type { DomainFactory, DomainSpec, SnapReader } from '@gamesaloon/rollback/zones'
import { refuse } from '@royal-fiesta/sim/refusal'
import { buildShowPhysicsScenes, buildShowRulesScene } from './showScene.ts'
import { readShowState } from './showState.ts'
import type { EngineShowConfig, EngineShowSnapshot, EngineWorldRef } from './showTypes.ts'

type DomainKind = 'seat' | 'field' | 'global'

/** The prepared scene texts and the world kinds their players come from. */
interface PreparedScenes {
  readonly seat: string
  readonly field: string
  readonly global: string
  readonly seatWorldKind: string
  readonly fieldWorldKind: string
  readonly globalWorldKind: string
}

/** The live world handles of one prepared factory: its timeline, its binding and its ownership. */
interface LiveWorld {
  readonly sim: EngineDomainSim
  readonly timeline: SwapTimeline
  readonly binding: RollbackBinding
  readonly scratch: boolean
}

/**
 * The prepared show factory (G7-SHOW-FACTORY): a `DomainFactory<number>` whose synchronous domain
 * operations run the one script module admitted by `createEngineShowFactory`, plus the rules-state
 * reader and the live-world references of the seat, field and global show domains.
 */
export interface EngineShowFactory extends DomainFactory<number> {
  /** The zone input codec shared by every session of this factory. */
  readonly codec: ZoneInputCodec
  create(spec: DomainSpec, tick: number): EngineDomainSim
  rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): EngineDomainSim
  reset(spec: DomainSpec, tick: number): EngineDomainSim
  /** Frees one world this factory created; a repeated, stale or foreign release changes nothing. */
  release(sim: EngineDomainSim): void
  /** Copies the authoritative show state of the global rules world of this factory. */
  rulesState(sim: EngineDomainSim): EngineShowSnapshot
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

/** The course of the first scheduled map, the one whose templates preparation emits. */
function firstCourse(config: EngineShowConfig) {
  if (!Array.isArray(config.season) || config.season.length === 0) {
    fail('season', 'the show catalog is empty; provide the committed season maps')
  }
  const index = config.season[0]?.course
  if (!Number.isInteger(index) || index < 0 || index >= config.courses.length) {
    fail('season/0/course', `invalid course index ${index}; use an index into config.courses`)
  }
  return config.courses[index]!
}

function playersOf(layout: SchemaLayout, worldKind: string): number {
  const kind = layout.world_kinds.find(entry => entry.name === worldKind)
  if (!kind) fail('schema', `the loaded schema has no '${worldKind}' world kind; regenerate the engine schema`)
  return kind.players
}

class ShowFactory implements EngineShowFactory {
  readonly codec: ZoneInputCodec
  private readonly config: EngineShowConfig
  private readonly engine: EngineShowConfig['engine']
  private readonly module: ScriptModule
  private readonly generic: EngineDomainFactory
  private readonly inputSlots: readonly number[]
  private readonly players: Record<DomainKind, number>
  private readonly live = new Map<number, LiveWorld>()
  private scratchWorld: number | undefined
  private pendingTimeline: SwapTimeline | undefined
  private disposed = false

  constructor(
    config: EngineShowConfig,
    module: ScriptModule,
    scenes: PreparedScenes,
    grid: ZoneGrid,
    inputSlots: readonly number[],
    layout: SchemaLayout,
  ) {
    this.config = config
    this.engine = config.engine
    this.module = module
    this.inputSlots = inputSlots.slice()
    this.players = {
      seat: playersOf(layout, scenes.seatWorldKind),
      field: playersOf(layout, scenes.fieldWorldKind),
      global: playersOf(layout, scenes.globalWorldKind),
    }
    this.generic = new EngineDomainFactory({
      engine: this.engine,
      scenes: { seat: scenes.seat, field: scenes.field, global: scenes.global },
      grid,
      runner: world => {
        const timeline = new SwapTimeline(this.engine, world, this.module)
        this.pendingTimeline = timeline
        return timeline
      },
      inputPlayers: spec => this.slotsOf(spec),
    })
    this.codec = this.generic.codec
  }

  create(spec: DomainSpec, tick: number): EngineDomainSim {
    this.assertLive()
    const { sim, timeline } = this.open(() => this.generic.create(spec, tick))
    return this.track(sim, timeline, false)
  }

  rebuild(spec: DomainSpec, tick: number, sources: SnapReader[]): EngineDomainSim {
    this.assertLive()
    this.dropScratch()
    const { sim, timeline } = this.open(() => this.generic.rebuild(spec, tick, sources))
    return this.track(sim, timeline, true)
  }

  reset(spec: DomainSpec, tick: number): EngineDomainSim {
    this.assertLive()
    this.dropScratch()
    const { sim, timeline } = this.open(() => this.generic.reset(spec, tick))
    return this.track(sim, timeline, true)
  }

  release(sim: EngineDomainSim): void {
    const record = this.live.get(sim.world)
    if (record === undefined || record.sim !== sim) return
    this.live.delete(sim.world)
    if (record.scratch && this.scratchWorld === sim.world) this.scratchWorld = undefined
    this.generic.release(sim)
  }

  rulesState(sim: EngineDomainSim): EngineShowSnapshot {
    this.recordOf(sim)
    if (sim.spec.kind !== 'global') {
      fail('rulesState.sim', `world ${sim.world} is a ${sim.spec.kind} domain; read the show state from the global rules world`)
    }
    return readShowState(this.config, sim.world, this.engine.tick(sim.world), this.module.faultCount)
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
    this.scratchWorld = undefined
    try {
      for (const record of records) this.generic.release(record.sim)
      this.generic.dispose()
    } finally {
      this.module.dispose()
    }
  }

  /** Maps the spec's round seats to the emitted input slots; -1 keeps a bot seat without a player. */
  private slotsOf(spec: DomainSpec): readonly number[] {
    // The rules domain carries the playing seats for assignment bookkeeping but has no input players.
    if (spec.kind === 'global') return spec.seats.map(() => -1)
    return spec.seats.map(roundSeat => {
      if (!Number.isInteger(roundSeat) || roundSeat < 0 || roundSeat >= this.inputSlots.length) {
        fail('inputPlayers.seats', `round seat ${roundSeat} is outside the prepared roster of ${this.inputSlots.length} seats`)
      }
      return this.inputSlots[roundSeat]!
    })
  }

  /** Runs one generic factory operation and keeps the timeline its runner built for the new world. */
  private open(operation: () => EngineDomainSim): { sim: EngineDomainSim; timeline: SwapTimeline } {
    this.pendingTimeline = undefined
    let sim: EngineDomainSim
    try {
      sim = operation()
    } catch (error) {
      this.pendingTimeline = undefined
      throw error
    }
    const timeline = this.pendingTimeline
    this.pendingTimeline = undefined
    if (timeline === undefined) {
      this.generic.release(sim)
      order(`world ${sim.world} was created without a show timeline; keep one script module per factory`)
    }
    return { sim, timeline }
  }

  /** Stores the live references and builds the binding the runtime steps and snapshots through. */
  private track(sim: EngineDomainSim, timeline: SwapTimeline, scratch: boolean): EngineDomainSim {
    let binding: RollbackBinding
    try {
      binding = new RollbackBinding(this.engine, sim.world, {
        playerCount: this.players[sim.spec.kind],
        peers: [{ peer: 0, players: this.slotsOf(sim.spec).filter(player => player >= 0) }],
        runner: timeline,
      })
    } catch (error) {
      this.generic.release(sim)
      throw error
    }
    this.live.set(sim.world, { sim, timeline, binding, scratch })
    if (scratch) this.scratchWorld = sim.world
    return sim
  }

  /** Forgets the scratch world the generic factory frees at the start of the next rebuild or reset. */
  private dropScratch(): void {
    const world = this.scratchWorld
    if (world === undefined) return
    this.scratchWorld = undefined
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

/**
 * Handoff: G7.2 Rules, season and results: run the local authoritative show calls
 * createEngineShowFactory(config: EngineShowConfig): Promise<EngineShowFactory> from here, awaits it
 * before session construction, calls the returned create/rebuild/reset for the seat, field and global
 * domains, steps the EngineWorldRef binding and reads rulesState from the global world. State/keys: the
 * admitted ScriptModule (faultCount), the seat/field templates of showScene.buildShowPhysicsScenes, the
 * show_rules scene of showScene.buildShowRulesScene, the ZoneGrid, and the per-world
 * SwapTimeline/RollbackBinding.
 * Handoff: G7.2 Rules, season and results: provide the local product runner awaits
 * createEngineShowFactory(config: EngineShowConfig): Promise<EngineShowFactory> through createEngineShow
 * before it constructs a local show and consumes the returned factory's prepared worlds and rules-state
 * snapshots. State/keys: the same admitted module, templates, grid and per-world timeline/binding registry.
 */
export async function createEngineShowFactory(config: EngineShowConfig): Promise<EngineShowFactory> {
  if (!config || typeof config !== 'object') fail('config', 'missing show configuration; pass an EngineShowConfig')
  if (!config.engine) fail('config.engine', 'missing engine instance; load the engine before preparing a show factory')
  const { seatOf, inputSlots } = rosterOf(config)
  const course = firstCourse(config)
  const rules = buildShowRulesScene(config)
  const physics = buildShowPhysicsScenes(config, course, seatOf, inputSlots)
  const module = await loadScript(config.engine, config.scriptBytes, { name: 'rf-scripts' })
  try {
    const layout = schemaLayout(config.engine)
    return new ShowFactory(
      config,
      module,
      {
        seat: physics.seat.text,
        field: physics.field.text,
        global: JSON.stringify(rules),
        seatWorldKind: physics.seat.show!.worldKind,
        fieldWorldKind: physics.field.show!.worldKind,
        globalWorldKind: rules.world_kind,
      },
      physics.grid,
      inputSlots,
      layout,
    )
  } catch (error) {
    module.dispose()
    throw error
  }
}
