import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { BodyId } from '@gamesaloon/rollback-rapier'
import { MAX_OBSTACLES } from '../course.ts'
import type { ObstacleSpec, ResolvedCourse } from '../course.ts'
import { G, groups } from '../groups.ts'
import { refuse } from '../refusal.ts'
import { cross3, dot3, pose as newPose, sub3, v3 } from '../vec.ts'
import type { Pose, Vec3 } from '../vec.ts'
import { GRAVITY_Y } from '../world.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { colliderDesc } from './colliders.ts'
import { isKinematic, motionPose, pointVelocity } from './motion.ts'

const MAX_LOADS = 64
const COLLIDE_WITH = G.CHAR | G.DEBRIS | G.PROBE

// Scratch pose for preStep and load; never part of sim state.
const scratchPose: Pose = newPose()
const scratchArm: Vec3 = v3(0, 0, 0)
const scratchForce: Vec3 = v3(0, 0, 0)
const scratchPoint: Vec3 = v3(0, 0, 0)
const scratchTorque: Vec3 = v3(0, 0, 0)

export class ObstacleSystem implements SimSystem<unknown> {
  readonly name = 'obstacles'
  readonly courses: readonly ResolvedCourse[]
  #courseIndex = -1
  #loadTick = 0
  #specs: ObstacleSpec[] = []
  #bodies: BodyId[] = []
  // Obstacle index -> see-saw slot, -1 for other kinds.
  #slot: number[] = []
  #angle: number[] = []
  #prevAngle: number[] = []
  #angVel: number[] = []
  // Per see-saw slot: flat x, y, z, mass quadruples.
  #loads: number[][] = []
  // Collider handle -> obstacle index; rebuilt lazily because handles change with load/restore.
  #colliderMap = new Map<number, number>()
  #mapDirty = true

  constructor(courses: readonly ResolvedCourse[]) {
    this.courses = courses
  }

  init(_ctx: WorldCtx<unknown>): void {}

  get courseIndex(): number { return this.#courseIndex }

  get count(): number { return this.#specs.length }

  get loadTick(): number { return this.#loadTick }

  load(ctx: WorldCtx<unknown>, courseIndex: number): void {
    if (this.#courseIndex >= 0) {
      refuse('obstacles', `load(${courseIndex})`, `course ${this.#courseIndex} is already loaded; unload it first`)
    }
    if (!Number.isInteger(courseIndex) || courseIndex < 0 || courseIndex >= this.courses.length) {
      refuse('obstacles', `load(${courseIndex})`, `course index out of range 0..${this.courses.length - 1}; pass a valid course index`)
    }
    const course = this.courses[courseIndex]
    const specs = course.obstacles
    if (specs.length > MAX_OBSTACLES) {
      refuse('obstacles', `courses/${course.id}/obstacles`, `${specs.length} obstacles, at most ${MAX_OBSTACLES}; split the course`)
    }
    const R = ctx.R
    const bodies: BodyId[] = []
    for (let i = 0; i < specs.length; i++) {
      const o = specs[i]
      const kinematic = isKinematic(o.motion.kind)
      const p = motionPose(o, 0, 0, scratchPose)
      const desc = kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed()
      desc.setTranslation(p.t.x, p.t.y, p.t.z)
      desc.setRotation({ x: p.r.x, y: p.r.y, z: p.r.z, w: p.r.w })
      const cols = []
      const word = groups(kinematic ? G.MOVING : G.STATIC, COLLIDE_WITH)
      for (let k = 0; k < o.colliders.length; k++) {
        cols.push(colliderDesc(R, o.colliders[k])
          .setCollisionGroups(word)
          .setFriction(o.friction)
          .setRestitution(0))
      }
      bodies.push(ctx.physics.createBody(desc, cols))
    }
    this.#courseIndex = courseIndex
    this.#loadTick = ctx.tick
    this.#specs = specs.slice()
    this.#bodies = bodies
    this.#resetSeesaws()
    this.#mapDirty = true
  }

  unload(ctx: WorldCtx<unknown>): void {
    const bodies = this.#bodies
    for (let i = bodies.length - 1; i >= 0; i--) ctx.physics.removeBody(bodies[i])
    this.#courseIndex = -1
    this.#loadTick = 0
    this.#specs = []
    this.#bodies = []
    this.#resetSeesaws()
    this.#mapDirty = true
  }

  // Zeroed see-saw state for the current specs, in index order.
  #resetSeesaws(): void {
    const specs = this.#specs
    this.#slot = []
    this.#angle = []
    this.#prevAngle = []
    this.#angVel = []
    this.#loads = []
    for (let i = 0; i < specs.length; i++) {
      if (specs[i].motion.kind === 'seesaw') {
        this.#slot.push(this.#angle.length)
        this.#angle.push(0)
        this.#prevAngle.push(0)
        this.#angVel.push(0)
        this.#loads.push([])
      } else {
        this.#slot.push(-1)
      }
    }
  }

  localTick(ctx: WorldCtx<unknown>): number {
    return ctx.tick - this.#loadTick
  }

  #check(i: number, what: string): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.#specs.length) {
      refuse('obstacles', `${what}(${i})`, `obstacle index out of range 0..${this.#specs.length - 1}; pass a loaded obstacle index`)
    }
  }

