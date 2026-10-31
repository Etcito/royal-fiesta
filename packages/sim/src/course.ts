import type { Vec3, Quat } from './vec.ts'
import type { MechanismSpec, SoundSpec } from './mechanismSpec.ts'
import { SEASON_SEATS, STAGE_IDS } from './season/kinds.ts'
import type { FinalRule, RoundKind, StageId } from './season/kinds.ts'

// ResolvedCourse is plain data produced by game/course; colliders are already
// scaled by `s` and expressed in the obstacle's local frame; contentHash is
// part of the match setup hash.

export type CourseKind = 'race' | 'survival' | 'hub' | 'gallery'
export type ProfileName = 'standard' | 'sprint'
export const MOTION_KINDS = [
  'static', 'spinner', 'pendulum', 'seesaw', 'rotatingDoor', 'conveyor', 'bouncePad', 'movingPlatform',
] as const
export type MotionKind = typeof MOTION_KINDS[number]
export const MAX_OBSTACLES = 96
export const MAX_COLLIDERS_PER_OBSTACLE = 8

export type Surface = 'normal' | 'ice' | 'mud' | 'rubber'
export const SURFACES: readonly Surface[] = ['normal', 'ice', 'mud', 'rubber']

export type ColliderSpec =
  | { shape: 'cuboid'; half: Vec3; t: Vec3; r: Quat }
  | { shape: 'roundCuboid'; half: Vec3; border: number; t: Vec3; r: Quat }
  | { shape: 'ball'; radius: number; t: Vec3; r: Quat }
  | { shape: 'capsule'; halfHeight: number; radius: number; t: Vec3; r: Quat }
  | { shape: 'cylinder'; halfHeight: number; radius: number; t: Vec3; r: Quat }
  | { shape: 'cone'; halfHeight: number; radius: number; t: Vec3; r: Quat }

export type Motion =
  | { kind: 'static' }
  | { kind: 'spinner'; axis: Vec3; radPerTick: number; phase: number }
  | { kind: 'pendulum'; pivot: Vec3; axis: Vec3; amp: number; periodTicks: number; phase: number }
  | { kind: 'seesaw'; axis: Vec3; maxAngle: number; spring: number; damping: number; inertia: number }
  | { kind: 'rotatingDoor'; axis: Vec3; stepAngle: number; periodTicks: number; moveTicks: number; phaseTicks: number }
  | { kind: 'conveyor'; velocity: Vec3 }
  | { kind: 'bouncePad'; speed: number }
  | { kind: 'movingPlatform'; offset: Vec3; periodTicks: number; phase: number; wave: 'sine' | 'pingpong' }

export interface ObstacleSpec {
  id: string
  asset: string
  t: Vec3
  r: Quat
  s: Vec3
  friction: number
  colliders: ColliderSpec[]
  motion: Motion
  surface?: Surface
}

export interface Box { center: Vec3; half: Vec3 }
export interface SpawnPoint { t: Vec3; facing: { x: number; z: number } }
export interface Checkpoint { box: Box; respawn: SpawnPoint }
export interface PathNode { p: Vec3; jump: boolean; dive: boolean; wait?: string; pull?: string }
export interface Region { id: number; box: Box; adjacent: number[] }

export interface RespawnSpec {
  mode: 'checkpoint' | 'home' | 'none'
  waitTicks: number
  protectTicks: number
  slots: number
  spacingM: number
}

export interface RouteSpec {
  ordered: boolean
  laps: number
  stages: number[]
}

export interface HomeSpec {
  team: number
  box: Box
  respawn: SpawnPoint[]
}

export interface GroupSpec {
  id: string
  role: 'floor' | 'wall' | 'hazard' | 'mover' | 'objective' | 'respawn' | 'route' | 'decor'
  friction: number | null
  surface: Surface | null
  members: string[]
}

export interface LevelSpec {
  season: string | null
  map: string | null
  kind: RoundKind
  finalRule: FinalRule | null
  stages: StageId[]
  capacity: number
  usual: number[]
  quota: number | null
  timeCapTicks: number
  overtimeTicks: number
  respawn: RespawnSpec
  route: RouteSpec
  teams: { count: 2; maxPerTeam: number } | null
  homes: HomeSpec[]
  groups: GroupSpec[]
  grab: { players: boolean; objects: boolean }
}

export interface FeatureSpec {
  id: string
  kind: string
  params: Readonly<Record<string, unknown>>
}

export interface ResolvedCourse {
  id: string
  name: string
  kind: CourseKind
  profiles: ProfileName[]
  timeLimitS: number
  killPlaneY: number
  spawns: SpawnPoint[]
  checkpoints: Checkpoint[]
  finish: Box | null
  path: PathNode[]
  regions: Region[]
  queuePad: Box | null
  obstacles: ObstacleSpec[]
  contentHash: number
  mechanisms?: MechanismSpec | null
  sounds?: SoundSpec[]
  level?: LevelSpec
  features?: FeatureSpec[]
}

export function legacyLevel(c: Pick<ResolvedCourse, 'kind' | 'timeLimitS' | 'checkpoints'>): LevelSpec {
  const survival = c.kind === 'survival'
  return {
    season: null,
    map: null,
    kind: survival ? 'survival' : 'race',
    finalRule: survival ? 'lastStanding' : null,
    stages: [...STAGE_IDS],
    capacity: SEASON_SEATS,
    usual: [],
    quota: null,
    timeCapTicks: Math.round(c.timeLimitS * 60),
    overtimeTicks: 0,
    respawn: {
      mode: survival ? 'none' : 'checkpoint',
      waitTicks: 0,
      protectTicks: 0,
      slots: 1,
      spacingM: 0,
    },
    route: {
      ordered: false,
      laps: 1,
      stages: c.checkpoints.map((_, index) => index),
    },
    teams: null,
    homes: [],
    groups: [],
    grab: { players: !survival, objects: true },
  }
}

export function levelOf(c: Pick<ResolvedCourse, 'kind' | 'timeLimitS' | 'checkpoints' | 'level'>): LevelSpec {
  return c.level ?? legacyLevel(c)
}

export function inBox(b: Box, p: Vec3): boolean {
  return Math.abs(p.x - b.center.x) <= b.half.x &&
    Math.abs(p.y - b.center.y) <= b.half.y &&
    Math.abs(p.z - b.center.z) <= b.half.z
}

export function surfaceOf(o: ObstacleSpec): Surface {
  return o.surface ?? 'normal'
}

export function regionOf(c: ResolvedCourse, p: Vec3): number {
  for (let i = 0; i < c.regions.length; i++) {
    if (inBox(c.regions[i].box, p)) return c.regions[i].id
  }
  return -1
}
