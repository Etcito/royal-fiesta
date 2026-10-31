import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RARITY_TICKETS } from '../../packages/game/src/economy/contract.ts'
import { generateEconomyConfig } from '../economyConfig.ts'
import type { EconomyConfig } from '../economyConfig.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const committed = JSON.parse(
  readFileSync(`${root}economy/royal-fiesta.economy.json`, 'utf8'),
) as EconomyConfig

test('the committed economy config equals the generator output', () => {
  assert.deepEqual(committed, generateEconomyConfig())
})

test('every item whose tickets price is present uses its rarity price (QB7)', () => {
  const items = committed.catalog.shop.items
  assert.ok(items.length > 0, 'the Season 1 catalogue has items')
  for (const item of items) {
    const tickets = item.price.tickets
    if (tickets === undefined) continue
    assert.equal(
      tickets,
      RARITY_TICKETS[item.rarity],
      `${item.id}: a ${item.rarity} item must cost ${RARITY_TICKETS[item.rarity]} tickets`,
    )
  }
})

test('every item slot and rarity is declared', () => {
  const shop = committed.catalog.shop
  for (const item of shop.items) {
    assert.ok(shop.slots.includes(item.slot), `${item.id}: slot ${item.slot} is not declared`)
    assert.ok(Object.hasOwn(shop.rarities, item.rarity), `${item.id}: rarity ${item.rarity} is not declared`)
  }
})
