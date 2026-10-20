import assert from 'node:assert/strict'
import test from 'node:test'
import { HALF_PI, PI } from '../src/detmath.ts'
import {
  add3, cross3, degToRad, normalize3, quatAxisAngle, quatConj, quatMul, quatNormalize,
  quatRotate, v3, yawFacing,
} from '../src/vec.ts'
import type { Quat, Vec3 } from '../src/vec.ts'

function near(actual: number, expected: number, eps: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: ${actual} vs ${expected}`)
}

function nearVec(a: Vec3, b: Vec3, eps: number): void {
  near(a.x, b.x, eps, 'x')
  near(a.y, b.y, eps, 'y')
  near(a.z, b.z, eps, 'z')
}

const qa = (): Quat => quatNormalize({ x: 0.1, y: 0.7, z: -0.3, w: 0.6 }, { x: 0, y: 0, z: 0, w: 1 })
const qb = (): Quat => quatNormalize({ x: -0.5, y: 0.2, z: 0.4, w: 0.7 }, { x: 0, y: 0, z: 0, w: 1 })

test('outs may alias inputs', () => {
  const a = v3(1, 2, 3)
  const b = v3(-4, 5, 0.5)
  assert.deepEqual(add3(a, b, a), add3(v3(1, 2, 3), b, v3(0, 0, 0)))
  const c = v3(1, 2, 3)
  assert.deepEqual(cross3(c, b, c), cross3(v3(1, 2, 3), b, v3(0, 0, 0)))
  const q = qa()
  assert.deepEqual(quatMul(q, qb(), q), quatMul(qa(), qb(), { x: 0, y: 0, z: 0, w: 0 }))
})

test('cross3(x, y) = z', () => {
  assert.deepEqual(cross3(v3(1, 0, 0), v3(0, 1, 0), v3(9, 9, 9)), v3(0, 0, 1))
})

test('normalize3 of zero is zero, not NaN', () => {
  assert.deepEqual(normalize3(v3(0, 0, 0), v3(9, 9, 9)), v3(0, 0, 0))
})

test('quatAxisAngle(Y, HALF_PI) rotates +Z to +X', () => {
  const q = quatAxisAngle(v3(0, 1, 0), HALF_PI, quatIdentityOut())
  nearVec(quatRotate(q, v3(0, 0, 1), v3(0, 0, 0)), v3(1, 0, 0), 1e-15)
})

test('quatMul(a, b) applies b, then a', () => {
  const a = qa()
  const b = qb()
  const v = v3(0.3, -1.2, 2.5)
  const composed = quatRotate(quatMul(a, b, quatIdentityOut()), v, v3(0, 0, 0))
  const stepwise = quatRotate(a, quatRotate(b, v, v3(0, 0, 0)), v3(0, 0, 0))
  nearVec(composed, stepwise, 1e-14)
})

test('quatConj undoes the rotation', () => {
  const q = qa()
  const v = v3(0.3, -1.2, 2.5)
  const back = quatRotate(quatConj(q, quatIdentityOut()), quatRotate(q, v, v3(0, 0, 0)), v3(0, 0, 0))
  nearVec(back, v, 1e-14)
})

test('quatNormalize gives norm 1', () => {
  const q = quatNormalize({ x: 3, y: -4, z: 12, w: 2 }, quatIdentityOut())
  near(Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w), 1, 1e-15, 'norm')
})

test('degToRad(180) === PI', () => {
  assert.equal(degToRad(180), PI)
})

test('yawFacing: 0 faces +Z, HALF_PI faces +X', () => {
  assert.deepEqual(yawFacing(0, { x: 9, z: 9 }), { x: 0, z: 1 })
  const f = yawFacing(HALF_PI, { x: 0, z: 0 })
  assert.equal(f.x, 1)
  near(f.z, 0, 1e-15, 'z')
})

function quatIdentityOut(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 }
}
