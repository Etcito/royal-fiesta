import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderScale } from '../src/perf/renderScale.ts'

test('renderScale defaults to 1 without a ?scale parameter', () => {
  assert.equal(renderScale, 1)
})
