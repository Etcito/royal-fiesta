import assert from 'node:assert/strict'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '../src/course.ts'
import type { BodySpec, JointSpec, MechEvent, MotorSpec } from '../src/mechanismSpec.ts'
import { MechLogicSystem, withLogic } from '../src/mechanisms/logicSystem.ts'
import { MechanismSystem } from '../src/mechanisms/system.ts'
import { ObstacleSystem } from '../src/obstacles/system.ts'
import { FiestaWorld } from '../src/world.ts'
import type { SimSystem } from '../src/world.ts'
import type { Pose } from '../src/vec.ts'
import { emptyMechanisms } from '../src/mechanismSpec.ts'
import type { AnimationSpec, LogicOp, LogicSpec, MechanismSpec } from '../src/mechanismSpec.ts'
import { MECH_TYPE_KINDS, animationKind, trackPose } from '../src/mechanisms/animation.ts'
import { evalLogic, newLogicState } from '../src/mechanisms/logic.ts'
import { pose, quatIdentity, quatMul, v3 } from '../src/vec.ts'

function node(op: LogicOp, inputs = [0, 1], ticks = 3, count = 3): LogicSpec {
  return { id: op, op, inputs, ticks, count }
}

function mechanism(logic: LogicSpec[]): MechanismSpec {
  const m = emptyMechanisms()
  m.switches.push({
    id: 'switch', plate: { item: 0, body: 0 }, mode: 'weight',
    onKg: 50, offKg: 30, joint: 0, onM: 0, offM: 0,
  })
  m.levers.push({
    id: 'lever', handle: { item: 0, body: 0 }, joint: 0,
    onAngle: 1, offAngle: 0, grabRange: 1,
  })
  m.logic = logic
  m.signals = ['switch', 'lever', ...logic.map(n => n.id)]
  return m
}

function trace(spec: LogicSpec, samples: number[][]): number[] {
  const m = mechanism([spec])
  const s = newLogicState(m)
  return samples.map(sample => {
    evalLogic(m, new Uint8Array(sample), s)
    return s.value[0]
  })
}

test('newLogicState sizes node state and concatenates only delay buffers', () => {
  const m = mechanism([node('delay', [0], 2), node('toggle'), node('delay', [1], 4)])
  const s = newLogicState(m)
  assert.ok(s.value instanceof Uint8Array)
  assert.ok(s.timer instanceof Int32Array)
  assert.ok(s.count instanceof Int32Array)
  assert.ok(s.prev instanceof Uint8Array)
  for (const a of [s.value, s.timer, s.count, s.prev]) assert.deepEqual([...a], [0, 0, 0])
  assert.deepEqual([...s.ring], [0, 0, 0, 0, 0, 0])
  assert.notEqual(newLogicState(m).ring, s.ring)
  const empty = newLogicState(emptyMechanisms())
  for (const a of [empty.value, empty.timer, empty.count, empty.prev, empty.ring]) assert.equal(a.length, 0)
})

test('and/or/not read switch and lever signals; not uses only its first input', () => {
  const m = mechanism([node('and'), node('or'), node('not')])
  const s = newLogicState(m)
  for (const [a, b, expected] of [
    [0, 0, [0, 0, 1]], [0, 1, [0, 1, 1]],
    [1, 0, [0, 1, 0]], [1, 1, [1, 1, 0]],
  ] as const) {
    evalLogic(m, new Uint8Array([a, b]), s)
    assert.deepEqual([...s.value], expected)
    assert.deepEqual([...s.prev], [a || b, a || b, a || b])
  }
})

test('logic reads earlier outputs immediately and later outputs from the previous tick', () => {
  const m = mechanism([node('or', [0, 4]), node('not', [2]), node('or', [1])])
  const s = newLogicState(m)
  evalLogic(m, new Uint8Array([0, 1]), s)
  assert.deepEqual([...s.value], [0, 1, 1])
  evalLogic(m, new Uint8Array([0, 0]), s)
  assert.deepEqual([...s.value], [1, 0, 0])
})

