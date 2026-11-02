import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogItem, Me } from '../src/economy/contract.ts'
import { createEconomyStub } from '../src/economy/stub.ts'
import { SHOP_BUTTONS, SHOP_SLOTS, shopLines, shopModel, shopStep } from '../src/flow/shop.ts'
import type { ShopModel } from '../src/flow/shop.ts'
import { flowAction } from '../src/screens/nav.ts'
import type { Action } from '../src/screens/nav.ts'

// The catalogue is built through economy's own stub, so remaining copies and the rarity ticket
// prices obey the same rules the service applies. The player owns the propeller hat already.
const CATALOG: CatalogItem[] = [
  { id: 'costume.ghost-aura', name: 'Ghost Aura', slot: 'special', rarity: 'epic',
    asset: 'costume.ghost-aura', price: { coins: 200, tickets: 6 }, editionCap: 5, sold: 5, remaining: 0 },
  { id: 'costume.fish-scarf', name: 'Fish Scarf', slot: 'bottom', rarity: 'common',
    asset: 'costume.fish-scarf', price: { coins: 30, tickets: 3 }, editionCap: 20, sold: 0, remaining: 20 },
  { id: 'costume.pineapple-suit', name: 'Pineapple Suit', slot: 'body', rarity: 'common',
    asset: 'costume.pineapple-suit', price: { coins: 30, tickets: 3 }, editionCap: 20, sold: 0, remaining: 20 },
  { id: 'costume.propeller-hat', name: 'Propeller Hat', slot: 'head', rarity: 'common',
    asset: 'costume.propeller-hat', price: { coins: 30, tickets: 3 }, editionCap: 20, sold: 8, remaining: 12 },
  { id: 'costume.queen-crown', name: 'Queen Crown', slot: 'head', rarity: 'legendary',
    asset: 'costume.queen-crown', price: { coins: 120, tickets: 5 }, editionCap: 6, sold: 1, remaining: 5 },
  { id: 'costume.bubble-boots', name: 'Bubble Boots', slot: 'bottom', rarity: 'rare',
    asset: 'costume.bubble-boots', price: { coins: 45, tickets: 4 }, editionCap: 10, sold: 2, remaining: 8 },
  { id: 'costume.wing-pack', name: 'Wing Pack', slot: 'body', rarity: 'rare',
    asset: 'costume.wing-pack', price: { coins: 500, tickets: 4 }, editionCap: 10, sold: 0, remaining: 10 },
  { id: 'costume.dragon-aura', name: 'Dragon Aura', slot: 'special', rarity: 'epic',
    asset: 'costume.dragon-aura', price: { coins: 900, tickets: 6 }, editionCap: 5, sold: 0, remaining: 5 },
]

const ME: Me = {
  playerId: 'shop-test',
  coins: 60,
  tickets: 5,
  owned: ['costume.propeller-hat'],
  inboxUnread: 2,
}

async function fresh(): Promise<ShopModel> {
  const catalog = await createEconomyStub({ catalog: CATALOG, me: ME }).catalog()
  return shopModel(catalog.items, ME)
}

type Ui = { k: 'focus' | 'adjust'; dir: -1 | 1 } | { k: 'select' }

// Keyboard arrows/Enter become focus/adjust/select UiEvents in apps/web/src/input/input.ts; the pad's
// d-pad and A button produce the same events in apps/web/src/input/padMenu.ts. flowAction() maps
// up/down arrows and the d-pad to up/down, left/right to adjust, and Enter/A to confirm, so driving
// the model with flowAction proves both input devices reach these exact steps.
function drive(
  m: ShopModel,
  events: readonly Ui[],
): { model: ShopModel; buy: ReturnType<typeof shopStep>['buy']; open: ReturnType<typeof shopStep>['open'] } {
  let current = m
  let result = { model: m, buy: null, open: null } as ReturnType<typeof shopStep>
  for (const ev of events) {
    const action = flowAction(ev)
    assert.notEqual(action, null)
    result = shopStep(current, action as Action)
    current = result.model
  }
  return result
}

const down = (times: number): Ui[] => Array.from({ length: times }, () => ({ k: 'focus', dir: 1 }) as Ui)

