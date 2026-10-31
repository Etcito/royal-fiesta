import assert from 'node:assert/strict'
import test from 'node:test'
import type { InboxEntry } from '../src/economy/contract.ts'
import {
  GIFT_MESSAGE,
  inboxButtonsLine,
  inboxLines,
  inboxModel,
  inboxStep,
} from '../src/flow/inbox.ts'
import type { InboxModel, InboxStep } from '../src/flow/inbox.ts'
import { flowAction } from '../src/screens/nav.ts'
import type { Action } from '../src/screens/nav.ts'

type Ui = { k: 'focus' | 'adjust'; dir: -1 | 1 } | { k: 'select' } | { k: string }

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'entry-1',
    item: 'costume.crown',
    sender: { kind: 'player', id: 'bean' },
    message: 'Enjoy the crown!',
    date: '2026-10-01T00:00:00.000Z',
    claimed: false,
    ...overrides,
  }
}

// Drive the model with keyboard/pad events, exactly as the app maps them.
function drive(m: InboxModel, events: readonly Ui[]): InboxStep {
  let step: InboxStep = { model: m, claim: null, gift: null, block: null }
  for (const ev of events) {
    const action = flowAction(ev)
    assert.notEqual(action, null)
    step = inboxStep(step.model, action as Action)
  }
  return step
}

const focus = (dir: -1 | 1): Ui => ({ k: 'focus', dir })
const adjust = (dir: -1 | 1): Ui => ({ k: 'adjust', dir })
const select: Ui = { k: 'select' }

test('rows are newest first by date', () => {
  const m = inboxModel([
    entry({ id: 'old', date: '2026-01-01T00:00:00.000Z' }),
    entry({ id: 'newest', date: '2026-03-01T00:00:00.000Z' }),
    entry({ id: 'middle', date: '2026-02-01T00:00:00.000Z' }),
  ])

  assert.deepEqual(m.rows.map(row => row.id), ['newest', 'middle', 'old'])
  assert.equal(m.focus, 0)
  assert.equal(m.button, 'claim')
  assert.equal(m.pending, false)
  assert.equal(m.picking, false)
})

test('confirm claims an unclaimed entry with an item', () => {
  const m = inboxModel([entry({ id: 'gift-1' })], ['costume.boots'])
  const step = drive(m, [select])

  assert.equal(step.claim, 'gift-1')
  assert.equal(step.gift, null)
  assert.equal(step.block, null)
  assert.equal(step.model.pending, true)
  assert.equal(step.model.error, null)
})

test('claim refuses a claimed entry and an item-less entry', () => {
  const claimed = drive(inboxModel([entry({ id: 'done', claimed: true })]), [select])
  assert.equal(claimed.claim, null)
  assert.equal(claimed.model.error, 'Nothing to claim')
  assert.equal(claimed.model.pending, false)

  const itemless = drive(inboxModel([entry({ id: 'note', item: null })]), [select])
  assert.equal(itemless.claim, null)
  assert.equal(itemless.model.error, 'Nothing to claim')
  assert.equal(itemless.model.pending, false)
})

test('gift picks with up/down and confirms the exact payload', () => {
  const owned = ['costume.crown', 'costume.boots']
  let m = inboxModel([entry({ id: 'gift-1', sender: { kind: 'player', id: 'bean' } })], owned)
  m = drive(m, [adjust(1)]).model
  assert.equal(m.button, 'gift')

  const opened = drive(m, [select])
  assert.equal(opened.model.picking, true)
  assert.equal(opened.model.giftItem, 0)
  assert.equal(opened.gift, null)
  assert.equal(inboxLines(opened.model)[5], 'Gift: costume.crown')

  const down = drive(opened.model, [focus(1)])
  assert.equal(down.model.giftItem, 1)
  assert.equal(inboxLines(down.model)[5], 'Gift: costume.boots')

  const confirmed = drive(down.model, [select])
  assert.deepEqual(confirmed.gift, { to: 'bean', itemId: 'costume.boots', message: GIFT_MESSAGE })
  assert.equal(confirmed.model.picking, false)
  assert.equal(confirmed.model.pending, true)
  assert.equal(confirmed.claim, null)
  assert.equal(confirmed.block, null)
})

