import assert from 'node:assert/strict'
import test from 'node:test'
import { createEconomyClient } from '../src/economy/client.ts'
import {
  COINS_PER_QUALIFY, ECONOMY_ERRORS, EconomyError, GIFT_LIMIT, RARITY_TICKETS, checkDescription,
  type CatalogItem, type Rarity,
} from '../src/economy/contract.ts'
import { createEconomyStub } from '../src/economy/stub.ts'

interface RequestRecord {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function fakeFetch(answer: (request: RequestRecord) => Response | Promise<Response>) {
  const requests: RequestRecord[] = []
  const fetchImpl = async (
    input: RequestInfo | URL, init: RequestInit = {},
  ): Promise<Response> => {
    const request: RequestRecord = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? undefined : String(init.body),
    }
    requests.push(request)
    return answer(request)
  }
  return { fetchImpl: fetchImpl as typeof fetch, requests }
}

function clientFor(answer: (request: RequestRecord) => Response | Promise<Response>) {
  const fake = fakeFetch(answer)
  const client = createEconomyClient('http://economy.test/api/', () => 'player-token', fake.fetchImpl)
  return { client, requests: fake.requests }
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<EconomyError> {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof EconomyError, `expected EconomyError, got ${String(err)}`)
    assert.equal(err.code, code)
    assert.ok(err.message.startsWith(`${code}: `), `refusal carries a reason: ${err.message}`)
    assert.ok(err.message.length > `${code}: `.length)
    return err
  }
  assert.fail(`expected a ${code} refusal`)
}

test('checkDescription refuses 9 characters and 281, accepts 10', () => {
  assert.notEqual(checkDescription('abcdefghi', []), null)
  assert.equal(checkDescription('abcdefghij', []), null)
  assert.notEqual(checkDescription('a'.repeat(281), []), null)
})

test('checkDescription refuses links', () => {
  const http = checkDescription('see http://x', [])
  assert.notEqual(http, null)
  assert.match(http ?? '', /link/i)
  assert.notEqual(checkDescription('www.x', []), null)
  assert.notEqual(checkDescription('please visit www.example now', []), null)
})

test('checkDescription refuses a banned word in mixed case and names it', () => {
  const reason = checkDescription('that is SHIT indeed', ['shit'])
  assert.notEqual(reason, null)
  assert.match(reason ?? '', /shit/i)
})

test('checkDescription accepts a banned word embedded inside another word', () => {
  assert.equal(checkDescription('assassin training', ['ass']), null)
  assert.equal(checkDescription('the classic grasshopper', ['ass']), null)
})

test('the client sends the S18 method, path, body and Bearer header per method', async () => {
  const { client, requests } = clientFor(() => new Response('{}', { status: 200 }))
  await client.catalog()
  await client.me()
  await client.buy('costume.propeller-hat', 'tickets')
  await client.commission('head', 'rare', 'a lovely hat')
  await client.commissions()
  await client.queue()
  await client.inbox()
  await client.claim('gift/42')
  await client.gift('bob', 'costume.propeller-hat', 'enjoy')
  await client.block('bob')
  await client.unblock('player two')

  const expected = [
    ['GET', 'http://economy.test/api/catalog', undefined],
    ['GET', 'http://economy.test/api/me', undefined],
    ['POST', 'http://economy.test/api/buy',
      JSON.stringify({ itemId: 'costume.propeller-hat', currency: 'tickets' })],
    ['POST', 'http://economy.test/api/commissions',
      JSON.stringify({ slot: 'head', rarity: 'rare', description: 'a lovely hat' })],
    ['GET', 'http://economy.test/api/commissions', undefined],
    ['GET', 'http://economy.test/api/commissions/queue', undefined],
    ['GET', 'http://economy.test/api/inbox', undefined],
    ['POST', 'http://economy.test/api/inbox/gift%2F42/claim', undefined],
    ['POST', 'http://economy.test/api/gifts',
      JSON.stringify({ to: 'bob', itemId: 'costume.propeller-hat', message: 'enjoy' })],
    ['POST', 'http://economy.test/api/blocks', JSON.stringify({ player: 'bob' })],
    ['DELETE', 'http://economy.test/api/blocks/player%20two', undefined],
  ] as const
  assert.equal(requests.length, expected.length)
  for (const [index, [method, url, body]] of expected.entries()) {
    const request = requests[index]
    assert.equal(request.method, method, `method of ${url}`)
    assert.equal(request.url, url)
    assert.equal(request.body, body, `body of ${url}`)
    assert.equal(request.headers.Authorization, 'Bearer player-token', `auth of ${url}`)
  }
})

