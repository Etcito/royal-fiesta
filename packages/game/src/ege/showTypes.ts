import type { EngineInstance } from '@etcito/game-engine/loader'
import type { RollbackBinding } from '@etcito/game-engine/rollback'
import type { SwapTimeline } from '@etcito/game-engine/hotswap'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MechItem } from '@royal-fiesta/sim/mechanismSpec'
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { LedgerReason } from '@royal-fiesta/sim/zones/ledger'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { EngineModuleIdentity } from '../../../../tools/egeScripts.ts'
import type { CourseV1, ResolvedGameAsset } from '../courseV1.ts'
import type { EmittedScene } from './sceneEmitter.ts'

export interface EngineShowConfig {
  engine: EngineInstance
  schemaText: string
  scriptBytes: BufferSource
  identity: EngineModuleIdentity
  seed: number
  courses: readonly CourseV1[]
  assets: ReadonlyMap<string, ResolvedGameAsset>
  zones: ReadonlyMap<string, ZonesFile>
  season: readonly SchedMap[]
  humans: readonly boolean[]
  plan?: readonly number[]
  testMode?: boolean
}

export interface EngineRoundResult {
  index: number
  map: string
  course: string
  kind: RoundKind
  final: boolean
  playoff: boolean
  endTick: number
  reason: LedgerReason
  ranking: readonly number[]
  qualified: readonly number[]
  eliminated: readonly number[]
  points: readonly number[]
  teamScores: readonly number[]
  champion: number
}

export interface EngineShowSnapshot {
  tick: number
  round: number
  screen: 'vote' | 'loading' | 'intro' | 'playing' | 'overtime' | 'results' | 'podium' | 'done'
  seatOf: readonly number[]
  alive: readonly number[]
  candidates: readonly string[]
  results: readonly EngineRoundResult[]
  champion: number | null
  faults: number
}

export interface EngineWorldRef {
  domain: number
  kind: 'seat' | 'field' | 'global' | 'hub'
  world: number
  binding: RollbackBinding
  timeline: SwapTimeline
  confirmedTick: number
  resimulating: boolean
}

/** One seat's stable room identity, its compacted round seat and live entity in a presentation world. */
export interface EnginePresentationSeat {
  readonly roomSeat: number
  readonly roundSeat: number
  readonly inputSlot: number
  readonly entity: number
}

/** One authored obstacle or mechanism body resolved to its actual live entity in a presentation world. */
export interface EnginePresentationObstacle {
  readonly spec: ObstacleSpec
  readonly entity: number
}

export interface EnginePresentationFeature {
  readonly index: number
  readonly entity: number
}

/**
 * G7-RUNTIME-PRESENTATION metadata of one live physics world: the scene template it was created from,
 * the incarnation that distinguishes a reused domain/world handle, and the copies that resolve template
 * indices to actual live entities. Borrowed engine data is valid only for this tick and incarnation.
 */
export interface EnginePresentationWorld {
  readonly ref: EngineWorldRef
  readonly incarnation: number
  readonly scene: EmittedScene
  readonly seats: readonly EnginePresentationSeat[]
  readonly entities: ReadonlyMap<number, number>
  readonly obstacles: readonly EnginePresentationObstacle[]
  readonly mechanisms: readonly MechItem[]
  readonly bodies: ReadonlyMap<string, number>
  readonly features: readonly EnginePresentationFeature[]
  readonly publishers: ReadonlyMap<number, string>
  /**
   * The raw far poses (`ege_zone_poses(world, 1)`) of this live incarnation as independent storage.
   * Call it only during the tick/incarnation that produced this metadata; it refuses after release,
   * scratch replacement or factory disposal even when a domain identifier is reused.
   */
  readonly farSnapshot: () => Uint8Array
}

/**
 * The current read-only presentation of a show: the stable show identity, the authoritative tick and
 * round, the script-committed map/course and every live physics world. With no active physics world
 * `course` is null and `worlds` has no physics entries; no stale handle is exposed.
 */
export interface EngineShowPresentation {
  readonly showId: string
  readonly tick: number
  readonly round: number
  readonly map: string | null
  readonly course: ResolvedCourse | null
  readonly worlds: readonly EnginePresentationWorld[]
}

/**
 * G7-RUNTIME-PRESENTATION observation: `post-tick` is delivered synchronously after every executed
 * runtime tick (rules-only included) and before the next accumulated tick; `before-release` is
 * delivered while a departing world's event source and metadata are still readable. The presentation
 * identifies the affected live worlds with their current confirmation/replay state.
 */
export interface EngineShowObservation {
  readonly kind: 'post-tick' | 'before-release'
  readonly tick: number
  readonly snapshot: EngineShowSnapshot
  readonly presentation: EngineShowPresentation
}

/**
 * G7-LOCAL-FRAME-AND-VOTE: frame accumulates finite nonnegative seconds at 60 Hz,
 * executes at most eight ticks and retains the remainder. Each tick samples active
 * mapped humans once in ascending room-seat order, validates the whole u32 S1
 * batch before stepping and converts each code once. Invalid u32 values refuse; callback
 * exceptions propagate without stepping. S1 neutral is 32639; missing slots use engine
 * zero. Zero elapsed time can drain accumulated ticks without sampling otherwise.
 * vote accepts a stable active human room seat and a candidate index during voting;
 * valid votes replace that seat's previous choice, repeat votes are idempotent, and
 * invalid identities, bots, indices and out-of-phase votes refuse without mutation.
 */
export interface EngineShowRuntime {
  readonly identity: EngineModuleIdentity
  readonly mode: 'local' | 'online'
  snapshot(): EngineShowSnapshot
  frame(dtS: number, sample: (roomSeat: number) => number): void
  vote(roomSeat: number, candidate: number): void
  worlds(): readonly EngineWorldRef[]
  /** Copies the read-only presentation of the current round and every live physics world. */
  presentation(): EngineShowPresentation
  /** Registers a synchronous observation listener; the returned unsubscribe is idempotent. */
  onPresentation(listener: (observation: EngineShowObservation) => void): () => void
  dispose(): void
}
