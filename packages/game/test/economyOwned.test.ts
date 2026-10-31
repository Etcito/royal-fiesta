import assert from 'node:assert/strict'
import test from 'node:test'
import { COINS_PER_QUALIFY, ECONOMY_ERRORS, EconomyError, type Me } from '../src/economy/contract.ts'
import { economyOwned, rewardOffline } from '../src/economy/owned.ts'
import { createEconomyStub } from '../src/economy/stub.ts'
import type { ZoneRoundResult } from '../src/net/zoneRounds.ts'

const me: Me = {
  playerId: 'alice', coins: 100, tickets: 3,
  owned: ['costume.fish-scarf'], inboxUnread: 0,
}

function round(overrides: Partial<ZoneRoundResult> = {}): ZoneRoundResult {
  return {
    index: 0, map: 'B', course: 's1-b-butterfly-freeway', kind: 'race',
    final: false, playoff: false, endTick: 600, reason: 'target',
    ranking: [2, 7, 0, 4], qualified: [2, 7, 0], eliminated: [4],
    points: [4, 3, 2, 0], teamScores: [], champion: -1,
    ...overrides,
  }
}

test('owned and unread follow buys, outgoing gifts, incoming gifts and claims', async () => {
  const stub = createEconomyStub({ me })
  const source = economyOwned(stub)
  assert.deepEqual(await source.owned(), me.owned)
  assert.equal(await source.unread(), 0)

  await stub.buy('costume.propeller-hat', 'coins')
  assert.deepEqual(await source.owned(), ['costume.fish-scarf', 'costume.propeller-hat'])
  assert.equal(await source.unread(), 0)

  await stub.gift('bob', 'costume.fish-scarf', 'A scarf for you')
  assert.deepEqual(await source.owned(), ['costume.propeller-hat'])
  assert.equal(await source.unread(), 0)

  const bob = stub.connect('bob')
  const [giftToBob] = await bob.inbox()
  await bob.claim(giftToBob.id)
  await bob.gift(me.playerId, 'costume.fish-scarf', 'A scarf for you too')
  assert.deepEqual(await source.owned(), ['costume.propeller-hat'])
  assert.equal(await source.unread(), 1)

  const [giftToAlice] = await stub.inbox()
  await stub.claim(giftToAlice.id)
  assert.deepEqual(await source.owned(), ['costume.propeller-hat', 'costume.fish-scarf'])
  assert.equal(await source.unread(), 0)
})

test('owned and unread pass through each EconomyError unchanged', async () => {
  const stub = createEconomyStub({ me })
  for (const code of Object.keys(ECONOMY_ERRORS)) {
    const error = new EconomyError(code, 'me refused')
    const source = economyOwned({ ...stub, async me() { throw error } })
    await assert.rejects(source.owned(), caught => caught === error)
    await assert.rejects(source.unread(), caught => caught === error)
  }
})

test('rewardOffline grants coins for each qualified local seat only', async () => {
  const stub = createEconomyStub({ me })
  rewardOffline(stub, round(), [0, 2, 4] as const)
  assert.deepEqual(await stub.me(), { ...me, coins: me.coins + 2 * COINS_PER_QUALIFY })
})

test('rewardOffline grants exactly one ticket to a local champion at seat zero', async () => {
  const stub = createEconomyStub({ me })
  rewardOffline(stub, round({
    final: true, ranking: [0, 2, 7, 4], qualified: [0], eliminated: [2, 7, 4],
    points: [4, 0, 0, 0], champion: 0,
  }), [0, 2, 4] as const)
  assert.deepEqual(await stub.me(), {
    ...me, coins: me.coins + COINS_PER_QUALIFY, tickets: me.tickets + 1,
  })
})

test('rewardOffline ignores a non-local champion and non-local qualifiers', async () => {
  const stub = createEconomyStub({ me })
  rewardOffline(stub, round({
    final: true, ranking: [7, 2, 0, 4], qualified: [7], eliminated: [2, 0, 4],
    points: [4, 0, 0, 0], champion: 7,
  }), [0, 4] as const)
  assert.deepEqual(await stub.me(), me)
})

test('rewardOffline grants nothing without local seats', async () => {
  const stub = createEconomyStub({ me })
  rewardOffline(stub, round({ champion: 0 }), [])
  assert.deepEqual(await stub.me(), me)
})
