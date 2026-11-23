import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requirementProblems, validRequirement } from '../../../tools/engineCaptureJob.ts'
import { showRows } from '../../../tools/engineShowCapture.ts'
import { parseShowArgs } from '../src/engineShow/ops.ts'

const SWAP_SCENARIO = 'engine-saved-script-applied'

/** The facts a completed saved-script scenario reports for the swap row: one rejected edit, one applied. */
function swapFacts(overrides: Record<string, unknown> = {}) {
  return {
    backend: 'engine',
    gpuErrors: [],
    faults: 0,
    local: { sampledTicks: 120 },
    effects: { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 },
    swap: {
      rejectedKept: true,
      rejectedDiagnostics: 1,
      applied: true,
      generation: 2,
      appliedRevision: 2,
      moduleChanged: true,
      tickPreserved: true,
      roundPreserved: true,
      riseBeforeM: 0.5,
      riseAfterM: 1.2,
      behaviorChanged: true,
      signals: 1,
      faults: 0,
      ...overrides,
    },
  }
}

test('the swap inventory holds exactly the saved-script-applied row through the shared validator', () => {
  const rows = showRows('swap')
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.equal(row.id, SWAP_SCENARIO)
  assert.equal(row.stage, 'swap')
  assert.equal(row.filename, 'engine-saved-script-applied.png')
  assert.deepEqual(row.args, { scenario: SWAP_SCENARIO, testMode: true, seed: 7, humans: 1 })
  assert.deepEqual(row.require, [
    'backend eq "engine"',
    'gpuErrors empty',
    'faults eq 0',
    'local.sampledTicks gt 0',
    'effects.droppedRecords eq 0',
    'effects.repeatedSoundDeliveries eq 0',
    'effects.repeatedGrantDeliveries eq 0',
    'swap.rejectedKept eq true',
    'swap.rejectedDiagnostics gt 0',
    'swap.applied eq true',
    'swap.generation eq 2',
    'swap.moduleChanged eq true',
    'swap.tickPreserved eq true',
    'swap.roundPreserved eq true',
    'swap.behaviorChanged eq true',
    'swap.signals eq 1',
    'swap.faults eq 0',
  ])
})

test('the swap row arguments parse against its own scenario id', () => {
  const [row] = showRows('swap')
  assert.deepEqual(parseShowArgs(row.args, new Set([SWAP_SCENARIO])), row.args)
})

test('every swap requirement rule matches the E8 grammar', () => {
  for (const rule of showRows('swap')[0].require) assert.ok(validRequirement(rule), rule)
})

test('requirementProblems accepts passing swap facts and names a changed behavior exactly once', () => {
  const [row] = showRows('swap')
  assert.deepEqual(requirementProblems(swapFacts(), row.require), [])
  const changed = requirementProblems(swapFacts({ behaviorChanged: false }), row.require)
  assert.equal(changed.length, 1)
  assert.ok(changed[0].startsWith('swap.behaviorChanged eq true'))
})
