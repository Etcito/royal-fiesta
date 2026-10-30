import assert from 'node:assert/strict'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '../src/course.ts'
import { emptyMechanisms } from '../src/mechanismSpec.ts'
import type { BodySpec, JointSpec, MechItem, MotorSpec } from '../src/mechanismSpec.ts'
import { createMechanismWorld } from '../src/mechanisms/preview.ts'
import { MechanismSystem } from '../src/mechanisms/system.ts'
import { add3, pose, quatMul, quatRotate } from '../src/vec.ts'

const R = await initRapier()
const O = { x: 0, y: 0, z: 0 }
const I = { x: 0, y: 0, z: 0, w: 1 }
const ref = { item: 0, body: 0 }
function body(id = 'box', overrides: Partial<BodySpec> = {}): BodySpec {
  return { id, type: 'dynamic', rest: pose(), density: 400,
    colliders: [{ shape: 'cuboid', half: { x: 0.5, y: 0.5, z: 0.5 }, t: O, r: I }],
    friction: 0.5, restitution: 0, linearDamping: 0, angularDamping: 0,
    gravityScale: 1, ccd: false, surface: 'normal', ...overrides }
}
function joint(overrides: Partial<JointSpec> = {}): JointSpec {
  return { id: 'pivot', kind: 'hinge', a: { item: -1, body: 0 }, b: ref,
    anchorA: O, anchorB: O, axis: { x: 0, y: 0, z: 1 }, limits: null,
    stiffness: 0, damping: 0, length: 0, motor: null, ...overrides }
}
// Hand-built converted sim item: degree-valued authoring input crosses the boundary here.
// No JSON loader is involved in this physics checklist.
function itemOf(bodies: BodySpec[], limitDeg?: number): MechItem {
  return { id: 'item', asset: 'test', t: O, r: I, s: { x: 1, y: 1, z: 1 }, bodies,
    joints: limitDeg === undefined ? [] : [joint({ limits: [-limitDeg * Math.PI / 180, limitDeg * Math.PI / 180] })] }
}
function make(item = itemOf([body()]), joints: JointSpec[] = []) {
  const course: ResolvedCourse = {
    id: 'l12', name: 'L12', kind: 'gallery', profiles: ['standard'], timeLimitS: 60,
    killPlaneY: -100, spawns: [], checkpoints: [], finish: null, path: [], regions: [],
    queuePad: null, contentHash: 0, obstacles: [],
    mechanisms: { ...emptyMechanisms(), items: [item], joints },
  }
  const preview = createMechanismWorld(R, course)
  const ctx = preview.world.ctx
  const sys = ctx.system<MechanismSystem>('mechanisms')
  return { preview, ctx, sys, rb: (index = 0) => ctx.physics.body(sys.bodyId({ item: 0, body: index })) }
}
function run(f: ReturnType<typeof make>, ticks: number) {
  for (let i = 0; i < ticks; i++) f.preview.step()
}
const drive: MotorSpec = { mode: 'target', speed: 0, target: 1, stiffness: 100000,
  damping: 1000, maxForce: 1000000, enabled: true }
function lift(m: MotorSpec) {
  return make(itemOf([body()]), [joint({ kind: 'slider', axis: { x: 0, y: 1, z: 0 }, motor: m })])
}

test('L12: degrees are not passed as radians (20° through itemOf)', () => {
  const f = make(itemOf([body()], 20))
  try {
    assert.deepEqual(f.sys.spec()!.items[0].joints[0].limits, [-Math.PI / 9, Math.PI / 9])
    for (let i = 0; i < 100; i++) {
      f.sys.addLoad(ref, { x: 0.5, y: 0, z: 0 }, 100)
      f.preview.step()
      assert.ok(Math.abs(f.sys.jointAngle(f.ctx, 0)) <= 20.5 * Math.PI / 180)
    }
    assert.ok(Math.abs(f.sys.jointAngle(f.ctx, 0)) > 19 * Math.PI / 180)
  } finally { f.preview.free() }
})

test('L12: motor maxForce is applied', () => {
  const strong = lift(drive), weak = lift({ ...drive, maxForce: 0.001 })
  try {
    run(strong, 120); run(weak, 120)
    assert.ok(Math.abs(strong.sys.jointTravel(strong.ctx, 0) - 1) < 0.1)
    assert.ok(weak.sys.jointTravel(weak.ctx, 0) < 0, 'tiny force cannot lift 400 kg')
  } finally { strong.preview.free(); weak.preview.free() }
})

