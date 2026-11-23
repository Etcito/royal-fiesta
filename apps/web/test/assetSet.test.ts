// assetSet: the engine show lists only the season's race courses; every other race course's assets stay out.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import { assetSet } from '../src/content/assetSet.ts'

const course = (id: string, kind: string, assetIds: string[]): CourseV1 => ({ id, kind, sim: kind === 'race' ? {} : null, assetIds } as unknown as CourseV1)

test('onlyRaceCourses drops the assets of race courses outside the season', () => {
  const courses = [course('in', 'race', ['a.in']), course('out', 'race', ['a.out']), course('hub-plaza', 'hub', ['a.hub']), course('podium', 'podium', ['a.podium'])]
  const byId = new Map(courses.map(c => [c.id, c]))
  const all = assetSet(courses, byId, 'sprint')
  const some = assetSet(courses, byId, 'sprint', [], new Set(['in']))
  assert.ok(all.includes('a.out') && all.includes('a.in'))
  assert.ok(some.includes('a.in') && some.includes('a.hub') && some.includes('a.podium'))
  assert.ok(!some.includes('a.out'))
})
