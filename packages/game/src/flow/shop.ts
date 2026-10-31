// The shop model: wardrobe slots of catalogue items, the Inbox/Commission buttons and the wallet.
// Pure: no DOM and no clock, in the style of flow/startScreen.ts. The caller supplies the catalogue and
// the player, and applies a buy by lowering the wallet and marking the item owned on the next refresh.
import type { CatalogItem, Me, Rarity, Slot } from '../economy/contract.ts'
import type { Action } from '../screens/nav.ts'

// The brief's fixed slot order and rarity order. Slots without items disappear; rarities rank items.
export const SHOP_SLOTS: readonly Slot[] = Object.freeze(['head', 'body', 'bottom', 'special'])
export const SHOP_RARITIES: readonly Rarity[] = Object.freeze(['common', 'rare', 'legendary', 'epic'])
export const SHOP_BUTTONS = Object.freeze(['inbox', 'commission'] as const)
export type ShopButton = typeof SHOP_BUTTONS[number]
export const SHOP_LINE_COUNT = 7

export interface ShopItem extends CatalogItem {
  owned: boolean
}

export interface ShopRow {
  slot: Slot
  items: ShopItem[]
}

export interface ShopModel {
  slots: ShopRow[]
  // [row, column]: rows are the item slots plus the button row at index slots.length.
  focus: [number, number]
  coins: number
  tickets: number
  pending: boolean
  error: string | null
}

export interface ShopStep {
  model: ShopModel
  buy: { itemId: string; currency: 'coins' | 'tickets' } | null
  // Set by confirm on the button row: the screen the caller must open.
  open: ShopButton | null
}

function rarityRank(rarity: Rarity): number {
  const rank = SHOP_RARITIES.indexOf(rarity)
  return rank < 0 ? SHOP_RARITIES.length : rank
}

function byRarityThenName(a: CatalogItem, b: CatalogItem): number {
  const rank = rarityRank(a.rarity) - rarityRank(b.rarity)
  if (rank !== 0) return rank
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function buttonCount(): number {
  return SHOP_BUTTONS.length
}

function columnCount(m: ShopModel, row: number): number {
  if (row < m.slots.length) return m.slots[row].items.length
  return buttonCount()
}

function clampFocus(m: ShopModel, row: number, column: number): [number, number] {
  const lastRow = m.slots.length
  const r = Math.min(Math.max(Math.trunc(row), 0), lastRow)
  const count = columnCount(m, r)
  const c = Math.min(Math.max(Math.trunc(column), 0), Math.max(0, count - 1))
  return [r, c]
}

export function shopModel(catalog: CatalogItem[], me: Me): ShopModel {
  const owned = new Set(me.owned)
  const slots = SHOP_SLOTS
    .map((slot): ShopRow => ({
      slot,
      items: catalog
        .filter(item => item.slot === slot)
        .sort(byRarityThenName)
        .map(item => ({ ...item, price: { ...item.price }, owned: owned.has(item.id) })),
    }))
    .filter(row => row.items.length > 0)
  return {
    slots,
    focus: clampFocus({ slots, focus: [0, 0], coins: me.coins, tickets: me.tickets, pending: false, error: null }, 0, 0),
    coins: me.coins,
    tickets: me.tickets,
    pending: false,
    error: null,
  }
}

function move(m: ShopModel, rowDelta: -1 | 0 | 1, columnDelta: -1 | 0 | 1): ShopModel {
  return {
    ...m,
    focus: clampFocus(m, m.focus[0] + rowDelta, m.focus[1] + columnDelta),
    error: null,
  }
}

function pickCurrency(item: ShopItem, coins: number, tickets: number): 'coins' | 'tickets' | null {
  if (item.price.coins !== undefined && coins >= item.price.coins) return 'coins'
  if (item.price.tickets !== undefined && tickets >= item.price.tickets) return 'tickets'
  return null
}

function refusal(m: ShopModel, error: string): ShopStep {
  return { model: { ...m, error }, buy: null, open: null }
}

export function shopStep(m: ShopModel, action: Action): ShopStep {
  switch (action) {
    case 'up':
      return { model: move(m, -1, 0), buy: null, open: null }
    case 'down':
      return { model: move(m, 1, 0), buy: null, open: null }
    case 'left':
      return { model: move(m, 0, -1), buy: null, open: null }
    case 'right':
      return { model: move(m, 0, 1), buy: null, open: null }
    case 'confirm': {
      if (m.pending) return { model: m, buy: null, open: null }
      const [row, column] = m.focus
      if (row >= m.slots.length) {
        const open = SHOP_BUTTONS[Math.min(Math.max(column, 0), buttonCount() - 1)]
        return { model: m, buy: null, open: open ?? null }
      }
      const item = m.slots[row]?.items[column]
      if (item === undefined) return { model: m, buy: null, open: null }
      if (item.owned) return refusal(m, 'Already owned')
      if (item.remaining <= 0) return refusal(m, 'Sold out')
      const currency = pickCurrency(item, m.coins, m.tickets)
      if (currency === null) return refusal(m, 'Not enough coins or tickets')
      return {
        model: { ...m, pending: true, error: null },
        buy: { itemId: item.id, currency },
        open: null,
      }
    }
    default:
      return { model: m, buy: null, open: null }
  }
}

function priceText(item: ShopItem): string {
  const parts: string[] = []
  if (item.price.coins !== undefined) parts.push(`${item.price.coins} coins`)
  if (item.price.tickets !== undefined) parts.push(`${item.price.tickets} tickets`)
  return parts.length === 0 ? '—' : parts.join(' / ')
}

function itemText(item: ShopItem | undefined): string {
  if (item === undefined) return '—'
  const count = item.owned ? 'OWNED' : item.remaining <= 0 ? 'SOLD OUT' : `${item.remaining} left`
  return `${item.name} · ${item.rarity} · ${priceText(item)} · ${count}`
}

// `>` and `<` mark the focused row. The four slot lines are always present (empty slots are padded),
// followed by the Inbox/Commission row and the status line, for exactly SHOP_LINE_COUNT strings.
function framed(text: string, focused: boolean): string {
  return focused ? `> ${text} <` : `< ${text} >`
}

export function shopLines(m: ShopModel): string[] {
  const lines: string[] = [`Coins ${m.coins} · Tickets ${m.tickets}`]
  for (let row = 0; row < 4; row++) {
    const entry = m.slots[row]
    const focused = m.focus[0] === row
    if (entry === undefined) {
      lines.push(framed('—', focused))
      continue
    }
    const column = Math.min(Math.max(m.focus[1], 0), entry.items.length - 1)
    lines.push(framed(itemText(entry.items[column]), focused))
  }
  const buttonRow = m.focus[0] === m.slots.length
  const buttons = SHOP_BUTTONS.map((button, index) => {
    const label = button === 'inbox' ? 'Inbox' : 'Commission'
    return buttonRow && m.focus[1] === index ? `[${label}]` : label
  }).join(' · ')
  lines.push(framed(buttons, buttonRow))
  lines.push(m.error ?? (m.pending ? 'Buying…' : ''))
  return lines
}