test('L12: setting motor enabled false stops driving', () => {
  const f = lift(drive)
  try {
    run(f, 120)
    const raised = f.sys.jointTravel(f.ctx, 0)
    assert.ok(raised > 0.9)
    f.sys.setMotor(f.ctx, 0, { ...drive, enabled: false })
    run(f, 60)
    assert.ok(f.sys.jointTravel(f.ctx, 0) < raised - 1, 'disabled motor releases the body to gravity')
  } finally { f.preview.free() }
})

test('L12: a kinematic body remains kinematic after 100 ticks', () => {
  const f = make(itemOf([body('kinematic', { type: 'kinematic' })]))
  try {
    for (let i = 0; i < 100; i++) {
      f.sys.setKinematicTarget(ref, { t: { x: i / 10, y: 2, z: 0 }, r: I })
      f.preview.step()
      assert.equal(f.rb().bodyType(), R.RigidBodyType.KinematicPositionBased)
    }
    assert.ok(Math.abs(f.rb().translation().x - 9.9) < 1e-5)
    assert.equal(f.rb().translation().y, 2)
  } finally { f.preview.free() }
})

test('L12: density 400 times a 1 m³ cuboid gives mass 400 kg', () => {
  const f = make()
  try {
    f.preview.step() // Rapier updates mass properties on the first step.
    assert.equal(f.rb().mass(), 400)
    assert.equal(f.rb().collider(0).density(), 400)
  } finally { f.preview.free() }
})

test('L12: rotating an item 90° rotates its body positions', () => {
  const item = itemOf([body('a', { rest: { t: { x: 2, y: 0, z: 0 }, r: I } }),
    body('b', { rest: { t: { x: 0, y: 0, z: 3 }, r: I } })])
  item.t = { x: 10, y: 5, z: 20 }
  item.r = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
  // Match the loader boundary: converted body rest poses are in course space.
  for (const b of item.bodies) {
    b.rest = {
      t: add3(item.t, quatRotate(item.r, b.rest.t, { ...O }), { ...O }),
      r: quatMul(item.r, b.rest.r, { ...I }),
    }
  }
  const f = make(item)
  try {
    for (const [index, expected] of [[0, [10, 5, 18]], [1, [13, 5, 20]]] as const) {
      const p = f.rb(index).translation()
      for (const [got, want] of [[p.x, expected[0]], [p.y, expected[1]], [p.z, expected[2]]]) {
        assert.ok(Math.abs(got - want) < 1e-5, `${got} vs ${want}`)
      }
    }
  } finally { f.preview.free() }
})

test('L12: welded bodies have contacts disabled', () => {
  const f = make(itemOf([body('a', { type: 'fixed' }), body('b')]),
    [joint({ kind: 'fixed', a: ref, b: { item: 0, body: 1 } })])
  try {
    let joints = 0
    f.ctx.physics.world.impulseJoints.forEach(j => {
      joints++
      assert.equal(j.contactsEnabled(), false)
    })
    assert.equal(joints, 1)
    run(f, 100)
    let contacts = 0
    f.ctx.physics.world.contactPair(f.rb().collider(0), f.rb(1).collider(0), () => { contacts++ })
    assert.equal(contacts, 0, 'overlapping welded colliders must not generate contacts')
    assert.ok(Math.abs(f.rb(1).translation().y) < 0.01)
  } finally { f.preview.free() }
})

test('L12: bodyOfCollider finds a body by its second collider', () => {
  const b = body()
  b.colliders.push({ shape: 'ball', radius: 0.25, t: { x: 1, y: 0, z: 0 }, r: I })
  const f = make(itemOf([b]))
  try {
    assert.equal(f.rb().numColliders(), 2)
    assert.deepEqual(f.sys.bodyOfCollider(f.ctx, f.rb().collider(1).handle), ref)
    const snapshot = f.preview.world.takeSnapshotBytes()
    f.preview.world.restoreSnapshotBytes(snapshot)
    assert.deepEqual(f.sys.bodyOfCollider(f.ctx, f.rb().collider(1).handle), ref)
  } finally { f.preview.free() }
})

test('L12: two identical course loads produce equal, sorted body ids', () => {
  const item = () => itemOf([body('a'), body('b'), body('c')])
  const a = make(item()), b = make(item())
  try {
    const ids = (f: ReturnType<typeof make>) => [0, 1, 2].map(body => f.sys.bodyId({ item: 0, body }))
    const first = ids(a)
    assert.deepEqual(first, ids(b))
    assert.equal(new Set(first).size, 3)
    assert.deepEqual(first, [...first].sort((x, y) => x - y))
  } finally { a.preview.free(); b.preview.free() }
})
