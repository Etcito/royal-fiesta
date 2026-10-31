// football.ts: the M6 ball and goal features (S19 `ball`, `goal`).
//
// goal.team is the DEFENDING team: a ball centre inside the goal box shrunk by
// the ball radius on X and Z scores `teamScore +1` for the other team. The ball
// is a dynamic MOVING body (filter STATIC|MOVING|CHAR|DEBRIS) so characters push
// it; 180 ticks after a goal the ball returns to spawn and every alive seat to
// its team home (teams.homeSpawn).

import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { levelOf } from '../course.ts'
import type { Box, FeatureSpec, SpawnPoint } from '../course.ts'
import { G, groups } from '../groups.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { homeSpawn } from '../season/teams.ts'
import { quatIdentity, v3 } from '../vec.ts'
import type { Quat, Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory, FeatureSeats } from './feature.ts'
import { orderedSeatIndices } from './seatState.ts'
import { boxParam, intParam, numParam, ticksParam, vec3Param } from './params.ts'

const BALL_KIND = 'ball'
const GOAL_KIND = 'goal'
const BALL_ASSET = 'candy.floor-disc'
const GOAL_ASSET = 'candy.wall-block'
const BALL_FILTER = G.STATIC | G.MOVING | G.CHAR | G.DEBRIS
const SCORE_RESET_TICKS = 180
const ANCHOR_MOVE2 = 0.25 * 0.25

type RigidBody = ReturnType<RapierWorldSim['body']>

interface GoalBox { readonly team: number; readonly box: Box }

