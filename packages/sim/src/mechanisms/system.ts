import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { BodyId } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '../course.ts'
import { datan2, dhypot3 } from '../detmath.ts'
import { emptyMechanisms, MECH_EVENT_RING } from '../mechanismSpec.ts'
import type {
  BodyRef, JointKind, JointSpec, MechEvent, MechEventKind, MechItem, MechanismSpec, MotorSpec,
} from '../mechanismSpec.ts'
import { refuse } from '../refusal.ts'
import { add3, cross3, dot3, normalize3, pose as newPose, quatConj, quatMul, quatRotate, sub3, v3 } from '../vec.ts'
import type { Pose, Quat, Vec3 } from '../vec.ts'
import { GRAVITY_Y } from '../world.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { createBody } from './bodies.ts'
import { applyMotor, createJoint } from './joints.ts'

// Snapshot kind byte order; append new kinds at the end so old snapshots keep their index.
const EVENT_KINDS: readonly MechEventKind[] = [
  'switchOn', 'switchOff', 'leverOn', 'leverOff',
  'motorStart', 'motorStop', 'animStart', 'animEnd', 'impact',
]

// A dynamic body that loses more than 3 m/s in one tick emits an impact; 10 m/s is full strength.
const IMPACT_DROP = 3
const IMPACT_FULL = 10

// Module scratch, reused across calls; never part of sim state.
const scratchPose: Pose = newPose()
const scratchPointA: Vec3 = v3(0, 0, 0)
const scratchPointB: Vec3 = v3(0, 0, 0)
const scratchArm: Vec3 = v3(0, 0, 0)
const scratchCross: Vec3 = v3(0, 0, 0)
const scratchAxis: Vec3 = v3(0, 0, 0)
const scratchQA: Quat = { x: 0, y: 0, z: 0, w: 1 }
const scratchQB: Quat = { x: 0, y: 0, z: 0, w: 1 }
const scratchQR: Quat = { x: 0, y: 0, z: 0, w: 1 }

function eventKindByte(kind: MechEventKind): number {
  const i = EVENT_KINDS.indexOf(kind)
  if (i < 0) refuse('mechanisms', 'events/kind', `unknown event kind '${kind}'; use a MechEventKind`)
  return i
}

function eventKindAt(byte: number): MechEventKind {
  const kind = EVENT_KINDS[byte]
  if (kind === undefined) {
    refuse('mechanisms', 'snapshot/events', `unknown event kind ${byte}; restore a mechanisms snapshot`)
  }
  return kind
}

function copyJoint(j: JointSpec): JointSpec {
  return {
    ...j,
    a: { item: j.a.item, body: j.a.body },
    b: { item: j.b.item, body: j.b.body },
    anchorA: { x: j.anchorA.x, y: j.anchorA.y, z: j.anchorA.z },
    anchorB: { x: j.anchorB.x, y: j.anchorB.y, z: j.anchorB.z },
    axis: { x: j.axis.x, y: j.axis.y, z: j.axis.z },
    limits: j.limits === null ? null : [j.limits[0], j.limits[1]],
    motor: j.motor === null ? null : { ...j.motor },
  }
}

