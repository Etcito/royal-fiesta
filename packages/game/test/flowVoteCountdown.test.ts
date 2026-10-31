import assert from 'node:assert/strict'
import test from 'node:test'
import { COUNTDOWN_MS, countdownAt } from '../src/flow/countdown.ts'
import type { CountdownLabel } from '../src/flow/countdown.ts'
import { VOTE_MS, voteStep } from '../src/flow/vote.ts'
import type { VoteCandidate, VoteModel } from '../src/flow/vote.ts'
import type { Action } from '../src/screens/nav.ts'

const candidates: VoteCandidate[] = [
  { map: 'A', name: 'Alpha', kind: 'race' },
  { map: 'B', name: 'Beta', kind: 'survival' },
  { map: 'C', name: 'Gamma', kind: 'final' },
]

function model(overrides: Partial<VoteModel> = {}): VoteModel {
  return { candidates, focus: 0, chosen: null, msLeft: VOTE_MS, ...overrides }
}

test('focus moves over the candidates and wraps at both ends', () => {
  let m = model()
  const seen: number[] = []
  for (const action of ['right', 'right', 'right', 'left'] as Action[]) {
    const r = voteStep(m, action, 0)
    assert.equal(r.sound, 'ui.hover')
    assert.equal(r.send, null)
    assert.equal(r.model.chosen, null)
    m = r.model
    seen.push(m.focus)
  }
  assert.deepEqual(seen, [1, 2, 0, 2])
  assert.equal(voteStep(m, 'up', 0).model.focus, 1)
  assert.equal(voteStep(m, 'down', 0).model.focus, 0)
  assert.equal(voteStep(m, 'left', 0).model.focus, 1)
  assert.equal(voteStep(m, 'right', 0).model.focus, 0)
})

test('confirm sends once; later confirms and moves are ignored (no cancel)', () => {
  const focused = voteStep(model(), 'right', 0).model
  assert.equal(focused.focus, 1)

  const confirmed = voteStep(focused, 'confirm', 16)
  assert.equal(confirmed.send, 1)
  assert.equal(confirmed.sound, 'flow.vote-confirm')
  assert.equal(confirmed.model.chosen, 1)
  assert.equal(confirmed.model.msLeft, VOTE_MS - 16)

  let m = confirmed.model
  for (const action of ['confirm', 'left', 'right', 'up', 'down', 'leave'] as Action[]) {
    const r = voteStep(m, action, 16)
    assert.equal(r.send, null)
    assert.equal(r.sound, null)
    assert.equal(r.model.focus, 1)
    assert.equal(r.model.chosen, 1)
    m = r.model
  }
  assert.equal(m.msLeft, VOTE_MS - 16 * 7)
})

test('5000 ms of 16 ms steps gives exactly four ticks before 0', () => {
  let m = model()
  const ticks: number[] = []
  let elapsed = 0
  while (elapsed < VOTE_MS) {
    const r = voteStep(m, null, 16)
    elapsed += 16
    if (r.sound === 'flow.vote-tick') ticks.push(r.model.msLeft)
    assert.equal(r.send, null)
    m = r.model
  }
  assert.deepEqual(ticks, [3992, 3000, 1992, 1000])
  assert.equal(m.msLeft, 0)
  assert.equal(m.chosen, null)
})

test('actions after msLeft 0 are ignored', () => {
  const m = model({ msLeft: 0 })
  for (const action of ['confirm', 'left', 'right', 'up', 'down', 'leave'] as Action[]) {
    const r = voteStep(m, action, 16)
    assert.equal(r.model.focus, 0)
    assert.equal(r.model.chosen, null)
    assert.equal(r.send, null)
    assert.equal(r.sound, null)
    assert.equal(r.model.msLeft, 0)
  }
})

test('a single candidate starts focused and confirm still sends 0', () => {
  const single = model({ candidates: [candidates[0]] })
  assert.equal(single.focus, 0)
  assert.equal(voteStep(single, 'left', 0).model.focus, 0)
  assert.equal(voteStep(single, 'right', 0).model.focus, 0)
  const r = voteStep(single, 'confirm', 0)
  assert.equal(r.model.chosen, 0)
  assert.equal(r.send, 0)
  assert.equal(r.sound, 'flow.vote-confirm')
})

test('countdown boundaries', () => {
  const cases: [number, CountdownLabel | null, string | null][] = [
    [0, '3', 'flow.count-tick'],
    [999, '3', 'flow.count-tick'],
    [1000, '2', 'flow.count-tick'],
    [1999, '2', 'flow.count-tick'],
    [2999, '1', 'flow.count-tick'],
    [3000, 'GO', 'flow.count-go'],
    [3999, 'GO', 'flow.count-go'],
    [4000, null, null],
  ]
  for (const [ms, label, sound] of cases) {
    assert.deepEqual(countdownAt(ms), { label, sound }, `at ${ms} ms`)
  }
  assert.deepEqual(countdownAt(-1), { label: null, sound: null })
  assert.equal(COUNTDOWN_MS, 4000)
})
