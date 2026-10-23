import test from 'node:test'
import assert from 'node:assert/strict'
import type { Vec3T } from '../src/render/port.ts'
import { basisFromFacing, cameraBasis, stickToWorld, yawTurn } from '../src/client/cameraBasis.ts'

type V3 = [number, number, number]
const sub = (a: Vec3T, b: Vec3T): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3T, b: Vec3T) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3T, b: Vec3T): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3T): V3 => { const l = Math.sqrt(dot(a, a)); return [a[0] / l, a[1] / l, a[2] / l] }

// Same maths as raa-math look_at_rh: view rows s, u, -f with translation -dot(row, eye).
const lookAtRh = (eye: Vec3T, target: Vec3T, up: Vec3T) => {
  const f = norm(sub(target, eye))
  const s = norm(cross(f, up))
  const u = cross(s, f)
  const nf: V3 = [-f[0], -f[1], -f[2]]
  return [[...s, -dot(s, eye)], [...u, -dot(u, eye)], [...nf, -dot(nf, eye)]]
}

// RH perspective (camera looks down -Z), fovY 60 deg, aspect 16/9, near 0.1, far 500.
const ndcX = (eye: Vec3T, target: Vec3T, p: Vec3T) => {
  const v = lookAtRh(eye, target, [0, 1, 0])
  const vx = v[0][0] * p[0] + v[0][1] * p[1] + v[0][2] * p[2] + v[0][3]
  const vz = v[2][0] * p[0] + v[2][1] * p[1] + v[2][2] * p[2] + v[2][3]
  const fy = 1 / Math.tan((60 * Math.PI / 180) / 2)
  const aspect = 16 / 9
  const clipX = (fy / aspect) * vx
  const clipW = -vz
  assert.ok(clipW > 0.1 && clipW < 500, 'point inside the depth range')
  return clipX / clipW
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ~ ${b}`)

test('player + right lands right of the player on screen for 8 yaws', () => {
  let wrong = 0
  for (let k = 0; k < 8; k++) {
    const yaw = k * Math.PI / 4
    const facing = { x: Math.sin(yaw), z: Math.cos(yaw) }
    const player: Vec3T = [0, 0, 0]
    const eye: Vec3T = [-facing.x * 7, 4, -facing.z * 7]
    const { right } = cameraBasis(eye, player)
    const px = ndcX(eye, player, player)
    const rx = ndcX(eye, player, [right.x, 0, right.z])
    if (!(rx > px)) wrong++
  }
  assert.equal(wrong, 0)
})

test('looking along +Z, right is -X', () => {
  const b = cameraBasis([0, 4, -7], [0, 0, 0])
  close(b.forward.x, 0); close(b.forward.z, 1)
  close(b.right.x, -1); close(b.right.z, 0)
})

test('stickToWorld maps x to right and y to forward', () => {
  const b = basisFromFacing({ x: 3, z: 4 })
  const out = { x: 0, z: 0 }
  stickToWorld(1, 0, b, out)
  close(out.x, b.right.x); close(out.z, b.right.z)
  stickToWorld(0, 1, b, out)
  close(out.x, b.forward.x); close(out.z, b.forward.z)
})

test('positive yawTurn rotates toward right, negative away, unit length kept', () => {
  const f = { x: 0.6, z: 0.8 }
  const { right } = basisFromFacing(f)
  const pos = yawTurn(f, 0.1)
  const neg = yawTurn(f, -0.1)
  assert.ok(pos.x * right.x + pos.z * right.z > 0)
  assert.ok(neg.x * right.x + neg.z * right.z < 0)
  close(Math.hypot(pos.x, pos.z), 1)
  close(Math.hypot(neg.x, neg.z), 1)
})

test('NaN or zero facing gives forward (0,1)', () => {
  for (const facing of [{ x: Number.NaN, z: 1 }, { x: 0, z: 0 }, { x: Infinity, z: 0 }]) {
    const b = basisFromFacing(facing)
    assert.deepEqual(b.forward, { x: 0, z: 1 })
    assert.deepEqual(b.right, { x: -1, z: 0 })
  }
})
