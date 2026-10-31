import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { FeatureSpec } from '../course.ts'
import { datan2, dcos, dsin, TAU } from '../detmath.ts'
import { G, groups } from '../groups.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { degToRad, quatAxisAngle, quatIdentity, v3 } from '../vec.ts'
import type { Quat, Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory } from './feature.ts'
import { intParam, numParam, vec3Param } from './params.ts'
import { orderedSeatIndices } from './seatState.ts'

const COLLIDE_WITH = G.CHAR | G.PROBE | G.DEBRIS
const Y_AXIS: Vec3 = v3(0, 1, 0)
const AHEAD_RAD = degToRad(30)

class Annulus implements CourseFeature {
  readonly id: string
  readonly kind = 'annulus'
  readonly #center: Vec3
  readonly #inner: number
  readonly #outer: number
  readonly #mid: number
  readonly #radialHalf: number
  readonly #tangHalf: number
  readonly #thick: number
  readonly #radPerSec: number
  readonly #segments: number
  readonly #stepRad: number
  readonly #t: Vec3[]
  readonly #r: Quat[]
  readonly #bodies: number[] = []
  readonly #colliders: number[] = []
  readonly #seatPos: Vec3 = v3(0, 0, 0)
  readonly #pointVel: Vec3 = v3(0, 0, 0)
  #overtimeTicks = 0

  constructor(spec: FeatureSpec, path: string) {
    this.id = spec.id
    this.#center = vec3Param(spec, path, 'center')
    this.#inner = numParam(spec, path, 'innerM', 0, 1000)
    this.#outer = numParam(spec, path, 'outerM', 0, 1000)
    if (!(this.#outer > this.#inner + 0.5)) {
      refuse('feature', `${path}/outerM`,
        `expected outerM > innerM + 0.5 m (inner ${this.#inner} m, outer ${this.#outer} m); widen the ring or shrink the hole`)
    }
    this.#thick = numParam(spec, path, 'thickM', 0.05, 10)
    this.#radPerSec = degToRad(numParam(spec, path, 'speedDegS', -360, 360))
    this.#segments = intParam(spec, path, 'segments', 6, 48)
    this.#mid = (this.#inner + this.#outer) / 2
    this.#radialHalf = (this.#outer - this.#inner) / 2
    this.#stepRad = TAU / this.#segments
    this.#tangHalf = this.#mid * dsin(this.#stepRad / 2) + 0.02
    this.#t = Array.from({ length: this.#segments }, () => v3(0, 0, 0))
    this.#r = Array.from({ length: this.#segments }, () => quatIdentity())
  }

  #poseAt(effectiveTick: number): void {
    const angle = this.#radPerSec * effectiveTick / 60
    for (let j = 0; j < this.#segments; j++) {
      const theta = angle + j * this.#stepRad
      const t = this.#t[j]
      t.x = this.#center.x + this.#mid * dsin(theta)
      t.y = this.#center.y
      t.z = this.#center.z + this.#mid * dcos(theta)
      quatAxisAngle(Y_AXIS, theta, this.#r[j])
    }
  }

  #carry(ctx: FeatureCtx): void {
    const omega = this.#radPerSec * (ctx.overtime ? 1.5 : 1)
    const v = this.#pointVel
    for (const i of orderedSeatIndices(ctx.seats)) {
      if (ctx.seats.status(i) !== PlayerStatus.alive) continue
      const ground = ctx.seats.groundCollider(i)
      if (ground < 0 || this.#colliders.indexOf(ground) < 0) continue
      const p = ctx.seats.pos(i, this.#seatPos)
      const dx = p.x - this.#center.x
      const dz = p.z - this.#center.z
      v.x = omega * dz
      v.y = 0
      v.z = -omega * dx
      ctx.seats.addVelocity(i, v)
    }
  }

  init(ctx: FeatureCtx): void {
    this.#overtimeTicks = 0
    this.#bodies.length = 0
    this.#colliders.length = 0
    this.#poseAt(ctx.roundTick)
    const R = ctx.R
    for (let j = 0; j < this.#segments; j++) {
      const p = this.#t[j]
      const q = this.#r[j]
      const desc = R.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(p.x, p.y, p.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      const collider = R.ColliderDesc.cuboid(this.#tangHalf, this.#thick / 2, this.#radialHalf)
        .setCollisionGroups(groups(G.MOVING, COLLIDE_WITH))
      const body = ctx.physics.createBody(desc, [collider])
      this.#bodies.push(body)
      this.#colliders.push(ctx.physics.body(body).collider(0).handle)
    }
  }

  preStep(ctx: FeatureCtx): void {
    if (ctx.overtime) this.#overtimeTicks = (this.#overtimeTicks + 1) >>> 0
    this.#poseAt(ctx.roundTick + 1 + this.#overtimeTicks / 2)
    for (let j = 0; j < this.#segments; j++) {
      const p = this.#t[j]
      const q = this.#r[j]
      const rb = ctx.physics.body(this.#bodies[j])
      rb.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
      rb.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    }
    this.#carry(ctx)
    ctx.sound('mech.motor', this.#center, 0.5)
  }

  postStep(ctx: FeatureCtx): void {
    this.#poseAt(ctx.roundTick + 1 + this.#overtimeTicks / 2)
  }

  snapshot(w: SnapWriter): void {
    w.u32(this.#overtimeTicks)
  }

  restore(r: SnapReader, ctx: FeatureCtx): void {
    this.#overtimeTicks = r.u32()
    this.#poseAt(ctx.roundTick + this.#overtimeTicks / 2)
    for (let j = 0; j < this.#segments; j++) {
      const p = this.#t[j]
      const q = this.#r[j]
      const body = ctx.physics.body(this.#bodies[j])
      const currentT = body.translation()
      if (currentT.x !== p.x || currentT.y !== p.y || currentT.z !== p.z) {
        body.setTranslation(p, false)
        body.setNextKinematicTranslation(p)
      }
      const currentQ = body.rotation()
      if (currentQ.x !== q.x || currentQ.y !== q.y || currentQ.z !== q.z || currentQ.w !== q.w) {
        body.setRotation(q, false)
        body.setNextKinematicRotation(q)
      }
    }
  }

  draw(out: FeatureDraw[]): void {
    const sx = this.#tangHalf * 2
    const sy = this.#thick
    const sz = this.#radialHalf * 2
    for (let j = 0; j < this.#segments; j++) {
      const p = this.#t[j]
      const q = this.#r[j]
      out.push({
        asset: 'candy.floor-tile',
        t: { x: p.x, y: p.y, z: p.z },
        r: { x: q.x, y: q.y, z: q.z, w: q.w },
        s: { x: sx, y: sy, z: sz },
        visible: true,
        tint: 0,
      })
    }
  }

  botTarget(_seat: number, pos: Vec3, out: Vec3): boolean {
    const dx = pos.x - this.#center.x
    const dy = pos.y - this.#center.y
    const dz = pos.z - this.#center.z
    const limit = this.#outer + 2
    if (dx * dx + dy * dy + dz * dz > limit * limit) return false
    const angle = datan2(dx, dz) + (this.#radPerSec < 0 ? -AHEAD_RAD : AHEAD_RAD)
    out.x = this.#center.x + this.#mid * dsin(angle)
    out.y = this.#center.y
    out.z = this.#center.z + this.#mid * dcos(angle)
    return true
  }
}

export const annulusFeature: FeatureFactory = (spec, path) => new Annulus(spec, path)
