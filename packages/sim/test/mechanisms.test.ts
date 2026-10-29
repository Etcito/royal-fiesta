import assert from 'node:assert/strict'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '../src/course.ts'
import { emptyMechanisms } from '../src/mechanismSpec.ts'
import type { BodySpec, JointSpec, MechEvent, MotorSpec } from '../src/mechanismSpec.ts'
import { createMechanismWorld } from '../src/mechanisms/preview.ts'
import { MechanismSystem } from '../src/mechanisms/system.ts'
import { pose, quatRotate } from '../src/vec.ts'

// initRapier uses the wrapper's deterministic-compat build, as in obstacles.test.ts.
const R = await initRapier()
const O = { x: 0, y: 0, z: 0 }
const I = { x: 0, y: 0, z: 0, w: 1 }
const ref = { item: 0, body: 0 }
const radians = (degrees: number) => degrees * Math.PI / 180
function body(overrides: Partial<BodySpec> = {}): BodySpec {
  return { id: 'plank', type: 'dynamic', rest: pose(), density: 100,
    colliders: [{ shape: 'cuboid', half: { x: 2, y: 0.1, z: 0.25 }, t: O, r: I }],
    friction: 0.5, restitution: 0, linearDamping: 0, angularDamping: 0.1,
    gravityScale: 1, ccd: true, surface: 'normal', ...overrides }
}
function joint(overrides: Partial<JointSpec> = {}): JointSpec {
  return { id: 'joint', kind: 'hinge', a: { item: -1, body: 0 }, b: ref,
    anchorA: O, anchorB: O, axis: { x: 0, y: 0, z: 1 }, limits: null,
    stiffness: 0, damping: 0, length: 0, motor: null, ...overrides }
}
function motor(maxForce: number): MotorSpec {
  return { mode: 'target', speed: 0, target: 1, stiffness: 100000, damping: 1000, maxForce, enabled: true }
}
function fixture(bodies: BodySpec[], joints: JointSpec[]) {
  const course: ResolvedCourse = {
    id: 'mechanism-lab', name: 'Mechanism lab', kind: 'gallery', profiles: ['standard'],
    timeLimitS: 60, killPlaneY: -100, spawns: [], checkpoints: [], finish: null,
    path: [], regions: [], queuePad: null, obstacles: [], contentHash: 0,
    mechanisms: { ...emptyMechanisms(), items: [{ id: 'lab', asset: 'lab', t: O, r: I,
      s: { x: 1, y: 1, z: 1 }, bodies, joints: [] }], joints },
  }
  const preview = createMechanismWorld(R, course)
  const sys = preview.world.ctx.system<MechanismSystem>('mechanisms')
  return { preview, sys, ctx: preview.world.ctx,
    rb: (index = 0) => preview.world.physics.body(sys.bodyId({ item: 0, body: index })) }
}

test('QB10: a 50 kg load tips the hinged plank toward the load within 60 ticks', () => {
  const f = fixture([body()], [joint({ limits: [-Math.PI / 4, Math.PI / 4] })])
  try {
    for (let i = 0; i < 60; i++) {
      const p = pose()
      assert.ok(f.preview.mechanismBodyPose(ref, p))
      const arm = quatRotate(p.r, { x: 1.5, y: 0, z: 0 }, { ...O })
      f.sys.addLoad(ref, { x: p.t.x + arm.x, y: p.t.y + arm.y, z: p.t.z + arm.z }, 50)
      f.preview.step()
    }
    assert.ok(f.sys.jointAngle(f.ctx, 0) < -0.05, 'positive-X end must tip down')
  } finally { f.preview.free() }
})

test('QB10: hinge stays within ±20° plus 0.5° under a strong load', () => {
  for (const direction of [-1, 1]) {
    const f = fixture([body()], [joint({ limits: [-radians(20), radians(20)] })])
    try {
      for (let i = 0; i < 120; i++) {
        f.sys.addLoad(ref, { x: direction * 1.5, y: 0, z: 0 }, 200)
        f.preview.step()
        assert.ok(Math.abs(f.sys.jointAngle(f.ctx, 0)) <= radians(20.5), `tick ${i}`)
      }
      assert.ok(Math.abs(f.sys.jointAngle(f.ctx, 0)) > radians(19), 'load reaches the limit')
    } finally { f.preview.free() }
  }
})

test('QB10: target motor reaches its target only with enough maxForce against gravity', () => {
  for (const maxForce of [100000, 0.001]) {
    const f = fixture([body()], [joint({ kind: 'slider', axis: { x: 0, y: 1, z: 0 }, motor: motor(maxForce) })])
    try {
      for (let i = 0; i < 120; i++) f.preview.step()
      const travel = f.sys.jointTravel(f.ctx, 0)
      if (maxForce > 1) assert.ok(Math.abs(travel - 1) < 0.02, `travel ${travel}`)
      else assert.ok(travel < 0.5, `weak motor travel ${travel}`)
    } finally { f.preview.free() }
  }
})

