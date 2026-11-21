import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEUTRAL_CODE, inputCode } from '@royal-fiesta/sim/input'
import {
  createShowPacer, parseShowArgs, registerEngineShowOps, registerScenario, runShowOperation, scenarioIds, watchShowErrors,
  ShowFactsCollector, BOT_CHECK_TICKS, isBotCheckTick, showSeatPoses, PODIUM_PLAN, PODIUM_REQUIRE, ROUND_REQUIRE, SHOW_COMMON_REQUIRE, SHOW_SCENARIO_IDS, SHOW_SCENARIO_REQUIRE, SIMPLE_REQUIRE,
} from '../src/engineShow/ops.ts'
import type { EngineShowFacts } from '../src/engineShow/ops.ts'
import { requirementProblems } from '../../../tools/engineCaptureJob.ts'
import { isRefusal } from '../../../packages/sim/src/refusal.ts'
import { showRows } from '../../../tools/engineShowCapture.ts'
import type { EngineShowPage } from '../src/engineShow/page.ts'
import { EngineSeatPresenter, farPenguinBridge } from '../src/engineShow/presentation.ts'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { createEngineShow } from '@royal-fiesta/game/ege/showRuntime'
import type { EngineShowConfig, EngineShowObservation } from '@royal-fiesta/game/ege/showTypes'
import { applyConfigOverrides } from '../src/engineShow/page.ts'
import { loadEngineShowContent } from '../../headless/src/engineShow.ts'
import { rfScriptBytes } from '../../headless/src/egeHarness.ts'
import { readRepoText } from '../../headless/src/files.ts'
import { engineShowTestMode } from '../src/engineShow/testMode.ts'

type Vec3 = readonly [number, number, number]

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
  // The optional plan passes through unchanged; a row without one keeps its scenario's plan.
  assert.equal('plan' in parseShowArgs(ARGS), false)
  assert.deepEqual(parseShowArgs({ ...ARGS, plan: [60, 12, 1] }).plan, [60, 12, 1])
  assert.deepEqual(PODIUM_PLAN, [60, 12, 1])
  for (const plan of [[], [60], [60, 60, 1], [12, 60, 1], [60, 12], [60, 1.5, 1], [60, 0, 1], '60,12,1']) {
    assert.throws(() => parseShowArgs({ ...ARGS, plan }), /plan/)
  }
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

test('the scenario pacer yields between slices, publishes the position and keeps the tick order', async () => {
  let clock = 0
  const phases: string[] = []
  const yields: boolean[] = []
  const pacer = createShowPacer('probe', {
    sliceMs: 100, budgetMs: 10_000, now: () => clock, phase: text => phases.push(text),
    yieldTask: async timer => { yields.push(timer) },
  })
  const order: number[] = []
  for (let i = 0; i < 60; i++) {
    order.push(i)
    clock += 40
    await pacer.tick(() => `round 0 screen 'playing' tick ${i}`)
  }
  assert.deepEqual(order, Array.from({ length: 60 }, (_, i) => i))
  assert.equal(yields.length, 20, 'three 40 ms ticks fill one 100 ms slice')
  assert.ok(yields.includes(true) && yields.includes(false), 'timer tasks and plain tasks both get a turn')
  assert.equal(phases.length, yields.length)
  assert.match(phases[0], /^engine-show: probe: round 0 screen 'playing' tick 2; 3 ticks stepped at 25 ticks\/s$/)
})

test('the scenario pacer refuses past the page budget and names where the show stood', async () => {
  let clock = 0
  const phases: string[] = []
  const pacer = createShowPacer('engine-show-winner-podium', {
    sliceMs: 100, budgetMs: 1000, now: () => clock, phase: text => phases.push(text), yieldTask: async () => undefined,
  })
  const run = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      clock += 50
      await pacer.tick(() => `round 1 screen 'playing' tick ${i}`)
    }
  }
  await assert.rejects(run(), /engine-show-winner-podium passed its 1 s page budget at round 1 screen 'playing' tick 21; 22 ticks stepped at 20 ticks\/s/)
  assert.match(phases.at(-1) ?? '', /tick 21/, 'the failing position is also the last published progress')
})

