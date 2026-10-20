import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RefusalError, isRefusal, refuse } from '../src/refusal.ts'

const AREA = 'course'
const PATH = 'fixtures/courses/race-sprint.course.json#/obstacles/3/motion/periodS'
const REASON = 'must be > 0; set a positive period'

test('message format and fields', () => {
  const e = new RefusalError(AREA, PATH, REASON)
  assert.equal(e.message, `[course] ${PATH}: ${REASON}`)
  assert.equal(e.area, AREA)
  assert.equal(e.path, PATH)
  assert.equal(e.reason, REASON)
  assert.equal(e.name, 'RefusalError')
  assert.ok(e instanceof Error)
})

test('isRefusal discriminates', () => {
  assert.equal(isRefusal(new RefusalError(AREA, PATH, REASON)), true)
  assert.equal(isRefusal(new Error('x')), false)
  assert.equal(isRefusal('x'), false)
  assert.equal(isRefusal(undefined), false)
})

test('refuse throws a RefusalError', () => {
  assert.throws(
    () => refuse(AREA, PATH, REASON),
    (e: unknown) => isRefusal(e) && e.message === `[course] ${PATH}: ${REASON}`,
  )
})
