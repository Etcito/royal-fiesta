import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EconomyError } from '../src/economy/contract.ts'
import { createEconomyStub, type EconomyConfig } from '../src/economy/stub.ts'
import { economyCases } from './economyCases.ts'

const config = JSON.parse(readFileSync(
  new URL('../../../economy/royal-fiesta.economy.json', import.meta.url), 'utf8')) as EconomyConfig

for (const ruleCase of economyCases) {
  test(`stub built from the config: ${ruleCase.name}`, async () => {
    const scenario = ruleCase.setup()
    const stub = createEconomyStub({ ...scenario.seed, config })
    const port = scenario.prepare ? await scenario.prepare(stub) : stub
    if (ruleCase.code === null) {
      assert.deepEqual(await scenario.run(port), { applied: false })
      return
    }
    await assert.rejects(scenario.run(port),
      (error: unknown) => error instanceof EconomyError && error.code === ruleCase.code)
  })
}

test('a stub built from the config exposes its slots, rarity prices and items', async () => {
  const stub = createEconomyStub({ config })
  assert.deepEqual(stub.slots, ['head', 'body', 'bottom', 'special'])
  for (const [rarity, { price }] of Object.entries(config.catalog.shop.rarities)) {
    assert.equal(stub.rarityTickets[rarity as keyof typeof stub.rarityTickets], price.tickets)
  }
  const { drop, items } = await stub.catalog()
  assert.equal(drop, config.catalog.shop.drop)
  assert.equal(items.length, config.catalog.shop.items.length)
  assert.equal(items[0].editionCap, config.catalog.shop.items[0].edition_cap)
})

test('round rewards follow the config and replays are not applied', async () => {
  const stub = createEconomyStub({ config, me: { playerId: 'p1' } })
  assert.deepEqual(await stub.reportRound('m', 1, 'p1', 'qualify'), { applied: true })
  assert.deepEqual(await stub.reportRound('m', 1, 'p1', 'win'), { applied: true })
  assert.deepEqual(await stub.reportRound('m', 1, 'p1', 'qualify'), { applied: false })
  const me = await stub.me()
  assert.equal(me.coins, config.catalog.round_rewards.qualify.coins)
  assert.equal(me.tickets, config.catalog.round_rewards.win.currencies?.tickets)
})

test('buying the last copy gives sold_out on the next buy', async () => {
  const item = config.catalog.shop.items[0]
  const catalog = (await createEconomyStub({ config }).catalog()).items
    .map(entry => entry.id === item.id ? { ...entry, sold: entry.editionCap - 1 } : entry)
  const stub = createEconomyStub({ config, catalog, me: { coins: 10_000 } })
  assert.equal((await stub.buy(item.id, 'coins')).remaining, 0)
  await assert.rejects(stub.connect('other').buy(item.id, 'coins'),
    (error: unknown) => error instanceof EconomyError && error.code === 'sold_out')
})

test('a gift does not change sold', async () => {
  const item = config.catalog.shop.items[0]
  const stub = createEconomyStub({ config, me: { coins: 10_000 } })
  await stub.buy(item.id, 'coins')
  await stub.gift('friend', item.id, 'for you')
  const after = (await stub.catalog()).items.find(entry => entry.id === item.id)
  assert.equal(after?.sold, 1)
})