test('the page failure watch keeps every console error, uncaught error, rejection and failed load once', () => {
  const printed: unknown[][] = []
  const fakeConsole = { error: (...values: unknown[]) => { printed.push(values) } }
  const original = fakeConsole.error
  const listeners = new Map<string, (event: unknown) => void>()
  const fakeWindow = {
    addEventListener: (type: string, listener: (event: never) => void) => { listeners.set(type, listener as (event: unknown) => void) },
    removeEventListener: (type: string) => { listeners.delete(type) },
  }
  const watch = watchShowErrors({ console: fakeConsole, window: fakeWindow })
  fakeConsole.error('[sdf-port] texture.atlas_full', 'jungle.floor-tile#jungle_floor_tile/__root__')
  fakeConsole.error('[sdf-port] texture.atlas_full', 'jungle.floor-tile#jungle_floor_tile/__root__')
  listeners.get('error')?.({ message: "show effects: entity 0 has no publisher for event 'ege.contact'" })
  listeners.get('error')?.({ target: { tagName: 'SCRIPT', src: 'assets/missing.js' } })
  listeners.get('unhandledrejection')?.({ reason: new Error('upload paint stalled') })
  assert.deepEqual(watch.errors(), [
    'console.error: [sdf-port] texture.atlas_full jungle.floor-tile#jungle_floor_tile/__root__',
    "error: show effects: entity 0 has no publisher for event 'ege.contact'",
    'failed load: script assets/missing.js',
    'unhandled rejection: upload paint stalled',
  ])
  assert.equal(printed.length, 2, 'the console still prints')
  watch.stop()
  assert.equal(fakeConsole.error, original)
  assert.equal(listeners.size, 0)
})

