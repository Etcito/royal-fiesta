import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requirementProblems } from '../../../tools/engineCaptureJob.ts'
import { showRows } from '../../../tools/engineShowCapture.ts'

/** The facts a completed online scenario reports for row 1: two clients, one round, no desync. */
function roundFacts(overrides: Record<string, unknown> = {}) {
  return {
    backend: 'engine',
    gpuErrors: [],
    faults: 0,
    membership: { checks: 1, duplicateSeatIds: [] },
    online: { clients: 2, humans: 2, bots: 58, sameRound: true, lateStartFrames: 30, backgroundFrames: 0, desyncs: 0, peerFaults: 0, ...overrides },
  }
}

/** The facts a completed online scenario reports for row 2: the background client, then the confirmed podium. */
function podiumFacts(progress: Record<string, unknown> = {}) {
  return {
    backend: 'engine',
    gpuErrors: [],
    faults: 0,
    online: { clients: 2, humans: 2, bots: 58, sameRound: true, lateStartFrames: 0, backgroundFrames: 120, desyncs: 0, peerFaults: 0 },
    progress: { podiumConfirmed: true, confirmedWinner: 0, ...progress },
    effects: { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 },
  }
}

test('the online inventory holds the two capture rows in order through the shared validator', () => {
  const rows = showRows('online')
  assert.deepEqual(rows.map(row => row.id), ['engine-online-late-client-round', 'engine-online-background-client-podium'])
  assert.deepEqual(rows.map(row => row.filename), ['engine-online-late-client-round.png', 'engine-online-background-client-podium.png'])
  assert.deepEqual(rows[0].args, { scenario: 'engine-online-late-client-round', testMode: true, seed: 7, humans: 2 })
  assert.deepEqual(rows[1].args, { scenario: 'engine-online-background-client-podium', testMode: true, seed: 7, humans: 2, plan: [60, 12, 1] })
  assert.equal(rows[0].stage, 'online')
  assert.equal(rows[1].stage, 'online')
})

test('requirementProblems accepts a passing online fact object and names each failed online requirement', () => {
  const [round, podium] = showRows('online')
  assert.deepEqual(requirementProblems(roundFacts(), round.require), [])
  assert.deepEqual(requirementProblems(podiumFacts(), podium.require), [])
  const desynced = requirementProblems(roundFacts({ desyncs: 1 }), round.require)
  assert.ok(desynced.some(problem => problem.startsWith('online.desyncs eq 0')))
  const humans = requirementProblems(roundFacts({ humans: 1 }), round.require)
  assert.ok(humans.some(problem => problem.startsWith('online.humans eq 2')))
  const unconfirmed = requirementProblems(podiumFacts({ podiumConfirmed: false }), podium.require)
  assert.ok(unconfirmed.some(problem => problem.startsWith('progress.podiumConfirmed eq true')))
})
