import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_COLLIDERS_PER_OBSTACLE, MAX_OBSTACLES, MOTION_KINDS, SURFACES, inBox, regionOf, surfaceOf,
} from '../src/course.ts'
import type { Box, ObstacleSpec, Region, ResolvedCourse } from '../src/course.ts'
import { quatIdentity, v3 } from '../src/vec.ts'

function box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): Box {
  return { center: v3(cx, cy, cz), half: v3(hx, hy, hz) }
}

function course(regions: Region[]): ResolvedCourse {
  return {
    id: 'test-course',
    name: 'Test Course',
    kind: 'race',
    profiles: ['standard'],
    timeLimitS: 60,
    killPlaneY: -12,
    spawns: [],
    checkpoints: [],
    finish: null,
    path: [],
    regions,
    queuePad: null,
    obstacles: [],
    contentHash: 0,
  }
}

function obstacle(surface?: ObstacleSpec['surface']): ObstacleSpec {
  return {
    id: 'obstacle',
    asset: 'box',
    t: v3(0, 0, 0),
    r: quatIdentity(),
    s: v3(1, 1, 1),
    friction: 0.5,
    colliders: [],
    motion: { kind: 'static' },
    ...(surface === undefined ? {} : { surface }),
  }
}

test('motion kinds and caps match the contract', () => {
  assert.deepEqual(MOTION_KINDS, [
    'static', 'spinner', 'pendulum', 'seesaw', 'rotatingDoor', 'conveyor', 'bouncePad', 'movingPlatform',
  ])
  assert.equal(MAX_OBSTACLES, 96)
  assert.equal(MAX_COLLIDERS_PER_OBSTACLE, 8)
})

test('surfaces list the four kinds in order', () => {
  assert.deepEqual(SURFACES, ['normal', 'ice', 'mud', 'rubber'])
})

test('surfaceOf reads a missing surface as normal and keeps an explicit one', () => {
  assert.equal(surfaceOf(obstacle()), 'normal')
  assert.equal(surfaceOf(obstacle('ice')), 'ice')
  for (const surface of SURFACES) assert.equal(surfaceOf(obstacle(surface)), surface)
})

test('a course without mechanisms or sounds reads as none', () => {
  const c = course([])
  assert.equal(c.mechanisms ?? null, null)
  assert.equal(c.sounds ?? null, null)
})

test('path nodes carry optional wait and pull signals', () => {
  const c = course([])
  c.path.push({ p: v3(0, 0, 0), jump: false, dive: false })
  c.path.push({ p: v3(0, 0, 1), jump: true, dive: true, wait: 'gate', pull: 'lever-a' })
  assert.equal(c.path[0].wait, undefined)
  assert.equal(c.path[1].wait, 'gate')
  assert.equal(c.path[1].pull, 'lever-a')
})

test('inBox includes the centre and exact faces, excludes points just outside', () => {
  const b = box(1, 2, 3, 2, 0.5, 4)
  assert.equal(inBox(b, v3(1, 2, 3)), true)
  assert.equal(inBox(b, v3(3, 2, 3)), true)
  assert.equal(inBox(b, v3(1, 2.5, 3)), true)
  assert.equal(inBox(b, v3(1, 2, 7)), true)
  assert.equal(inBox(b, v3(3 + 1e-9, 2, 3)), false)
  assert.equal(inBox(b, v3(1, 2.5 + 1e-9, 3)), false)
  assert.equal(inBox(b, v3(1, 2, 7 + 1e-9)), false)
  assert.equal(inBox(b, v3(-1 - 1e-9, 2, 3)), false)
})

test('regionOf returns the first match as an id, or -1 outside', () => {
  const c = course([
    { id: 7, box: box(0, 0, 0, 5, 5, 5), adjacent: [9, 4] },
    { id: 9, box: box(0, 0, 0, 5, 5, 5), adjacent: [7] },
    { id: 4, box: box(20, 0, 0, 1, 1, 1), adjacent: [] },
  ])
  assert.equal(regionOf(c, v3(0, 0, 0)), 7)
  assert.equal(regionOf(c, v3(20, 0, 0)), 4)
  assert.equal(regionOf(c, v3(50, 0, 0)), -1)
})
