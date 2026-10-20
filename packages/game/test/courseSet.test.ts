import assert from 'node:assert/strict'
import test from 'node:test'
import type { CourseKind, ProfileName } from '@royal-fiesta/sim/course'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses, resolveCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'

const FLOOR = 'fixtures/assets/floor-tile.prims.json'
const FLOOR_TEXT = JSON.stringify({
  format: 'raa.prims', version: 0, id: 'floor-tile', name: 'floor-tile',
  nodes: [{ id: 'body', kind: 'box', params: { size: [4, 0.5, 4] }, material: 'body', op: 'union', transform: { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] } }],
  materials: { body: { color: [1, 1, 1], roughness: 0.5, metallic: 0, emissive: [0, 0, 0] } },
  collision: { mode: 'override', colliders: [{ node: null, shape: 'cuboid', params: { halfExtents: [2, 0.25, 2] }, t: [0, 0, 0], r: [0, 0, 0, 1] }] },
})

// Same approach as course.test.ts: fixtureResolver over an in-memory file map.
function resolver() {
  const files = new Map<string, string>([[FLOOR, FLOOR_TEXT]])
  return fixtureResolver(async path => {
    const text = files.get(path)
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  })
}

function course(id: string, kind: CourseKind, profiles: ProfileName[]): Record<string, unknown> {
  return {
    format: 'royal-fiesta.course',
    version: 0,
    id,
    name: id,
    kind,
    profiles,
    assetsManifest: null,
    timeLimitS: 60,
    killPlaneY: -12,
    spawns: Array.from({ length: 8 }, (_, i) => ({ t: [i - 3.5, 1, 0], yawDeg: 0 })),
    checkpoints: [],
    finish: kind === 'race' ? { center: [0, 1, 20], half: [4, 2, 1] } : null,
    path: [{ p: [0, 0, 0], jump: false, dive: false }, { p: [0, 0, 20], jump: false, dive: false }],
    regions: [{ id: 0, center: [0, 0, 10], half: [10, 10, 20], adjacent: [] }],
    queuePad: null,
    obstacles: [
      { id: 'floor-1', asset: 'floor-tile', t: [0, -0.25, 10], r: [0, 0, 0, 1], s: [4, 1, 6], friction: 0.5, colliders: null,
        motion: { kind: 'static' } },
    ],
  }
}

function entry(id: string, kind: CourseKind, profiles: ProfileName[], dir = 'fixtures/courses'): CourseEntry {
  return { path: `${dir}/${id}.course.json`, json: course(id, kind, profiles) }
}

const BOTH: ProfileName[] = ['standard', 'sprint']

test('resolveCourses returns courses sorted by id in code-unit order', async () => {
  const entries = [
    entry('survival-b', 'survival', BOTH),
    entry('race-z', 'race', BOTH),
    entry('race-a', 'race', BOTH),
    entry('gallery-x', 'gallery', ['standard']),
  ]
  const courses = await resolveCourses(entries, resolver())
  assert.deepEqual(courses.map(c => c.id), ['gallery-x', 'race-a', 'race-z', 'survival-b'])
})

test('resolveCourses refuses a duplicate id at the second entry path', async () => {
  const first = entry('race-a', 'race', BOTH)
  const second = entry('race-a', 'race', ['standard'], 'fixtures/courses/copy')
  await assert.rejects(resolveCourses([entry('survival-b', 'survival', BOTH), first, second], resolver()), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.equal(e.area, 'course')
    assert.equal(e.path, second.path)
    assert.match(e.message, /duplicate course id 'race-a'; /)
    return true
  })
})

test('resolveCourses applies the profile filter', async () => {
  const entries = [
    entry('race-std', 'race', ['standard']),
    entry('race-both', 'race', BOTH),
    entry('survival-sprint', 'survival', ['sprint']),
  ]
  const all = await resolveCourses(entries, resolver())
  assert.deepEqual(all.map(c => c.id), ['race-both', 'race-std', 'survival-sprint'])
  const sprint = await resolveCourses(entries, resolver(), 'sprint')
  assert.deepEqual(sprint.map(c => c.id), ['race-both', 'survival-sprint'])
  const standard = await resolveCourses(entries, resolver(), 'standard')
  assert.deepEqual(standard.map(c => c.id), ['race-both', 'race-std'])
})

test('matchCourses keeps race and survival courses of the profile', async () => {
  const entries = [
    entry('race-std', 'race', ['standard']),
    entry('race-both', 'race', BOTH),
    entry('survival-both', 'survival', BOTH),
    entry('gallery-x', 'gallery', BOTH),
  ]
  const courses = await matchCourses(entries, resolver(), 'sprint')
  assert.deepEqual(courses.map(c => c.id), ['race-both', 'survival-both'])
})

for (const missing of ['race', 'survival'] as const) {
  test(`matchCourses refuses when no ${missing} course matches the profile`, async () => {
    const entries = [
      entry('race-a', 'race', missing === 'race' ? ['standard'] : BOTH),
      entry('survival-b', 'survival', missing === 'survival' ? ['standard'] : BOTH),
      entry('gallery-x', 'gallery', BOTH),
    ]
    await assert.rejects(matchCourses(entries, resolver(), 'sprint'), (e: unknown) => {
      assert.ok(isRefusal(e))
      assert.equal(e.area, 'course')
      assert.equal(e.message, `[course] courses: no ${missing} course for profile 'sprint'; add a ${missing} course whose profiles include 'sprint'`)
      return true
    })
  })
}
