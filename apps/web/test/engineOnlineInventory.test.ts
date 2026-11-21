import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requirementProblems } from '../../../tools/engineCaptureJob.ts'
import { showRows } from '../../../tools/engineShowCapture.ts'

/** The facts a completed online scenario reports for the late-client row: two clients, one round, no desync. */
function roundFacts(overrides: Record<string, unknown> = {}) {
  return {
    backend: 'engine',
    gpuErrors: [],
    faults: 0,
    membership: { checks: 1, duplicateSeatIds: [] },
    online: { clients: 2, humans: 2, bots: 58, sameRound: true, lateStartFrames: 30, backgroundFrames: 0, desyncs: 0, peerFaults: 0, ...overrides },
  }
}

test('the online inventory holds exactly the late-client round row through the shared validator', () => {
  const rows = showRows('online')
  assert.deepEqual(rows.map(row => row.id), ['engine-online-late-client-round'])
  assert.equal(rows[0].filename, 'engine-online-late-client-round.png')
  assert.equal(rows[0].stage, 'online')
  assert.deepEqual(rows[0].args, { scenario: 'engine-online-late-client-round', testMode: true, seed: 7, humans: 2 })
})

test('no online row requires progress or effects facts', () => {
  for (const row of showRows('online')) {
    for (const line of row.require) {
      assert.ok(!line.startsWith('progress.') && !line.startsWith('effects.'), `${row.id}: ${line}`)
    }
  }
})

test('requirementProblems accepts a passing online fact object and names each failed online requirement', () => {
  const [round] = showRows('online')
  assert.deepEqual(requirementProblems(roundFacts(), round.require), [])
  const desynced = requirementProblems(roundFacts({ desyncs: 1 }), round.require)
  assert.ok(desynced.some(problem => problem.startsWith('online.desyncs eq 0')))
  const humans = requirementProblems(roundFacts({ humans: 1 }), round.require)
  assert.ok(humans.some(problem => problem.startsWith('online.humans eq 2')))
})
