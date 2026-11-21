import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEUTRAL_CODE, inputCode } from '@royal-fiesta/sim/input'
import {
  parseShowArgs, registerEngineShowOps, registerScenario, runShowOperation, scenarioIds,
  ShowFactsCollector, PODIUM_REQUIRE, ROUND_REQUIRE, SHOW_COMMON_REQUIRE, SHOW_SCENARIO_IDS, SHOW_SCENARIO_REQUIRE, SIMPLE_REQUIRE,
} from '../src/engineShow/ops.ts'
import type { EngineShowFacts } from '../src/engineShow/ops.ts'
import { requirementProblems } from '../../../tools/engineCaptureJob.ts'
import { showRows } from '../../../tools/engineShowCapture.ts'
import type { EngineShowPage } from '../src/engineShow/page.ts'

const ARGS = { scenario: 'simple-engine-character', testMode: true, seed: 7, humans: 1 }

function factsOf(scenario: string): EngineShowFacts {
  const base = {
    backend: 'engine' as const, seats: 60, humans: 1, bots: 59, faults: 0, gpuErrors: [],
    local: {
      sampledTicks: 12, neutralObserved: true, positiveDirectionObserved: true, negativeDirectionObserved: true,
      jumpObserved: true, diveObserved: true, grabObserved: true, positionChanged: true,
    },
    botsMoved: 9,
    membership: { checks: 3, nearSeats: 8, farSeats: 52, duplicateSeatIds: [] as number[] },
    progress: {
      completedRounds: 0, visitedCourseIds: [] as string[], distinctCourses: 0, confirmedWinner: null as number | null,
      podiumConfirmed: false,
    },
    effects: { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 },
  }
  if (scenario === 'sixty-seat-engine-round') {
    base.progress = { completedRounds: 1, visitedCourseIds: ['s1-b-butterfly-freeway'], distinctCourses: 1, confirmedWinner: null, podiumConfirmed: false }
  }
  if (scenario === 'engine-show-winner-podium') {
    base.progress = {
      completedRounds: 3, visitedCourseIds: ['s1-b-butterfly-freeway', 's1-c1-diamond-citadel'], distinctCourses: 2,
      confirmedWinner: 5, podiumConfirmed: true,
    }
  }
  return base
}

function copy(facts: EngineShowFacts): EngineShowFacts {
  return JSON.parse(JSON.stringify(facts)) as EngineShowFacts
}

test('show arguments reject unknown fields, scenarios and invalid values', () => {
  assert.deepEqual(parseShowArgs(ARGS), ARGS)
  assert.throws(() => parseShowArgs({ ...ARGS, extra: 1 }), /extra/)
  assert.throws(() => parseShowArgs({ ...ARGS, scenario: 'unknown' }), /scenario/)
  assert.throws(() => parseShowArgs({ ...ARGS, testMode: false }), /testMode/)
  assert.throws(() => parseShowArgs({ ...ARGS, humans: 9 }), /humans/)
  assert.throws(() => parseShowArgs({ ...ARGS, seed: -1 }), /seed/)
  assert.throws(() => parseShowArgs(null), /object/)
})

test('scenario registration is early, typed and refuses duplicates', () => {
  assert.throws(() => registerScenario('Bad_Id', async () => { throw new Error() }), /hyphenated/)
  const run = async () => ({ facts: {}, capture: { name: 'x.png', width: 1920, height: 1080, mime: 'image/png' as const, base64: '' } })
  registerScenario('registration-probe', run)
  assert.ok(scenarioIds().includes('registration-probe'))
  assert.throws(() => registerScenario('registration-probe', run), /duplicate/)
})