test('a failing scenario still reports every page error seen in the same pass', async () => {
  registerScenario('failing-pass-probe', async () => {
    console.error('[sdf-port] texture.atlas_full probe#g/body')
    throw new Error('the show stopped early')
  })
  const page = Promise.resolve({ ready: Promise.resolve(), state: () => { throw new Error('unused') }, dispose() {}, presentation: () => null } as EngineShowPage)
  await assert.rejects(runShowOperation(page, { ...ARGS, scenario: 'failing-pass-probe' }),
    /the show stopped early \| page errors: console\.error: \[sdf-port\] texture\.atlas_full probe#g\/body/)
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

test('the hub inventory parses through the shared validator', () => {
  const rows = showRows('hub')
  assert.deepEqual(rows.map(row => row.id), ['engine-hub-walking-and-emotes', 'engine-show-returned-to-hub'])
  for (const row of rows) {
    assert.equal(row.stage, 'hub')
    assert.equal(row.filename, `${row.id}.png`)
  }
  assert.deepEqual(rows[0].args, { scenario: 'engine-hub-walking-and-emotes', testMode: true, seed: 7, humans: 1 })
  assert.deepEqual(rows[1].args, { scenario: 'engine-show-returned-to-hub', testMode: true, seed: 7, humans: 1, plan: [60, 12, 1] })
  assert.deepEqual(rows.map(row => row.require), [
    ['backend eq "engine"', 'gpuErrors empty', 'hub.ready eq true', 'hub.faults eq 0', 'hub.localMoved eq true',
      'hub.localEmote gt 0', 'hub.remoteEmote gt 0', 'hub.lobbyBots eq 4', 'hub.botsMoved gt 0'],
    ['backend eq "engine"', 'gpuErrors empty', 'faults eq 0', 'hub.ready eq true', 'hub.faults eq 0',
      'progress.completedRounds ge 2', 'progress.confirmedWinner ge 0', 'progress.podiumConfirmed eq true',
      'effects.droppedRecords eq 0', 'effects.repeatedSoundDeliveries eq 0', 'effects.repeatedGrantDeliveries eq 0',
      'hub.returned eq 1', 'hub.spawnRestored eq true', 'hub.movedAfterReturn eq true', 'hub.emoteAfterReturn gt 0',
      'hub.lobbyBots eq 4'],
  ])
  assert.throws(() => showRows('missing'), (error: unknown) => isRefusal(error))
  assert.equal(showRows().length, 3)
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

test('far seats decoded by EngineFarView reach the far-figure draw input as penguins at their course positions', () => {
  const ALL = Array.from({ length: 60 }, (_, seat) => seat)
  const NEAR = new Set(ALL.slice(0, 8))
  // Seat n stands at x = n * 1.8 - 18 on the authored start grid row, z = -4, one metre up (world metres).
  const poseOf = (seat: number): readonly [number, number, number] => [seat * 1.8 - 18, 1, -4]
  const bytes = new Uint8Array(2 + ALL.length * 60)
  const raw = new DataView(bytes.buffer)
  raw.setUint16(0, ALL.length, true)
  ALL.forEach((seat, i) => {
    const at = 2 + i * 60
    raw.setUint32(at, seat + 1, true)
    poseOf(seat).forEach((value, n) => raw.setFloat64(at + 4 + n * 8, value, true))
    raw.setFloat64(at + 52, 1, true)
  })
  const presentationWorld = {
    ref: { domain: 1, kind: 'seat', world: 1 },
    incarnation: 1,
    seats: ALL.map((roomSeat, roundSeat) => ({ roomSeat, roundSeat, inputSlot: roomSeat === 0 ? 0 : -1, entity: 100 + roomSeat })),
    farSnapshot: () => bytes.slice(),
  }
  const snapshot = { tick: 1, round: 0, screen: 'playing', seatOf: ALL, alive: ALL, candidates: [], results: [], champion: null, faults: 0 }
  const presenter = new EngineSeatPresenter({ tick: () => 1, parked: () => new Set() })
  presenter.observe({
    kind: 'post-tick', tick: 1, snapshot,
    presentation: { showId: 's', tick: 1, round: 0, map: 'm0', course: null, worlds: [presentationWorld] },
  } as never, NEAR)
  const submission = presenter.submission()
  assert.equal(submission.near.size, 8)
  assert.equal(submission.far.size, 52)

  const registered: string[] = []
  const created = new Map<number, Vec3>()
  const placed = new Map<number, { pos: readonly number[]; scale: readonly number[] }>()
  const port = {
    registerAsset: (id: string) => { registered.push(id); return 7 },
    createInstance: (asset: number) => { assert.equal(asset, 7); const id = created.size + 1; created.set(id, [0, 0, 0]); return id },
    setTransform: (id: number, pos: readonly number[], _rot: readonly number[], scale: readonly number[]) => { placed.set(id, { pos, scale }) },
    setVisible: () => {},
    destroyInstance: () => {},
  }
  const bridge = farPenguinBridge(port as never, { id: 'zone.far-bean' } as never)
  bridge.sync(submission.view)
  assert.deepEqual(registered, ['zone-far-bean'])
  assert.equal(bridge.instances, submission.far.size)
  assert.equal(placed.size, 52)
  const positions = [...placed.values()].map(item => item.pos.map(Math.fround).join(','))
  for (const seat of ALL.slice(8)) {
    assert.ok(positions.includes(poseOf(seat).map(Math.fround).join(',')), `seat ${seat} is drawn at its course position`)
  }
  // The near scene draws its figures at unit scale; a far figure is the same penguin at the same scale.
  for (const item of placed.values()) assert.deepEqual([...item.scale], [1, 1, 1])
  bridge.dispose()
})

test('bot movement is measured between bot checks, not between per-tick local samples', () => {
  const collector = new ShowFactsCollector({ seats: 60, humans: 1, bots: 59 })
  const at = (x: number) => new Map<number, readonly [number, number, number]>([[0, [0, 0, 0]], [5, [x, 0, 0]]])
  collector.observeBots(at(0))
  collector.observeBots(at(0.05))
  assert.equal(collector.botCount(), 0)
  collector.observeBots(at(3))
  assert.equal(collector.botCount(), 1)
})

test('the sixty-seat test-mode round moves its scripted bots and botsMoved reads positive through the page bot checks', async () => {
  // Same construction as the page's sixty-seat-engine-round: authored courses and season, one human
  // at room seat 0, default plan, test mode; the 59 bots are never sampled, their brains drive them.
  const content = await loadEngineShowContent()
  const engine = await loadEngine()
  const schemaText = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schemaText)
  const runtime = await createEngineShow({
    engine, schemaText, scriptBytes: await rfScriptBytes(), seed: 7,
    identity: { backend: 'engine', schemaKey: schemaLayout(engine).key, moduleKey: 'test' },
    courses: content.courses, assets: content.assets, zones: content.zones, season: content.season,
    humans: Array.from({ length: 60 }, (_, seat) => seat === 0), testMode: engineShowTestMode(true).enabled,
  })
  const collector = new ShowFactsCollector({ seats: 60, humans: 1, bots: 59 })
  const first = new Map<number, readonly [number, number, number]>()
  let moved = false
  let checks = 0
  const unsubscribe = runtime.onPresentation((observation: EngineShowObservation) => {
    if (observation.kind !== 'post-tick' || !isBotCheckTick(observation.tick)) return
    const poses = showSeatPoses(observation.presentation, 60)
    if (poses.size === 0) return
    checks++
    for (const [seat, pos] of poses) {
      if (seat === 0) continue
      const was = first.get(seat)
      if (was === undefined) first.set(seat, pos)
      else if (Math.hypot(pos[0] - was[0], pos[2] - was[2]) > 0.1) moved = true
    }
    collector.observeBots(poses)
  })
  try {
    const neutral = inputCode({ moveX: 0, moveZ: 0, jump: false, dive: false, grab: false })
    for (let frame = 0; frame < 4000 && (checks < 2 || collector.botCount() === 0 || !moved); frame++) {
      runtime.frame(8 / 60, () => neutral)
      assert.equal(runtime.snapshot().faults, 0)
    }
    assert.ok(checks >= 2, `only ${checks} bot check(s) every ${BOT_CHECK_TICKS} ticks saw a physics world`)
    assert.ok(moved, 'no scripted bot changed its engine position')
    collector.effects({ droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 })
    assert.ok(collector.facts().botsMoved > 0, 'botsMoved is 0')
  } finally {
    unsubscribe()
    runtime.dispose()
  }
})

function configBase(): EngineShowConfig {
  return {
    engine: null as unknown as EngineShowConfig['engine'],
    schemaText: '{}',
    scriptBytes: new Uint8Array(),
    identity: { backend: 'engine', schemaKey: 1, moduleKey: 'test' },
    seed: 7,
    courses: [],
    assets: new Map(),
    zones: new Map(),
    season: [],
    humans: Array.from({ length: 60 }, () => false),
  }
}

test('configuration overrides keep the base config and replace humans and plan or refuse visibly', () => {
  const base = configBase()
  const kept = applyConfigOverrides(base)
  assert.deepEqual(kept.humans, base.humans)
  assert.equal(kept.plan, undefined)
  assert.equal(kept.seed, base.seed)
  assert.deepEqual(kept.identity, base.identity)
  const three = applyConfigOverrides(base, { humans: 3 })
  assert.equal(three.humans.length, 60)
  assert.deepEqual(three.humans, Array.from({ length: 60 }, (_, seat) => seat < 3))
  assert.equal(three.plan, undefined)
  assert.deepEqual(applyConfigOverrides({ ...base, plan: [60, 1] }, { plan: [60, 12, 1] }).plan, [60, 12, 1])
  const planned = applyConfigOverrides(base, { humans: 1, plan: [60, 12, 1] })
  assert.deepEqual(planned.humans, Array.from({ length: 60 }, (_, seat) => seat === 0))
  assert.deepEqual(planned.plan, [60, 12, 1])
  for (const humans of [0, 9, 1.5]) {
    assert.throws(() => applyConfigOverrides(base, { humans }), (error: unknown) =>
      isRefusal(error) && error.area === 'engine-show' && error.path === 'overrides.humans')
  }
  for (const plan of [[], [0], [60, 1.5, 1]]) {
    assert.throws(() => applyConfigOverrides(base, { plan }), (error: unknown) =>
      isRefusal(error) && error.area === 'engine-show' && error.path === 'overrides.plan')
  }
})