test('the gift picker wraps over the owned items', () => {
  let m = inboxModel([entry()], ['costume.crown', 'costume.boots'])
  m = drive(m, [adjust(1), select, focus(-1)]).model
  assert.equal(m.giftItem, 1)
})

test('left cancels gift picking without a gift', () => {
  let m = inboxModel([entry()], ['costume.crown'])
  m = drive(m, [adjust(1), select]).model
  assert.equal(m.picking, true)

  const cancelled = drive(m, [adjust(-1)])
  assert.equal(cancelled.model.picking, false)
  assert.equal(cancelled.gift, null)
  assert.equal(cancelled.model.pending, false)
  assert.equal(cancelled.model.button, 'gift')
})

test('block returns a player sender and refuses other senders', () => {
  let m = inboxModel([entry({ sender: { kind: 'player', id: 'bean' } })])
  m = drive(m, [adjust(1), adjust(1)]).model
  assert.equal(m.button, 'block')

  const blocked = drive(m, [select])
  assert.equal(blocked.block, 'bean')
  assert.equal(blocked.model.pending, true)

  const system = drive(inboxModel([entry({ sender: { kind: 'system', id: null } })]), [
    adjust(1), adjust(1), select,
  ])
  assert.equal(system.model.button, 'block')
  assert.equal(system.block, null)
  assert.equal(system.model.pending, false)

  const owner = drive(inboxModel([entry({ sender: { kind: 'owner', id: null } })]), [
    adjust(1), adjust(1), select,
  ])
  assert.equal(owner.block, null)
})

test('pending blocks new requests', () => {
  const pending = { ...inboxModel([entry({ id: 'gift-1' })], ['costume.crown']), pending: true }
  const step = drive(pending, [focus(1), select, adjust(1), select])
  assert.equal(step.claim, null)
  assert.equal(step.gift, null)
  assert.equal(step.block, null)
  assert.equal(step.model.focus, 0)
  assert.equal(step.model.button, 'claim')
})

test('the empty inbox shows five blank rows and its status line', () => {
  const m = inboxModel([], [])
  assert.deepEqual(inboxLines(m), ['', '', '', '', '', 'Inbox is empty'])
  assert.deepEqual(Object.keys(m).includes('rows'), true)
  assert.equal(inboxButtonsLine(m), '[Claim]  Gift  Block')
})

test('the row window follows the focus and the buttons line brackets the focus', () => {
  const entries = Array.from({ length: 7 }, (_, i) => entry({
    id: `e${i}`,
    item: `costume.${i}`,
    date: `2026-10-0${7 - i}T00:00:00.000Z`,
    claimed: i % 2 === 0,
  }))
  let m = inboxModel(entries)
  assert.deepEqual(m.rows.map(row => row.id), ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'])
  assert.equal(inboxLines(m)[0], '> From bean · costume.0 · claimed <')

  m = drive(m, [focus(1), focus(1), focus(1), focus(1)]).model
  assert.equal(m.focus, 4)
  const lines = inboxLines(m)
  assert.equal(lines.length, 6)
  assert.equal(lines[0], '> From bean · costume.2 · claimed <')
  assert.equal(lines[4], '> From bean · costume.6 · claimed <')
  assert.equal(lines[5], '')

  assert.equal(inboxButtonsLine(m), '[Claim]  Gift  Block')
  const gifted = drive(m, [adjust(1)]).model
  assert.equal(inboxButtonsLine(gifted), 'Claim  [Gift]  Block')
  const blocked = drive(gifted, [adjust(1)]).model
  assert.equal(inboxButtonsLine(blocked), 'Claim  Gift  [Block]')
  assert.equal(inboxButtonsLine(drive(blocked, [adjust(1)]).model), '[Claim]  Gift  Block')
  assert.equal(inboxButtonsLine(drive(blocked, [adjust(-1)]).model), 'Claim  [Gift]  Block')
})
