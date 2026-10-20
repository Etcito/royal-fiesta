import assert from 'node:assert/strict'
import test from 'node:test'
import { MOTION_KINDS } from '../src/course.ts'
import type { Motion, ObstacleSpec } from '../src/course.ts'
import {
  isKinematic, motionPose, pointVelocity, smoothstep01, triangleWave,
} from '../src/obstacles/motion.ts'
import { FIXED_DT } from '@gamesaloon/rollback-rapier'
import { add3, pose, quatConj, quatIdentity, quatRotate, scale3, sub3, v3 } from '../src/vec.ts'
import type { Pose, Quat, Vec3 } from '../src/vec.ts'

const TICKS = [0, 1, 59, 60, 3599]
const EPS = 1e-12

function obstacle(motion: Motion, t: Vec3 = v3(1, 2, 3), r: Quat = quatIdentity()): ObstacleSpec {
  return { id: 'o', asset: 'a', t, r, s: v3(1, 1, 1), friction: 0, colliders: [], motion }
}

function near(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= EPS, `${what}: ${actual} != ${expected}`)
}

function assertPose(p: Pose, t: Vec3, r: Quat, what: string): void {
  near(p.t.x, t.x, `${what} t.x`)
  near(p.t.y, t.y, `${what} t.y`)
  near(p.t.z, t.z, `${what} t.z`)
  near(p.r.x, r.x, `${what} r.x`)
  near(p.r.y, r.y, `${what} r.y`)
  near(p.r.z, r.z, `${what} r.z`)
  near(p.r.w, r.w, `${what} r.w`)
}

test('isKinematic covers every kind', () => {
  const expected: Record<string, boolean> = {
    static: false, spinner: true, pendulum: true, seesaw: true,
    rotatingDoor: true, conveyor: false, bouncePad: false, movingPlatform: true,
  }
  for (const kind of MOTION_KINDS) assert.equal(isKinematic(kind), expected[kind], kind)
})

test('smoothstep01 clamps and eases', () => {
  const cases: [number, number][] = [[-1, 0], [0, 0], [0.5, 0.5], [1, 1], [2, 1]]
  for (const [u, want] of cases) assert.equal(smoothstep01(u), want, `u=${u}`)
})

test('triangleWave hits -1, 0, 1', () => {
  const cases: [number, number][] = [[0, -1], [0.25, 0], [0.5, 1], [0.75, 0], [1.25, 0]]
  for (const [u, want] of cases) assert.equal(triangleWave(u), want, `u=${u}`)
})

test('static, conveyor and bouncePad keep (t0, r0)', () => {
  const r0 = { x: 0, y: Math.sin(0.3), z: 0, w: Math.cos(0.3) }
  const motions: Motion[] = [
    { kind: 'static' },
    { kind: 'conveyor', velocity: v3(0, 0, -3) },
    { kind: 'bouncePad', speed: 14 },
  ]
  for (const m of motions) {
    const o = obstacle(m, v3(1, 2, 3), r0)
    for (const L of TICKS) assertPose(motionPose(o, L, 0, pose()), o.t, r0, `${m.kind} L=${L}`)
  }
})

test('spinner turns radPerTick per tick around its axis', () => {
  const o = obstacle({ kind: 'spinner', axis: v3(0, 1, 0), radPerTick: Math.PI / 120, phase: 0 })
  for (const L of TICKS) {
    const half = Math.PI / 120 * L / 2
    const r = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
    assertPose(motionPose(o, L, 0, pose()), o.t, r, `spinner L=${L}`)
  }
  // theta = pi/2 at L = 60.
  const p60 = motionPose(o, 60, 0, pose())
  near(p60.r.y, Math.SQRT1_2, 'spinner L=60 r.y')
  near(p60.r.w, Math.SQRT1_2, 'spinner L=60 r.w')
})

test('seesaw follows its angle, not the tick', () => {
  const o = obstacle({ kind: 'seesaw', axis: v3(1, 0, 0), maxAngle: 0.35, spring: 800, damping: 300, inertia: 900 })
  const r = { x: Math.sin(0.1), y: 0, z: 0, w: Math.cos(0.1) }
  for (const L of TICKS) assertPose(motionPose(o, L, 0.2, pose()), o.t, r, `seesaw L=${L}`)
})

test('pointVelocity is exactly zero for static and bouncePad', () => {
  for (const m of [{ kind: 'static' }, { kind: 'bouncePad', speed: 14 }] as Motion[]) {
    const v = pointVelocity(obstacle(m), 10, 0, 0, v3(5, 1, 2), v3(9, 9, 9))
    assert.deepEqual(v, v3(0, 0, 0), m.kind)
  }
})

test('pointVelocity of a spinner rim is omega x r', () => {
  // A slow spinner keeps the one-tick chord within 1e-3 of the tangent.
  const w = 0.001
  const o = obstacle({ kind: 'spinner', axis: v3(0, 1, 0), radPerTick: w, phase: 0 }, v3(0, 0, 0))
  // Rim point at radius 2 on +X; omega = (0, w*60, 0) rad/s.
  const v = pointVelocity(o, 0, 0, 0, v3(2, 0, 0), v3(0, 0, 0))
  const omega = w * 60
  assert.ok(Math.abs(v.x) <= 1e-3, `vx ${v.x}`)
  assert.ok(Math.abs(v.y) <= 1e-3, `vy ${v.y}`)
  assert.ok(Math.abs(v.z - -omega * 2) <= 1e-3, `vz ${v.z}`)
})

function zQuat(theta: number): Quat {
  return { x: 0, y: 0, z: Math.sin(theta / 2), w: Math.cos(theta / 2) }
}

