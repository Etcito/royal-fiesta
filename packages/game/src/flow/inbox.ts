// The inbox model: newest-first rows, the Claim/Gift/Block buttons and the gift picker.
// Pure: the caller supplies the entries and the owned item ids, and the model names the
// request a confirm makes. While a request is pending, no new request leaves the model.
import type { InboxEntry } from '../economy/contract.ts'
import type { Action } from '../screens/nav.ts'

export type InboxButton = 'claim' | 'gift' | 'block'

export const INBOX_BUTTONS: readonly InboxButton[] = Object.freeze(['claim', 'gift', 'block'])

export const GIFT_MESSAGE = 'A gift from a friend!'

const WINDOW = 5
const NOTHING_TO_CLAIM = 'Nothing to claim'

export interface InboxModel {
  rows: InboxEntry[]
  // The focused row index, clamped to the rows.
  focus: number
  button: InboxButton
  // Item ids the player can give away; the gift picker indexes this list.
  owned: string[]
  picking: boolean
  giftItem: number
  // A request is in flight: movement and confirms are ignored until it settles.
  pending: boolean
  error: string | null
}

export interface InboxStep {
  model: InboxModel
  claim: string | null
  gift: { to: string; itemId: string; message: string } | null
  block: string | null
}

export function inboxModel(entries: readonly InboxEntry[], owned: readonly string[] = []): InboxModel {
  const rows = [...entries].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  return {
    rows,
    focus: 0,
    button: 'claim',
    owned: [...owned],
    picking: false,
    giftItem: 0,
    pending: false,
    error: null,
  }
}

function senderName(entry: InboxEntry): string {
  return entry.sender.id ?? entry.sender.kind
}

// The gift/block target: a player sender with an id, else null.
function playerSender(entry: InboxEntry | undefined): string | null {
  if (entry === undefined || entry.sender.kind !== 'player') return null
  return entry.sender.id
}

function buttonsAt(button: InboxButton, delta: -1 | 1): InboxButton {
  const at = INBOX_BUTTONS.indexOf(button)
  const n = INBOX_BUTTONS.length
  return INBOX_BUTTONS[(at + delta + n) % n]
}

function idle(m: InboxModel, patch: Partial<InboxModel> = {}): InboxStep {
  return { model: { ...m, ...patch }, claim: null, gift: null, block: null }
}

function stepPicking(m: InboxModel, action: Action): InboxStep {
  const entry = m.rows[m.focus]
  switch (action) {
    case 'up':
    case 'down': {
      const n = m.owned.length
      if (n === 0) return idle(m, { picking: false, error: null })
      const delta = action === 'down' ? 1 : -1
      return idle(m, { giftItem: ((m.giftItem + delta) % n + n) % n, error: null })
    }
    case 'confirm': {
      const to = playerSender(entry)
      const itemId = m.owned[m.giftItem]
      if (to === null || itemId === undefined) return idle(m, { picking: false, error: null })
      return {
        model: { ...m, picking: false, pending: true, error: null },
        claim: null,
        gift: { to, itemId, message: GIFT_MESSAGE },
        block: null,
      }
    }
    case 'left':
    case 'right':
      return idle(m, { picking: false, giftItem: 0, error: null })
    default:
      return idle(m)
  }
}

function stepConfirm(m: InboxModel): InboxStep {
  const entry = m.rows[m.focus]
  switch (m.button) {
    case 'claim':
      if (entry !== undefined && !entry.claimed && entry.item !== null) {
        return { model: { ...m, pending: true, error: null }, claim: entry.id, gift: null, block: null }
      }
      return idle(m, { error: NOTHING_TO_CLAIM })
    case 'gift': {
      if (playerSender(entry) === null || m.owned.length === 0) return idle(m, { error: null })
      return idle(m, { picking: true, giftItem: 0, error: null })
    }
    case 'block': {
      const to = playerSender(entry)
      if (to === null) return idle(m, { error: null })
      return { model: { ...m, pending: true, error: null }, claim: null, gift: null, block: to }
    }
  }
}

export function inboxStep(m: InboxModel, action: Action): InboxStep {
  if (m.pending) return idle(m)
  if (m.picking) return stepPicking(m, action)
  switch (action) {
    case 'up':
    case 'down': {
      const delta = action === 'down' ? 1 : -1
      const focus = Math.min(Math.max(m.focus + delta, 0), Math.max(0, m.rows.length - 1))
      return idle(m, { focus, error: null })
    }
    case 'left':
    case 'right':
      return idle(m, { button: buttonsAt(m.button, action === 'right' ? 1 : -1), error: null })
    case 'confirm':
      return stepConfirm(m)
    default:
      return idle(m)
  }
}

function statusLine(m: InboxModel): string {
  if (m.error !== null) return m.error
  if (m.picking) return `Gift: ${m.owned[m.giftItem] ?? ''}`
  if (m.rows.length === 0) return 'Inbox is empty'
  return ''
}

// Five row lines around the focus (blank when there are fewer rows) and the status line.
export function inboxLines(m: InboxModel): string[] {
  const total = m.rows.length
  const start = total <= WINDOW ? 0 : Math.min(Math.max(m.focus - 2, 0), total - WINDOW)
  const lines: string[] = []
  for (let i = 0; i < WINDOW; i++) {
    const entry = m.rows[start + i]
    if (entry === undefined) {
      lines.push('')
      continue
    }
    const label = entry.item ?? entry.message
    const state = entry.claimed ? 'claimed' : 'new'
    lines.push(`> From ${senderName(entry)} · ${label} · ${state} <`)
  }
  lines.push(statusLine(m))
  return lines
}

const BUTTON_LABELS: Readonly<Record<InboxButton, string>> = Object.freeze({
  claim: 'Claim',
  gift: 'Gift',
  block: 'Block',
})

export function inboxButtonsLine(m: InboxModel): string {
  return INBOX_BUTTONS.map(button => (
    button === m.button ? `[${BUTTON_LABELS[button]}]` : BUTTON_LABELS[button]
  )).join('  ')
}