test('toggle flips on rising edges of the OR of its inputs only', () => {
  assert.deepEqual(trace(node('toggle'), [
    [0, 0], [0, 1], [1, 1], [1, 0], [0, 0], [1, 0], [1, 0], [0, 0], [0, 1],
  ]), [0, 1, 1, 1, 1, 0, 0, 0, 1])
})

test('timer is on for exactly ticks evaluations including the rising edge', () => {
  assert.deepEqual(trace(node('timer'), [
    [0, 0], [0, 1], [1, 1], [1, 0], [1, 0], [0, 0], [1, 0], [0, 0], [0, 0], [0, 0],
  ]), [0, 1, 1, 1, 0, 0, 1, 1, 1, 0])
  assert.deepEqual(trace(node('timer', [0], 1), [[1, 0], [1, 0], [0, 0], [1, 0]]), [1, 0, 0, 1])
})

test('timer restarts its full duration on a new rising edge', () => {
  assert.deepEqual(trace(node('timer'), [
    [1, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0],
  ]), [1, 1, 1, 1, 1, 0])
})

test('delay outputs the OR of its inputs exactly ticks evaluations later', () => {
  assert.deepEqual(trace(node('delay'), [
    [0, 1], [0, 0], [1, 0], [1, 1], [0, 0], [0, 0], [0, 0], [0, 0],
  ]), [0, 0, 0, 1, 0, 1, 1, 0])
  assert.deepEqual(trace(node('delay', [0], 1), [[1, 0], [0, 0], [1, 0], [0, 0]]), [0, 1, 0, 1])
})

test('multiple delay buffers wrap independently across intervening nodes', () => {
  const m = mechanism([node('delay', [0], 2), node('not', [0]), node('delay', [1], 3)])
  const s = newLogicState(m)
  const arrays = [s.value, s.timer, s.count, s.prev, s.ring]
  const a = [1, 0, 1, 1, 0, 0, 1, 0]
  const b = [0, 1, 0, 1, 1, 0, 0, 1]
  for (let i = 0; i < a.length; i++) {
    evalLogic(m, new Uint8Array([a[i], b[i]]), s)
    assert.equal(s.value[0], i < 2 ? 0 : a[i - 2])
    assert.equal(s.value[2], i < 3 ? 0 : b[i - 3])
    assert.equal(s.timer[0], (i + 1) % 2)
    assert.equal(s.timer[2], (i + 1) % 3)
  }
  for (const [i, a] of [s.value, s.timer, s.count, s.prev, s.ring].entries()) assert.equal(a, arrays[i])
})

test('counter turns on at its threshold and counts only rising OR edges', () => {
  assert.deepEqual(trace(node('counter'), [
    [0, 0], [0, 1], [1, 1], [0, 0], [1, 0], [1, 1], [0, 0], [0, 1], [0, 0],
  ]), [0, 0, 0, 0, 0, 0, 0, 1, 1])
})

test('a toggle feedback cycle settles and remains stable', () => {
  const m = mechanism([node('toggle', [0, 3]), node('or', [2])])
  const s = newLogicState(m)
  const inputs = new Uint8Array([0, 0])
  evalLogic(m, inputs, s)
  assert.deepEqual([...s.value], [0, 0])
  inputs[0] = 1
  evalLogic(m, inputs, s)
  inputs[0] = 0
  for (let i = 0; i < 100; i++) {
    evalLogic(m, inputs, s)
    assert.deepEqual([...s.value], [1, 1])
  }
})

function animation(loop: AnimationSpec['loop'] = 'once', easing: AnimationSpec['easing'] = 'linear'): AnimationSpec {
  return {
    id: 'track', target: { item: 0, body: 0 }, loop, easing, autostart: true,
    keys: [
      { tick: 0, t: v3(0, 0, 0), r: quatIdentity() },
      { tick: 10, t: v3(10, 20, -10), r: quatIdentity() },
      { tick: 20, t: v3(30, 40, 10), r: quatIdentity() },
    ],
  }
}

