import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { engineCodeOfS1 } from '@royal-fiesta/game/ege/inputCodes'
import { buildShowRulesScene } from '@royal-fiesta/game/ege/showScene'
import { createEngineShow } from '@royal-fiesta/game/ege/showRuntime'
import { readShowRoundResult, readShowState } from '@royal-fiesta/game/ege/showState'
import type { EngineShowConfig, EngineShowRuntime, EngineShowSnapshot } from '@royal-fiesta/game/ege/showTypes'
import { legacyLevel } from '@royal-fiesta/sim/course'
import { encodeInput } from '@royal-fiesta/sim/input'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { parseZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

const engine = await loadEngine()
const schemaText = await readRepoText(RF_EGE_SCHEMA)
engine.setSchema(schemaText)
const layout = schemaLayout(engine)
const script = await rfScriptBytes()

// The runtime is exercised on the real strip course with a short authored gameplay cap so a full
// show fits a test; the runtime itself never shortens a cap (testMode only shortens presentation).
const loaded = await loadEgeCourse('ege-strip')
const level = { ...(loaded.course.sim!.level ?? legacyLevel(loaded.course.sim!)), timeCapTicks: 600, overtimeTicks: 0 }
const course = { ...loaded.course, sim: { ...loaded.course.sim!, level } } as typeof loaded.course
const zones = new Map([[course.id, parseZonesFile({
  format: 'royal-fiesta.zones', version: 0, course: course.id,
  grid: { origin: [-32, -64], cell: [2, 2], cols: 32, rows: 64 }, parts: {}, tuning: {},
}, `courses/${course.id}.zones.json`, course.sim!)]])

const season = [
  { id: 'A', course: 0, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: false },
  { id: 'B', course: 0, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: false },
  { id: 'Q', course: 0, kind: 'final', finalRule: 'crown', stages: ['final'], team: false, cut: false },
] as const

function humansAt(rooms: readonly number[]): boolean[] {
  return Array.from({ length: 60 }, (_, room) => rooms.includes(room))
}

function showConfig(humans: readonly boolean[], over: Partial<EngineShowConfig> = {}): EngineShowConfig {
  return {
    engine, schemaText, scriptBytes: script.slice(), seed: 7,
    identity: { backend: 'engine', schemaKey: layout.key, moduleKey: 'publication' },
    courses: [course], assets: loaded.assets, zones, season, humans, plan: [60, 2], testMode: true,
    ...over,
  }
}

const NEUTRAL = encodeInput({ moveX: 0, moveZ: 0, jump: false, dive: false, grab: false })
const MOVE = encodeInput({ moveX: 1, moveZ: 1, jump: true, dive: false, grab: false })
// The landed show controller decodes `show_control.code` as the S1 wire code while the controls
// script copies the engine input code; these S1 samples convert once (engineCodeOfS1) to engine
// bytes the landed decode reads as forward (254) and half forward (190).
const SHOW_FORWARD = 254 | (125 << 8)
const SHOW_HALF = 254 | (61 << 8)

test('frame accumulates finite seconds, caps at eight ticks and samples active humans once per tick', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([2, 45])))
  try {
    const calls: number[] = []
    const start = nextTick(runtime)
    runtime.frame(0.001, room => { calls.push(room); return NEUTRAL })
    assert.equal(calls.length, 0)
    assert.equal(nextTick(runtime), start)

    runtime.frame(1 / 60, room => { calls.push(room); return NEUTRAL })
    assert.deepEqual(calls, [2, 45])
    assert.equal(nextTick(runtime), start + 1)

    calls.length = 0
    runtime.frame(9 / 60, room => { calls.push(room); return NEUTRAL })
    assert.equal(calls.length, 16)
    assert.deepEqual(calls.slice(0, 4), [2, 45, 2, 45])
    assert.equal(nextTick(runtime), start + 9)

    calls.length = 0
    runtime.frame(0, room => { calls.push(room); return NEUTRAL })
    assert.deepEqual(calls, [2, 45])
    assert.equal(nextTick(runtime), start + 10)

    for (const dt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const before = nextTick(runtime)
      calls.length = 0
      assert.throws(() => runtime.frame(dt, room => { calls.push(room); return NEUTRAL }), RefusalError)
      assert.equal(calls.length, 0)
      assert.equal(nextTick(runtime), before)
    }

    for (const bad of [4294967296, -1, 1.5, Number.NaN, undefined]) {
      const before = nextTick(runtime)
      assert.throws(() => runtime.frame(1 / 60, () => bad as number), RefusalError)
      assert.equal(nextTick(runtime), before)
    }
    const boom = new Error('sampler failed')
    const before = nextTick(runtime)
    assert.throws(() => runtime.frame(1 / 60, () => { throw boom }), error => error === boom)
    assert.equal(nextTick(runtime), before)
  } finally { runtime.dispose() }
})

test('frame converts sampled S1 codes once and routes them through the mapped human slots', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([0, 31])))
  try {
    for (let i = 0; i < 3; i++) {
      runtime.frame(1 / 60, room => room === 0 ? MOVE : NEUTRAL)
    }
    const seat = runtime.worlds().find(ref => ref.kind === 'seat')
    assert.ok(seat, 'a playing round opens its show_seat world')
    const state = readWorldState(engine, seat.world, layout)
    const entityOf = (room: number) => Object.entries(state.components.show_seat_identity)
      .find(([, row]) => Number(row.room_seat) === room)![0]
    assert.equal(Number(state.components.show_control[entityOf(0)]!.code), engineCodeOfS1(MOVE))
    assert.equal(Number(state.components.show_control[entityOf(31)]!.code), engineCodeOfS1(NEUTRAL))
    // A configured bot has no input slot and is never sampled; its scripted control stays neutral.
    assert.equal(Number(state.components.show_control[entityOf(5)]!.code), 32639)
  } finally { runtime.dispose() }
})

