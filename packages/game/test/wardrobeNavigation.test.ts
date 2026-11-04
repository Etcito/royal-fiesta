import test from 'node:test'
import assert from 'node:assert/strict'
import { startScreen, startStep, LOCAL_COSMETICS } from '../src/flow/startScreen.ts'
import { shopModel, shopStep, shopTab } from '../src/flow/shop.ts'
import type { CatalogItem } from '../src/economy/contract.ts'
const owned = LOCAL_COSMETICS.map(c => c.id)
const wardrobe = () => startScreen(owned, LOCAL_COSMETICS, 0, { colour: 0, worn: { head: owned[0] } })
const catalog: CatalogItem[] = LOCAL_COSMETICS.map(c => ({ ...c, name: c.id, rarity: 'common', price: { coins: 30, tickets: 2 }, remaining: 10, editionCap: 10, sold: 0 }))
const shop = () => shopModel(catalog, { playerId: 'test', coins: 100, tickets: 3, owned: [owned[0]], inboxUnread: 0 })
test('the carousel arrows wear what they show; None removes it and confirm has nothing left to do', () => {
 const original = wardrobe()
 const browse = startStep(original, 'right')
 assert.equal(browse.effect, 'wear'); assert.equal(browse.model.bins[0].worn, 1)
 assert.equal(browse.model.bins[0].selected, 1)
 const confirm = startStep(browse.model, 'confirm')
 assert.equal(confirm.effect, null); assert.deepEqual(confirm.model, browse.model)
 let m = original
 m = startStep(m, 'left').model
 assert.equal(m.bins[0].selected, -1)
 assert.equal(m.bins[0].worn, -1)
 assert.equal(original.bins[0].worn, 0)
})
test('all four carousel rows, palette and actions wrap deterministically', () => {
 let m = wardrobe()
 for (let i = 1; i < 4; i++) { m = startStep(m, 'down').model; assert.equal(m.bin, i) }
 m = startStep(m, 'down').model; assert.equal(m.focus, 'palette')
 m = startStep(m, 'down').model; assert.equal(startStep(m, 'confirm').effect, 'play')
 m = startStep(m, 'down').model; assert.equal(startStep(m, 'confirm').effect, 'shop')
 assert.equal(startStep(m, 'down').model.bin, 0)
})
test('the arrows step the one shown item through None and every owned colour variant, wrapping', () => {
 let m = wardrobe()
 const seen = new Set([m.bins[0].selected])
 for (let i = 0; i < 10; i++) { m = startStep(m, 'right').model; seen.add(m.bins[0].selected) }
 assert.equal(seen.size, 10)
 assert.ok(seen.has(-1), 'None is one of the stops')
 assert.equal(m.bins[0].selected, wardrobe().bins[0].selected, 'ten steps over nine items and None come back')
})
test('four tabs include all 24 colour variants, grid uses three columns and returns to tabs', () => {
 let m = shop()
 assert.equal(m.slots.length, 4); assert.equal(m.slots.flatMap(s=>s.items).length, 36)
 assert.equal(m.zone, 'tabs')
 m = shopStep(m, 'right').model; assert.equal(m.focus[0], 1)
 m = shopStep(m, 'down').model; assert.equal(m.zone, 'grid')
 m = shopStep(m, 'right').model; assert.equal(m.focus[1], 1)
 m = shopStep(m, 'down').model; assert.equal(m.focus[1], 4)
 m = shopStep(m, 'up').model; assert.equal(m.focus[1], 1)
 m = shopStep(m, 'up').model; assert.equal(m.zone, 'tabs')
 assert.equal(shopStep(shopTab(m, 0), 'left').model.focus[0], 3)
})
test('buy requires explicit confirmation, respects wallet/ownership/stock and freezes pending input', () => {
 let m = { ...shopTab(shop(), 1), zone: 'grid' as const }
 const first = shopStep(m, 'confirm')
 assert.equal(first.buy, null); assert.ok(first.model.confirm)
 const canceled = shopStep(first.model, 'left'); assert.equal(canceled.model.confirm, null)
 const buy = shopStep(first.model, 'confirm')
 assert.deepEqual(buy.buy, first.model.confirm); assert.equal(buy.model.pending, true)
 assert.equal(shopStep(buy.model, 'confirm').buy, null)
 assert.deepEqual(shopStep(buy.model, 'right').model, buy.model)
 assert.match(shopStep({ ...m, coins: 0, tickets: 0 }, 'confirm').model.error!, /Not enough/)
 const item = m.slots[1].items[0]; item.owned = true
 assert.equal(shopStep(m, 'confirm').model.error, 'Already owned')
 item.owned = false; item.remaining = 0
 assert.equal(shopStep(m, 'confirm').model.error, 'Sold out')
})