test('trackPose wraps loop, mirrors pingpong and clamps once', () => {
  const out = pose()
  const cases: [AnimationSpec['loop'], number, number][] = [
    ['loop', 0, 0], ['loop', 5, 5], ['loop', 10, 10], ['loop', 15, 20],
    ['loop', 20, 0], ['loop', 25, 5], ['loop', 40, 0], ['loop', -5, 20],
    ['pingpong', 0, 0], ['pingpong', 15, 20], ['pingpong', 20, 30],
    ['pingpong', 25, 20], ['pingpong', 35, 5], ['pingpong', 40, 0],
    ['pingpong', 45, 5], ['pingpong', -5, 5],
    ['once', -5, 0], ['once', 0, 0], ['once', 5, 5],
    ['once', 15, 20], ['once', 20, 30], ['once', 25, 30],
  ]
  for (const [loop, tick, x] of cases) {
    assert.equal(trackPose(animation(loop), tick, out), out)
    assert.equal(out.t.x, x, `${loop} at ${tick}`)
  }
  assert.deepEqual(trackPose(animation(), 5, out).t, v3(5, 10, -5))
  assert.deepEqual(trackPose(animation(), 15, out).t, v3(20, 30, 0))
})

test('single keys and zero-length tracks always give key zero', () => {
  for (const loop of ['loop', 'pingpong', 'once'] as const) {
    const a = animation(loop)
    a.keys = [{ tick: 10, t: v3(7, 8, 9), r: quatIdentity() }]
    for (const tick of [-30, 0, 10, 100]) {
      assert.deepEqual(trackPose(a, tick, pose()), { t: v3(7, 8, 9), r: quatIdentity() })
    }
    a.keys = [
      { tick: 0, t: v3(1, 2, 3), r: quatIdentity() },
      { tick: 0, t: v3(4, 5, 6), r: quatIdentity() },
    ]
    assert.deepEqual(trackPose(a, 100, pose()).t, v3(1, 2, 3))
  }
})

test('linear and smooth easing meet at the midpoint and differ at the quarter point', () => {
  const linear = animation('once', 'linear')
  const smooth = animation('once', 'smooth')
  assert.equal(trackPose(linear, 5, pose()).t.x, 5)
  assert.equal(trackPose(smooth, 5, pose()).t.x, 5)
  assert.equal(trackPose(linear, 2.5, pose()).t.x, 2.5)
  assert.equal(trackPose(smooth, 2.5, pose()).t.x, 1.5625)
  assert.equal(trackPose(smooth, 15, pose()).t.x, 20)
})

test('quaternion interpolation takes the shorter arc and stays unit', () => {
  const a = animation()
  a.keys = a.keys.slice(0, 2)
  a.keys[1].r = { x: 0, y: -0.6, z: 0, w: -0.8 }
  const out = pose()
  for (let tick = 0; tick <= 10; tick++) {
    trackPose(a, tick, out)
    const q = out.r
    assert.ok(Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1) < 1e-14)
    assert.ok(q.y >= 0 && q.w > 0)
  }
  trackPose(a, 5, out)
  assert.ok(Math.abs(out.r.y - 0.3 / Math.sqrt(0.9)) < 1e-14)
  assert.ok(Math.abs(out.r.w - 0.9 / Math.sqrt(0.9)) < 1e-14)
  a.keys[1].r = { x: 0, y: 0, z: 0, w: -1 }
  assert.deepEqual(trackPose(a, 5, out).r, quatIdentity())
})