function nextTick(runtime: EngineShowRuntime): number {
  const global = runtime.worlds().find(ref => ref.kind === 'global')!
  return global.confirmedTick
}

function votesOf(runtime: EngineShowRuntime): { seat: number; choice: number }[] {
  const global = runtime.worlds().find(ref => ref.kind === 'global')!
  const state = readWorldState(engine, global.world, layout)
  return Object.values(state.components.show_vote ?? {}).map(row => ({
    seat: Number(row.seat), choice: Number(row.choice),
  }))
}

test('vote replaces a pending choice, repeats idempotently and refuses invalid or out-of-phase votes', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([0, 31])))
  try {
    runtime.frame(1 / 60, () => NEUTRAL)
    const open = runtime.snapshot()
    assert.equal(open.screen, 'vote')
    assert.equal(open.candidates.length, 2)
    for (const attempt of [() => runtime.vote(5, 0), () => runtime.vote(0, -1), () => runtime.vote(0, 2), () => runtime.vote(99, 0)]) {
      assert.throws(attempt, RefusalError)
    }
    assert.deepEqual(votesOf(runtime), [])
    runtime.vote(0, 0)
    assert.deepEqual(votesOf(runtime), [{ seat: 0, choice: 0 }])
    runtime.vote(0, 1)
    assert.deepEqual(votesOf(runtime), [{ seat: 0, choice: 1 }])
    runtime.vote(0, 1)
    assert.deepEqual(votesOf(runtime), [{ seat: 0, choice: 1 }])
    runtime.vote(31, 0)
    assert.equal(votesOf(runtime).length, 2)
    runtime.frame(2 / 60, () => NEUTRAL)
    assert.notEqual(runtime.snapshot().screen, 'vote')
    assert.throws(() => runtime.vote(0, 0), RefusalError)
  } finally { runtime.dispose() }
})

interface ShowRun {
  readonly snapshot: EngineShowSnapshot
  readonly screens: ReadonlySet<string>
}

async function driveShow(runtime: EngineShowRuntime, framesPerCall: number): Promise<ShowRun> {
  const screens = new Set<string>()
  const sample = (room: number): number => room === 0 ? SHOW_FORWARD : SHOW_HALF
  let votedRound = -1
  for (let frame = 0; frame < 4000; frame++) {
    const state = runtime.snapshot()
    screens.add(state.screen)
    if (state.screen === 'done') return { snapshot: state, screens }
    if (state.screen === 'vote' && state.candidates.length > 1 && votedRound !== state.round) {
      for (const room of [0, 1]) if (state.seatOf.includes(room)) runtime.vote(room, 1)
      votedRound = state.round
    }
    runtime.frame(frame === 0 ? 1 / 60 : framesPerCall, sample)
  }
  throw new Error('the scripted show did not reach done')
}

test('completes a sixty-seat scripted show through a confirmed final and equal replay/restore', async () => {
  const config = showConfig(humansAt([0, 1]))
  const runtime = await createEngineShow(config)
  let final: EngineShowSnapshot
  try {
    const outcome = await driveShow(runtime, 1 / 60)
    final = outcome.snapshot
    for (const screen of ['vote', 'loading', 'intro', 'playing', 'results', 'podium', 'done']) {
      assert.ok(outcome.screens.has(screen), `the show displayed '${screen}'`)
    }
    assert.equal(final.faults, 0)
    assert.equal(final.screen, 'done')
    assert.equal(final.seatOf.length, 2)
    assert.ok(final.results.length >= 2)
    const last = final.results.at(-1)!
    assert.equal(last.final, true)
    assert.equal(last.champion, 0)
    assert.equal(final.champion, 0)
    assert.deepEqual(final.alive, [0])

    const copy = runtime.snapshot()
    ;(copy.seatOf as number[]).push(99)
    ;(copy.results as unknown[]).pop()
    ;(copy.results[0]!.ranking as number[]).push(99)
    const fresh = runtime.snapshot()
    assert.ok(!fresh.seatOf.includes(99))
    assert.equal(fresh.results.length, final.results.length)
    assert.ok(!fresh.results[0]!.ranking.includes(99))

    const global = runtime.worlds().find(ref => ref.kind === 'global')!
    assert.equal(readShowRoundResult(config, global.world, last.endTick), null)
    assert.deepEqual(readShowRoundResult(config, global.world, last.endTick + 1), last)
    const pending = readShowState(config, global.world, last.endTick, final.faults)
    assert.equal(pending.results.some(result => result.index === last.index), false)
    assert.equal(pending.champion, null)
    const confirmed = readShowState(config, global.world, last.endTick + 1, final.faults)
    assert.deepEqual(confirmed.results, final.results)
    assert.equal(confirmed.champion, 0)

    const saved = engine.snapshot(global.world).slice()
    const restored = engine.createWorld(JSON.stringify(buildShowRulesScene(config)))
    try {
      engine.restore(restored, saved)
      assert.deepEqual(readShowState(config, restored, engine.tick(restored), final.faults), final)
      assert.deepEqual(readShowRoundResult(config, restored, engine.tick(restored)), last)
    } finally { engine.freeWorld(restored) }
  } finally { runtime.dispose() }
  runtime.dispose()
  assert.throws(() => runtime.worlds(), RefusalError)

  const replay = await createEngineShow(showConfig(humansAt([0, 1])))
  try {
    const outcome = await driveShow(replay, 8 / 60)
    assert.deepEqual(outcome.snapshot, final)
  } finally { replay.dispose() }
})
