import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyMechanisms } from '../src/mechanismSpec.ts'
import type { AnimationSpec, LogicOp, LogicSpec, MechanismSpec } from '../src/mechanismSpec.ts'
import { MECH_TYPE_KINDS, animationKind, trackPose } from '../src/mechanisms/animation.ts'
import { evalLogic, newLogicState } from '../src/mechanisms/logic.ts'
import { pose, quatIdentity, v3 } from '../src/vec.ts'

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