test('a 409 sold_out JSON body throws EconomyError sold_out with status 409', async () => {
  const { client } = clientFor(() => new Response(
    JSON.stringify({ error: 'sold_out', reason: 'the edition is gone' }), { status: 409 },
  ))
  const err = await expectRefusal(client.buy('costume.propeller-hat', 'coins'), 'sold_out')
  assert.equal(err.status, 409)
  assert.match(err.message, /edition is gone/)
})

test('server error bodies map every refusal code with the response status', async () => {
  const codes = [
    'unauthorized', 'unknown_item', 'not_found', 'sold_out', 'insufficient_funds',
    'already_owned', 'not_owned', 'already_claimed', 'no_price', 'invalid',
    'description_refused', 'self_gift', 'blocked', 'rate_limited',
  ] as const
  for (const code of codes) {
    const status = ECONOMY_ERRORS[code]
    const { client } = clientFor(() => new Response(
      JSON.stringify({ error: code, reason: `reason for ${code}` }), { status },
    ))
    const err = await expectRefusal(client.buy('costume.propeller-hat', 'coins'), code)
    assert.equal(err.status, status, `status of ${code}`)
    assert.match(err.message, new RegExp(`reason for ${code}`))
  }
})

test('a non-2xx response with a JSON body maps error to the code and reason', async () => {
  const { client } = clientFor(() => new Response(
    JSON.stringify({ error: 'insufficient_funds', reason: 'you need more coins' }), { status: 409 },
  ))
  const err = await expectRefusal(client.buy('costume.pineapple-suit', 'coins'), 'insufficient_funds')
  assert.equal(err.status, 409)
  assert.match(err.message, /you need more coins/)
})

test('a 500 text body gives http_500', async () => {
  const { client } = clientFor(() => new Response('upstream exploded', { status: 500 }))
  const err = await expectRefusal(client.me(), 'http_500')
  assert.equal(err.status, 500)
})

test('a rejected fetch gives code network', async () => {
  const { client } = clientFor(() => { throw new Error('connection refused') })
  const err = await expectRefusal(client.catalog(), 'network')
  assert.equal(err.status, 0)
})

function catalogItem(id: string, overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id, name: id, slot: 'head', rarity: 'common', asset: id,
    price: { coins: 10 }, editionCap: 10, sold: 0, remaining: 10,
    ...overrides,
  }
}

interface StubCase {
  rule: string
  run: () => Promise<void>
}