test('the engineShow operation is installed before the page and awaits the real readiness', async () => {
  let resolvePage!: (page: EngineShowPage) => void
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  const page = new Promise<EngineShowPage>(resolve => { resolvePage = resolve })
  let called = false
  registerScenario('early-registration-probe', async () => {
    called = true
    return { facts: { observed: true }, capture: { name: 'early.png', width: 1920, height: 1080, mime: 'image/png', base64: '' } }
  })
  const scope = globalThis as unknown as { window: { nmcGpu: { ops: Record<string, (input: unknown) => Promise<unknown>> }; addEventListener: () => void; removeEventListener: () => void } }
  scope.window = { nmcGpu: { ops: {} }, addEventListener: () => undefined, removeEventListener: () => undefined }
  try {
    registerEngineShowOps(page)
    const op = scope.window.nmcGpu.ops.engineShow
    assert.equal(typeof op, 'function')
    let settled = false
    const result = op({ ...ARGS, scenario: 'early-registration-probe' }).then(value => { settled = true; return value })
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    assert.equal(called, false, 'the scenario waits for the page promise')
    assert.equal(settled, false, 'the operation waits for readiness')
    resolvePage({ ready, state: () => { throw new Error('unused') }, dispose() {}, presentation: () => null })
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    assert.equal(called, false, 'the scenario waits for page.ready')
    resolveReady()
    const out = await result as { json: { facts: Record<string, unknown> } }
    assert.equal(called, true)
    assert.deepEqual(out.json.facts.gpuErrors, [])
    await assert.rejects(runShowOperation(page, { ...ARGS, scenario: 'missing-scenario' }), /not registered|unknown/)
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
})

test('the shared facts collector counts real samples, audits, progress and effects', () => {
  const collector = new ShowFactsCollector({ seats: 60, humans: 1, bots: 59 })
  collector.effects({ droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 })
  collector.sample({ code: NEUTRAL_CODE, stored: NEUTRAL_CODE, before: [0, 0, 0], after: [0, 0, 0], mode: 0 })
  collector.sample({ code: inputCode({ moveZ: 1 }), stored: inputCode({ moveZ: 1 }), before: [0, 0, 0], after: [0, 0, 2], mode: 0 })
  collector.sample({ code: inputCode({ moveZ: -1 }), stored: inputCode({ moveZ: -1 }), before: [0, 0, 0], after: [0, 0, -2], mode: 0 })
  collector.sample({ code: inputCode({ jump: true, dive: true, grab: true }), stored: inputCode({ jump: true, dive: true, grab: true }), before: null, after: null, mode: 0 })
  collector.botMoved(3)
  collector.botMoved(3)
  collector.botMoved(7)
  collector.audit([0, 1], [1, 2])
  collector.progress({ snapshot: { round: 0, results: [], champion: null, screen: 'playing' }, course: 'c1', tick: 5 })
  collector.progress({
    snapshot: { round: 1, results: [{ index: 0, course: 'c1', endTick: 10, champion: -1 }], champion: null, screen: 'playing' },
    course: 'c2', tick: 20,
  })
  collector.progress({
    snapshot: {
      round: 2,
      results: [{ index: 0, course: 'c1', endTick: 10, champion: -1 }, { index: 1, course: 'c2', endTick: 30, champion: 7 }],
      champion: 7, screen: 'podium',
    },
    course: null, tick: 40,
  })
  collector.scriptFaults(0)
  const facts = collector.facts()
  assert.equal(facts.local.sampledTicks, 4)
  assert.deepEqual(
    [facts.local.neutralObserved, facts.local.positiveDirectionObserved, facts.local.negativeDirectionObserved, facts.local.jumpObserved, facts.local.diveObserved, facts.local.grabObserved, facts.local.positionChanged],
    [true, true, true, true, true, true, true],
  )
  assert.equal(facts.botsMoved, 2)
  assert.deepEqual(facts.membership, { checks: 1, nearSeats: 2, farSeats: 2, duplicateSeatIds: [1] })
  assert.deepEqual(facts.progress, {
    completedRounds: 2, visitedCourseIds: ['c1', 'c2'], distinctCourses: 2, confirmedWinner: 7, podiumConfirmed: true,
  })
  const mismatch = new ShowFactsCollector({ seats: 60, humans: 1, bots: 59 })
  assert.throws(() => mismatch.progress({
    snapshot: { round: 0, results: [{ index: 0, course: 'other', endTick: 10, champion: -1 }], champion: null, screen: 'results' },
    course: 'c1', tick: 11,
  }), /confirmed 'other'/)
})

test('the offline inventory parses through the shared validator with the exact ordered requirements', () => {
  const rows = showRows()
  assert.deepEqual(rows.map(row => row.id), [...SHOW_SCENARIO_IDS])
  for (const row of rows) {
    assert.equal(row.stage, 'offline')
    assert.equal(row.filename, `${row.id}.png`)
    assert.deepEqual(row.args, { scenario: row.id, testMode: true, seed: 7, humans: 1 })
    assert.deepEqual(row.require, SHOW_SCENARIO_REQUIRE[row.id])
    assert.ok(row.held_constant.length > 0)
  }
  assert.deepEqual(SHOW_SCENARIO_REQUIRE['simple-engine-character'], SIMPLE_REQUIRE)
  assert.deepEqual(SHOW_SCENARIO_REQUIRE['sixty-seat-engine-round'], ROUND_REQUIRE)
  assert.deepEqual(SHOW_SCENARIO_REQUIRE['engine-show-winner-podium'], PODIUM_REQUIRE)
  for (const require of [SIMPLE_REQUIRE, ROUND_REQUIRE, PODIUM_REQUIRE]) {
    assert.deepEqual(require.slice(0, SHOW_COMMON_REQUIRE.length), SHOW_COMMON_REQUIRE)
  }
})

test('valid simple, round and podium facts pass their own requirements', () => {
  for (const scenario of SHOW_SCENARIO_IDS) {
    const facts = factsOf(scenario)
    assert.deepEqual(requirementProblems(facts, [...SHOW_SCENARIO_REQUIRE[scenario]]), [], scenario)
    const row = showRows().find(item => item.id === scenario)!
    assert.deepEqual(requirementProblems(facts, row.require), [], scenario)
  }
})

test('missing fields, unconfirmed winners, zero audits, all-near frames and duplicates fail', () => {
  const simple = copy(factsOf('simple-engine-character'))
  delete (simple.local as { sampledTicks?: number }).sampledTicks
  assert.ok(requirementProblems(simple, SIMPLE_REQUIRE).some(problem => problem.includes('local.sampledTicks')))

  const zero = copy(factsOf('simple-engine-character'))
  zero.local.sampledTicks = 0
  assert.ok(requirementProblems(zero, SIMPLE_REQUIRE).some(problem => problem.includes('local.sampledTicks')))

  const podiumNull = copy(factsOf('engine-show-winner-podium'))
  podiumNull.progress.confirmedWinner = null
  assert.ok(requirementProblems(podiumNull, PODIUM_REQUIRE).some(problem => problem.includes('confirmedWinner')))

  const podiumUnconfirmed = copy(factsOf('engine-show-winner-podium'))
  podiumUnconfirmed.progress.podiumConfirmed = false
  assert.ok(requirementProblems(podiumUnconfirmed, PODIUM_REQUIRE).some(problem => problem.includes('podiumConfirmed')))

  const zeroAudits = copy(factsOf('simple-engine-character'))
  zeroAudits.membership.checks = 0
  assert.ok(requirementProblems(zeroAudits, SIMPLE_REQUIRE).some(problem => problem.includes('membership.checks')))

  const allNear = copy(factsOf('sixty-seat-engine-round'))
  allNear.membership.farSeats = 0
  assert.ok(requirementProblems(allNear, ROUND_REQUIRE).some(problem => problem.includes('membership.farSeats')))

  const duplicated = copy(factsOf('simple-engine-character'))
  duplicated.membership.duplicateSeatIds = [4, 9]
  assert.ok(requirementProblems(duplicated, SIMPLE_REQUIRE).some(problem => problem.includes('duplicateSeatIds')))
})

test('insufficient physical-course progression and nonzero effect errors fail', () => {
  const oneCourse = copy(factsOf('engine-show-winner-podium'))
  oneCourse.progress.visitedCourseIds = ['s1-b-butterfly-freeway']
  oneCourse.progress.distinctCourses = 1
  assert.ok(requirementProblems(oneCourse, PODIUM_REQUIRE).some(problem => problem.includes('distinctCourses')))

  const fewRounds = copy(factsOf('engine-show-winner-podium'))
  fewRounds.progress.completedRounds = 1
  assert.ok(requirementProblems(fewRounds, PODIUM_REQUIRE).some(problem => problem.includes('completedRounds')))

  const effects = copy(factsOf('sixty-seat-engine-round'))
  effects.effects = { droppedRecords: 1, repeatedSoundDeliveries: 1, repeatedGrantDeliveries: 1 }
  const problems = requirementProblems(effects, ROUND_REQUIRE)
  assert.ok(problems.some(problem => problem.includes('droppedRecords')))
  assert.ok(problems.some(problem => problem.includes('repeatedSoundDeliveries')))
  assert.ok(problems.some(problem => problem.includes('repeatedGrantDeliveries')))
})
