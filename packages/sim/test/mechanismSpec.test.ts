import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_BUDGET, MECH_CAPS, MECH_EVENT_RING, countBudget, emptyMechanisms, isMechanismView,
} from '../src/mechanismSpec.ts'
import type {
  BodySpec, JointSpec, MechItem, MechanismSpec, MechEvent, MechanismView,
} from '../src/mechanismSpec.ts'
import { pose, quatIdentity, v3 } from '../src/vec.ts'
import type { Pose } from '../src/vec.ts'

function body(id: string, type: BodySpec['type']): BodySpec {
  return {
    id,
    type,
    colliders: [],
    rest: pose(),
    density: 400,
    friction: 0.5,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0.05,
    gravityScale: 1,
    ccd: false,
    surface: 'normal',
  }
}

function joint(id: string, kind: JointSpec['kind'] = 'fixed'): JointSpec {
  return {
    id,
    kind,
    a: { item: -1, body: 0 },
    b: { item: -1, body: 0 },
    anchorA: v3(0, 0, 0),
    anchorB: v3(0, 0, 0),
    axis: v3(1, 0, 0),
    limits: null,
    stiffness: 0,
    damping: 0,
    length: 0,
    motor: null,
  }
}

function item(id: string, bodies: BodySpec[], joints: JointSpec[] = []): MechItem {
  return { id, asset: id, t: v3(0, 0, 0), r: quatIdentity(), s: v3(1, 1, 1), bodies, joints }
}

function view(): MechanismView {
  return {
    mechanismEvents(_fromTick: number, _out: MechEvent[]): number { return 0 },
    mechanismBodyPose(_ref, out: Pose): boolean { void out; return false },
    signal(_id: string): boolean { return false },
  }
}

test('isMechanismView accepts an object with the three methods', () => {
  assert.equal(isMechanismView(view()), true)
  assert.equal(isMechanismView(emptyMechanisms()), false)
})

test('isMechanismView rejects null, primitives and partial objects', () => {
  for (const value of [null, undefined, 0, 'view', true, [], {}, emptyMechanisms()]) {
    assert.equal(isMechanismView(value), false)
  }
  const missingEvents = view() as Partial<MechanismView>
  delete missingEvents.mechanismEvents
  assert.equal(isMechanismView(missingEvents), false)
  const missingPose = view() as Partial<MechanismView>
  delete missingPose.mechanismBodyPose
  assert.equal(isMechanismView(missingPose), false)
  const missingSignal = view() as Partial<MechanismView>
  delete missingSignal.signal
  assert.equal(isMechanismView(missingSignal), false)
  assert.equal(isMechanismView({ ...view(), signal: true }), false)
})

test('emptyMechanisms has every group empty and the default budget', () => {
  assert.deepEqual(emptyMechanisms(), {
    items: [],
    joints: [],
    switches: [],
    levers: [],
    logic: [],
    links: [],
    animations: [],
    signals: [],
    budget: { dynamicBodies: 24, joints: 32 },
  })
})

test('emptyMechanisms returns fresh arrays and a fresh budget', () => {
  const a = emptyMechanisms()
  const b = emptyMechanisms()
  a.items.push(item('a', []))
  a.signals.push('switch-a')
  a.budget.dynamicBodies = 0
  assert.deepEqual(b.items, [])
  assert.deepEqual(b.signals, [])
  assert.deepEqual(b.budget, { dynamicBodies: 24, joints: 32 })
  assert.notEqual(a.budget, b.budget)
  assert.notEqual(a.budget, DEFAULT_BUDGET)
  assert.deepEqual(DEFAULT_BUDGET, { dynamicBodies: 24, joints: 32 })
})

test('countBudget is zero for an empty mechanism spec', () => {
  assert.deepEqual(countBudget(emptyMechanisms()), { dynamicBodies: 0, joints: 0 })
})

test('countBudget counts dynamic bodies and every item and course joint', () => {
  const m: MechanismSpec = emptyMechanisms()
  m.items.push(
    item('seesaw', [body('plank', 'dynamic'), body('base', 'fixed')], [joint('pivot', 'hinge')]),
    item('door', [body('leaf', 'kinematic'), body('frame', 'fixed'), body('bolt', 'dynamic')]),
  )
  m.joints.push(joint('rope-a', 'rope'), joint('spring-a', 'spring'))
  assert.deepEqual(countBudget(m), { dynamicBodies: 2, joints: 3 })
})

test('countBudget respects an item with no bodies or joints', () => {
  const m: MechanismSpec = emptyMechanisms()
  m.items.push(item('empty', []))
  assert.deepEqual(countBudget(m), { dynamicBodies: 0, joints: 0 })
})

test('caps and event ring match the contract', () => {
  assert.equal(MECH_EVENT_RING, 64)
  assert.deepEqual(MECH_CAPS, {
    maxItems: 48,
    maxBodiesPerItem: 16,
    maxJoints: 64,
    maxSignals: 64,
    maxKeys: 32,
    maxSounds: 32,
  })
})