test('mechanism state types are sim; only animations targeted by links are sim', () => {
  assert.deepEqual(MECH_TYPE_KINDS, {
    switch: 'sim', lever: 'sim', logic: 'sim', motor: 'sim', door: 'sim', spring: 'sim',
  })
  const m = emptyMechanisms()
  m.animations.push(animation(), { ...animation(), id: 'linked', autostart: false })
  assert.equal(animationKind(m, 0), 'tick')
  assert.equal(animationKind(m, 1), 'tick')
  m.links.push(
    { id: 'door', from: 0, to: { kind: 'door', joint: 0, openAngle: 1, closedAngle: 0 } },
    { id: 'play', from: 0, to: { kind: 'animation', animation: 1, on: 'play', off: 'pause' } },
  )
  assert.equal(animationKind(m, 0), 'tick')
  assert.equal(animationKind(m, 1), 'sim')
  m.animations[0].autostart = false
  assert.equal(animationKind(m, 0), 'tick')
})

// System fixtures use resolved specs directly, without the game/course loader.
const R = await initRapier()
const ref = { item: 0, body: 0 }
function systemBody(overrides: Partial<BodySpec> = {}): BodySpec {
  return { id: 'body', type: 'dynamic', rest: pose(), density: 100,
    colliders: [{ shape: 'cuboid', half: v3(0.5, 0.1, 0.2), t: v3(0, 0, 0), r: quatIdentity() }],
    friction: 0, restitution: 0, linearDamping: 1, angularDamping: 1,
    gravityScale: 0, ccd: false, surface: 'normal', ...overrides }
}
function systemJoint(overrides: Partial<JointSpec> = {}): JointSpec {
  return { id: 'joint', kind: 'hinge', a: { item: -1, body: 0 }, b: ref,
    anchorA: v3(0, 0, 0), anchorB: v3(0, 0, 0), axis: v3(0, 0, 1), limits: null,
    stiffness: 0, damping: 0, length: 0, motor: null, ...overrides }
}
function systemCourse(bodies = [systemBody({ type: 'fixed' })], joints: JointSpec[] = []): ResolvedCourse {
  return { id: 'logic-lab', name: 'Logic lab', kind: 'gallery', profiles: ['standard'],
    timeLimitS: 60, killPlaneY: -100, spawns: [], checkpoints: [], finish: null,
    path: [], regions: [], queuePad: null, obstacles: [], contentHash: 0,
    mechanisms: { ...emptyMechanisms(), items: [{ id: 'lab', asset: 'lab', t: v3(0, 0, 0),
      r: quatIdentity(), s: v3(1, 1, 1), bodies, joints: [] }], joints,
      switches: [{ id: 'plate', plate: ref, mode: 'weight', onKg: 50, offKg: 30,
        joint: 0, onM: 0.1, offM: 0.05 }], signals: ['plate'] } }
}
function systemFixture(course = systemCourse()) {
  const preview = withLogic(R, course)
  const ctx = preview.world.ctx
  const mech = ctx.system<MechanismSystem>('mechanisms')
  const logic = ctx.system<MechLogicSystem>('mechLogic')
  return { preview, ctx, mech, logic,
    step(kg = 0) { mech.addLoad(ref, v3(0, 0, 0), kg); preview.step() },
    bodyPose(body = 0) {
      const out = pose()
      assert.ok(preview.mechanismBodyPose({ item: 0, body }, out))
      return out
    } }
}
function nearPose(actual: Pose, expected: Pose): void {
  for (const k of ['x', 'y', 'z'] as const) assert.ok(Math.abs(actual.t[k] - expected.t[k]) < 1e-9, `translation ${k}`)
  for (const k of ['x', 'y', 'z', 'w'] as const) assert.ok(Math.abs(actual.r[k] - expected.r[k]) < 1e-9, `rotation ${k}`)
}
function expectedPose(a: AnimationSpec, tick: number, rest: Pose): Pose {
  const out = trackPose(a, tick, pose())
  out.t.x += rest.t.x; out.t.y += rest.t.y; out.t.z += rest.t.z
  quatMul(out.r, rest.r, out.r)
  return out
}
function systemTrack(loop: AnimationSpec['loop'] = 'loop'): AnimationSpec {
  return { id: 'track', target: ref, loop, easing: 'linear', autostart: true,
    keys: [0, 16].map(tick => ({ tick, t: v3(tick, tick / 2, -tick / 4),
      r: { x: 1, y: 0, z: 0, w: 0 } })) }
}

