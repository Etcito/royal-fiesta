import assert from 'node:assert/strict'
import test from 'node:test'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { assetColliders, engineColliders } from '../src/ege/colliders.ts'
import {
  FEATURE_EMITTERS,
  featureSalt,
  featureSnake,
  tintColor,
  visualOf,
} from '../src/ege/featureEmitters.ts'

const AT = { x: 0, y: 0, z: 0 }
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }

test('a cuboid and a roundCuboid map to the exact halfExtents', () => {
  const list: ColliderSpec[] = [
    { shape: 'cuboid', half: { x: 1, y: 2, z: 3 }, t: { x: 4, y: 5, z: 6 }, r: IDENTITY },
    { shape: 'roundCuboid', half: { x: 1, y: 2, z: 3 }, border: 0.5, t: AT, r: IDENTITY },
  ]
  const out = engineColliders(list, 'courses/x.course.json#/obstacles/3/colliders')
  assert.deepEqual(out[0].halfExtents, [1, 2, 3])
  assert.deepEqual(out[0].t, [4, 5, 6])
  assert.deepEqual(out[1].halfExtents, [1.5, 2.5, 3.5])
})

test('ball, capsule and cylinder fields carry over', () => {
  const out = engineColliders([
    { shape: 'ball', radius: 2, t: AT, r: IDENTITY },
    { shape: 'capsule', radius: 1, halfHeight: 3, t: AT, r: IDENTITY },
    { shape: 'cylinder', radius: 4, halfHeight: 5, t: AT, r: IDENTITY },
  ], 'p')
  assert.deepEqual(out[0], { shape: 'ball', radius: 2, t: [0, 0, 0], r: [0, 0, 0, 1] })
  assert.deepEqual(out[1], { shape: 'capsule', radius: 1, halfHeight: 3, t: [0, 0, 0], r: [0, 0, 0, 1] })
  assert.deepEqual(out[2], { shape: 'cylinder', radius: 4, halfHeight: 5, t: [0, 0, 0], r: [0, 0, 0, 1] })
})

test('a cone is refused at its pointer', () => {
  const list: ColliderSpec[] = [
    { shape: 'cuboid', half: { x: 1, y: 1, z: 1 }, t: AT, r: IDENTITY },
    { shape: 'cone', radius: 1, halfHeight: 2, t: AT, r: IDENTITY },
  ]
  assert.throws(
    () => engineColliders(list, 'courses/x.course.json#/obstacles/3/colliders'),
    (e: unknown) => e instanceof RefusalError &&
      e.message === "[ege-scene] courses/x.course.json#/obstacles/3/colliders/1/shape: shape 'cone' has no engine collider (cuboid, roundCuboid, ball, capsule, cylinder); use one of those shapes in the asset's collision",
  )
})

test('assetColliders accepts the halfExtents alias and the params form', () => {
  const out = assetColliders([
    { shape: 'cuboid', halfExtents: [1, 2, 3] },
    { shape: 'ball', params: { radius: 2 } },
    { shape: 'roundCuboid', params: { halfExtents: [1, 1, 1], borderRadius: 0.25 } },
  ], 'asset#/collision')
  assert.deepEqual(out[0].halfExtents, [1, 2, 3])
  assert.equal(out[1].shape, 'ball')
  assert.equal(out[1].radius, 2)
  assert.deepEqual(out[2].halfExtents, [1.25, 1.25, 1.25])
})

test('feature snake names and salts follow the E3/E4 tables', () => {
  assert.equal(featureSnake('boostLane'), 'boost_lane')
  assert.equal(featureSalt(3), 0x103)
})

test('visualOf maps a draw asset to its engine shape, params and colour', () => {
  assert.deepEqual(visualOf('candy.floor-tile', { x: 2, y: 1, z: 4 }),
    { shape: 1, params: [1, 0.5, 2, 0], color: 0xF5D0E0 })
})

test('tint 2 is the palette blue and the registry starts empty', () => {
  assert.equal(tintColor(2, 0), 0x54BAFF)
  assert.equal(Object.keys(FEATURE_EMITTERS).length, 0)
})