const STUB_CASES: StubCase[] = [
  {
    rule: 'catalogue keeps one item per slot with RARITY_TICKETS prices and remaining = cap - sold',
    run: async () => {
      const stub = createEconomyStub()
      const { items } = await stub.catalog()
      for (const id of ['costume.propeller-hat', 'costume.pineapple-suit', 'costume.fish-scarf']) {
        assert.ok(items.some(item => item.id === id), `default catalogue has ${id}`)
      }
      assert.deepEqual(
        [...new Set(items.map(item => item.slot))].sort(),
        ['body', 'bottom', 'head', 'special'],
      )
      for (const item of items) {
        assert.equal(item.remaining, item.editionCap - item.sold, item.id)
        if (item.price.tickets !== undefined) {
          assert.equal(item.price.tickets, RARITY_TICKETS[item.rarity], item.id)
        }
      }
      const hat = items.find(item => item.id === 'costume.propeller-hat')
      assert.equal(hat?.price.coins, 30)
      assert.equal(hat?.rarity, 'common')
    },
  },
  {
    rule: 'buy reaches sold_out at the edition cap and remaining counts down to 0',
    run: async () => {
      const stub = createEconomyStub({
        catalog: [catalogItem('cap.hat', { editionCap: 2 })], me: { coins: 50 },
      })
      const first = await stub.buy('cap.hat', 'coins')
      assert.equal(first.remaining, 1)
      await stub.gift('friend', 'cap.hat', 'first hat')
      const second = await stub.buy('cap.hat', 'coins')
      assert.equal(second.remaining, 0)
      await stub.gift('friend', 'cap.hat', 'second hat')
      await expectRefusal(stub.buy('cap.hat', 'coins'), 'sold_out')
    },
  },
  {
    rule: 'buy refuses insufficient_funds',
    run: async () => {
      const stub = createEconomyStub({
        catalog: [catalogItem('price.hat', { price: { coins: 25 } })], me: { coins: 5 },
      })
      await expectRefusal(stub.buy('price.hat', 'coins'), 'insufficient_funds')
    },
  },
  {
    rule: 'buy refuses already_owned',
    run: async () => {
      const stub = createEconomyStub({
        catalog: [catalogItem('own.hat')], me: { coins: 10, owned: ['own.hat'] },
      })
      await expectRefusal(stub.buy('own.hat', 'coins'), 'already_owned')
    },
  },
  {
    rule: 'buy refuses unknown_item',
    run: async () => {
      const stub = createEconomyStub({ me: { coins: 10 } })
      await expectRefusal(stub.buy('missing.hat', 'coins'), 'unknown_item')
    },
  },
  {
    rule: 'buy refuses no_price in a currency the item does not price',
    run: async () => {
      const stub = createEconomyStub({
        catalog: [catalogItem('coin.hat', { price: { coins: 10 } })], me: { tickets: 10 },
      })
      await expectRefusal(stub.buy('coin.hat', 'tickets'), 'no_price')
    },
  },
  {
    rule: 'grant qualify adds 10 coins and win adds 1 ticket',
    run: async () => {
      const stub = createEconomyStub()
      stub.grant('qualify')
      assert.equal((await stub.me()).coins, COINS_PER_QUALIFY)
      stub.grant('win')
      assert.equal((await stub.me()).tickets, 1)
    },
  },
  {
    rule: 'commission spends 3/4/5/6 tickets and queues a pending entry without playerId',
    run: async () => {
      for (const rarity of Object.keys(RARITY_TICKETS) as Rarity[]) {
        const stub = createEconomyStub({ me: { tickets: 10 } })
        const entry = await stub.commission('head', rarity, 'a lovely hat please')
        assert.equal(entry.status, 'pending')
        assert.equal((await stub.me()).tickets, 10 - RARITY_TICKETS[rarity], rarity)
        const mine = await stub.commissions()
        assert.deepEqual(mine.map(value => value.id), [entry.id])
        const queue = await stub.queue()
        assert.equal(queue.length, 1)
        assert.equal(queue[0].status, 'pending')
        assert.equal('playerId' in queue[0], false)
        assert.equal(queue[0].description, 'a lovely hat please')
      }
    },
  },
  {
    rule: 'a URL description is refused description_refused with no tickets spent',
    run: async () => {
      const stub = createEconomyStub({ me: { tickets: 10 } })
      const err = await expectRefusal(
        stub.commission('head', 'rare', 'see http://x'), 'description_refused',
      )
      assert.match(err.message, /link/i)
      assert.equal((await stub.me()).tickets, 10)
      assert.deepEqual(await stub.commissions(), [])
      assert.deepEqual(await stub.queue(), [])
    },
  },
  {
    rule: 'commission refuses insufficient_funds and queues nothing',
    run: async () => {
      const tickets = RARITY_TICKETS.epic - 1
      const stub = createEconomyStub({ me: { tickets } })
      await expectRefusal(
        stub.commission('special', 'epic', 'a lovely hat please'), 'insufficient_funds',
      )
      assert.equal((await stub.me()).tickets, tickets)
      assert.deepEqual(await stub.commissions(), [])
      assert.deepEqual(await stub.queue(), [])
    },
  },
  {
    rule: 'gift refuses self_gift',
    run: async () => {
      const stub = createEconomyStub({ catalog: [catalogItem('self.hat')], me: { coins: 10 } })
      await stub.buy('self.hat', 'coins')
      await expectRefusal(stub.gift('local', 'self.hat', 'hello me'), 'self_gift')
    },
  },
  {
    rule: 'gift refuses not_owned',
    run: async () => {
      const stub = createEconomyStub()
      await expectRefusal(stub.gift('bob', 'costume.propeller-hat', 'enjoy'), 'not_owned')
    },
  },
  {
    rule: 'a blocked sender is refused until the recipient unblocks, then the gift lands in the inbox',
    run: async () => {
      const stub = createEconomyStub({
        catalog: [catalogItem('gift.hat', { price: { coins: 10 } })], me: { coins: 10 },
      })
      const bob = stub.connect('bob')
      const localId = (await stub.me()).playerId
      await stub.buy('gift.hat', 'coins')
      await bob.block(localId)
      await expectRefusal(stub.gift('bob', 'gift.hat', 'for you'), 'blocked')
      assert.ok((await stub.me()).owned.includes('gift.hat'))
      assert.deepEqual(await bob.inbox(), [])
      await bob.unblock(localId)
      await stub.gift('bob', 'gift.hat', 'for you')
      assert.equal((await stub.me()).owned.includes('gift.hat'), false)
      const inbox = await bob.inbox()
      assert.equal(inbox.length, 1)
      assert.equal(inbox[0].claimed, false)
      assert.equal(inbox[0].item, 'gift.hat')
      assert.equal(inbox[0].message, 'for you')
      assert.deepEqual(inbox[0].sender, { kind: 'player', id: localId })
      assert.equal((await bob.me()).inboxUnread, 1)
      const afterClaim = await bob.claim(inbox[0].id)
      assert.ok(afterClaim.owned.includes('gift.hat'))
      assert.equal(afterClaim.inboxUnread, 0)
      assert.equal((await bob.me()).inboxUnread, 0)
      await expectRefusal(bob.claim(inbox[0].id), 'already_claimed')
      const again = stub.connect('bob')
      assert.equal((await again.me()).playerId, 'bob')
      assert.ok((await again.me()).owned.includes('gift.hat'))
    },
  },
  {
    rule: 'gift refuses rate_limited on the sixth gift',
    run: async () => {
      const owned = ['g.1', 'g.2', 'g.3', 'g.4', 'g.5', 'g.6']
      const stub = createEconomyStub({ me: { owned: [...owned] } })
      for (const id of owned.slice(0, GIFT_LIMIT.count)) {
        await stub.gift('friend', id, 'a gift')
      }
      await expectRefusal(stub.gift('friend', owned[GIFT_LIMIT.count], 'a gift'), 'rate_limited')
    },
  },
  {
    rule: 'a gift moves the item and leaves sold and remaining unchanged',
    run: async () => {
      const stub = createEconomyStub({
        catalog: [catalogItem('send.hat', { editionCap: 3 })], me: { coins: 10 },
      })
      await stub.buy('send.hat', 'coins')
      const item = async () => (await stub.catalog()).items.find(value => value.id === 'send.hat')
      const before = await item()
      assert.equal(before?.sold, 1)
      assert.equal(before?.remaining, 2)
      await stub.gift('friend', 'send.hat', 'enjoy')
      assert.equal((await stub.me()).owned.includes('send.hat'), false)
      const after = await item()
      assert.equal(after?.sold, 1)
      assert.equal(after?.remaining, 2)
      assert.deepEqual(after, before)
    },
  },
]

for (const { rule, run } of STUB_CASES) test(`stub rule: ${rule}`, run)
