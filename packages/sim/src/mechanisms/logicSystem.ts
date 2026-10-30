import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '../course.ts'
import { neutralInput } from '../input.ts'
import { emptyMechanisms } from '../mechanismSpec.ts'
import type { BodyRef, JointSpec, MechEventKind, MechanismSpec, MotorSpec } from '../mechanismSpec.ts'
import { ObstacleSystem } from '../obstacles/system.ts'
import { refuse } from '../refusal.ts'
import { add3, pose, quatMul } from '../vec.ts'
import type { Pose } from '../vec.ts'
import { FiestaWorld } from '../world.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { animationKind, trackPose } from './animation.ts'
import { evalLogic, newLogicState } from './logic.ts'
import type { LogicState } from './logic.ts'
import type { MechanismWorld } from './preview.ts'
import { MechanismSystem } from './system.ts'

interface LeverGrabber extends SimSystem<unknown> {
  grabbingLever?(player: number): number
}
interface Playback { running: number; dir: number; localTick: number }

function targetMotor(target: number, stiffness: number, damping: number, maxForce: number): MotorSpec {
  return { mode: 'target', speed: 0, target, stiffness, damping, maxForce, enabled: true }
}

export class MechLogicSystem implements SimSystem<unknown> {
  readonly name = 'mechLogic'
  readonly #courses: readonly ResolvedCourse[]
  #courseIndex = -1
  #loadTick = 0
  #spec: MechanismSpec | null = null
  #logic: LogicState = newLogicState(emptyMechanisms())
  #signals = new Uint8Array(0)
  #previous = new Uint8Array(0)
  #animations: (Playback | null)[] = []
  #rests: Pose[] = []
  #joints: JointSpec[] = []
  #jointBodies: BodyRef[] = []
  #press = new Uint16Array(0)
  #pending = new Uint8Array(0)
  readonly #pose = pose()