test('four slots in head, body, bottom, special order, items sorted by rarity then name', async () => {
  const m = await fresh()

  assert.deepEqual(SHOP_SLOTS, ['head', 'body', 'bottom', 'special'])
  assert.deepEqual(m.slots.map(row => row.slot), ['head', 'body', 'bottom', 'special'])
  assert.deepEqual(m.slots.map(row => row.items.map(item => item.name)), [
    ['Propeller Hat', 'Queen Crown'],
    ['Pineapple Suit', 'Wing Pack'],
    ['Fish Scarf', 'Bubble Boots'],
    ['Dragon Aura', 'Ghost Aura'],
  ])
  // The rare items follow the commons, the legendary follows the common, and the epics tie on
  // rarity so their names order them.
  assert.deepEqual(m.slots.map(row => row.items.map(item => item.rarity)), [
    ['common', 'legendary'],
    ['common', 'rare'],
    ['common', 'rare'],
    ['epic', 'epic'],
  ])
  assert.deepEqual(m.slots[0].items.map(item => item.owned), [true, false])
  assert.ok(m.slots.slice(1).every(row => row.items.every(item => !item.owned)))

  const hat = m.slots[0].items[0]
  assert.deepEqual(hat.price, { coins: 30, tickets: 3 })
  assert.equal(hat.remaining, 12)
  assert.equal(m.slots[3].items[1].remaining, 0)
  assert.equal(m.coins, 60)
  assert.equal(m.tickets, 5)
  assert.deepEqual(m.focus, [0, 0])
})

test('tab navigation, three-column grid and two-stage coin purchase', async () => {
  let m = await fresh()
  m = shopStep(shopStep(m, 'right').model, 'right').model
  m = shopStep(m, 'down').model
  m = shopStep(m, 'right').model
  const confirm = shopStep(m, 'confirm')
  assert.deepEqual(confirm.model.focus, [2, 1])
  assert.equal(confirm.buy, null)
  const buy = shopStep(confirm.model, 'confirm')
  assert.deepEqual(buy.buy, { itemId: 'costume.bubble-boots', currency: 'coins' })
  assert.equal(buy.model.pending, true)
  assert.equal(shopStep(buy.model, 'confirm').buy, null)
})

test('ticket fallback, ownership, stock and affordability are checked before confirmation', async () => {
  const m = await fresh()
  const ticket = shopStep({ ...m, zone: 'grid', focus: [1, 1] }, 'confirm')
  assert.equal(ticket.model.confirm?.currency, 'tickets')
  assert.deepEqual(shopStep(ticket.model, 'confirm').buy, { itemId: 'costume.wing-pack', currency: 'tickets' })
  assert.equal(shopStep({ ...m, zone: 'grid' }, 'confirm').model.error, 'Already owned')
  assert.equal(shopStep({ ...m, zone: 'grid', focus: [3, 1] }, 'confirm').model.error, 'Sold out')
  const broke = shopStep({ ...m, zone: 'grid', focus: [3, 0] }, 'confirm')
  assert.equal(broke.model.error, 'Not enough coins or tickets')
  assert.equal(shopStep(broke.model, 'right').model.error, null)
})

test('grid bottom reaches the action buttons; tab edges wrap', async () => {
  const m = await fresh()
  const grid = shopStep(m, 'down').model
  const buttons = shopStep(grid, 'down').model
  assert.equal(buttons.zone, 'buttons')
  assert.equal(shopStep(buttons, 'confirm').open, 'inbox')
  assert.equal(shopStep(shopStep(buttons, 'right').model, 'confirm').open, 'commission')
  assert.equal(shopStep(m, 'left').model.focus[0], 3)
  assert.equal(shopStep(shopStep(m, 'left').model, 'right').model.focus[0], 0)
  assert.deepEqual(SHOP_BUTTONS, ['inbox', 'commission'])
})

test('seven lines show the wallet, remaining copies, OWNED, SOLD OUT and focus marks', async () => {
  const m = await fresh()
  const lines = shopLines(m)

  assert.equal(lines.length, 7)
  assert.equal(lines[0], 'Coins 60 · Tickets 5')
  assert.equal(lines[1], '> Propeller Hat · common · 30 coins / 3 tickets · OWNED <')
  assert.equal(lines[2], '< Pineapple Suit · common · 30 coins / 3 tickets · 20 left >')
  assert.equal(lines[3], '< Fish Scarf · common · 30 coins / 3 tickets · 20 left >')
  assert.equal(lines[4], '< Dragon Aura · epic · 900 coins / 6 tickets · 5 left >')
  assert.equal(lines[5], '< Inbox · Commission >')
  assert.equal(lines[6], '')

  // The focused slot row and the button row both carry the > < marks; pending and error fill the status.
  const living = shopLines(m.slots.length === 4 ? { ...m, focus: [3, 1] } : m)
  assert.equal(living[4], '> Ghost Aura · epic · 200 coins / 6 tickets · SOLD OUT <')
  const button = shopLines({ ...m, focus: [4, 0] })
  assert.equal(button[5], '> [Inbox] · Commission <')
  const pending = shopLines({ ...m, pending: true })
  assert.equal(pending[6], 'Buying…')
  const error = shopLines({ ...m, error: 'Sold out' })
  assert.equal(error[6], 'Sold out')
})
