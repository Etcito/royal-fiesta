import assert from 'node:assert/strict'
import test from 'node:test'
import { ELIM_SHOW, elimShow, elimShowAt, elimSkip } from '../src/flow/elimShow.ts'
import { resultRows } from '../src/flow/roundResults.ts'
import type { ZoneRoundResult } from '../src/net/zoneRounds.ts'

const seats = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

function result(overrides: Partial<ZoneRoundResult> = {}): ZoneRoundResult {
  return {
    index: 0,
    map: 'A',
    course: 'course-a',
    kind: 'race',
    final: false,
    playoff: false,
    endTick: 100,
    reason: 'target',
    ranking: [],
    qualified: [],
    eliminated: [],
    points: [],
    teamScores: [],
    champion: -1,
    ...overrides,
  }
}

test('60 entrants with 20 eliminated drop once each, in order, within 6000..8000 ms', () => {
  const entrants = seats(60)
  const eliminated = [59, 0, 31, 12, 47, 3, 22, 55, 8, 40, 17, 33, 2, 44, 26, 51, 9, 37, 14, 58]
  const out = new Set(eliminated)
  const ranking = entrants.filter(seat => !out.has(seat)).concat(eliminated)
  const qualified = ranking.slice(0, 40)
  const points = ranking.map((_, index) => (index < 40 ? 60 - index : 0))
  const m = elimShow(entrants, result({ ranking, qualified, eliminated, points }))

  assert.equal(m.grid.length, 60)
  m.grid.forEach((cell, index) => {
    assert.equal(cell.seat, index)
    assert.equal(cell.col, index % ELIM_SHOW.cols)
    assert.equal(cell.row, Math.floor(index / ELIM_SHOW.cols))
    assert.equal(cell.state, 'stay')
  })
  assert.deepEqual(m.counter, { from: 60, to: 40, now: 60 })
  assert.ok(m.doneAtMs >= ELIM_SHOW.minMs && m.doneAtMs <= ELIM_SHOW.maxMs)

  const dropped: number[] = []
  let firstDone = -1
  for (let ms = 0; ms <= 9000; ms++) {
    const frame = elimShowAt(m, ms)
    dropped.push(...frame.drops)
    assert.equal(frame.done, ms >= m.doneAtMs)
    if (frame.done && firstDone < 0) firstDone = ms
  }

  assert.deepEqual(dropped, eliminated)
  assert.equal(new Set(dropped).size, 20)
  assert.equal(firstDone, m.doneAtMs)
  assert.equal(m.counter.now, 40)
  for (const cell of m.grid) {
    assert.equal(cell.state, out.has(cell.seat) ? 'drop' : 'stay')
  }
})

test('6 entrants with 1 eliminated', () => {
  const entrants = [4, 5, 6, 7, 8, 9]
  const m = elimShow(entrants, result({
    ranking: [4, 5, 6, 7, 8, 9], qualified: [4, 5, 6, 8, 9], eliminated: [7],
    points: [6, 5, 4, 0, 2, 1],
  }))

  assert.deepEqual(m.counter, { from: 6, to: 5, now: 6 })
  assert.equal(m.doneAtMs, 6000)
  assert.deepEqual(elimShowAt(m, 1499), { drops: [], counter: 6, done: false })
  assert.deepEqual(elimShowAt(m, 1500), { drops: [7], counter: 5, done: false })
  assert.deepEqual(elimShowAt(m, 1500), { drops: [], counter: 5, done: false })
  assert.deepEqual(elimShowAt(m, 2000), { drops: [], counter: 5, done: false })
  assert.equal(elimShowAt(m, 5999).done, false)
  assert.equal(elimShowAt(m, 6000).done, true)
  assert.equal(m.grid.find(cell => cell.seat === 7)?.state, 'drop')
})

test('zero eliminations: no drops and done at 6000 ms', () => {
  const m = elimShow([0, 1, 2], result({ ranking: [0, 1, 2], qualified: [0, 1, 2], eliminated: [], points: [3, 2, 1] }))
  assert.equal(m.doneAtMs, ELIM_SHOW.minMs)
  assert.deepEqual(elimShowAt(m, 7000), { drops: [], counter: 3, done: true })
})

test('a team round drops its group in one frame', () => {
  const entrants = seats(6)
  const m = elimShow(entrants, result({
    kind: 'team', ranking: [0, 1, 2, 3, 4, 5], qualified: [0, 1, 2, 3], eliminated: [4, 5],
    points: [6, 6, 6, 6, 0, 0], teamScores: [3, 1],
  }))

  assert.deepEqual(m.schedule.map(entry => entry.atMs), [1500, 1500])
  assert.deepEqual(elimShowAt(m, 1499).drops, [])
  assert.deepEqual(elimShowAt(m, 1500), { drops: [4, 5], counter: 4, done: false })
  assert.deepEqual(elimShowAt(m, 3000), { drops: [], counter: 4, done: false })
  assert.equal(m.counter.now, 4)
})

test('skip is refused at 1499 ms and accepted at 1500 ms', () => {
  const m = elimShow(seats(6), result({
    kind: 'team', ranking: [0, 1, 2, 3, 4, 5], qualified: [0, 1, 2, 3], eliminated: [4, 5],
    points: [6, 6, 6, 6, 0, 0], teamScores: [3, 1],
  }))

  assert.equal(elimSkip(m, 1499), m)
  assert.equal(m.counter.now, 6)
  assert.ok(m.grid.every(cell => cell.state === 'stay'))

  const skipped = elimSkip(m, 1500)
  assert.deepEqual(skipped.counter, { from: 6, to: 4, now: 4 })
  assert.equal(skipped.doneAtMs, 1500)
  for (const cell of skipped.grid) {
    assert.equal(cell.state, cell.seat === 4 || cell.seat === 5 ? 'gone' : 'stay')
  }
})

test('resultRows totals across two rounds', () => {
  const first = result({ index: 0, ranking: [3, 1, 2, 0], qualified: [3, 1], eliminated: [2, 0], points: [4, 3, 0, 0] })
  const second = result({ index: 1, ranking: [1, 0, 3, 2], qualified: [1, 0], eliminated: [3, 2], points: [4, 3, 0, 0] })
  const rows = resultRows(second, seat => `seat ${seat}`, [first])

  assert.deepEqual(rows, [
    { seat: 1, name: 'seat 1', rank: 1, points: 4, total: 7, qualified: true },
    { seat: 0, name: 'seat 0', rank: 2, points: 3, total: 3, qualified: true },
    { seat: 3, name: 'seat 3', rank: 3, points: 0, total: 4, qualified: false },
    { seat: 2, name: 'seat 2', rank: 4, points: 0, total: 0, qualified: false },
  ])
})

test('team winners share rank 1', () => {
  const r = result({
    kind: 'team', ranking: [0, 2, 1, 3], qualified: [0, 2], eliminated: [1, 3],
    points: [6, 6, 0, 0], teamScores: [2, 0],
  })
  const rows = resultRows(r, seat => `s${seat}`)

  assert.deepEqual(rows.map(row => [row.seat, row.rank, row.points]), [
    [0, 1, 6],
    [2, 1, 6],
    [1, 3, 0],
    [3, 4, 0],
  ])
  assert.equal(rows[0].qualified, true)
  assert.equal(rows[1].qualified, true)
})