test('system: weight plate hysteresis reads loads before mechanisms clears them', () => {
  const f = systemFixture()
  try {
    for (const [kg, on] of [[60, true], [40, true], [25, false], [40, false]] as const) {
      f.step(kg)
      assert.equal(f.preview.signal('plate'), on)
      assert.equal(f.mech.loadKg(ref), 0)
    }
    const events: MechEvent[] = []
    f.preview.mechanismEvents(0, events)
    assert.deepEqual(events.map(e => [e.kind, e.source]), [['switchOn', 0], ['switchOff', 0]])
    assert.equal(f.preview.signal('missing'), false)
    assert.throws(() => f.logic.signalAt(-1))
    assert.throws(() => f.logic.signalAt(1))
    f.preview.reset()
    assert.equal(f.preview.tick, 0)
    assert.equal(f.preview.signal('plate'), false)
  } finally { f.preview.free() }
})

test('system: travel switch has hysteresis on a slider', () => {
  const c = systemCourse([systemBody()], [systemJoint({ kind: 'slider', axis: v3(1, 0, 0) })])
  c.mechanisms!.switches[0].mode = 'travel'
  const f = systemFixture(c)
  try {
    for (const [x, on] of [[0.125, true], [0.075, true], [0.025, false], [0.075, false]] as const) {
      f.preview.world.physics.body(f.mech.bodyId(ref)).setTranslation(v3(x, 0, 0), true)
      assert.ok(Math.abs(f.mech.jointTravel(f.ctx, 0) - x) < 1e-7)
      f.step()
      assert.equal(f.preview.signal('plate'), on)
    }
  } finally { f.preview.free() }
})

test('system: two eight-tick lever presses toggle the hinge on and back off', () => {
  const c = systemCourse([systemBody()], [systemJoint({ limits: [-0.7, 0.7] })])
  const m = c.mechanisms!
  m.switches = []; m.signals = ['lever']
  m.levers = [{ id: 'lever', handle: ref, joint: 0, onAngle: 0.4, offAngle: -0.2, grabRange: 1 }]
  const obstacles = new ObstacleSystem([c]), logic = new MechLogicSystem([c]), mech = new MechanismSystem([c])
  let held = false
  const stub: SimSystem<unknown> & { grabbingLever(player: number): number } = {
    name: 'characters', init() {}, preStep() {}, postStep() {}, snapshot() {}, restore() {},
    grabbingLever(player) { assert.equal(player, 0); return held ? 0 : -1 },
  }
  const world = new FiestaWorld<unknown>(R, { playerCount: 1, systems: [obstacles, logic, mech, stub] })
  try {
    obstacles.load(world.ctx, 0); mech.load(world.ctx, 0); logic.load(world.ctx, 0)
    for (const expected of [true, false]) {
      held = true
      for (let i = 0; i < 8; i++) world.step([null])
      assert.equal(logic.signal('lever'), !expected, 'hold alone does not toggle')
      held = false
      let elapsed = 0
      do { world.step([null]); elapsed++ } while (logic.signal('lever') !== expected && elapsed < 120)
      assert.equal(logic.signal('lever'), expected, `toggle within ${elapsed} ticks`)
    }
    const events: MechEvent[] = []
    mech.events(0, events)
    assert.deepEqual(events.filter(e => e.kind.startsWith('lever')).map(e => e.kind), ['leverOn', 'leverOff'])
  } finally { world.free() }
})

