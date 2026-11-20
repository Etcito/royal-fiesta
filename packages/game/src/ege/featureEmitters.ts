// E3/E4: the feature registry, kind order, salt, draw-asset visual table and tint colours of the engine round.
// Each feature milestone adds one import and one map line per kind.

import type { FeatureSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { Vec3 } from '@royal-fiesta/sim/vec'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { ResolvedGameAsset } from '../courseV1.ts'
import { markerEmitter } from './features/marker.ts'
import { boostLaneEmitter } from './features/boostLane.ts'
import { launchPadEmitter } from './features/launchPad.ts'
import { catchVolumeEmitter } from './features/catchVolume.ts'
import { rollingLogEmitter } from './features/rollingLog.ts'
import { doorBankEmitter } from './features/doorBank.ts'
import { swimVolumeEmitter } from './features/swimVolume.ts'
import { carryItemEmitter } from './features/carryItem.ts'
import { tileFieldEmitter } from './features/tileField.ts'
import { hexFieldEmitter } from './features/hexField.ts'
import { memoryTilesEmitter } from './features/memoryTiles.ts'
import { annulusEmitter } from './features/annulus.ts'
import { sweepEmitter } from './features/sweep.ts'
import { risingKillEmitter } from './features/risingKill.ts'
import { ballEmitter } from './features/ball.ts'
import { goalEmitter } from './features/goal.ts'
import { collectibleEmitter } from './features/collectible.ts'
import { bankEmitter } from './features/bank.ts'
import { captureZoneEmitter } from './features/captureZone.ts'
import { tailSetEmitter } from './features/tailSet.ts'
import { crownEmitter } from './features/crown.ts'
import { roadEmitter } from './features/road.ts'

export type RawEntity = {
  name: string
  components?: Record<string, Record<string, number | number[]>>
  body?: Record<string, unknown>
  colliders?: Record<string, unknown>[]
}

export interface FeatureEmitContext {
  course: ResolvedCourse
  seatCount?: number
  worldKind?: 'round' | 'show_seat' | 'show_field' | 'show_hub'
  index: number
  path: string
  assets: ReadonlyMap<string, ResolvedGameAsset>
}

export interface FeatureEntities {
  root: RawEntity
  children: RawEntity[]
}

export type FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => FeatureEntities

// E3: the order of FEATURE_KINDS in the sim catalog; it fixes schedule order and the `feature.kind` value.
export const FEATURE_KIND_RANK: Readonly<Record<string, number>> = {
  marker: 0,
  boostLane: 1,
  launchPad: 2,
  catchVolume: 3,
  rollingLog: 4,
  doorBank: 5,
  swimVolume: 6,
  carryItem: 7,
  tileField: 8,
  hexField: 9,
  memoryTiles: 10,
  annulus: 11,
  sweep: 12,
  risingKill: 13,
  ball: 14,
  goal: 15,
  collectible: 16,
  bank: 17,
  captureZone: 18,
  tailSet: 19,
  crown: 20,
  road: 21,
}

const FEATURE_SNAKE: Readonly<Record<string, string>> = {
  marker: 'marker',
  boostLane: 'boost_lane',
  launchPad: 'launch_pad',
  catchVolume: 'catch_volume',
  rollingLog: 'rolling_log',
  doorBank: 'door_bank',
  swimVolume: 'swim_volume',
  carryItem: 'carry_item',
  tileField: 'tile_field',
  hexField: 'hex_field',
  memoryTiles: 'memory_tiles',
  annulus: 'annulus',
  sweep: 'sweep',
  risingKill: 'rising_kill',
  ball: 'ball',
  goal: 'goal',
  collectible: 'collectible',
  bank: 'bank',
  captureZone: 'capture_zone',
  tailSet: 'tail_set',
  crown: 'crown',
  road: 'road',
}

export function featureSnake(kind: string): string {
  if (!Object.hasOwn(FEATURE_SNAKE, kind)) {
    refuse('ege-scene', `features/${kind}/kind`, `unknown feature kind '${kind}'; registered: ${Object.keys(FEATURE_KIND_RANK).join(', ')}`)
  }
  return FEATURE_SNAKE[kind]
}

// E4: the per-feature RNG salt, so no feature shares the engine's stream.
export function featureSalt(index: number): number {
  return 0x100 + index
}

// Engine shape ids (engine 1.5).
const BOX = 1
const SPHERE = 2
const CYLINDER = 4

interface Visual {
  shape: number
  params(s: Vec3): [number, number, number, number]
  color: number
}

const VISUALS: Readonly<Record<string, Visual>> = {
  'candy.floor-disc': { shape: CYLINDER, params: (s) => [s.x, s.y / 2, 0, 0], color: 0xF2E6D0 },
  'candy.floor-tile': { shape: BOX, params: (s) => [s.x / 2, s.y / 2, s.z / 2, 0], color: 0xF5D0E0 },
  'candy.conveyor-belt': { shape: BOX, params: (s) => [s.x / 2, s.y / 2, s.z / 2, 0], color: 0x8C6BD9 },
  'candy.wall-block': { shape: BOX, params: (s) => [s.x / 2, s.y / 2, s.z / 2, 0], color: 0xE8C39E },
  'candy.slime-pool': { shape: BOX, params: (s) => [s.x / 2, s.y / 2, s.z / 2, 0], color: 0x7FD67F },
  'candy.mech-spring-pad': { shape: CYLINDER, params: (s) => [s.x / 2, s.y / 2, 0, 0], color: 0xFF8C42 },
  'candy.mech-door': { shape: BOX, params: (s) => [s.x / 2, s.y / 2, s.z / 2, 0], color: 0xC98B5A },
  'candy.sweeper-bar': { shape: BOX, params: (s) => [s.x / 2, s.y / 2, s.z / 2, 0], color: 0xE04F5F },
  'candy.spinner-bar': { shape: CYLINDER, params: (s) => [s.x / 2, s.y / 2, 0, 0], color: 0xB0784A },
  'candy.tower': { shape: SPHERE, params: (s) => [s.x, 0, 0, 0], color: 0xFFD140 },
}

export function visualOf(asset: string, s: Vec3): { shape: number; params: number[]; color: number } {
  if (!Object.hasOwn(VISUALS, asset)) {
    refuse('ege-scene', `visual/${asset}`, `no engine visual for draw asset '${asset}'; add a row to the visual table`)
  }
  const row = VISUALS[asset]
  return { shape: row.shape, params: row.params(s), color: row.color }
}

const TINTS: readonly number[] = [0xFF6B9E, 0x54BAFF, 0xFFD140, 0x73D966]

export function tintColor(tint: number, base: number): number {
  if (tint === 0) return base
  if (Number.isInteger(tint) && tint >= 1 && tint <= TINTS.length) return TINTS[tint - 1]
  return refuse('ege-scene', `visual/tint/${tint}`, `tint ${tint} has no colour; use 0 for the base colour or 1..4`)
}

export const FEATURE_EMITTERS: Readonly<Record<string, FeatureEmitter>> = Object.freeze({
  marker: markerEmitter,
  boostLane: boostLaneEmitter,
  launchPad: launchPadEmitter,
  catchVolume: catchVolumeEmitter,
  rollingLog: rollingLogEmitter,
  doorBank: doorBankEmitter,
  swimVolume: swimVolumeEmitter,
  carryItem: carryItemEmitter,
  tileField: tileFieldEmitter,
  hexField: hexFieldEmitter,
  memoryTiles: memoryTilesEmitter,
  annulus: annulusEmitter,
  sweep: sweepEmitter,
  risingKill: risingKillEmitter,
  ball: ballEmitter,
  goal: goalEmitter,
  collectible: collectibleEmitter,
  bank: bankEmitter,
  captureZone: captureZoneEmitter,
  tailSet: tailSetEmitter,
  crown: crownEmitter,
  road: roadEmitter,
})
