import type { EngineInstance } from '@etcito/game-engine/loader'
import type { RollbackBinding } from '@etcito/game-engine/rollback'
import type { SwapTimeline } from '@etcito/game-engine/hotswap'
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { LedgerReason } from '@royal-fiesta/sim/zones/ledger'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { EngineModuleIdentity } from '../../../../tools/egeScripts.ts'
import type { CourseV1, ResolvedGameAsset } from '../courseV1.ts'

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
  dispose(): void
}
