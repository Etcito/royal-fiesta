// The commission menu model: slot, rarity, description and submit rows, plus the public queue.
// Pure: the caller supplies the ticket balance and banned words, and runs the submitted commission.
import {
  RARITY_TICKETS, checkDescription,
  type Commission, type Rarity, type Slot,
} from '../economy/contract.ts'
import type { Action } from '../screens/nav.ts'

const SLOTS: readonly Slot[] = Object.freeze(['head', 'body', 'bottom', 'special'])
const RARITIES: readonly Rarity[] = Object.freeze(['common', 'rare', 'legendary', 'epic'])
const LAST_ROW = 3

export interface CommissionModel {
  slot: Slot
  rarity: Rarity
  description: string
  cost: number
  problem: string | null
  focus: number
  tickets: number
  banned: readonly string[]
  pending: boolean
  error: string | null
  queue: Omit<Commission, 'playerId'>[]
}

interface CommissionStepResult {
  model: CommissionModel
  submit: { slot: Slot; rarity: Rarity; description: string } | null
}

function normalizeTickets(tickets: number): number {
  return Number.isFinite(tickets) ? Math.max(0, Math.trunc(tickets)) : 0
}

function insufficient(cost: number): string {
  return `Not enough tickets (needs ${cost})`
}

function cycle<T>(values: readonly T[], current: T, delta: -1 | 1): T {
  const index = values.indexOf(current)
  const from = index < 0 ? 0 : index
  return values[(from + delta + values.length) % values.length]
}

export function commissionModel(tickets: number, banned: readonly string[] = []): CommissionModel {
  return {
    slot: 'head',
    rarity: 'common',
    description: '',
    cost: RARITY_TICKETS.common,
    problem: null,
    focus: 0,
    tickets: normalizeTickets(tickets),
    banned: [...banned],
    pending: false,
    error: null,
    queue: [],
  }
}

function withCost(m: CommissionModel, rarity: Rarity): CommissionModel {
  const cost = RARITY_TICKETS[rarity]
  const problem = checkDescription(m.description, m.banned)
    ?? (m.tickets < cost ? insufficient(cost) : null)
  return { ...m, rarity, cost, problem }
}

function withText(m: CommissionModel, text: string): CommissionModel {
  return { ...m, description: text, problem: checkDescription(text, m.banned), error: null }
}

function submitAt(m: CommissionModel): CommissionStepResult {
  const problem = checkDescription(m.description, m.banned)
  if (problem !== null) return { model: { ...m, problem }, submit: null }
  if (m.tickets < m.cost) {
    return { model: { ...m, problem: insufficient(m.cost) }, submit: null }
  }
  return {
    model: { ...m, problem: null, error: null, pending: true },
    submit: { slot: m.slot, rarity: m.rarity, description: m.description.trim() },
  }
}

export function commissionStep(
  m: CommissionModel,
  input: Action | { text: string },
): CommissionStepResult {
  if (m.pending) return { model: m, submit: null }
  if (typeof input === 'object' && input !== null) {
    return { model: withText(m, input.text), submit: null }
  }
  switch (input) {
    case 'up':
      return { model: { ...m, focus: Math.max(0, m.focus - 1) }, submit: null }
    case 'down':
      return { model: { ...m, focus: Math.min(LAST_ROW, m.focus + 1) }, submit: null }
    case 'left':
    case 'right': {
      const delta = input === 'right' ? 1 : -1
      if (m.focus === 0) {
        return { model: { ...m, slot: cycle(SLOTS, m.slot, delta) }, submit: null }
      }
      if (m.focus === 1) {
        return { model: withCost(m, cycle(RARITIES, m.rarity, delta)), submit: null }
      }
      return { model: m, submit: null }
    }
    case 'confirm':
      return m.focus === LAST_ROW ? submitAt(m) : { model: m, submit: null }
    default:
      return { model: m, submit: null }
  }
}

export function withQueue(
  m: CommissionModel,
  queue: readonly Omit<Commission, 'playerId'>[],
  error: string | null = null,
): CommissionModel {
  return { ...m, queue: queue.map(entry => ({ ...entry })), pending: false, error }
}

export function commissionLines(m: CommissionModel): string[] {
  const rows = [
    `Slot: ${m.slot}`,
    `Rarity: ${m.rarity} · Cost: ${m.cost} tickets`,
    m.description.trim() === '' ? '(type a description)' : m.description,
    `Submit (${m.cost} tickets)`,
    m.problem ?? m.error ?? `Tickets: ${m.tickets}`,
  ]
  const queue = m.queue.slice(-2).reverse().map(entry =>
    `${entry.status} · ${entry.slot} · ${entry.rarity} · ${entry.description.slice(0, 40)}`)
  if (queue.length === 0) queue.push('Queue is empty')
  while (queue.length < 2) queue.push('')
  return [
    ...rows.map((line, index) => (index === m.focus ? `> ${line} <` : line)),
    ...queue,
  ]
}
