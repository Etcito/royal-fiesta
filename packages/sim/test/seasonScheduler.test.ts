import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { Rng } from '@gamesaloon/rollback'
import { RefusalError } from '../src/refusal.ts'
import type { RoundKind, StageId } from '../src/season/kinds.ts'
import { DEFAULT_PLAN, advanceCursor, newCursor, nextSlot } from '../src/season/plan.ts'
import type { RoundSlot } from '../src/season/plan.ts'
import { seedOrder } from '../src/season/qualify.ts'
import { NO_BACK_TO_BACK, candidates, commitMap, newSchedule, resolveVote } from '../src/season/scheduler.ts'
import type { SchedMap, ShowSchedule } from '../src/season/scheduler.ts'

function map(id: string, kind: RoundKind, stages: readonly StageId[]): SchedMap {
  return {
    id, course: id.charCodeAt(0), kind, stages, team: kind === 'team',
    cut: id === 'E' || id === 'P',
    finalRule: id === 'I' ? 'lastStanding' : id === 'Q' ? 'crown' : null,
  }
}

// Synthetic loaded maps with the S12 kinds, stages, final rules and cut flags.
const MAPS: readonly SchedMap[] = [
  map('A', 'team', ['R3']),
  map('B', 'race', ['R1', 'R2', 'R3']),
  map('C1', 'race', ['R1', 'R2', 'R3', 'R4']),
  map('C2', 'race', ['R1', 'R2', 'R3', 'R4']),
  map('D', 'race', ['R2', 'R3', 'R4']),
  map('E', 'race', ['R1', 'R2']),
  map('F', 'race', ['R1', 'R2', 'R3']),
  map('G', 'race', ['R2', 'R3', 'R4']),
  map('H', 'survival', ['R2', 'R3', 'R4']),
  map('I', 'survival', ['R3', 'R4', 'final']),
  map('J', 'survival', ['R2', 'R3', 'R4']),
  map('K', 'survival', ['R2', 'R3', 'R4']),
  map('L', 'team', ['R3']),
  map('M', 'team', ['R3']),
  map('N', 'collection', ['R2', 'R3', 'R4']),
  map('O', 'hunt', ['R2', 'R3', 'R4']),
  map('P', 'logic', ['R2', 'R3', 'R4']),
  map('Q', 'final', ['final']),
]

function slot(stage: RoundSlot['stage'], teamAllowed = false, playoff = false): RoundSlot {
  return { stage, final: stage === 'final', target: stage === 'final' ? 1 : 12, teamAllowed, playoff }
}

function schedule(overrides: Partial<ShowSchedule> = {}): ShowSchedule {
  return { finalMap: 'Q', used: [], lastKind: null, previous: null, rngState: 0, ...overrides }
}

function refusesStage(run: () => unknown, stage: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RefusalError)
    assert.equal(error.area, 'scheduler')
    assert.ok(error.message.includes(stage))
    assert.match(error.message, /build or load a map of that stage/)
    return true
  })
}