function finiteVec(p: Vec3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

function finitePose(p: Pose): boolean {
  return finiteVec(p.t) &&
    Number.isFinite(p.r.x) && Number.isFinite(p.r.y) && Number.isFinite(p.r.z) && Number.isFinite(p.r.w)
}

function readQuat(q: { x: number; y: number; z: number; w: number }, out: Quat): Quat {
  out.x = q.x
  out.y = q.y
  out.z = q.z
  out.w = q.w
  return out
}

function blankEvent(): MechEvent {
  return { tick: 0, kind: 'impact', source: 0, x: 0, y: 0, z: 0, strength: 0 }
}

// Rapier 0.21 deterministic-compat returns an impulse joint's packed u64 handle
// reinterpreted as an f64 (joint 1 is 5e-324), and its JS Sets address a joint by
// the low u32 of that f64's bits. Snapshot the index, rebuild the same key.
const handleBits = new Float64Array(1)
const handleWords = new Uint32Array(handleBits.buffer)

function handleIndex(handle: number): number {
  if (Number.isInteger(handle) && handle >= 0 && handle < 0x100000000) return handle
  handleBits[0] = handle
  return handleWords[0]
}

function handleFromIndex(index: number): number {
  handleWords[0] = index >>> 0
  handleWords[1] = 0
  return handleBits[0]
}

export class MechanismSystem implements SimSystem<unknown> {
  readonly name = 'mechanisms'
  readonly courses: readonly ResolvedCourse[]
  #courseIndex = -1
  #spec: MechanismSpec | null = null
  #items: readonly MechItem[] = []
  // Item -> first index in the flat body list.
  #itemStart: number[] = []
  #bodies: BodyId[] = []
  #bodyItems: number[] = []
  #bodyLocals: number[] = []
  #jointHandles: number[] = []
  #jointKinds: JointKind[] = []
  #jointSpecs: JointSpec[] = []
  #jointA: (BodyId | null)[] = []
  #jointB: (BodyId | null)[] = []
  #motors: (MotorSpec | null)[] = []
  #kinTarget: Pose[] = []
  #kinPending: boolean[] = []
  // Per body: flat x, y, z, mass quadruples, in arrival order.
  #loads: number[][] = []
  #loadApplied: number[] = []
  #prevSpeed: number[] = []
  #speedDirty = true
  // Collider handle -> flat body index; rebuilt lazily because handles change with load/restore.
  #colliderMap = new Map<number, number>()
  #mapDirty = true
  #events: MechEvent[] = []
  #head = 0
  #count = 0

  constructor(courses: readonly ResolvedCourse[]) {
    this.courses = courses
  }

  init(_ctx: WorldCtx<unknown>): void {}

  load(ctx: WorldCtx<unknown>, courseIndex: number): void {
    if (this.#courseIndex >= 0) {
      refuse('mechanisms', `load(${courseIndex})`, `course ${this.#courseIndex} is already loaded; unload it first`)
    }
    if (!Number.isInteger(courseIndex) || courseIndex < 0 || courseIndex >= this.courses.length) {
      refuse('mechanisms', `load(${courseIndex})`, `course index out of range 0..${this.courses.length - 1}; pass a valid course index`)
    }
    const course = this.courses[courseIndex]
    const spec = course.mechanisms ?? emptyMechanisms()
    const items = spec.items
    const bodies: BodyId[] = []
    const bodyItems: number[] = []
    const bodyLocals: number[] = []
    const itemStart: number[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      itemStart.push(bodies.length)
      const itemPose = scratchPose
      itemPose.t.x = item.t.x
      itemPose.t.y = item.t.y
      itemPose.t.z = item.t.z
      itemPose.r.x = item.r.x
      itemPose.r.y = item.r.y
      itemPose.r.z = item.r.z
      itemPose.r.w = item.r.w
      for (let b = 0; b < item.bodies.length; b++) {
        bodies.push(createBody(ctx, item, item.bodies[b], itemPose))
        bodyItems.push(i)
        bodyLocals.push(b)
      }
    }
    this.#courseIndex = courseIndex
    this.#spec = spec
    this.#items = items
    this.#itemStart = itemStart
    this.#bodies = bodies
    this.#bodyItems = bodyItems
    this.#bodyLocals = bodyLocals
    this.#initBodyState()
    this.#jointHandles = []
    this.#jointKinds = []
    this.#jointSpecs = []
    this.#jointA = []
    this.#jointB = []
    this.#motors = []
    this.#head = 0
    this.#count = 0
    this.#events = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      for (let k = 0; k < item.joints.length; k++) {
        const j = item.joints[k]
        const where = `items/${item.id}/joints/${j.id}`
        this.#pushJoint(ctx, j, this.#itemJointBody(i, j.a, `${where}/a`), this.#itemJointBody(i, j.b, `${where}/b`))
      }
    }
    for (let k = 0; k < spec.joints.length; k++) {
      const j = spec.joints[k]
      const where = `joints/${j.id}`
      this.#pushJoint(ctx, j, this.#levelJointBody(j.a, `${where}/a`), this.#levelJointBody(j.b, `${where}/b`))
    }
    this.#mapDirty = true
  }

  unload(ctx: WorldCtx<unknown>): void {
    const world = ctx.physics.world
    for (let i = this.#jointHandles.length - 1; i >= 0; i--) {
      const joint = world.getImpulseJoint(this.#jointHandles[i])
      if (joint !== undefined && joint !== null) world.removeImpulseJoint(joint, true)
    }
    for (let i = this.#bodies.length - 1; i >= 0; i--) ctx.physics.removeBody(this.#bodies[i])
    this.#courseIndex = -1
    this.#spec = null
    this.#items = []
    this.#itemStart = []
    this.#bodies = []
    this.#bodyItems = []
    this.#bodyLocals = []
    this.#jointHandles = []
    this.#jointKinds = []
    this.#jointSpecs = []
    this.#jointA = []
    this.#jointB = []
    this.#motors = []
    this.#initBodyState()
    this.#colliderMap.clear()
    this.#mapDirty = true
  }

  #pushJoint(ctx: WorldCtx<unknown>, j: JointSpec, a: BodyId | null, b: BodyId | null): void {
    const handle = createJoint(ctx, j, a, b)
    this.#jointHandles.push(handle)
    this.#jointKinds.push(j.kind)
    this.#jointSpecs.push(copyJoint(j))
    this.#jointA.push(a)
    this.#jointB.push(b)
    this.#motors.push(j.motor === null ? null : { ...j.motor })
    if (j.motor !== null) applyMotor(ctx, handle, j.kind, j.motor)
  }

  #initBodyState(): void {
    const n = this.#bodies.length
    this.#kinTarget = []
    this.#kinPending = []
    this.#loads = []
    this.#loadApplied = []
    this.#prevSpeed = []
    for (let i = 0; i < n; i++) {
      this.#kinTarget.push(newPose())
      this.#kinPending.push(false)
      this.#loads.push([])
      this.#prevSpeed.push(0)
    }
    this.#speedDirty = true
  }
  spec(): MechanismSpec | null {
    return this.#spec
  }

  bodyId(ref: BodyRef): BodyId {
    return this.#bodies[this.#flat(ref, 'bodyId')]
  }

  bodyOfCollider(ctx: WorldCtx<unknown>, colliderHandle: number): BodyRef | null {
    if (this.#mapDirty) {
      const map = this.#colliderMap
      map.clear()
      for (let i = 0; i < this.#bodies.length; i++) {
        const rb = ctx.physics.body(this.#bodies[i])
        const n = rb.numColliders()
        for (let k = 0; k < n; k++) map.set(rb.collider(k).handle, i)
      }
      this.#mapDirty = false
    }
    const flat = this.#colliderMap.get(colliderHandle)
    if (flat === undefined) return null
    return { item: this.#bodyItems[flat], body: this.#bodyLocals[flat] }
  }

  bodyPose(ctx: WorldCtx<unknown>, ref: BodyRef, out: Pose): boolean {
    if (this.#courseIndex < 0) return false
    const items = this.#items
    if (!Number.isInteger(ref.item) || ref.item < 0 || ref.item >= items.length) return false
    const bodies = items[ref.item].bodies
    if (!Number.isInteger(ref.body) || ref.body < 0 || ref.body >= bodies.length) return false
    const rb = ctx.physics.body(this.#bodies[this.#itemStart[ref.item] + ref.body])
    const t = rb.translation()
    const r = rb.rotation()
    out.t.x = t.x
    out.t.y = t.y
    out.t.z = t.z
    out.r.x = r.x
    out.r.y = r.y
    out.r.z = r.z
    out.r.w = r.w
    return true
  }

  // Velocity of a world point carried by the body: linvel + angvel x (p - body origin).
  pointVelocity(ctx: WorldCtx<unknown>, ref: BodyRef, p: Vec3, out: Vec3): Vec3 {
    const rb = ctx.physics.body(this.#bodies[this.#flat(ref, 'pointVelocity')])
    const t = rb.translation()
    const v = rb.linvel()
    const w = rb.angvel()
    scratchArm.x = p.x - t.x
    scratchArm.y = p.y - t.y
    scratchArm.z = p.z - t.z
    cross3(w, scratchArm, scratchCross)
    out.x = v.x + scratchCross.x
    out.y = v.y + scratchCross.y
    out.z = v.z + scratchCross.z
    return out
  }

  // Relative rotation of the two joint frames about the hinge's free X axis.
  jointAngle(ctx: WorldCtx<unknown>, joint: number): number {
    const slot = this.#jointSlot(joint, 'jointAngle')
    if (this.#jointKinds[slot] !== 'hinge') {
      refuse('mechanisms', `jointAngle(${joint})`, `joint '${this.#jointSpecs[slot].id}' is a ${this.#jointKinds[slot]}, not a hinge`)
    }
    const j = this.#impulseJoint(ctx, slot)
    readQuat(j.body1().rotation(), scratchQA)
    readQuat(j.body2().rotation(), scratchQB)
    quatMul(scratchQA, j.frameX1(), scratchQA)
    quatMul(scratchQB, j.frameX2(), scratchQB)
    quatConj(scratchQA, scratchQA)
    quatMul(scratchQA, scratchQB, scratchQR)
    return 2 * datan2(scratchQR.x, scratchQR.w)
  }

  // Translation of body b's anchor along the slider axis, away from body a's anchor.
  jointTravel(ctx: WorldCtx<unknown>, joint: number): number {
    const slot = this.#jointSlot(joint, 'jointTravel')
    if (this.#jointKinds[slot] !== 'slider') {
      refuse('mechanisms', `jointTravel(${joint})`, `joint '${this.#jointSpecs[slot].id}' is a ${this.#jointKinds[slot]}, not a slider`)
    }
    const spec = this.#jointSpecs[slot]
    const j = this.#impulseJoint(ctx, slot)
    const rbA = j.body1()
    const rbB = j.body2()
    const tA = rbA.translation()
    const tB = rbB.translation()
    quatRotate(rbA.rotation(), spec.anchorA, scratchPointA)
    add3(scratchPointA, tA, scratchPointA)
    quatRotate(rbB.rotation(), spec.anchorB, scratchPointB)
    add3(scratchPointB, tB, scratchPointB)
    sub3(scratchPointB, scratchPointA, scratchPointB)
    normalize3(spec.axis, scratchAxis)
    quatRotate(rbA.rotation(), scratchAxis, scratchAxis)
    return dot3(scratchPointB, scratchAxis)
  }

  addLoad(ref: BodyRef, point: Vec3, mass: number): void {
    if (!finiteVec(point) || !Number.isFinite(mass) || mass < 0) {
      refuse('mechanisms', `addLoad(${ref.item}, ${ref.body})`, 'non-finite point or mass, or a negative mass; pass finite numbers with mass >= 0')
    }
    this.#loads[this.#flat(ref, 'addLoad')].push(point.x, point.y, point.z, mass)
  }

  loadKg(ref: BodyRef): number {
    const loads = this.#loads[this.#flat(ref, 'loadKg')]
    let kg = 0
    for (let k = 3; k < loads.length; k += 4) kg += loads[k]
    return kg
  }

  setMotor(ctx: WorldCtx<unknown>, joint: number, m: MotorSpec | null): void {
    const slot = this.#jointSlot(joint, 'setMotor')
    applyMotor(ctx, this.#jointHandles[slot], this.#jointKinds[slot], m)
    this.#motors[slot] = m === null ? null : { ...m }
  }

  setSpringStiffness(ctx: WorldCtx<unknown>, joint: number, stiffness: number): void {
    if (!Number.isFinite(stiffness) || stiffness < 0) {
      refuse('mechanisms', `setSpringStiffness(${joint})`, `stiffness ${stiffness} is not a non-negative finite number; pass stiffness >= 0`)
    }
    const slot = this.#jointSlot(joint, 'setSpringStiffness')
    const spec = this.#jointSpecs[slot]
    if (spec.kind !== 'spring') {
      refuse('mechanisms', `setSpringStiffness(${joint})`, `joint '${spec.id}' is a ${spec.kind}, not a spring`)
    }
    // Rapier 0.21 has no spring-stiffness setter: rebuild the joint with the new stiffness.
    const world = ctx.physics.world
    const old = this.#impulseJoint(ctx, slot)
    world.removeImpulseJoint(old, true)
    spec.stiffness = stiffness
    this.#jointHandles[slot] = createJoint(ctx, spec, this.#jointA[slot], this.#jointB[slot])
  }

  setKinematicTarget(ref: BodyRef, pose: Pose): void {
    const flat = this.#flat(ref, 'setKinematicTarget')
    const item = this.#bodyItems[flat]
    const local = this.#bodyLocals[flat]
    if (this.#items[item].bodies[local].type !== 'kinematic') {
      refuse('mechanisms', `setKinematicTarget(${ref.item}, ${ref.body})`, `body '${this.#items[item].bodies[local].id}' is not kinematic; only kinematic bodies take targets`)
    }
    if (!finitePose(pose)) {
      refuse('mechanisms', `setKinematicTarget(${ref.item}, ${ref.body})`, 'non-finite target pose; pass finite numbers')
    }
    const target = this.#kinTarget[flat]
    target.t.x = pose.t.x
    target.t.y = pose.t.y
    target.t.z = pose.t.z
    target.r.x = pose.r.x
    target.r.y = pose.r.y
    target.r.z = pose.r.z
    target.r.w = pose.r.w
    this.#kinPending[flat] = true
  }
  preStep(ctx: WorldCtx<unknown>, _inputs: readonly unknown[]): void {
    if (this.#courseIndex < 0) return
    this.#captureSpeeds(ctx)
    const n = this.#bodies.length
    for (let i = 0; i < n; i++) {
      const loads = this.#loads[i]
      if (loads.length === 0) continue
      const rb = ctx.physics.body(this.#bodies[i])
      if (!rb.isDynamic()) continue
      for (let k = 0; k < loads.length; k += 4) {
        const mass = loads[k + 3]
        rb.addForceAtPoint(
          { x: 0, y: mass * GRAVITY_Y, z: 0 },
          { x: loads[k], y: loads[k + 1], z: loads[k + 2] },
          true,
        )
      }
      this.#loadApplied.push(i)
    }
    for (let i = 0; i < n; i++) {
      if (!this.#kinPending[i]) continue
      this.#kinPending[i] = false
      const rb = ctx.physics.body(this.#bodies[i])
      if (!rb.isKinematic()) continue
      const p = this.#kinTarget[i]
      rb.setNextKinematicTranslation({ x: p.t.x, y: p.t.y, z: p.t.z })
      rb.setNextKinematicRotation({ x: p.r.x, y: p.r.y, z: p.r.z, w: p.r.w })
    }
  }

  postStep(ctx: WorldCtx<unknown>): void {
    if (this.#courseIndex < 0) return
    const applied = this.#loadApplied
    for (let k = 0; k < applied.length; k++) {
      // addForces persist across steps in Rapier; a load lasts exactly this one tick.
      const rb = ctx.physics.body(this.#bodies[applied[k]])
      rb.resetForces(true)
      rb.resetTorques(true)
    }
    applied.length = 0
    for (let i = 0; i < this.#loads.length; i++) this.#loads[i].length = 0
    const n = this.#bodies.length
    for (let i = 0; i < n; i++) {
      const rb = ctx.physics.body(this.#bodies[i])
      if (!rb.isDynamic()) {
        this.#prevSpeed[i] = 0
        continue
      }
      const v = rb.linvel()
      const speed = dhypot3(v.x, v.y, v.z)
      const drop = this.#prevSpeed[i] - speed
      if (drop > IMPACT_DROP) {
        const t = rb.translation()
        this.emit({
          tick: ctx.tick,
          kind: 'impact',
          source: this.#bodyItems[i],
          x: t.x,
          y: t.y,
          z: t.z,
          strength: Math.min(1, drop / IMPACT_FULL),
        })
      }
      this.#prevSpeed[i] = speed
    }
  }

  emit(ev: MechEvent): void {
    const ring = this.#events
    let index: number
    if (this.#count < MECH_EVENT_RING) {
      index = (this.#head + this.#count) % MECH_EVENT_RING
      this.#count++
    } else {
      index = this.#head
      this.#head = (this.#head + 1) % MECH_EVENT_RING
    }
    let slot = ring[index]
    if (slot === undefined) {
      slot = blankEvent()
      ring[index] = slot
    }
    slot.tick = ev.tick
    slot.kind = ev.kind
    slot.source = ev.source
    slot.x = ev.x
    slot.y = ev.y
    slot.z = ev.z
    slot.strength = ev.strength
  }

  // Oldest first, tick >= fromTick; copies into out[0..n-1] and returns n.
  events(fromTick: number, out: MechEvent[]): number {
    let n = 0
    for (let k = 0; k < this.#count; k++) {
      const ev = this.#events[(this.#head + k) % MECH_EVENT_RING]
      if (ev === undefined || ev.tick < fromTick) continue
      let slot = out[n]
      if (slot === undefined) {
        slot = blankEvent()
        out[n] = slot
      }
      slot.tick = ev.tick
      slot.kind = ev.kind
      slot.source = ev.source
      slot.x = ev.x
      slot.y = ev.y
      slot.z = ev.z
      slot.strength = ev.strength
      n++
    }
    return n
  }

  snapshot(w: SnapWriter): void {
    w.i32(this.#courseIndex)
    const bodies = this.#bodies
    w.u32(bodies.length)
    for (let i = 0; i < bodies.length; i++) w.u32(bodies[i])
    const joints = this.#jointHandles
    w.u32(joints.length)
    for (let i = 0; i < joints.length; i++) w.u32(handleIndex(joints[i]))
    w.u32(this.#head)
    w.u32(this.#count)
    for (let k = 0; k < this.#count; k++) {
      const ev = this.#events[(this.#head + k) % MECH_EVENT_RING]
      if (ev === undefined) refuse('mechanisms', 'snapshot/events', `event ring slot ${k} is empty; restore a valid mechanisms state`)
      w.u32(ev.tick)
      w.u8(eventKindByte(ev.kind))
      w.i16(ev.source)
      w.f64(ev.x)
      w.f64(ev.y)
      w.f64(ev.z)
      w.f64(ev.strength)
    }
  }

  // Never touches Rapier: the world is replaced after the systems restore.
  restore(r: SnapReader, _ctx: WorldCtx<unknown>): void {
    const courseIndex = r.i32()
    const bodyCount = r.u32()
    const bodies: BodyId[] = []
    for (let i = 0; i < bodyCount; i++) bodies.push(r.u32())
    const jointCount = r.u32()
    const handles: number[] = []
    for (let i = 0; i < jointCount; i++) handles.push(r.u32())
    const head = r.u32()
    const count = r.u32()
    if (head >= MECH_EVENT_RING) {
      refuse('mechanisms', 'snapshot/events', `ring head ${head} out of range 0..${MECH_EVENT_RING - 1}; restore a mechanisms snapshot`)
    }
    if (count > MECH_EVENT_RING) {
      refuse('mechanisms', 'snapshot/events', `${count} events, at most ${MECH_EVENT_RING}; restore a mechanisms snapshot`)
    }
    const events: MechEvent[] = []
    for (let k = 0; k < count; k++) {
      const tick = r.u32()
      const kind = eventKindAt(r.u8())
      const source = r.i16()
      const x = r.f64()
      const y = r.f64()
      const z = r.f64()
      const strength = r.f64()
      events.push({ tick, kind, source, x, y, z, strength })
    }
    let spec: MechanismSpec | null = null
    let items: readonly MechItem[] = []
    const itemStart: number[] = []
    const bodyItems: number[] = []
    const bodyLocals: number[] = []
    if (courseIndex === -1) {
      if (bodyCount !== 0 || jointCount !== 0) {
        refuse('mechanisms', 'snapshot/bodies', `no course loaded but the snapshot has ${bodyCount} bodies and ${jointCount} joints; restore a mechanisms snapshot`)
      }
    } else {
      if (courseIndex < -1 || courseIndex >= this.courses.length) {
        refuse('mechanisms', 'snapshot/courseIndex', `course ${courseIndex} out of range 0..${this.courses.length - 1}; restore with the same course list`)
      }
      spec = this.courses[courseIndex].mechanisms ?? emptyMechanisms()
      items = spec.items
      for (let i = 0; i < items.length; i++) {
        itemStart.push(bodyItems.length)
        for (let b = 0; b < items[i].bodies.length; b++) {
          bodyItems.push(i)
          bodyLocals.push(b)
        }
      }
      if (bodyCount !== bodies.length) {
        refuse('mechanisms', 'snapshot/bodies', `snapshot has ${bodyCount} bodies, course has ${bodies.length}; restore with the same course list`)
      }
      let expectedJoints = spec.joints.length
      for (let i = 0; i < items.length; i++) expectedJoints += items[i].joints.length
      if (jointCount !== expectedJoints) {
        refuse('mechanisms', 'snapshot/joints', `snapshot has ${jointCount} joints, course has ${expectedJoints}; restore with the same course list`)
      }
    }
    this.#courseIndex = courseIndex
    this.#spec = spec
    this.#items = items
    this.#itemStart = itemStart
    this.#bodies = bodies
    this.#bodyItems = bodyItems
    this.#bodyLocals = bodyLocals
    this.#jointHandles = []
    for (let i = 0; i < handles.length; i++) this.#jointHandles.push(handleFromIndex(handles[i]))
    this.#jointKinds = []
    this.#jointSpecs = []
    this.#jointA = []
    this.#jointB = []
    this.#motors = []
    if (spec !== null) {
      for (let i = 0; i < items.length; i++) {
        for (let k = 0; k < items[i].joints.length; k++) {
          const j = items[i].joints[k]
          const where = `items/${items[i].id}/joints/${j.id}`
          this.#restoreJoint(j, this.#itemJointBody(i, j.a, `${where}/a`), this.#itemJointBody(i, j.b, `${where}/b`))
        }
      }
      for (let k = 0; k < spec.joints.length; k++) {
        const j = spec.joints[k]
        this.#restoreJoint(j, this.#levelJointBody(j.a, `joints/${j.id}/a`), this.#levelJointBody(j.b, `joints/${j.id}/b`))
      }
    }
    this.#initBodyState()
    this.#head = head
    this.#count = count
    this.#events = []
    for (let k = 0; k < count; k++) this.#events[(head + k) % MECH_EVENT_RING] = events[k]
    this.#mapDirty = true
  }

  #restoreJoint(j: JointSpec, a: BodyId | null, b: BodyId | null): void {
    this.#jointKinds.push(j.kind)
    this.#jointSpecs.push(copyJoint(j))
    this.#jointA.push(a)
    this.#jointB.push(b)
    this.#motors.push(j.motor === null ? null : { ...j.motor })
  }

  #flat(ref: BodyRef, what: string): number {
    const items = this.#items
    if (ref.item === -1) {
      refuse('mechanisms', `${what}(${ref.item}, ${ref.body})`, 'the world has no mechanism body; pass a loaded item body ref')
    }
    if (!Number.isInteger(ref.item) || ref.item < 0 || ref.item >= items.length) {
      refuse('mechanisms', `${what}(${ref.item}, ${ref.body})`, `item out of range 0..${items.length - 1}; pass a loaded item body ref`)
    }
    const bodies = items[ref.item].bodies
    if (!Number.isInteger(ref.body) || ref.body < 0 || ref.body >= bodies.length) {
      refuse('mechanisms', `${what}(${ref.item}, ${ref.body})`, `body out of range 0..${bodies.length - 1}; pass a loaded item body ref`)
    }
    return this.#itemStart[ref.item] + ref.body
  }

  #itemJointBody(itemIndex: number, ref: BodyRef, what: string): BodyId | null {
    if (ref.item === -1) return null
    const bodies = this.#items[itemIndex].bodies
    if (!Number.isInteger(ref.body) || ref.body < 0 || ref.body >= bodies.length) {
      refuse('mechanisms', `${what}(${ref.item}, ${ref.body})`, `body out of range 0..${bodies.length - 1}; pass a body of this item`)
    }
    return this.#bodies[this.#itemStart[itemIndex] + ref.body]
  }

  #levelJointBody(ref: BodyRef, what: string): BodyId | null {
    if (ref.item === -1) return null
    return this.#bodies[this.#flat(ref, what)]
  }

  // Accepts a flat joint index (the order load created them) or the Rapier handle
  // returned by createJoint; the converted mechanism spec refers to joints by index.
  #jointSlot(joint: number, what: string): number {
    if (!Number.isFinite(joint)) {
      refuse('mechanisms', `${what}(${joint})`, 'non-finite joint number; pass a joint index or handle')
    }
    const handles = this.#jointHandles
    for (let i = 0; i < handles.length; i++) {
      if (handles[i] === joint) return i
    }
    if (Number.isInteger(joint) && joint >= 0 && joint < handles.length) return joint
    return refuse('mechanisms', `${what}(${joint})`, `unknown joint; pass index 0..${handles.length - 1} or a handle of a loaded mechanisms joint`)
  }

  #impulseJoint(ctx: WorldCtx<unknown>, slot: number) {
    const j = ctx.physics.world.getImpulseJoint(this.#jointHandles[slot])
    if (j === undefined || j === null) {
      refuse('mechanisms', `joint(${this.#jointHandles[slot]})`, 'no such joint in the physics world; pass a loaded mechanisms joint')
    }
    return j
  }

  // The speed before this tick's forces: captured once after load/restore, then kept from postStep.
  #captureSpeeds(ctx: WorldCtx<unknown>): void {
    if (!this.#speedDirty) return
    const n = this.#bodies.length
    for (let i = 0; i < n; i++) {
      const rb = ctx.physics.body(this.#bodies[i])
      if (!rb.isDynamic()) {
        this.#prevSpeed[i] = 0
        continue
      }
      const v = rb.linvel()
      this.#prevSpeed[i] = dhypot3(v.x, v.y, v.z)
    }
    this.#speedDirty = false
  }
}