for (const [op, expected] of [
  ['and', [0, 1, 1, 0, 1, 0, 0]], ['or', [0, 1, 1, 0, 1, 0, 0]],
  ['not', [1, 0, 0, 1, 0, 1, 1]], ['toggle', [0, 1, 1, 1, 0, 0, 0]],
  ['timer', [0, 1, 1, 0, 1, 1, 0]], ['delay', [0, 0, 0, 1, 1, 0, 1]],
  ['counter', [0, 0, 0, 0, 1, 1, 1]],
] as const) {
  test(`system: ${op} publishes its output`, () => {
    const c = systemCourse(), m = c.mechanisms!
    m.logic = [node(op, [0], 2, 2)]; m.signals.push(op)
    const f = systemFixture(c)
    try {
      const actual = [0, 60, 60, 0, 60, 0, 0].map(kg => {
        f.step(kg)
        assert.equal(f.logic.signalAt(1), f.preview.signal(op))
        return Number(f.preview.signal(op))
      })
      assert.deepEqual(actual, expected)
    } finally { f.preview.free() }
  })
}

const drive: MotorSpec = { mode: 'speed', speed: 2, target: 0, stiffness: 2000,
  damping: 200, maxForce: 5000, enabled: true }
test('system: motor link starts and stops its motor and emits both edges', () => {
  const c = systemCourse([systemBody()], [systemJoint()])
  c.mechanisms!.links = [{ id: 'motor', from: 0, to: { kind: 'motor', joint: 0,
    on: drive, off: { ...drive, enabled: false } } }]
  const f = systemFixture(c)
  try {
    for (let i = 0; i < 30; i++) f.step(60)
    const rb = () => f.preview.world.physics.body(f.mech.bodyId(ref))
    assert.ok(rb().angvel().z > 1.5)
    f.step(0)
    // Remove residual inertia: a disabled motor must not accelerate again.
    rb().setAngvel(v3(0, 0, 0), true)
    for (let i = 0; i < 30; i++) f.step(0)
    assert.ok(Math.abs(rb().angvel().z) < 1e-6)
    const events: MechEvent[] = []
    f.preview.mechanismEvents(0, events)
    assert.deepEqual(events.filter(e => e.kind.startsWith('motor')).map(e => [e.kind, e.source]),
      [['motorStart', 0], ['motorStop', 0]])
  } finally { f.preview.free() }
})

test('system: door link reaches openAngle in 180 ticks then closes', () => {
  const c = systemCourse([systemBody()], [systemJoint()])
  c.mechanisms!.links = [{ id: 'door', from: 0, to: { kind: 'door', joint: 0, openAngle: 1, closedAngle: 0 } }]
  const f = systemFixture(c)
  try {
    for (const [kg, angle] of [[60, 1], [0, 0]]) {
      for (let i = 0; i < 180; i++) f.step(kg)
      assert.ok(Math.abs(f.mech.jointAngle(f.ctx, 0) - angle) < 2 * Math.PI / 180)
    }
  } finally { f.preview.free() }
})

test('system: spring link changes slider travel under the same load', () => {
  // Separate fixed switch plate keeps the applied test load identical in both phases.
  const moving = { item: 0, body: 1 }
  const c = systemCourse([systemBody({ type: 'fixed', rest: { t: v3(10, 0, 0), r: quatIdentity() } }),
    systemBody({ id: 'platform', rest: { t: v3(0, -2, 0), r: quatIdentity() } })], [
    systemJoint({ id: 'guide', kind: 'slider', b: moving, axis: v3(0, 1, 0) }),
    systemJoint({ id: 'spring', kind: 'spring', b: moving, length: 2, stiffness: 500, damping: 100 }),
  ])
  c.mechanisms!.links = [{ id: 'spring', from: 0,
    to: { kind: 'spring', joint: 1, stiffnessOn: 2000, stiffnessOff: 500 } }]
  const f = systemFixture(c)
  try {
    const settle = (kg: number) => {
      for (let i = 0; i < 240; i++) {
        f.mech.addLoad(moving, f.bodyPose(1).t, 20)
        f.step(kg)
      }
      return f.mech.jointTravel(f.ctx, 0)
    }
    const stiff = settle(60), soft = settle(0)
    assert.ok(soft < stiff - 0.3, `stiff ${stiff}, soft ${soft}`)
    assert.ok(Math.abs(settle(60) - stiff) < 0.02, 'rising edge restores stiff response')
  } finally { f.preview.free() }
})