describe('season scheduler', () => {
  it('mirrors the season noBackToBack rules', () => {
    const season = JSON.parse(readFileSync(new URL('../../../courses/season.json', import.meta.url), 'utf8'))
    assert.deepEqual(NO_BACK_TO_BACK, season.rules.noBackToBack)
  })

  it('reserves a seeded final before drawing any round, including fixture finals', () => {
    const reserved = new Set<string | null>()
    for (let seed = 0; seed < 200; seed++) {
      const rng = new Rng(seed)
      const expectedRng = new Rng(seed)
      const expected = ['I', 'Q'][expectedRng.int(0, 1)]
      const s = newSchedule(MAPS, rng)
      assert.deepEqual(s, {
        finalMap: expected, used: [], lastKind: null, previous: null, rngState: expectedRng.state,
      })
      reserved.add(s.finalMap)
      for (const stage of ['R1', 'R2', 'R3', 'R4'] as const) {
        assert.ok(!candidates(MAPS, slot(stage, true), s, rng, 99).includes(expected))
      }
      assert.deepEqual(candidates(MAPS, slot('final'), s, rng, 99), [expected])
    }
    assert.deepEqual(reserved, new Set(['I', 'Q']))
    const fixture = { ...map('fixture', 'survival', ['R2', 'final']), finalRule: 'lastStanding' as const }
    const invalid = { ...map('invalid', 'final', ['R1']), finalRule: 'crown' as const }
    assert.equal(newSchedule([fixture, invalid], new Rng(1)).finalMap, 'fixture')
    assert.equal(newSchedule([invalid], new Rng(1)).finalMap, null)
  })

  it('does not repeat maps over a complete 60 -> 1 show', () => {
    const rng = new Rng(1)
    let s = newSchedule(MAPS, rng)
    let cursor = newCursor(DEFAULT_PLAN, 60)
    while (true) {
      const round = nextSlot(cursor)
      if (round === null) break
      const choices = candidates(MAPS, round, s, rng)
      assert.ok(choices.length > 0)
      for (const id of choices) assert.ok(!s.used.includes(id))
      const selected = MAPS.find(m => m.id === resolveVote(choices, [], 1, cursor.roundIndex))!
      assert.ok(!NO_BACK_TO_BACK.some(([a, b]) => a === s.previous && b === selected.id))
      s = commitMap(s, selected)
      cursor = advanceCursor(cursor, round, round.target, selected.team)
    }
    assert.equal(cursor.alive, 1)
    assert.equal(s.used.length, 5)
    assert.equal(new Set(s.used).size, s.used.length)
    assert.equal(s.used.at(-1), s.finalMap)
  })

  it('offers team maps only when the slot permits them, even after relaxation', () => {
    for (const allowed of [false, true]) {
      const ids = candidates(MAPS, slot('R3', allowed), schedule(), new Rng(5), 99)
      for (const team of ['A', 'L', 'M']) assert.equal(ids.includes(team), allowed)
    }
    const teams = MAPS.filter(m => m.team)
    refusesStage(() => candidates(teams, slot('R3'), schedule({ used: ['A', 'L', 'M'] }), new Rng(1)), 'R3')
  })

  it('never offers H -> I or D -> G over 200 seeds, even after repeat relaxation', () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const [before, after] of NO_BACK_TO_BACK) {
        const s = commitMap(schedule(), MAPS.find(m => m.id === before)!)
        const draw = candidates(MAPS, slot('R4'), s, new Rng(seed), 99)
        assert.ok(!draw.includes(after))
        s.used = MAPS.map(m => m.id)
        assert.ok(!candidates(MAPS, slot('R4'), s, new Rng(seed), 99).includes(after))
        refusesStage(() => candidates(MAPS.filter(m => m.id === after), slot('R4'), s, new Rng(seed)), 'R4')
      }
    }
    // Reservation cannot override the adjacency rule in the final either.
    refusesStage(() => candidates(MAPS, slot('final'), schedule({ finalMap: 'I', previous: 'H' }), new Rng(1)), 'final')
  })

  it('draws just one cut map, exclusively E/P regardless of their ordinary stages', () => {
    const drawn = new Set<string>()
    for (let seed = 0; seed < 200; seed++) {
      const ids = candidates(MAPS, slot('cut'), schedule(), new Rng(seed), 99)
      assert.equal(ids.length, 1)
      assert.ok(['E', 'P'].includes(ids[0]))
      drawn.add(ids[0])
    }
    assert.deepEqual(drawn, new Set(['E', 'P']))
    refusesStage(() => candidates(MAPS.filter(m => !m.cut), slot('cut'), schedule(), new Rng(1)), 'cut')
  })

  it('relaxes kind preference before allowing an in-show repeat', () => {
    const pool = [map('race', 'race', ['R2']), map('survival', 'survival', ['R2'])]
    const rng = new Rng(3)
    const s = schedule({ lastKind: 'race' })
    // A short preferred pool is not topped up with same-kind maps.
    assert.deepEqual(candidates(pool, slot('R2'), s, rng), ['survival'])
    s.used = ['survival']
    assert.deepEqual(candidates(pool, slot('R2'), s, rng), ['race'])
    s.used = ['race', 'survival']
    assert.deepEqual(new Set(candidates(pool, slot('R2'), s, rng)), new Set(['race', 'survival']))
    refusesStage(() => candidates(pool, slot('R4'), s, rng), 'R4')
    refusesStage(() => candidates([], slot('R1'), schedule(), rng), 'R1')
    refusesStage(() => candidates(MAPS.filter(m => m.id !== 'Q'), slot('final'), schedule(), rng), 'final')
  })

  it('keeps the reserved final out of a middle pool even when repeats are needed', () => {
    const i = MAPS.find(m => m.id === 'I')!
    const s = schedule({ finalMap: 'I', used: ['I'], lastKind: 'survival' })
    refusesStage(() => candidates([i], slot('R4'), s, new Rng(1)), 'R4')
  })

  it('draws seeded candidates without replacement and saves the resulting RNG state', () => {
    const original = MAPS.map(m => m.id)
    const seen = new Set<string>()
    for (let seed = 0; seed < 20; seed++) {
      const rng = new Rng(seed)
      const s = newSchedule(MAPS, rng)
      const resumedRng = new Rng(s.rngState)
      const copy = { ...s, used: [...s.used] }
      const ids = candidates(MAPS, slot('R2'), s, rng)
      assert.deepEqual(ids, candidates(MAPS, slot('R2'), copy, resumedRng))
      assert.equal(ids.length, 3)
      assert.equal(new Set(ids).size, 3)
      assert.equal(s.rngState, rng.state)
      assert.deepEqual(s, copy)
      assert.deepEqual(s.used, [])
      seen.add(ids.join(','))
      assert.equal(candidates(MAPS, slot('R2', false, true), s, rng, 99).length, 1)
      assert.equal(candidates(MAPS, slot('R2'), s, rng, 2).length, 2)
    }
    assert.ok(seen.size > 1)
    assert.deepEqual(MAPS.map(m => m.id), original)
  })

  it('commits a map into a new schedule without changing the original', () => {
    const s = schedule({ used: ['B'], rngState: 123 })
    const updated = commitMap(s, MAPS.find(m => m.id === 'H')!)
    assert.deepEqual(updated, {
      finalMap: 'Q', used: ['B', 'H'], lastKind: 'survival', previous: 'H', rngState: 123,
    })
    assert.deepEqual(s, schedule({ used: ['B'], rngState: 123 }))
    assert.notEqual(updated, s)
    assert.notEqual(updated.used, s.used)
  })
})

