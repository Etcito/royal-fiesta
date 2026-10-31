import { orderedSeatIndices } from './seatState.ts'
import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { CHAR, CharMode } from '../character/constants.ts'
import { HALF_PI, datan2 } from '../detmath.ts'
import { G, groups } from '../groups.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { quatAxisAngle, quatIdentity, quatMul, v3 } from '../vec.ts'
import type { FeatureSpec } from '../course.ts'
import type { Pose, Quat, Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory } from './feature.ts'
import { numParam, vec3Param } from './params.ts'

const STATE_VERSION = 2
const COLLIDE_WITH = G.CHAR | G.PROBE | G.DEBRIS
const Y_AXIS: Vec3 = v3(0, 1, 0)
const Y_TO_X: Quat = quatAxisAngle(v3(0, 0, 1), -HALF_PI, quatIdentity())

class RollingLog implements CourseFeature {
  readonly id: string
  readonly kind = 'rollingLog'
  readonly #from: Vec3; readonly #delta: Vec3; readonly #pathDir: Vec3; readonly #dir: Vec3
  readonly #axis: Vec3; readonly #orient: Quat
  readonly #radius: number; readonly #length: number; readonly #speed: number; readonly #distance: number
  readonly #travelS: number; readonly #pauseS: number; readonly #periodTicks: number; readonly #phaseTicks: number
  readonly #pose: Pose = { t: v3(0, 0, 0), r: quatIdentity() }
  readonly #vel: Vec3 = v3(0, 0, 0)
  readonly #roll: Quat = quatIdentity()
  readonly #seatPos: Vec3 = v3(0, 0, 0)
  #body = -1
  #physics!: RapierWorldSim
  constructor(spec: FeatureSpec, path: string) {
    this.id = spec.id
    const from = vec3Param(spec, path, 'from')
    const to = vec3Param(spec, path, 'to')
    this.#from = from
    this.#delta = v3(to.x - from.x, to.y - from.y, to.z - from.z)
    const distance = Math.sqrt(this.#delta.x * this.#delta.x + this.#delta.y * this.#delta.y + this.#delta.z * this.#delta.z)
    if (!(distance > 1e-6)) {
      refuse('feature', `${path}/to`, 'expected to to differ from from; move the log ends apart')
    }
    const hx = this.#delta.x
    const hz = this.#delta.z
    const hLen = Math.sqrt(hx * hx + hz * hz)
    if (!(hLen > 1e-9)) {
      refuse('feature', `${path}/to`, 'expected a horizontal travel direction; keep from and to at the same height')
    }
    this.#distance = distance
    this.#dir = v3(hx / hLen, 0, hz / hLen)
    this.#axis = v3(hz / hLen, 0, -hx / hLen)
    this.#pathDir = v3(this.#delta.x / distance, this.#delta.y / distance, this.#delta.z / distance)
    this.#orient = quatAxisAngle(Y_AXIS, datan2(this.#dir.x, this.#dir.z), quatIdentity())
    this.#radius = numParam(spec, path, 'radius', 0.2, 3)
    this.#length = numParam(spec, path, 'length', 0.5, 30)
    this.#speed = numParam(spec, path, 'speed', 0.5, 20)
    const periodS = numParam(spec, path, 'periodS', 0.5, 120)
    const phaseS = numParam(spec, path, 'phaseS', 0, Infinity, 0)
    this.#travelS = distance / this.#speed
    if (periodS * this.#speed < 2 * distance) {
      refuse('feature', `${path}/periodS`, `periodS ${periodS} s at ${this.#speed} m/s is shorter than the ${2 * distance} m round trip; raise periodS or speed`)
    }
    this.#pauseS = (periodS - 2 * this.#travelS) / 2
    this.#periodTicks = Math.max(1, Math.round(periodS * 60))
    this.#phaseTicks = phaseS > 0 ? Math.max(1, Math.round(phaseS * 60)) : 0
  }
  #poseAt(tick: number): void {
    let c = (tick + this.#phaseTicks) % this.#periodTicks
    if (c < 0) c += this.#periodTicks
    const s = c / 60
    const t1 = this.#travelS
    const t2 = t1 + this.#pauseS
    const t3 = t2 + this.#travelS
    let u = 0
    let signed = 0
    let vx = 0
    let vy = 0
    let vz = 0
    if (s < t1) {
      u = s / t1
      signed = this.#distance * u
      vx = this.#pathDir.x * this.#speed
      vy = this.#pathDir.y * this.#speed
      vz = this.#pathDir.z * this.#speed
    } else if (s < t2) {
      u = 1
      signed = this.#distance
    } else if (s < t3) {
      u = 1 - (s - t2) / t1
      signed = this.#distance * u
      vx = -this.#pathDir.x * this.#speed
      vy = -this.#pathDir.y * this.#speed
      vz = -this.#pathDir.z * this.#speed
    }
    const t = this.#pose.t
    t.x = this.#from.x + this.#delta.x * u
    t.y = this.#from.y + this.#delta.y * u
    t.z = this.#from.z + this.#delta.z * u
    quatAxisAngle(this.#axis, signed / this.#radius, this.#roll)
    quatMul(this.#roll, this.#orient, this.#pose.r)
    this.#vel.x = vx
    this.#vel.y = vy
    this.#vel.z = vz
  }
  init(ctx: FeatureCtx): void {
    this.#physics = ctx.physics
    this.#poseAt(0)
    const p = this.#pose
    const desc = ctx.R.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(p.t.x, p.t.y, p.t.z)
      .setRotation({ x: p.r.x, y: p.r.y, z: p.r.z, w: p.r.w })
    const collider = ctx.R.ColliderDesc.cylinder(this.#length / 2, this.#radius)
      .setRotation(Y_TO_X)
      .setCollisionGroups(groups(G.MOVING, COLLIDE_WITH))
    this.#body = ctx.physics.createBody(desc, [collider])
  }
  preStep(ctx: FeatureCtx): void {
    this.#poseAt(ctx.tick + 1)
    const p = this.#pose
    const rb = ctx.physics.body(this.#body)
    rb.setNextKinematicTranslation({ x: p.t.x, y: p.t.y, z: p.t.z })
    rb.setNextKinematicRotation({ x: p.r.x, y: p.r.y, z: p.r.z, w: p.r.w })
  }
  postStep(ctx: FeatureCtx): void {
    this.#poseAt(ctx.tick + 1)
    const centre = this.#pose.t
    const axis = this.#axis
    const half = this.#length / 2
    const reach = this.#radius + CHAR.radius + 0.05
    const reach2 = reach * reach
    for (const i of orderedSeatIndices(ctx.seats)) {
      if (ctx.seats.status(i) !== PlayerStatus.alive) continue
      if (ctx.seats.protectedNow(i)) continue
      if (ctx.seats.mode(i) === CharMode.stunned) continue
      const p = ctx.seats.pos(i, this.#seatPos)
      const rx = p.x - centre.x
      const ry = p.y - centre.y
      const rz = p.z - centre.z
      const along = rx * axis.x + rz * axis.z
      const clamped = along < -half ? -half : along > half ? half : along
      const nx = rx - axis.x * clamped
      const ny = ry
      const nz = rz - axis.z * clamped
      const d2 = nx * nx + ny * ny + nz * nz
      if (!(d2 < reach2)) continue
      const d = Math.sqrt(d2)
      let ux = 0
      let uy = 1
      let uz = 0
      if (d > 1e-9) {
        ux = nx / d
        uy = ny / d
        uz = nz / d
      }
      const alongSpeed = this.#vel.x * ux + this.#vel.y * uy + this.#vel.z * uz
      if (!(alongSpeed > CHAR.bumpMinSpeed)) continue
      const planar = Math.sqrt(ux * ux + uz * uz)
      const px = planar > 1e-9 ? ux / planar : this.#dir.x
      const pz = planar > 1e-9 ? uz / planar : this.#dir.z
      ctx.seats.knock(i, {
        x: this.#vel.x * CHAR.knockGain + px * CHAR.knockNormal,
        y: CHAR.knockUp,
        z: this.#vel.z * CHAR.knockGain + pz * CHAR.knockNormal,
      })
      ctx.sound('mech.log', { x: p.x, y: p.y, z: p.z }, 1)
    }
  }
  snapshot(w: SnapWriter): void {
    w.u8(STATE_VERSION)
    const p = this.#pose
    w.f64(p.t.x); w.f64(p.t.y); w.f64(p.t.z)
    w.f64(p.r.x); w.f64(p.r.y); w.f64(p.r.z); w.f64(p.r.w)
    const body = this.#physics.body(this.#body)
    const t = body.translation(), r = body.rotation()
    w.f64(t.x); w.f64(t.y); w.f64(t.z)
    w.f64(r.x); w.f64(r.y); w.f64(r.z); w.f64(r.w)
  }
  restore(r: SnapReader, ctx: FeatureCtx): void {
    r.u8()
    this.#pose.t = v3(r.f64(), r.f64(), r.f64())
    this.#pose.r = { x: r.f64(), y: r.f64(), z: r.f64(), w: r.f64() }
    const t = v3(r.f64(), r.f64(), r.f64())
    const q = { x: r.f64(), y: r.f64(), z: r.f64(), w: r.f64() }
    this.#physics = ctx.physics
    const body = ctx.physics.body(this.#body)
    const currentT = body.translation(), currentQ = body.rotation()
    // A rebuild needs the transferred pose. On rollback Rapier already restored
    // it exactly; do not renormalize the rotation or overwrite its next pose.
    if (currentT.x !== t.x || currentT.y !== t.y || currentT.z !== t.z) {
      body.setTranslation(t, false)
      body.setNextKinematicTranslation(t)
    }
    if (currentQ.x !== q.x || currentQ.y !== q.y || currentQ.z !== q.z || currentQ.w !== q.w) {
      body.setRotation(q, false)
      body.setNextKinematicRotation(q)
    }
  }

  draw(out: FeatureDraw[]): void {
    const p = this.#pose
    out.push({
      asset: 'candy.spinner-bar',
      t: { x: p.t.x, y: p.t.y, z: p.t.z },
      r: { x: p.r.x, y: p.r.y, z: p.r.z, w: p.r.w },
      s: v3(this.#length, this.#radius * 2, this.#radius * 2),
      visible: true,
      tint: 0,
    })
  }

  botTarget(): boolean {
    return false
  }
}

export const rollingLogFeature: FeatureFactory = (spec, path) => new RollingLog(spec, path)