for (const off of ['pause', 'reverse', 'stop'] as const) {
  test(`system: animation play/${off} targets expected poses`, () => {
    const c = systemCourse([systemBody({ type: 'kinematic' })]), m = c.mechanisms!
    const a = systemTrack(); a.autostart = false
    m.animations = [a]
    m.links = [{ id: 'animation', from: 0, to: { kind: 'animation', animation: 0, on: 'play', off } }]
    const f = systemFixture(c)
    try {
      for (let i = 0; i < 6; i++) f.step(60)
      nearPose(f.bodyPose(), expectedPose(a, 6, pose()))
      for (let i = 0; i < 2; i++) f.step(0)
      nearPose(f.bodyPose(), expectedPose(a, off === 'reverse' ? 4 : 6, pose()))
      f.step(60)
      nearPose(f.bodyPose(), expectedPose(a, off === 'stop' ? 1 : off === 'reverse' ? 5 : 7, pose()))
    } finally { f.preview.free() }
  })
}
test('system: animation rising reverse runs backward and once emits animEnd', () => {
  const c = systemCourse([systemBody({ type: 'kinematic' })]), m = c.mechanisms!
  const a = systemTrack('once')
  m.animations = [a]
  m.links = [{ id: 'animation', from: 0, to: { kind: 'animation', animation: 0, on: 'reverse', off: 'pause' } }]
  const f = systemFixture(c)
  try {
    for (let i = 0; i < 6; i++) f.step()
    for (let i = 1; i <= 8; i++) {
      f.step(60)
      nearPose(f.bodyPose(), expectedPose(a, Math.max(0, 6 - i), pose()))
    }
    const events: MechEvent[] = []
    f.preview.mechanismEvents(0, events)
    assert.deepEqual(events.filter(e => e.kind.startsWith('anim')).map(e => [e.kind, e.source]),
      [['animStart', 0], ['animStart', 0], ['animEnd', 0]])
  } finally { f.preview.free() }
})

for (const loop of ['loop', 'pingpong', 'once'] as const) {
  test(`system: autostart ${loop} composes trackPose with rest at tick T`, () => {
    const rest = { t: v3(3, 4, 5), r: { x: 0, y: 1, z: 0, w: 0 } }
    const c = systemCourse([systemBody({ type: 'kinematic', rest })]), m = c.mechanisms!
    const a = systemTrack(loop)
    // A link classifies this as stateful; autostart must work without a rising edge.
    m.animations = [a]
    m.links = [{ id: 'animation', from: 0, to: { kind: 'animation', animation: 0, on: 'play', off: 'pause' } }]
    const f = systemFixture(c)
    try {
      for (let tick = 1; tick <= 65; tick++) {
        f.step()
        nearPose(f.bodyPose(), expectedPose(a, tick, rest))
      }
    } finally { f.preview.free() }
  })
}

test('system: tick track uses tick minus nonzero loadTick after an older snapshot restore', () => {
  const rest = { t: v3(3, 4, 5), r: { x: 0, y: 1, z: 0, w: 0 } }
  const c = systemCourse([systemBody({ type: 'kinematic', rest })])
  const a = systemTrack('pingpong'); c.mechanisms!.animations = [a]
  const f = systemFixture(c)
  try {
    f.logic.unload(f.ctx)
    for (let i = 0; i < 23; i++) f.step()
    f.logic.load(f.ctx, 0)
    const loadTick = f.preview.tick
    for (let i = 0; i < 7; i++) f.step()
    const older = f.preview.world.takeSnapshotBytes()
    const check = () => {
      for (let i = 0; i < 40; i++) {
        f.step()
        nearPose(f.bodyPose(), expectedPose(a, f.preview.tick - loadTick, rest))
      }
      return f.bodyPose()
    }
    const first = check()
    f.preview.world.restoreSnapshotBytes(older)
    assert.equal(f.preview.tick, 30)
    assert.deepEqual(check(), first)
  } finally { f.preview.free() }
})

