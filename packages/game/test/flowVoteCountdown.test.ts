import assert from 'node:assert/strict'
import test from 'node:test'
import { COUNTDOWN_MS, countdownAt } from '../src/flow/countdown.ts'
import type { CountdownLabel } from '../src/flow/countdown.ts'
import { VOTE_MS, votePick, voteStep } from '../src/flow/vote.ts'
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

test('a pointer pick focuses and votes the clicked candidate with the confirm cue', () => {
  const picked = votePick(model(), 2)
  assert.equal(picked.model.focus, 2)
  assert.equal(picked.model.chosen, 2)
  assert.equal(picked.model.msLeft, VOTE_MS)
  assert.equal(picked.send, 2)
  assert.equal(picked.sound, 'flow.vote-confirm')
})

test('a pointer pick after a vote is ignored (no cancel, no second send)', () => {
  const voted = model({ focus: 1, chosen: 1 })
  const picked = votePick(voted, 2)
  assert.deepEqual(picked, { model: voted, send: null, sound: null })
  assert.equal(picked.model.focus, 1)
  assert.equal(picked.model.chosen, 1)
})

test('a pointer pick at 0 ms is ignored', () => {
  const expired = model({ msLeft: 0 })
  const picked = votePick(expired, 1)
  assert.deepEqual(picked, { model: expired, send: null, sound: null })
  assert.equal(picked.model.focus, 0)
  assert.equal(picked.model.chosen, null)
})

test('a pointer pick outside the candidates is ignored', () => {
  for (const index of [-1, 3, 1.5]) {
    const picked = votePick(model(), index)
    assert.deepEqual(picked, { model: model(), send: null, sound: null })
  }
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
