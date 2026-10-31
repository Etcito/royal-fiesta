import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_COLLIDERS_PER_OBSTACLE, MAX_OBSTACLES, MOTION_KINDS, SURFACES, inBox, legacyLevel, levelOf, regionOf,
  surfaceOf,
} from '../src/course.ts'
import type { Box, CourseKind, LevelSpec, ObstacleSpec, Region, ResolvedCourse, SpawnPoint } from '../src/course.ts'
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

function spawn(x: number, z: number): SpawnPoint {
  return { t: v3(x, 0, z), facing: { x: 0, z: 1 } }
}

function courseWith(kind: CourseKind, timeLimitS: number, checkpoints: number): ResolvedCourse {
  const c = course([])
  c.kind = kind
  c.timeLimitS = timeLimitS
  c.checkpoints = Array.from({ length: checkpoints }, (_, i) => ({
    box: box(i, 0, 0, 1, 1, 1),
    respawn: spawn(i, 0),
  }))
  return c
}

test('legacyLevel of a 3-checkpoint race uses the V1 defaults', () => {
  assert.deepEqual(legacyLevel(courseWith('race', 120, 3)), {
    season: null,
    map: null,
    kind: 'race',
    finalRule: null,
    stages: ['R1', 'R2', 'R3', 'R4', 'final'],
    capacity: 60,
    usual: [],
    quota: null,
    timeCapTicks: 7200,
    overtimeTicks: 0,
    respawn: { mode: 'checkpoint', waitTicks: 0, protectTicks: 0, slots: 1, spacingM: 0 },
    route: { ordered: false, laps: 1, stages: [0, 1, 2] },
    teams: null,
    homes: [],
    groups: [],
    grab: { players: true, objects: true },
  })
})

test('legacyLevel of a survival course has no respawn and keeps last standing', () => {
  const level = legacyLevel(courseWith('survival', 90, 2))
  assert.equal(level.kind, 'survival')
  assert.equal(level.finalRule, 'lastStanding')
  assert.equal(level.timeCapTicks, 5400)
  assert.equal(level.respawn.mode, 'none')
  assert.deepEqual(level.route.stages, [0, 1])
  assert.deepEqual(level.grab, { players: false, objects: true })
})

test('a hub course gives kind race', () => {
  const level = legacyLevel(courseWith('hub', 60, 1))
  assert.equal(level.kind, 'race')
  assert.equal(level.finalRule, null)
  assert.equal(level.respawn.mode, 'checkpoint')
  assert.equal(level.timeCapTicks, 3600)
})

test('levelOf returns an explicit level unchanged', () => {
  const c = courseWith('race', 60, 1)
  const level: LevelSpec = { ...legacyLevel(c), season: 's1', map: 'E', quota: 12 }
  c.level = level
  assert.equal(levelOf(c), level)
  assert.deepEqual(levelOf(courseWith('race', 60, 1)), legacyLevel(courseWith('race', 60, 1)))
})