test('motor disable wakes a sleeping body and survives restore without driving again', () => {
  for (const off of [null, { ...motor(100000), enabled: false }]) {
    const f = fixture([body()], [joint({ kind: 'slider', axis: { x: 0, y: 1, z: 0 }, motor: motor(100000) })])
    try {
      for (let i = 0; i < 120; i++) f.preview.step()
      const raised = f.sys.jointTravel(f.ctx, 0)
      assert.ok(raised > 0.9)
      f.rb().sleep()
      assert.ok(f.rb().isSleeping())
      f.sys.setMotor(f.ctx, 0, off)
      assert.equal(f.rb().isSleeping(), false, 'motor change wakes the body')
      const released = f.preview.world.takeSnapshotBytes()
      for (let i = 0; i < 60; i++) f.preview.step()
      const fallen = f.sys.jointTravel(f.ctx, 0)
      assert.ok(fallen < raised - 1, 'released body falls under gravity')
      f.sys.setMotor(f.ctx, 0, motor(100000))
      f.preview.step()
      f.preview.world.restoreSnapshotBytes(released)
      for (let i = 0; i < 60; i++) f.preview.step()
      assert.equal(f.sys.jointTravel(f.ctx, 0), fallen, 'restore keeps the motor disabled')
    } finally { f.preview.free() }
  }
})

test('QB10: a displaced spring settles within 2 cm of its rest anchor distance in 240 ticks', () => {
  const f = fixture([body({ gravityScale: 0, rest: { t: { x: 0, y: -2, z: 0 }, r: I } })],
    [joint({ kind: 'spring', length: 2, stiffness: 1000, damping: 300 })])
  try {
    f.rb().setTranslation({ x: 0, y: -3, z: 0 }, true)
    for (let i = 0; i < 240; i++) f.preview.step()
    const p = f.rb().translation()
    assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - 2) < 0.02)
    assert.ok(f.rb().linvel().y < 0.02 && f.rb().linvel().y > -0.02, 'settled, not merely crossing rest')
  } finally { f.preview.free() }
})

test('QB10: a falling rope body never exceeds length plus 1 cm', () => {
  const f = fixture([body({ rest: { t: { x: 0, y: -1, z: 0 }, r: I } })], [joint({ kind: 'rope', length: 2 })])
  try {
    for (let i = 0; i < 240; i++) {
      f.preview.step()
      const p = f.rb().translation()
      assert.ok(Math.hypot(p.x, p.y, p.z) <= 2.01, `tick ${i}`)
    }
    assert.ok(f.rb().translation().y < -1.9, 'rope becomes taut')
  } finally { f.preview.free() }
})

test('QB10: a dynamic box landing emits an impact event', () => {
  const f = fixture([
    body({ rest: { t: { x: 0, y: 4, z: 0 }, r: I } }),
    body({ id: 'floor', type: 'fixed', rest: { t: { x: 0, y: -0.2, z: 0 }, r: I } }),
  ], [])
  try {
    for (let i = 0; i < 90; i++) f.preview.step()
    const events: MechEvent[] = []
    assert.ok(f.preview.mechanismEvents(0, events) > 0)
    const impact = events.find(e => e.kind === 'impact')
    assert.ok(impact)
    assert.equal(impact.source, 0)
    assert.ok(impact.tick > 0 && impact.tick < 90)
    assert.ok(impact.strength > 0 && impact.strength <= 1)
    assert.ok(Math.abs(impact.y) < 0.5, 'impact is at the landing')
  } finally { f.preview.free() }
})

test('QB1: independent 300-tick runs and tick-120 restore/resimulation have equal snapshot bytes', () => {
  const make = () => fixture([
    body(),
    body({ id: 'kinematic', type: 'kinematic', rest: { t: { x: 10, y: 2, z: 0 }, r: I } }),
    body({ id: 'spring', gravityScale: 0, rest: { t: { x: 20, y: -2, z: 0 }, r: I } }),
  ], [joint({ limits: [-0.35, 0.35] }), joint({ id: 'spring', kind: 'spring',
    b: { item: 0, body: 2 }, anchorA: { x: 20, y: 0, z: 0 }, length: 2, stiffness: 1000, damping: 300 })])
  const a = make(), b = make(), restored = make()
  const prepare = (f: ReturnType<typeof make>) => {
    const tick = f.preview.tick
    f.sys.addLoad(ref, { x: tick % 60 < 30 ? 1 : -1, y: 0, z: 0 }, 50)
    f.sys.setKinematicTarget({ item: 0, body: 1 }, { t: { x: 10, y: 2 + (tick % 60) / 60, z: 0 }, r: I })
    if (tick === 90) {
      f.sys.setMotor(f.ctx, 0, { ...motor(10000), target: 0.1 })
      f.sys.setSpringStiffness(f.ctx, 1, 2000)
    }
    // Wrap the event ring before the checkpoint, including a pending event.
    f.sys.emit({ tick, kind: 'switchOn', source: 0, x: tick / 60, y: 2, z: 3, strength: 0.5 })
  }
  try {
    for (let tick = 0; tick < 300; tick++) {
      prepare(a); prepare(b)
      if (tick === 120) {
        const checkpoint = a.preview.world.takeSnapshotBytes()
        restored.preview.world.restoreSnapshotBytes(checkpoint)
        assert.equal(restored.preview.tick, 120)
        assert.equal(restored.sys.loadKg(ref), 50)
        assert.deepEqual(restored.preview.world.takeSnapshotBytes(), checkpoint)
      } else if (tick > 120) prepare(restored)
      a.preview.step(); b.preview.step()
      if (tick >= 120) restored.preview.step()
    }
    assert.equal(a.preview.tick, 300)
    assert.deepEqual(b.preview.world.takeSnapshotBytes(), a.preview.world.takeSnapshotBytes())
    assert.deepEqual(restored.preview.world.takeSnapshotBytes(), a.preview.world.takeSnapshotBytes())
  } finally { a.preview.free(); b.preview.free(); restored.preview.free() }
})