describe('resolveVote', () => {
  it('selects the most votes and ignores abstentions', () => {
    assert.equal(resolveVote(['A', 'B', 'C'], [0, 1, 1, -1, 2, 1], 7, 2), 'B')
    assert.equal(resolveVote(['A', 'B', 'C'], [-1, 2, -1], 7, 2), 'C')
    assert.equal(resolveVote(['Q'], [-1, 0], 1, 0), 'Q')
  })

  it('breaks ties by seedOrder of candidate indices using seed and roundIndex', () => {
    const cands = ['Q', 'I', 'P']
    const winners = new Set<string>()
    for (let seed = 0; seed < 20; seed++) {
      for (let round = 0; round < 5; round++) {
        const order = [0, 1, 2].sort((a, b) => seedOrder(seed, round, a) - seedOrder(seed, round, b))
        assert.equal(resolveVote(cands, [0, 1, 2, -1], seed, round), cands[order[0]])
        assert.equal(resolveVote(cands, [-1, -1], seed, round), cands[order[0]])
        assert.equal(resolveVote(cands, [], seed, round), cands[order[0]])
        const tied = order.filter(i => i !== 0)
        assert.equal(resolveVote(cands, [1, 2], seed, round), cands[tied[0]])
        winners.add(cands[order[0]])
      }
    }
    assert.ok(winners.size > 1)
    assert.throws(() => resolveVote([], [], 1, 0), RefusalError)
  })
})
