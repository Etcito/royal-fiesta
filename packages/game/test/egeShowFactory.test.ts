import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { readShowRoundResult, readShowState } from '../src/ege/showState.ts'
import type { EngineShowConfig } from '../src/ege/showTypes.ts'

const schemaText = readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')
const engine = await loadEngine()
engine.setSchema(schemaText)
const config = {
  engine, schemaText, identity: { backend: 'engine', schemaKey: schemaLayout(engine).key, moduleKey: 'publication' },
  season: [{ id: 'map', course: 0 }], courses: [{ id: 'course' }],
} as unknown as EngineShowConfig
const entity = (name: string, fields: Record<string, number>) => ({ components: { [name]: fields } })
function scene(screen = 0, withResult = false) {
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
  return { format: 'ege.scene', version: 1, world_kind: 'show_rules', seed: 1, entities }
}

test('copies authoritative show state and strictly confirms the current result', () => {
  for (const [screen, name] of ['vote', 'loading', 'intro', 'playing', 'overtime', 'results', 'podium', 'done'].entries()) {
    const world = engine.createWorld(JSON.stringify(scene(screen, true)))
    try {
      const pending = readShowState(config, world, 12, 2)
      assert.equal(pending.screen, name)
      assert.deepEqual(pending.seatOf, [3, 59])
      assert.deepEqual(pending.alive, [59])
      assert.deepEqual(pending.candidates, ['map'])
      assert.deepEqual(pending.results, [])
      assert.equal(pending.champion, null)
      assert.equal(readShowRoundResult(config, world, 12), null)
      const result = readShowRoundResult(config, world, 13)!
      assert.deepEqual(result, { index: 0, map: 'map', course: 'course', kind: 'final', final: true, playoff: false, endTick: 12, reason: 'crown', ranking: [59, 3], qualified: [59], eliminated: [3], points: [2, 0], teamScores: [5, 7], champion: 59 })
      assert.equal(readShowState(config, world, 13, 0).champion, 59)
      ;(result.ranking as number[]).push(2)
      assert.deepEqual(readShowRoundResult(config, world, 13)!.ranking, [59, 3])
    } finally { engine.freeWorld(world) }
  }
  const world = engine.createWorld(JSON.stringify(scene()))
  try {
    assert.equal(readShowRoundResult(config, world, 100), null)
    assert.deepEqual(readShowState(config, world, 100, 0).results, [])
    assert.throws(() => readShowState(config, world, -1, 0), RefusalError)
    assert.throws(() => readShowState({ ...config, season: [] }, world, 0, 0), RefusalError)
  } finally { engine.freeWorld(world) }
})

test('refuses wrong worlds and malformed stored roster positions', () => {
  const wrong = { ...scene(), world_kind: 'round' }
  const world = engine.createWorld(JSON.stringify(wrong))
  try { assert.throws(() => readShowState(config, world, 0, 0), RefusalError) } finally { engine.freeWorld(world) }
  const bad = scene()
  bad.entities[2].components.show_roster_entry.position = 0
  const malformed = engine.createWorld(JSON.stringify(bad))
  try { assert.throws(() => readShowState(config, malformed, 0, 0), RefusalError) } finally { engine.freeWorld(malformed) }
})