function sameVector(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

/** `${course}#/features/<index>`, derived from this feature's own pointer. */
function featurePointer(base: string, index: number): string {
  const marker = '#/features/'
  const at = base.lastIndexOf(marker)
  return at >= 0 ? `${base.slice(0, at + marker.length)}${index}` : `${base}${marker}${index}`
}

function readGoal(spec: FeatureSpec, path: string): GoalBox {
  return { team: intParam(spec, path, 'team', 0, 1), box: boxParam(spec, path) }
}

function insideGoal(box: Box, p: Vec3, radius: number): boolean {
  return Math.abs(p.x - box.center.x) <= box.half.x - radius &&
    Math.abs(p.y - box.center.y) <= box.half.y &&
    Math.abs(p.z - box.center.z) <= box.half.z - radius
}

class Ball implements CourseFeature {
  readonly id: string
  readonly kind = BALL_KIND
  readonly #spawn: Vec3
  readonly #radius: number
  readonly #mass: number
  readonly #resetTicks: number
  readonly #path: string
  readonly #zero = v3(0, 0, 0)
  readonly #anchor = v3(0, 0, 0)
  readonly #home: SpawnPoint = { t: v3(0, 0, 0), facing: { x: 0, z: 0 } }
  #goals: GoalBox[] = []
  #physics!: RapierWorldSim
  #seats!: FeatureSeats
  #body = -1
  #pending = -1
  #anchorTick = 0

  constructor(spec: FeatureSpec, path: string) {
    this.id = spec.id
    this.#path = path
    this.#spawn = vec3Param(spec, path, 'spawn')
    this.#radius = numParam(spec, path, 'radius', 0.3, 3)
    this.#mass = numParam(spec, path, 'mass', 0.1, 500)
    this.#resetTicks = ticksParam(spec, path, 'resetS', 1, 120)
    this.#anchor.x = this.#spawn.x
    this.#anchor.y = this.#spawn.y
    this.#anchor.z = this.#spawn.z
  }

  init(ctx: FeatureCtx): void {
    this.#physics = ctx.physics
    this.#seats = ctx.seats
    this.#goals = []
    const specs = ctx.course.features ?? []
    for (let i = 0; i < specs.length; i++) {
      if (specs[i].kind === GOAL_KIND) this.#goals.push(readGoal(specs[i], featurePointer(this.#path, i)))
    }
    const collider = ctx.R.ColliderDesc.ball(this.#radius).setMass(this.#mass)
      .setCollisionGroups(groups(G.MOVING, BALL_FILTER))
    const desc = ctx.R.RigidBodyDesc.dynamic()
      .setTranslation(this.#spawn.x, this.#spawn.y, this.#spawn.z)
      .setCcdEnabled(true)
    this.#body = ctx.physics.createBody(desc, [collider])
    this.#pending = -1
    this.#anchorTick = ctx.tick
  }

  preStep(): void {}

  postStep(ctx: FeatureCtx): void {
    const body = this.#physics.body(this.#body)
    const p = body.translation()
    if (ctx.roundTick >= 0) {
      if (this.#pending < 0) {
        for (const goal of this.#goals) {
          if (!insideGoal(goal.box, p, this.#radius)) continue
          ctx.emit('teamScore', 1 - goal.team, 1, 0)
          ctx.sound('obj.goal', p, 1)
          this.#pending = ctx.tick + SCORE_RESET_TICKS
          break
        }
      }
      if (this.#pending >= 0 && ctx.tick >= this.#pending) {
        this.#pending = -1
        this.#place(body, ctx.tick)
        this.#resetSeats(ctx)
        return
      }
    }
    if (this.#pending >= 0) return
    const dx = p.x - this.#anchor.x
    const dy = p.y - this.#anchor.y
    const dz = p.z - this.#anchor.z
    if (dx * dx + dy * dy + dz * dz > ANCHOR_MOVE2) {
      this.#anchor.x = p.x
      this.#anchor.y = p.y
      this.#anchor.z = p.z
      this.#anchorTick = ctx.tick
    } else if (ctx.tick - this.#anchorTick >= this.#resetTicks || p.y < ctx.course.killPlaneY) {
      this.#place(body, ctx.tick)
    }
  }

  #place(body: RigidBody, tick: number): void {
    body.setTranslation(this.#spawn, true)
    body.setRotation(quatIdentity(), true)
    body.setLinvel(this.#zero, true)
    body.setAngvel(this.#zero, true)
    this.#anchor.x = this.#spawn.x
    this.#anchor.y = this.#spawn.y
    this.#anchor.z = this.#spawn.z
    this.#anchorTick = tick
  }

  #resetSeats(ctx: FeatureCtx): void {
    const level = levelOf(ctx.course)
    if (level.homes.length === 0) return
    let k0 = 0
    let k1 = 0
    for (const i of orderedSeatIndices(ctx.seats)) {
      if (ctx.seats.status(i) !== PlayerStatus.alive) continue
      const team = ctx.seats.team(i)
      const k = team === 1 ? k1++ : k0++
      homeSpawn(level, team, k, this.#home)
      ctx.seats.teleport(i, this.#home)
    }
  }

  snapshot(w: SnapWriter): void {
    const body = this.#physics.body(this.#body)
    const p = body.translation(), q = body.rotation(), v = body.linvel(), a = body.angvel()
    w.f64(p.x); w.f64(p.y); w.f64(p.z)
    w.f64(q.x); w.f64(q.y); w.f64(q.z); w.f64(q.w)
    w.f64(v.x); w.f64(v.y); w.f64(v.z)
    w.f64(a.x); w.f64(a.y); w.f64(a.z)
    w.u8(body.isSleeping() ? 1 : 0)
    w.i32(this.#pending)
    w.i32(this.#anchorTick)
    w.f64(this.#anchor.x); w.f64(this.#anchor.y); w.f64(this.#anchor.z)
  }

  restore(r: SnapReader, ctx: FeatureCtx): void {
    this.#physics = ctx.physics
    this.#seats = ctx.seats
    const body = this.#physics.body(this.#body)
    const p = v3(r.f64(), r.f64(), r.f64())
    const q: Quat = { x: r.f64(), y: r.f64(), z: r.f64(), w: r.f64() }
    const v = v3(r.f64(), r.f64(), r.f64()), a = v3(r.f64(), r.f64(), r.f64())
    const sleeping = r.u8() !== 0
    // Domain rollback already restored Rapier; compare before setting.
    if (!sameVector(body.translation(), p)) body.setTranslation(p, false)
    const rotation = body.rotation()
    if (!sameVector(rotation, q) || rotation.w !== q.w) body.setRotation(q, false)
    if (!sameVector(body.linvel(), v)) body.setLinvel(v, false)
    if (!sameVector(body.angvel(), a)) body.setAngvel(a, false)
    if (sleeping !== body.isSleeping()) { if (sleeping) body.sleep(); else body.wakeUp() }
    this.#pending = r.i32()
    this.#anchorTick = r.i32()
    this.#anchor.x = r.f64(); this.#anchor.y = r.f64(); this.#anchor.z = r.f64()
  }

  draw(out: FeatureDraw[]): void {
    const body = this.#physics.body(this.#body)
    const s = this.#radius * 2
    out.push({ asset: BALL_ASSET, t: body.translation(), r: body.rotation(),
      s: v3(s, s, s), visible: true, tint: 0 })
  }

  botTarget(seat: number, pos: Vec3, out: Vec3): boolean {
    let i = -1
    for (let j = 0; j < this.#seats.count; j++) if (this.#seats.seat(j) === seat) { i = j; break }
    if (i < 0) return false
    const team = this.#seats.team(i)
    const ball = this.#physics.body(this.#body).translation()
    let goal: GoalBox | undefined
    let bestD = Infinity
    for (const candidate of this.#goals) {
      if (candidate.team === team) continue
      const gx = candidate.box.center.x - ball.x
      const gz = candidate.box.center.z - ball.z
      const d = gx * gx + gz * gz
      if (d < bestD) { bestD = d; goal = candidate }
    }
    if (!goal) return false
    const dx = goal.box.center.x - ball.x
    const dz = goal.box.center.z - ball.z
    const len = Math.sqrt(dx * dx + dz * dz)
    const dirX = len > 1e-9 ? dx / len : 0
    const dirZ = len > 1e-9 ? dz / len : 0
    const behind = (pos.x - ball.x) * dirX + (pos.z - ball.z) * dirZ
    if (behind < -this.#radius / 2) {
      out.x = ball.x; out.y = ball.y; out.z = ball.z
    } else {
      const back = this.#radius + 1
      out.x = ball.x - dirX * back
      out.y = ball.y
      out.z = ball.z - dirZ * back
    }
    return true
  }

  grabCandidates(): void {}
}

class Goal implements CourseFeature {
  readonly id: string
  readonly kind = GOAL_KIND
  readonly #team: number
  readonly #box: Box

  constructor(spec: FeatureSpec, path: string) {
    this.id = spec.id
    this.#team = intParam(spec, path, 'team', 0, 1)
    this.#box = boxParam(spec, path)
  }

  init(): void {}
  preStep(): void {}
  postStep(): void {}
  snapshot(): void {}
  restore(): void {}

  draw(out: FeatureDraw[]): void {
    out.push({ asset: GOAL_ASSET, t: this.#box.center, r: quatIdentity(),
      s: v3(this.#box.half.x * 2, this.#box.half.y * 2, this.#box.half.z * 2),
      visible: true, tint: this.#team === 0 ? 2 : 3 })
  }

  botTarget(): boolean { return false }

  grabCandidates(): void {}
}

export const ballFeature: FeatureFactory = (spec, path) => new Ball(spec, path)
export const goalFeature: FeatureFactory = (spec, path) => new Goal(spec, path)