  #seesawSlot(i: number, what: string): number {
    this.#check(i, what)
    const s = this.#slot[i]
    if (s < 0) refuse('obstacles', `${what}(${i})`, `obstacle '${this.#specs[i].id}' is not a seesaw; pass a seesaw index`)
    return s
  }

  spec(i: number): ObstacleSpec {
    this.#check(i, 'spec')
    return this.#specs[i]
  }

  bodyId(i: number): BodyId {
    this.#check(i, 'bodyId')
    return this.#bodies[i]
  }

  obstacleOfCollider(ctx: WorldCtx<unknown>, colliderHandle: number): number {
    if (this.#mapDirty) {
      const map = new Map<number, number>()
      for (let i = 0; i < this.#bodies.length; i++) {
        const rb = ctx.physics.body(this.#bodies[i])
        const n = rb.numColliders()
        for (let k = 0; k < n; k++) map.set(rb.collider(k).handle, i)
      }
      this.#colliderMap = map
      this.#mapDirty = false
    }
    const i = this.#colliderMap.get(colliderHandle)
    return i === undefined ? -1 : i
  }

  pose(i: number, localTick: number, out: Pose): Pose {
    this.#check(i, 'pose')
    const s = this.#slot[i]
    return motionPose(this.#specs[i], localTick, s >= 0 ? this.#angle[s] : 0, out)
  }

  pointVelocity(ctx: WorldCtx<unknown>, i: number, p: Vec3, out: Vec3): Vec3 {
    this.#check(i, 'pointVelocity')
    const s = this.#slot[i]
    const a0 = s >= 0 ? this.#prevAngle[s] : 0
    const a1 = s >= 0 ? this.#angle[s] : 0
    return pointVelocity(this.#specs[i], this.localTick(ctx), a0, a1, p, out)
  }

  addLoad(i: number, point: Vec3, mass: number): void {
    const s = this.#seesawSlot(i, 'addLoad')
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z) || !Number.isFinite(mass)) {
      refuse('obstacles', `addLoad(${i})`, 'non-finite point or mass; pass finite numbers')
    }
    const loads = this.#loads[s]
    if (loads.length >= MAX_LOADS * 4) {
      refuse('obstacles', `addLoad(${i})`, `too many loads; at most ${MAX_LOADS} per seesaw per tick`)
    }
    loads.push(point.x, point.y, point.z, mass)
  }

  seesawAngle(i: number): number {
    return this.#angle[this.#seesawSlot(i, 'seesawAngle')]
  }

  preStep(ctx: WorldCtx<unknown>, _inputs: readonly unknown[]): void {
    if (this.#courseIndex < 0) return
    const L = this.localTick(ctx)
    const specs = this.#specs
    // See-saws integrate before the targets so the target uses this tick's angle.
    for (let i = 0; i < specs.length; i++) {
      const m = specs[i].motion
      if (m.kind === 'seesaw') this.#integrate(this.#slot[i], specs[i].t, m.axis, m.maxAngle, m.spring, m.damping, m.inertia, ctx.dt)
    }
    for (let i = 0; i < specs.length; i++) {
      const o = specs[i]
      if (!isKinematic(o.motion.kind)) continue
      const s = this.#slot[i]
      const p = motionPose(o, L + 1, s >= 0 ? this.#angle[s] : 0, scratchPose)
      const rb = ctx.physics.body(this.#bodies[i])
      rb.setNextKinematicTranslation({ x: p.t.x, y: p.t.y, z: p.t.z })
      rb.setNextKinematicRotation({ x: p.r.x, y: p.r.y, z: p.r.z, w: p.r.w })
    }
  }

  // Semi-implicit Euler on the 1-DOF angle, loads summed in arrival order.
  #integrate(s: number, t0: Vec3, axis: Vec3, maxAngle: number, spring: number, damping: number, inertia: number, dt: number): void {
    const loads = this.#loads[s]
    let torque = 0
    for (let k = 0; k < loads.length; k += 4) {
      scratchPoint.x = loads[k]
      scratchPoint.y = loads[k + 1]
      scratchPoint.z = loads[k + 2]
      sub3(scratchPoint, t0, scratchArm)
      scratchForce.x = 0
      scratchForce.y = loads[k + 3] * GRAVITY_Y
      scratchForce.z = 0
      torque += dot3(axis, cross3(scratchArm, scratchForce, scratchTorque))
    }
    let angle = this.#angle[s]
    let angVel = this.#angVel[s]
    this.#prevAngle[s] = angle
    const alpha = (torque - spring * angle - damping * angVel) / inertia
    angVel += alpha * dt
    angle += angVel * dt
    if (Math.abs(angle) > maxAngle) {
      angle = Math.sign(angle) * maxAngle
      angVel = 0
    }
    this.#angle[s] = angle
    this.#angVel[s] = angVel
    loads.length = 0
  }

  postStep(_ctx: WorldCtx<unknown>): void {}

  snapshot(w: SnapWriter): void {
    w.i32(this.#courseIndex)
    w.u32(this.#loadTick)
    const bodies = this.#bodies
    w.u32(bodies.length)
    for (let i = 0; i < bodies.length; i++) w.u32(bodies[i])
    for (let s = 0; s < this.#angle.length; s++) {
      w.f64(this.#angle[s])
      w.f64(this.#prevAngle[s])
      w.f64(this.#angVel[s])
      const loads = this.#loads[s]
      w.u32(loads.length / 4)
      for (let k = 0; k < loads.length; k++) w.f64(loads[k])
    }
  }

  // Never touches Rapier: the world is replaced after the systems restore.
  restore(r: SnapReader, _ctx: WorldCtx<unknown>): void {
    const courseIndex = r.i32()
    const loadTick = r.u32()
    const count = r.u32()
    let specs: ObstacleSpec[] = []
    if (courseIndex >= 0) {
      if (courseIndex >= this.courses.length) {
        refuse('obstacles', 'snapshot/courseIndex', `course ${courseIndex} out of range 0..${this.courses.length - 1}; restore with the same course list`)
      }
      specs = this.courses[courseIndex].obstacles.slice()
    } else if (courseIndex !== -1) {
      refuse('obstacles', 'snapshot/courseIndex', `got ${courseIndex}; restore an obstacles snapshot`)
    }
    if (count !== specs.length) {
      refuse('obstacles', 'snapshot/count', `snapshot has ${count} obstacles, course has ${specs.length}; restore with the same course list`)
    }
    const bodies: BodyId[] = []
    for (let i = 0; i < count; i++) bodies.push(r.u32())
    this.#courseIndex = courseIndex
    this.#loadTick = loadTick
    this.#specs = specs
    this.#bodies = bodies
    this.#resetSeesaws()
    for (let s = 0; s < this.#angle.length; s++) {
      this.#angle[s] = r.f64()
      this.#prevAngle[s] = r.f64()
      this.#angVel[s] = r.f64()
      const n = r.u32()
      if (n > MAX_LOADS) refuse('obstacles', 'snapshot/loads', `${n} pending loads, at most ${MAX_LOADS}; restore an obstacles snapshot`)
      const loads = this.#loads[s]
      for (let k = 0; k < n * 4; k++) loads.push(r.f64())
    }
    this.#mapDirty = true
  }
}