function yQuat(theta: number): Quat {
  return { x: 0, y: Math.sin(theta / 2), z: 0, w: Math.cos(theta / 2) }
}

function ss(u: number): number {
  const c = Math.min(1, Math.max(0, u))
  return c * c * (3 - 2 * c)
}

test('pendulum swings t and r around its pivot', () => {
  for (const phase of [0, Math.PI / 2]) {
    const amp = Math.PI / 3
    const o = obstacle(
      { kind: 'pendulum', pivot: v3(0, 6, 0), axis: v3(0, 0, 1), amp, periodTicks: 120, phase },
      v3(0, 1, 0),
    )
    for (const L of TICKS) {
      const theta = amp * Math.sin(2 * Math.PI * L / 120 + phase)
      // t0 - pivot = (0,-5,0), rotated about +Z by theta.
      const t = v3(5 * Math.sin(theta), 6 - 5 * Math.cos(theta), 0)
      assertPose(motionPose(o, L, 0, pose()), t, zQuat(theta), `pendulum phase=${phase} L=${L}`)
    }
  }
})

test('rotatingDoor steps stepAngle per period with a smoothstep move', () => {
  const step = Math.PI / 2
  const door = (phaseTicks: number) => obstacle(
    { kind: 'rotatingDoor', axis: v3(0, 1, 0), stepAngle: step, periodTicks: 120, moveTicks: 30, phaseTicks },
  )
  const cases: [number, number[]][] = [
    [0, [0, step * ss(1 / 30), step, step, 30 * step]],
    // tau = L + 15: 15, 16, 74, 75, 3614 (k = 30, u = 14/30).
    [15, [step * ss(0.5), step * ss(16 / 30), step, step, step * (30 + ss(14 / 30))]],
  ]
  for (const [phaseTicks, thetas] of cases) {
    const o = door(phaseTicks)
    TICKS.forEach((L, i) => {
      assertPose(motionPose(o, L, 0, pose()), o.t, yQuat(thetas[i]), `door phaseTicks=${phaseTicks} L=${L}`)
    })
  }
})

test('movingPlatform slides along offset with sine and pingpong waves', () => {
  for (const wave of ['sine', 'pingpong'] as const) {
    const o = obstacle({ kind: 'movingPlatform', offset: v3(4, 0, 0), periodTicks: 240, phase: 0, wave })
    for (const L of TICKS) {
      const u = L / 240
      const w = wave === 'sine'
        ? Math.sin(2 * Math.PI * L / 240)
        : 1 - 4 * Math.abs((u - Math.floor(u)) - 0.5)
      assertPose(motionPose(o, L, 0, pose()), v3(1 + 4 * w, 2, 3), quatIdentity(), `platform ${wave} L=${L}`)
    }
  }
})

test('pointVelocity of a fast spinner rim matches omega x r', () => {
  const k = 0.05
  const o = obstacle({ kind: 'spinner', axis: v3(0, 1, 0), radPerTick: k, phase: 0 })
  const p = v3(o.t.x + 3, o.t.y + 0.5, o.t.z)
  const omega = k * 60
  for (const L of [0, 600]) {
    const v = pointVelocity(o, L, 0, 0, p, v3(0, 0, 0))
    // The one-tick chord is parallel to the tangent at mid-tick, so r is p - t0 turned by
    // half a tick; with r = p - t0 itself the chord sags by 3*k^2/2*60 = 0.225 m/s in x.
    const rx = 3 * Math.cos(k / 2)
    const rz = -3 * Math.sin(k / 2)
    // omega x r for omega = (0, omega, 0): (omega*rz, 0, -omega*rx).
    near3(v, v3(omega * rz, 0, -omega * rx), 1e-3, `spinner L=${L}`)
    // The exact chord, by hand.
    near3(v, v3(3 * (Math.cos(k) - 1) * 60, 0, -3 * Math.sin(k) * 60), 1e-9, `spinner chord L=${L}`)
  }
})

function near3(a: Vec3, b: Vec3, eps: number, what: string): void {
  assert.ok(Math.abs(a.x - b.x) <= eps, `${what} x: ${a.x} != ${b.x}`)
  assert.ok(Math.abs(a.y - b.y) <= eps, `${what} y: ${a.y} != ${b.y}`)
  assert.ok(Math.abs(a.z - b.z) <= eps, `${what} z: ${a.z} != ${b.z}`)
}

test('pointVelocity of a conveyor is its belt velocity', () => {
  const o = obstacle({ kind: 'conveyor', velocity: v3(0, 0, -3) })
  assert.deepEqual(pointVelocity(o, 10, 0, 0, v3(5, 1, 2), v3(9, 9, 9)), v3(0, 0, -3))
})

test('pointVelocity of a see-saw is the finite difference of its poses', () => {
  const o = obstacle({ kind: 'seesaw', axis: v3(1, 0, 0), maxAngle: 0.35, spring: 800, damping: 300, inertia: 900 })
  const p = v3(1, 3, 5)
  const v = pointVelocity(o, 7, 0, 0.01, p, v3(0, 0, 0))
  const a = motionPose(o, 7, 0, pose())
  const b = motionPose(o, 8, 0.01, pose())
  const local = quatRotate(quatConj(a.r, quatIdentity()), sub3(p, a.t, v3(0, 0, 0)), v3(0, 0, 0))
  const p1 = add3(b.t, quatRotate(b.r, local, v3(0, 0, 0)), v3(0, 0, 0))
  near3(v, scale3(sub3(p1, p, v3(0, 0, 0)), 1 / FIXED_DT, v3(0, 0, 0)), 1e-9, 'seesaw')
  assert.ok(Math.abs(v.y) + Math.abs(v.z) > 0.1, `seesaw velocity is non-zero: ${JSON.stringify(v)}`)
})
