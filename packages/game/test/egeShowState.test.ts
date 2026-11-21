import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { dropShowStateMemo, readShowRoundResult, readShowState, sameBytes, showSchemaLayout } from '../src/ege/showState.ts'
import type { EngineShowConfig } from '../src/ege/showTypes.ts'

const schemaText = readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')
const engine = await loadEngine()
engine.setSchema(schemaText)
const config = {
  engine, schemaText, identity: { backend: 'engine', schemaKey: schemaLayout(engine).key, moduleKey: 'publication' },
  season: [{ id: 'map', course: 0 }], courses: [{ id: 'course' }],
} as unknown as EngineShowConfig
const entity = (name: string, fields: Record<string, number>) => ({ components: { [name]: fields } })

/** A rules world on the given screen; `withResult` adds one closed final round ending at tick 12. */
function scene(screen: number, withResult: boolean) {
  const entities = [
    entity('show_season_cursor', { owner: 0, step: 0, alive: 2, team_rounds: 0, round_index: 0, rng_state: 1, final_map: -1, last_kind: -1, previous: -1 }),
    entity('show_presentation', { owner: 0, tick: 13, round_index: 0, screen, entered_tick: 0, result_index: withResult ? 0 : -1, seat_count: 2, alive_count: 1, vote_ticks: 1, results_ticks: 1, podium_ticks: 1 }),
    entity('show_roster_entry', { owner: 0, list: 0, position: 1, room_seat: 59 }),
    entity('show_roster_entry', { owner: 0, list: 0, position: 0, room_seat: 3 }),
    entity('show_roster_entry', { owner: 0, list: 1, position: 0, room_seat: 59 }),
    entity('show_candidate', { owner: 0, round_index: 0, index: 0, map: 0 }),
  ]
  if (withResult) entities.push(
    entity('show_round_result', { owner: 0, index: 0, map: 0, course: 0, kind: 6, final: 1, playoff: 0, end_tick: 12, reason: 7, champion: 59, ranking_count: 2, qualified_count: 1, eliminated_count: 1, team_count: 2 }),
    ...[[0, 1, 3, 0], [0, 0, 59, 2], [1, 0, 59, 0], [2, 0, 3, 0]].map(([list, position, seat, points]) => entity('show_result_seat', { owner: 0, result: 0, list, position, seat, points })),
    ...[5, 7].map((score, team) => entity('show_result_team', { owner: 0, result: 0, team, score })),
  )
  return JSON.stringify({ format: 'ege.scene', version: 1, world_kind: 'show_rules', seed: 1, entities })
}

/** The memoized read next to a read taken after the memo was dropped: both must describe the same world. */
function bothReads(world: number) {
  const memoized = { state: readShowState(config, world, 13, 0), result: readShowRoundResult(config, world, 13) }
  dropShowStateMemo(config)
  const fresh = { state: readShowState(config, world, 13, 0), result: readShowRoundResult(config, world, 13) }
  assert.deepEqual(memoized, fresh)
  return memoized
}

test('the schema layout is parsed once per engine and equals the engine layout', () => {
  assert.equal(showSchemaLayout(engine), showSchemaLayout(engine))
  assert.deepEqual(showSchemaLayout(engine), schemaLayout(engine))
})

test('memoized and un-memoized show reads are equal across a step, a changed world and a rollback', () => {
  const world = engine.createWorld(scene(0, false))
  const later = engine.createWorld(scene(5, true))
  try {
    const first = bothReads(world)
    assert.equal(first.state.screen, 'vote')
    assert.deepEqual(first.state.results, [])
    assert.equal(first.result, null)
    const saved = engine.snapshot(world).slice()

    // A step changes the world bytes: the memo taken before it is not served for the stepped world.
    // One engine tick without its script entries (no script host in this unit test): the tick counter advances.
    const entries = engine.schedule(world)
    engine.beginTick(world, [])
    entries.forEach((entry, index) => { if (entry.lane === 'simulation' && entry.kind === 'engine') engine.runEnginePhase(world, index) })
    engine.endTick(world)
    assert.ok(!sameBytes(saved, engine.snapshot(world)), 'the step changed the snapshot')
    assert.deepEqual(bothReads(world).state, first.state)

    // The world advances to a closed final: the memoized read follows the authoritative bytes.
    readShowState(config, world, 13, 0)
    engine.restore(world, engine.snapshot(later).slice())
    const closed = bothReads(world)
    assert.equal(closed.state.screen, 'results')
    assert.equal(closed.state.champion, 59)
    assert.deepEqual(closed.result?.ranking, [59, 3])

    // Rollback to the saved bytes: the read returns to the earlier state, never the memo of the later one.
    engine.restore(world, saved)
    const rolled = bothReads(world)
    assert.deepEqual(rolled, first)

    // A reused world handle with other content is a different world for the memo.
    readShowState(config, world, 13, 0)
    engine.freeWorld(world)
    const reused = engine.createWorld(scene(6, true))
    try {
      assert.equal(bothReads(reused).state.screen, 'podium')
    } finally { engine.freeWorld(reused) }
  } finally {
    engine.freeWorld(later)
  }
})

test('every read returns storage independent of the memo and of earlier reads', () => {
  const world = engine.createWorld(scene(5, true))
  try {
    const a = readShowState(config, world, 13, 0)
    ;(a.seatOf as number[]).push(7)
    ;(a.alive as number[]).length = 0
    ;(a.candidates as string[])[0] = 'changed'
    ;(a.results[0].ranking as number[]).reverse()
    ;(a.results[0] as { champion: number }).champion = 3
    const b = readShowState(config, world, 13, 0)
    assert.deepEqual(b.seatOf, [3, 59])
    assert.deepEqual(b.alive, [59])
    assert.deepEqual(b.candidates, ['map'])
    assert.deepEqual(b.results[0].ranking, [59, 3])
    assert.equal(b.results[0].champion, 59)
    assert.notEqual(a.results[0], b.results[0])
    const result = readShowRoundResult(config, world, 13)!
    ;(result.points as number[]).push(9)
    assert.deepEqual(readShowRoundResult(config, world, 13)!.points, [2, 0])
  } finally { engine.freeWorld(world) }
})
