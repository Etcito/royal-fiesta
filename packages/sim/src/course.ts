import type { Vec3, Quat } from './vec.ts'

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
}

export interface Box { center: Vec3; half: Vec3 }
export interface SpawnPoint { t: Vec3; facing: { x: number; z: number } }
export interface Checkpoint { box: Box; respawn: SpawnPoint }
export interface PathNode { p: Vec3; jump: boolean; dive: boolean }
export interface Region { id: number; box: Box; adjacent: number[] }

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
}

export function inBox(b: Box, p: Vec3): boolean {
  return Math.abs(p.x - b.center.x) <= b.half.x &&
    Math.abs(p.y - b.center.y) <= b.half.y &&
    Math.abs(p.z - b.center.z) <= b.half.z
}

export function regionOf(c: ResolvedCourse, p: Vec3): number {
  for (let i = 0; i < c.regions.length; i++) {
    if (inBox(c.regions[i].box, p)) return c.regions[i].id
  }
  return -1
}
