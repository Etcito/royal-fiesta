// framePerf: with no ?perf=1 every call is a no-op and reports nothing.
import assert from 'node:assert/strict'
import test from 'node:test'
import { count, end, frameBegin, frameTimings, perfEnabled, span, timed } from '../src/perf/framePerf.ts'

test('perf off: spans cost nothing and frameTimings is empty', () => {
  assert.equal(perfEnabled, false)
  const t = span()
  end('x', t)
  count('y', 1)
  frameBegin()
  assert.equal(timed('z', () => 7), 7)
  const f = frameTimings()
  assert.equal(f.enabled, false)
  assert.deepEqual(f.modules, [])
})
