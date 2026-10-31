// Course features live inside a zone domain. The domain gives each feature its
// own rng = domainRng.fork(fnv1a32(feature.id)), so two features never share a
// random stream and the stream does not advance when other features are added.
//
// Each feature creates its bodies in init, in course `features` array order.
// Collider pools are created once in init and then toggled by enabling and
// disabling colliders; a feature never adds or removes bodies per tick.

import type { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierModule, RapierWorldSim } from '@gamesaloon/rollback-rapier'
import type { FeatureSpec, ResolvedCourse, SpawnPoint } from '../course.ts'
import type { PlayerInput } from '../input.ts'
import type { Vec3, Quat } from '../vec.ts'
import type { FiestaEventKind } from '../zones/ledger.ts'

export interface FeatureSeats {
  readonly count: number
  seat(i: number): number
  pos(i: number, out: Vec3): Vec3
  vel(i: number, out: Vec3): Vec3
  mode(i: number): number
  grounded(i: number): boolean
  groundCollider(i: number): number
  status(i: number): number
  team(i: number): number
  input(i: number): PlayerInput
  protectedNow(i: number): boolean
  setVelocity(i: number, v: Vec3): void
  addVelocity(i: number, v: Vec3): void
  teleport(i: number, at: SpawnPoint): void
  kill(i: number): void
  setCarry(i: number, kind: number, id: number): void
  /** CarryKind of the seat. */
  carry(i: number): number
  /** Unit planar facing, with y = 0. */
  facing(i: number, out: Vec3): Vec3
  /** Set swim mode and apply immediate drag and buoyancy. */
  setSwim(i: number, inside: boolean, drag: number, buoyancy: number): void
  /** Set velocity and stun, as an obstacle bump. */
  knock(i: number, v: Vec3): void
}

export interface FeatureCtx {
  readonly R: RapierModule
  readonly physics: RapierWorldSim
  readonly tick: number
  readonly roundTick: number
  readonly entrants: number
  readonly overtime: boolean
  /** Team behind on score; -1 when none or tied (until M6, always -1). */
  readonly trailingTeam: number
  readonly course: ResolvedCourse
  readonly seats: FeatureSeats
  readonly rng: Rng
  emit(kind: FiestaEventKind, seat: number, a: number, b: number): void
  sound(id: string, pos: Vec3, strength: number): void
  soundLoop(key: string, id: string, pos: Vec3, strength: number, rate: number): void
}

export interface FeatureDraw {
  asset: string
  t: Vec3
  r: Quat
  s: Vec3
  visible: boolean
  tint: 0 | 1 | 2 | 3 | 4
}

export interface FeatureSound {
  key: string
  rate: number
  id: string
  pos: Vec3
  strength: number
  loop: boolean
}

export interface CourseFeature {
  readonly id: string
  readonly kind: string
  init(ctx: FeatureCtx): void
  preStep(ctx: FeatureCtx): void
  postStep(ctx: FeatureCtx): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: FeatureCtx): void
  draw(out: FeatureDraw[]): void
  /** Where a bot of this seat should go now; false leaves the bot goal unchanged. */
  botTarget?(seat: number, pos: Vec3, out: Vec3): boolean
  grabCandidates?(pos: Vec3, facing: { x: number; z: number }, out: { id: number; dist: number }[]): void
}

/** `path` is the feature's JSON pointer, `${coursePath}#/features/<index>`. */
export type FeatureFactory = (spec: FeatureSpec, path: string) => CourseFeature