  constructor(courses: readonly ResolvedCourse[]) { this.#courses = courses }
  init(_ctx: WorldCtx<unknown>): void {}

  // Derived data comes only from the course, including during restore.
  #configure(courseIndex: number, players: number): void {
    if (!Number.isInteger(courseIndex) || courseIndex < -1 || courseIndex >= this.#courses.length) {
      refuse('mechLogic', 'courseIndex', `invalid course index ${courseIndex}`)
    }
    this.#courseIndex = courseIndex
    const m = courseIndex === -1 ? null : this.#courses[courseIndex].mechanisms ?? emptyMechanisms()
    this.#spec = m
    this.#logic = newLogicState(m ?? emptyMechanisms())
    this.#signals = new Uint8Array(m?.signals.length ?? 0)
    this.#previous = new Uint8Array(this.#signals.length)
    this.#press = new Uint16Array((m?.levers.length ?? 0) * players)
    this.#pending = new Uint8Array(this.#press.length)
    this.#animations = []
    this.#rests = []
    this.#joints = []
    this.#jointBodies = []
    if (m === null) return
    for (let i = 0; i < m.items.length; i++) {
      for (const j of m.items[i].joints) {
        this.#joints.push(j)
        const ref = j.b.item === -1 ? j.a : j.b
        this.#jointBodies.push({ item: i, body: ref.body })
      }
    }
    for (const j of m.joints) {
      this.#joints.push(j)
      this.#jointBodies.push(j.b.item === -1 ? j.a : j.b)
    }
    for (let i = 0; i < m.animations.length; i++) {
      const a = m.animations[i]
      this.#animations.push(animationKind(m, i) === 'tick' ? null : {
        running: a.autostart ? 1 : 0, dir: 1, localTick: 0,
      })
      const body = m.items[a.target.item].bodies[a.target.body]
      // S13 body rest poses already include the item's course placement.
      this.#rests.push({ t: { ...body.rest.t }, r: { ...body.rest.r } })
    }
  }

  load(ctx: WorldCtx<unknown>, courseIndex: number): void {
    if (this.#courseIndex !== -1) refuse('mechLogic', 'load', 'unload the current course first')
    if (courseIndex === -1) refuse('mechLogic', 'load', 'pass a valid course index')
    this.#configure(courseIndex, ctx.playerCount)
    this.#loadTick = ctx.tick
    const mech = ctx.system<MechanismSystem>('mechanisms')
    for (let i = 0; i < this.#animations.length; i++) {
      if (this.#animations[i]?.running) {
        this.#emit(ctx, mech, 'animStart', i, this.#spec!.animations[i].target)
      }
    }
  }

  unload(_ctx: WorldCtx<unknown>): void {
    this.#configure(-1, 0)
    this.#loadTick = 0
  }

  signal(id: string): boolean {
    const i = this.#spec?.signals.indexOf(id) ?? -1
    return i >= 0 && this.#signals[i] !== 0
  }

  signalAt(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.#signals.length) {
      refuse('mechLogic', 'signalAt', `signal index ${index} out of range`)
    }
    return this.#signals[index] !== 0
  }

  #emit(ctx: WorldCtx<unknown>, mech: MechanismSystem, kind: MechEventKind, source: number, ref: BodyRef): void {
    const p = this.#pose
    if (!mech.bodyPose(ctx, ref, p)) return
    mech.emit({ tick: ctx.tick, kind, source, x: p.t.x, y: p.t.y, z: p.t.z, strength: 1 })
  }

  preStep(ctx: WorldCtx<unknown>, _inputs: readonly unknown[]): void {
    const m = this.#spec
    if (m === null) return
    const mech = ctx.system<MechanismSystem>('mechanisms')
    this.#previous.set(this.#signals)
    for (let i = 0; i < m.switches.length; i++) {
      const s = m.switches[i]
      const weight = s.mode === 'weight'
      const x = weight ? mech.loadKg(s.plate) : mech.jointTravel(ctx, s.joint)
      const on = weight ? s.onKg : s.onM, off = weight ? s.offKg : s.offM
      this.#signals[i] = this.#signals[i] ? (x <= off ? 0 : 1) : (x >= on ? 1 : 0)
      if (this.#signals[i] !== this.#previous[i]) {
        this.#emit(ctx, mech, this.#signals[i] ? 'switchOn' : 'switchOff', i, s.plate)
      }
    }
    const characters = ctx.hasSystem('characters') ? ctx.system<LeverGrabber>('characters') : null
    for (let i = 0; i < m.levers.length; i++) {
      const lever = m.levers[i], signal = m.switches.length + i
      const angle = mech.jointAngle(ctx, lever.joint)
      this.#signals[signal] = this.#signals[signal]
        ? (angle <= lever.offAngle ? 0 : 1) : (angle >= lever.onAngle ? 1 : 0)
      const joint = this.#joints[lever.joint]
      if (this.#signals[signal] !== this.#previous[signal]) {
        this.#emit(ctx, mech, this.#signals[signal] ? 'leverOn' : 'leverOff', signal, lever.handle)
        let pending = false
        for (let p = 0; p < ctx.playerCount; p++) {
          const k = i * ctx.playerCount + p
          pending = pending || this.#pending[k] !== 0
          this.#pending[k] = 0
        }
        if (pending) mech.setMotor(ctx, lever.joint, joint.motor)
      }
      for (let p = 0; p < ctx.playerCount; p++) {
        const k = i * ctx.playerCount + p
        if (typeof characters?.grabbingLever === 'function' && characters.grabbingLever(p) === i) {
          // Saturation preserves a long hold without wrapping into a short press.
          this.#press[k] = Math.min(12, this.#press[k] + 1)
        } else {
          if (this.#press[k] > 0 && this.#press[k] < 12) {
            const on = this.#signals[signal] === 0
            const target = joint.limits !== null ? joint.limits[on ? 1 : 0]
              : on ? 2 * lever.onAngle - lever.offAngle : 2 * lever.offAngle - lever.onAngle
            mech.setMotor(ctx, lever.joint, targetMotor(target, 4000, 400, 2000))
            this.#pending[k] = 1
          }
          this.#press[k] = 0
        }
      }
    }
    evalLogic(m, this.#signals, this.#logic)
    this.#signals.set(this.#logic.value, m.switches.length + m.levers.length)
    for (const link of m.links) {
      const on = this.#signals[link.from] !== 0
      if (this.#signals[link.from] === this.#previous[link.from]) continue
      const to = link.to
      switch (to.kind) {
        case 'motor':
          mech.setMotor(ctx, to.joint, on ? to.on : to.off)
          this.#emit(ctx, mech, on ? 'motorStart' : 'motorStop', to.joint, this.#jointBodies[to.joint])
          break
        case 'door': {
          const motor = this.#joints[to.joint].motor
          mech.setMotor(ctx, to.joint, targetMotor(on ? to.openAngle : to.closedAngle,
            motor?.stiffness ?? 2000, motor?.damping ?? 200, motor?.maxForce ?? 5000))
          break
        }
        case 'spring':
          mech.setSpringStiffness(ctx, to.joint, on ? to.stiffnessOn : to.stiffnessOff)
          break
        case 'animation': {
          const state = this.#animations[to.animation]!
          if (on) {
            state.running = 1
            state.dir = to.on === 'play' ? 1 : -1
            this.#emit(ctx, mech, 'animStart', to.animation, m.animations[to.animation].target)
          } else if (to.off === 'reverse') {
            state.running = 1
            state.dir = -state.dir
          } else {
            state.running = 0
            if (to.off === 'stop') state.localTick = 0
          }
          break
        }
      }
    }
    for (let i = 0; i < m.animations.length; i++) {
      const a = m.animations[i], state = this.#animations[i]
      let tick = ctx.tick + 1 - this.#loadTick
      let ended = false
      if (state !== null) {
        if (!state.running) continue
        const length = a.keys[a.keys.length - 1].tick
        tick = state.localTick + state.dir
        if (a.loop === 'once') {
          ended = state.dir > 0 ? tick >= length : tick <= 0
          tick = Math.max(0, Math.min(length, tick))
        } else {
          const period = a.loop === 'loop' ? length : 2 * length
          tick = period === 0 ? 0 : ((tick % period) + period) % period
        }
        state.localTick = tick
        if (ended) state.running = 0
      }
      const out = trackPose(a, tick, this.#pose), rest = this.#rests[i]
      add3(rest.t, out.t, out.t)
      quatMul(out.r, rest.r, out.r)
      mech.setKinematicTarget(a.target, out)
      if (ended) this.#emit(ctx, mech, 'animEnd', i, a.target)
    }
  }

  postStep(_ctx: WorldCtx<unknown>): void {}

  snapshot(w: SnapWriter): void {
    w.i32(this.#courseIndex)
    w.u32(this.#loadTick)
    w.u32(this.#signals.length)
    for (const signal of this.#signals) w.u8(signal)
    const s = this.#logic
    for (let i = 0; i < s.value.length; i++) {
      w.u8(s.value[i])
      w.i32(s.timer[i])
      w.i32(s.count[i])
      w.u8(s.prev[i])
    }
    for (const byte of s.ring) w.u8(byte)
    for (const state of this.#animations) {
      if (state === null) continue
      w.u8(state.running)
      w.u8(state.dir === -1 ? 0 : 1)
      w.u32(state.localTick)
    }
    for (let i = 0; i < this.#press.length; i++) {
      w.u16(this.#press[i])
      w.u8(this.#pending[i])
    }
  }

  restore(r: SnapReader, ctx: WorldCtx<unknown>): void {
    this.#configure(r.i32(), ctx.playerCount)
    this.#loadTick = r.u32()
    const n = r.u32()
    if (n !== this.#signals.length) refuse('mechLogic', 'snapshot/signals', 'signal count does not match the course')
    for (let i = 0; i < n; i++) this.#signals[i] = r.u8()
    const s = this.#logic
    for (let i = 0; i < s.value.length; i++) {
      s.value[i] = r.u8()
      s.timer[i] = r.i32()
      s.count[i] = r.i32()
      s.prev[i] = r.u8()
    }
    for (let i = 0; i < s.ring.length; i++) s.ring[i] = r.u8()
    for (const state of this.#animations) {
      if (state === null) continue
      state.running = r.u8()
      state.dir = r.u8() === 0 ? -1 : 1
      state.localTick = r.u32()
    }
    for (let i = 0; i < this.#press.length; i++) {
      this.#press[i] = r.u16()
      this.#pending[i] = r.u8()
    }
  }
}

export function withLogic(R: RapierModule, course: ResolvedCourse): MechanismWorld {
  const courses = [course]
  const obstacles = new ObstacleSystem(courses)
  const logic = new MechLogicSystem(courses)
  const mechanisms = new MechanismSystem(courses)
  const world = new FiestaWorld<unknown>(R, {
    playerCount: 1, systems: [obstacles, logic, mechanisms],
  })
  obstacles.load(world.ctx, 0)
  mechanisms.load(world.ctx, 0)
  logic.load(world.ctx, 0)
  const start = world.takeSnapshotBytes()
  const inputs = [neutralInput()]
  return {
    world,
    get tick() { return world.tick },
    step(): void { world.step(inputs) },
    reset(): void { world.restoreSnapshotBytes(start) },
    free(): void { world.free() },
    mechanismEvents(fromTick, out) { return mechanisms.events(fromTick, out) },
    mechanismBodyPose(ref, out) { return mechanisms.bodyPose(world.ctx, ref, out) },
    signal(id) { return logic.signal(id) },
  }
}
