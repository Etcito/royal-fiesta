import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  commissionLines, commissionModel, commissionStep, withQueue,
} from '../src/flow/commission.ts'
import type { CommissionModel } from '../src/flow/commission.ts'
import type { Commission } from '../src/economy/contract.ts'
import type { Action } from '../src/screens/nav.ts'

const BANNED = JSON.parse(readFileSync(
  new URL('../../../economy/banned-words.json', import.meta.url), 'utf8')) as string[]

function rows(m: CommissionModel, times: number): CommissionModel {
  let model = m
  for (let i = 0; i < times; i++) model = commissionStep(model, 'down').model
  return model
}

function typed(m: CommissionModel, text: string): CommissionModel {
  return commissionStep(m, { text }).model
}

function atSubmit(m: CommissionModel): CommissionModel {
  return rows(m, 3)
}

function queueEntry(overrides: Partial<Omit<Commission, 'playerId'>> = {}): Omit<Commission, 'playerId'> {
  return {
    id: 'commission-1', slot: 'head', rarity: 'common', description: 'a shiny golden crown',
    status: 'pending', createdAt: '2026-10-31T00:00:00.000Z', ...overrides,
  }
}

test('left and right cycle the slot over head, body, bottom and special', () => {
  let m = commissionModel(10, BANNED)
  assert.equal(m.slot, 'head')
  const seen: string[] = []
  for (const action of ['right', 'right', 'right', 'right', 'left'] as Action[]) {
    m = commissionStep(m, action).model
    seen.push(m.slot)
  }
  assert.deepEqual(seen, ['body', 'bottom', 'special', 'head', 'special'])
})

test('left and right cycle the rarity and its cost follows RARITY_TICKETS', () => {
  let m = rows(commissionModel(10, BANNED), 1)
  assert.equal(m.focus, 1)
  assert.equal(m.rarity, 'common')
  assert.equal(m.cost, 3)

  const costs: [string, number][] = []
  for (const action of ['right', 'right', 'right', 'right', 'left'] as Action[]) {
    m = commissionStep(m, action).model
    costs.push([m.rarity, m.cost])
  }
  assert.deepEqual(costs, [
    ['rare', 4], ['legendary', 5], ['epic', 6], ['common', 3], ['epic', 6],
  ])
})

test('a 9-character description, a URL and a banned word are refused before submit', () => {
  const cases = ['abcdefghi', 'see https://example.test', 'a casino hat please']
  for (const text of cases) {
    const m = atSubmit(typed(commissionModel(20, BANNED), text))
    assert.equal(m.focus, 3)
    assert.notEqual(m.problem, null, text)
    const step = commissionStep(m, 'confirm')
    assert.equal(step.submit, null, text)
    assert.equal(step.model.problem, m.problem, text)
    assert.equal(step.model.pending, false, text)
    assert.ok(commissionLines(step.model)[4].includes(m.problem as string), text)
  }
})

test('a valid description submits the exact trimmed payload and waits', () => {
  let m = typed(commissionModel(5, BANNED), '  a shiny golden crown  ')
  assert.equal(m.problem, null)
  m = rows(m, 1)
  m = commissionStep(m, 'right').model
  assert.equal(m.rarity, 'rare')
  assert.equal(m.cost, 4)
  m = atSubmit(m)

  const step = commissionStep(m, 'confirm')
  assert.deepEqual(step.submit, { slot: 'head', rarity: 'rare', description: 'a shiny golden crown' })
  assert.equal(step.model.pending, true)
  assert.equal(step.model.problem, null)

  assert.equal(commissionStep(step.model, 'confirm').submit, null)
  assert.equal(commissionStep(step.model, 'down').submit, null)
  assert.equal(commissionStep(step.model, { text: 'another description entirely' }).submit, null)
  assert.equal(step.model.description, '  a shiny golden crown  ')
})

test('insufficient tickets refuse with the needed count and keep the problem visible', () => {
  let m = typed(commissionModel(3, BANNED), 'a shiny golden crown')
  m = rows(m, 1)
  m = commissionStep(m, 'right').model
  m = commissionStep(m, 'right').model
  m = commissionStep(m, 'right').model
  assert.equal(m.rarity, 'epic')
  assert.equal(m.cost, 6)
  m = atSubmit(m)

  const refused = commissionStep(m, 'confirm')
  assert.equal(refused.submit, null)
  assert.equal(refused.model.problem, 'Not enough tickets (needs 6)')
  assert.equal(refused.model.pending, false)
  assert.equal(commissionLines(refused.model)[4], 'Not enough tickets (needs 6)')

  let enough = typed(commissionModel(6, BANNED), 'a shiny golden crown')
  enough = rows(enough, 1)
  enough = commissionStep(commissionStep(commissionStep(enough, 'right').model, 'right').model, 'right').model
  enough = atSubmit(enough)
  assert.deepEqual(commissionStep(enough, 'confirm').submit, {
    slot: 'head', rarity: 'epic', description: 'a shiny golden crown',
  })
})

test('withQueue stores the queue, resets pending and shows the two newest entries', () => {
  let m = atSubmit(typed(commissionModel(10, BANNED), 'a shiny golden crown'))
  const submitted = commissionStep(m, 'confirm')
  assert.equal(submitted.model.pending, true)

  const older = queueEntry({
    id: 'commission-0', slot: 'body', rarity: 'common', status: 'shipped',
    description: 'an older commission',
  })
  const newer = queueEntry({
    id: 'commission-1', slot: 'head', rarity: 'rare', status: 'pending',
    description: 'x'.repeat(50),
  })
  const queued = withQueue(submitted.model, [older, newer])
  assert.equal(queued.pending, false)
  assert.deepEqual(queued.queue, [older, newer])
  assert.equal(queued.error, null)

  const lines = commissionLines(queued)
  assert.equal(lines.length, 7)
  assert.equal(lines[5], `pending · head · rare · ${'x'.repeat(40)}`)
  assert.equal(lines[6], 'shipped · body · common · an older commission')
})

test('commissionLines returns exactly seven lines, marks the focused row and handles an empty queue', () => {
  const m = commissionModel(7, BANNED)
  const lines = commissionLines(m)
  assert.equal(lines.length, 7)
  assert.equal(lines[0], '> Slot: head <')
  assert.equal(lines[1], 'Rarity: common · Cost: 3 tickets')
  assert.equal(lines[2], '(type a description)')
  assert.equal(lines[3], 'Submit (3 tickets)')
  assert.equal(lines[4], 'Tickets: 7')
  assert.equal(lines[5], 'Queue is empty')
  assert.equal(lines[6], '')

  const moved = rows(m, 4)
  assert.equal(moved.focus, 3)
  assert.equal(commissionLines(moved)[3], '> Submit (3 tickets) <')
  assert.equal(commissionLines(rows(m, 9))[3], '> Submit (3 tickets) <')
  assert.equal(commissionLines(commissionStep(m, 'up').model)[0], '> Slot: head <')
})

test('withQueue shows a submission error on the status line', () => {
  const m = withQueue(commissionModel(10, BANNED), [], 'service unavailable')
  const lines = commissionLines(m)
  assert.equal(lines[4], 'service unavailable')
  assert.equal(lines[5], 'Queue is empty')
})