test('system: and/or distinguish both switch inputs across the full truth table', () => {
  const other = { item: 0, body: 1 }
  const c = systemCourse([systemBody({ type: 'fixed' }),
    systemBody({ id: 'other', type: 'fixed', rest: { t: v3(10, 0, 0), r: quatIdentity() } })])
  const m = c.mechanisms!
  m.switches.push({ ...m.switches[0], id: 'second', plate: other })
  m.logic = [node('and', [0, 1]), node('or', [0, 1])]
  m.signals = ['plate', 'second', 'and', 'or']
  const f = systemFixture(c)
  try {
    for (const [a, b] of [[false, false], [false, true], [true, false], [true, true]]) {
      f.mech.addLoad(other, v3(10, 0, 0), b ? 60 : 0)
      f.step(a ? 60 : 0)
      assert.equal(f.preview.signal('and'), a && b)
      assert.equal(f.preview.signal('or'), a || b)
    }
  } finally { f.preview.free() }
})

test('system: 600 ticks match exactly with snapshot/restore and five-tick resims every 41 ticks', () => {
  const make = () => {
    const c = systemCourse([systemBody(),
      systemBody({ id: 'linked', type: 'kinematic', rest: { t: v3(10, 0, 0), r: quatIdentity() } }),
      systemBody({ id: 'clock', type: 'kinematic', rest: { t: v3(30, 0, 0), r: quatIdentity() } })],
    [systemJoint({ limits: [-1, 1] })])
    const m = c.mechanisms!
    m.logic = [node('toggle', [0]), node('timer', [0], 13), node('delay', [0], 9), node('counter', [0], 0, 4)]
    m.signals.push(...m.logic.map(n => n.id))
    m.animations = [
      { ...systemTrack('pingpong'), id: 'linked', target: { item: 0, body: 1 } },
      { ...systemTrack('loop'), id: 'clock', target: { item: 0, body: 2 } },
    ]
    m.links = [
      { id: 'motor', from: 1, to: { kind: 'motor', joint: 0,
        on: { ...drive, mode: 'target', target: 0.6 }, off: { ...drive, mode: 'target', target: -0.6 } } },
      { id: 'animation', from: 0, to: { kind: 'animation', animation: 0, on: 'play', off: 'reverse' } },
    ]
    return systemFixture(c)
  }
  const straight = make(), rollback = make()
  const advance = (f: ReturnType<typeof make>) => f.step(f.preview.tick % 37 < 11 ? 60 : 25)
  try {
    for (let tick = 0; tick < 600; tick++) advance(straight)
    while (rollback.preview.tick < 600) {
      if (rollback.preview.tick > 0 && rollback.preview.tick % 41 === 0) {
        const checkpoint = rollback.preview.world.takeSnapshotBytes()
        const tick = rollback.preview.tick
        for (let i = 0; i < 5; i++) advance(rollback)
        const speculative = [0, 1, 2].map(i => rollback.bodyPose(i))
        rollback.preview.world.restoreSnapshotBytes(checkpoint)
        assert.equal(rollback.preview.tick, tick)
        rollback.preview.world.beginResim()
        try { for (let i = 0; i < 5; i++) advance(rollback) }
        finally { rollback.preview.world.endResim() }
        assert.deepEqual([0, 1, 2].map(i => rollback.bodyPose(i)), speculative)
      } else advance(rollback)
    }
    assert.equal(straight.preview.tick, 600)
    assert.equal(rollback.preview.tick, 600)
    assert.deepEqual([0, 1, 2].map(i => rollback.bodyPose(i)), [0, 1, 2].map(i => straight.bodyPose(i)))
    const signals = (f: ReturnType<typeof make>) => Uint8Array.from(
      ['plate', 'toggle', 'timer', 'delay', 'counter'], id => Number(f.preview.signal(id)))
    assert.deepEqual(signals(rollback), signals(straight))
    assert.ok(signals(straight).some(byte => byte !== 0), 'comparison includes active signals')
  } finally { straight.preview.free(); rollback.preview.free() }
})
