import assert from 'node:assert/strict'
import test from 'node:test'
import { createEconomyClient } from '../src/economy/client.ts'
import {
  COINS_PER_QUALIFY, ECONOMY_ERRORS, EconomyError, GIFT_LIMIT, RARITY_TICKETS, checkDescription,
  type CatalogItem, type Rarity,
} from '../src/economy/contract.ts'
import { createEconomyStub } from '../src/economy/stub.ts'
import type { WsFactory, WsLike } from '../src/net/ws.ts'
import { economyCases } from './economyCases.ts'

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

for (const rule of economyCases) {
  if (rule.code === null) continue // The offline stub has grant(), not host round reporting.
  test(`shared stub rule: ${rule.name}`, async () => {
    const scenario = rule.setup()
    const stub = createEconomyStub(scenario.seed)
    const port = scenario.prepare ? await scenario.prepare(stub) : stub
    const error = await expectRefusal(scenario.run(port), rule.code!)
    assert.equal(error.status, ECONOMY_ERRORS[rule.code as keyof typeof ECONOMY_ERRORS])
  })
}

type Frame = { t: string; op?: string; [key: string]: unknown }
const auth = { provider: 'wavedash' as const, token: 'player-token', name: 'Player', game: 'test-game' }
const wireCommission = {
  id: 'commission-1', slot: 'head', rarity: 'rare', description: 'a lovely hat',
  status: 'pending', created_at: 1_700_000_000_000,
}
const entry = {
  id: 'gift/42', item: 'hat', sender: { kind: 'player', id: 'friend' },
  message: 'enjoy', date: '2026-10-31T00:00:00.000Z', claimed: false,
}
const shopItems = ['hat', 'empty', 'negative'].map(id => {
  const { editionCap, ...item } = catalogItem(id)
  return { ...item, edition_cap: editionCap }
})
function answer(frame: Frame): Frame {
  switch (frame.t) {
    case 'eco_shop': return { t: 'eco_shop', drop: 'drop-1', items: shopItems }
    case 'eco_get': return {
      t: 'eco_state', coins: 42, balances: { tickets: 7, stars: 9 },
      cards: { hat: 2, empty: 0, negative: -1, collectible: 1 },
    }
    case 'eco_inbox': return { t: 'eco_inbox', entries: [entry], unread: 1 }
    case 'eco_shop_buy': return { t: 'eco_shop_bought', remaining: 8, applied: true }
    case 'eco_commission': return { t: 'eco_commissioned', commission: wireCommission, applied: true }
    case 'eco_commissions': return { t: 'eco_commissions', items: [wireCommission] }
    case 'eco_queue': return { t: 'eco_queue', items: [wireCommission] }
    case 'eco_claim': return { t: 'eco_claimed', id: frame.id, item: 'hat', applied: true }
    case 'eco_gift': return { t: 'eco_gifted', to: frame.to, item: frame.item, applied: true }
    case 'eco_block': return { t: 'eco_blocked', player: frame.player, blocked: frame.blocked }
    case 'eco_round': return { t: 'eco_round', applied: true }
    default: throw new Error(`unexpected frame ${frame.t}`)
  }
}

function scriptedWs(script: (frame: Frame) => Frame | undefined = answer, autoOpen = true, autoAuth = true) {
  const frames: Frame[] = []
  const urls: string[] = []
  const receive = (frame: Frame) => socket.onmessage?.({ data: JSON.stringify(frame) })
  const socket: WsLike & { readyState: number } = {
    readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
    send(data) {
      assert.equal(socket.readyState, 1)
      const frame = JSON.parse(data) as Frame
      frames.push(frame)
      const reply = frame.t === 'auth'
        ? autoAuth ? { t: 'authed', player_id: 'local', provider: auth.provider, display_name: auth.name } : undefined
        : script(frame)
      if (reply) queueMicrotask(() => receive({ ...reply, ...(frame.op ? { op: frame.op } : {}) }))
    },
    close() {
      if (socket.readyState === 3) return
      socket.readyState = 3
      socket.onclose?.({ code: 1000, reason: 'closed by fake' })
    },
  }
  const open = () => { socket.readyState = 1; socket.onopen?.() }
  const factory: WsFactory = url => {
    urls.push(url)
    if (autoOpen) queueMicrotask(open)
    return socket
  }
  return { factory, frames, urls, socket, receive, open }
}
function clientFor(script?: (frame: Frame) => Frame | undefined) {
  const fake = scriptedWs(script)
  return { ...fake, client: createEconomyClient('wss://economy.test/ws', auth, fake.factory) }
}

const expectedMe = { playerId: 'local', coins: 42, tickets: 7, owned: ['hat'], inboxUnread: 1 }

test('WS methods send auth first and fresh ops, and map gamesaloon replies', async () => {
  const { client, frames, urls } = clientFor()
  assert.deepEqual(urls, [], 'connection is lazy')
  const catalog = await client.catalog()
  assert.deepEqual(catalog, { drop: 'drop-1', items: ['hat', 'empty', 'negative'].map(id => catalogItem(id)) })
  assert.deepEqual(await client.me(), expectedMe)
  assert.deepEqual(await client.buy('hat', 'tickets'), { ...expectedMe, remaining: 8 })
  const { created_at, ...fields } = wireCommission
  const publicCommission = { ...fields, createdAt: new Date(created_at).toISOString() }
  assert.deepEqual(await client.commission('head', 'rare', 'a lovely hat'), { ...publicCommission, playerId: 'local' })
  assert.deepEqual(await client.commissions(), [{ ...publicCommission, playerId: 'local' }])
  assert.deepEqual(await client.queue(), [publicCommission])
  assert.deepEqual(await client.inbox(), [entry])
  assert.deepEqual(await client.claim('gift/42'), expectedMe)
  assert.equal(await client.gift('bob', 'hat', 'enjoy'), undefined)
  assert.equal(await client.block('bob'), undefined)
  assert.equal(await client.unblock('bob'), undefined)
  assert.deepEqual(await client.reportRound('match-1', 2, 'wavedash-player', 'win'), { applied: true })

  const meFrames = [{ t: 'eco_get' }, { t: 'eco_inbox' }, { t: 'eco_shop' }]
  assert.deepEqual(frames.map(({ op: _op, ...frame }) => frame), [
    { t: 'auth', ...auth }, { t: 'eco_shop' }, ...meFrames,
    { t: 'eco_shop_buy', item: 'hat', currency: 'tickets' }, ...meFrames,
    { t: 'eco_commission', slot: 'head', rarity: 'rare', description: 'a lovely hat' },
    { t: 'eco_commissions' }, { t: 'eco_queue' }, { t: 'eco_inbox' },
    { t: 'eco_claim', id: 'gift/42' }, ...meFrames,
    { t: 'eco_gift', to: 'bob', item: 'hat', message: 'enjoy' },
    { t: 'eco_block', player: 'bob', blocked: true }, { t: 'eco_block', player: 'bob', blocked: false },
    { t: 'eco_round', match_id: 'match-1', round: 2, player: 'wavedash-player', kind: 'win' },
  ])
  assert.deepEqual(urls, ['wss://economy.test/ws'])
  const ops = frames.slice(1).map(frame => frame.op!)
  assert.equal(new Set(ops).size, ops.length)
  for (const [i, op] of ops.entries()) {
    assert.match(op, /^[A-Za-z0-9_:.-]{1,64}$/)
    assert.equal(op.split(':')[1], String(i + 1))
  }
  client.close()
})

for (const rule of economyCases) {
  test(`shared WS rule: ${rule.name}`, async () => {
    let roundReports = 0
    const { client } = clientFor(frame => rule.code === null
      ? { t: 'eco_round', applied: ++roundReports === 1 }
      : { t: 'error', reason: rule.code })
    const result = rule.setup().run(client)
    if (rule.code === null) {
      assert.deepEqual(await result, { applied: false })
      assert.equal(roundReports, 2)
    } else {
      const error = await expectRefusal(result, rule.code)
      assert.equal(error.status, ECONOMY_ERRORS[rule.code as keyof typeof ECONOMY_ERRORS])
    }
    client.close()
  })
}

test('WS errors preserve listed and unknown reasons and normalize protocol refusals', async () => {
  const mappings = [
    ...Object.keys(ECONOMY_ERRORS).map(code => [code, code]),
    ['tx_conflict', 'invalid'], ['bad_message', 'invalid'], ['bad_argument', 'invalid'],
    ['auth_required', 'unauthorized'], ['auth_failed', 'unauthorized'],
    ['economy_unavailable', 'economy_unavailable'], ['new_reason', 'new_reason'],
  ]
  for (const [reason, code] of mappings) {
    const { client } = clientFor(() => ({ t: 'error', reason }))
    const error = await expectRefusal(client.catalog(), code)
    assert.equal(error.status, ECONOMY_ERRORS[code as keyof typeof ECONOMY_ERRORS] ?? 500)
    client.close()
  }
})

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('WS requests wait for authentication and support guest credentials', async () => {
  const fake = scriptedWs(answer, false, false)
  const guest = { provider: 'guest' as const, token: 'guest-token-123456', game: 'test-game' }
  const client = createEconomyClient('wss://economy.test/ws', guest, fake.factory)
  const result = client.catalog()
  assert.equal(fake.frames.length, 0)
  fake.open()
  await flush()
  assert.deepEqual(fake.frames, [{ t: 'auth', ...guest }])
  fake.receive({ t: 'authed', player_id: 'guest-player' })
  await result
  assert.equal(fake.frames[1].t, 'eco_shop')
  client.close()
})

test('WS auth errors reject every waiting call', async () => {
  const fake = scriptedWs(answer, true, false)
  const client = createEconomyClient('wss://economy.test/ws', auth, fake.factory)
  const checks = [expectRefusal(client.catalog(), 'unauthorized'), expectRefusal(client.me(), 'unauthorized')]
  await flush()
  fake.receive({ t: 'error', reason: 'auth_failed' })
  await Promise.all(checks)
  assert.equal(fake.frames.length, 1)
})

test('WS matches concurrent replies by op and ignores pushes and unrelated replies', async () => {
  const { client, receive, frames } = clientFor(() => undefined)
  let settled = 0
  const first = client.inbox().then(value => { settled++; return value })
  const second = client.inbox().then(value => { settled++; return value })
  await flush()
  receive({ t: 'eco_inbox', entries: [entry], unread: 1 })
  receive({ t: 'error', op: 'unrelated', reason: 'sold_out' })
  receive({ t: 'eco_state', cards: {}, coins: 0 })
  await flush()
  assert.equal(settled, 0)
  receive({ t: 'eco_inbox', op: frames[2].op, entries: [], unread: 0 })
  assert.deepEqual(await second, [])
  assert.equal(settled, 1)
  receive({ t: 'eco_inbox', op: frames[1].op, entries: [entry], unread: 1 })
  assert.deepEqual(await first, [entry])
  client.close()
})

for (const phase of ['connecting', 'authenticating', 'pending', 'explicit'] as const) {
  test(`WS close rejects calls with network while ${phase}`, async () => {
    const fake = scriptedWs(() => undefined, phase !== 'connecting', phase !== 'authenticating')
    const client = createEconomyClient('wss://economy.test/ws', auth, fake.factory)
    const checks = [expectRefusal(client.catalog(), 'network'), expectRefusal(client.inbox(), 'network')]
    await flush()
    if (phase === 'explicit') client.close()
    else fake.socket.close()
    for (const error of await Promise.all(checks)) assert.equal(error.status, 0)
    await expectRefusal(client.catalog(), 'network')
    assert.equal(fake.urls.length, 1, 'a closed client never silently replays a mutation')
    client.close()
  })
}

test('WS close before first request stays lazy', async () => {
  const { client, urls } = clientFor()
  client.close()
  await expectRefusal(client.catalog(), 'network')
  assert.deepEqual(urls, [])
})

test('WS factory and send failures reject as network errors', async () => {
  const broken = createEconomyClient('wss://economy.test/ws', auth, () => { throw new Error('cannot connect') })
  await expectRefusal(broken.catalog(), 'network')
  for (const duringAuth of [true, false]) {
    const fake = scriptedWs()
    const client = createEconomyClient('wss://economy.test/ws', auth, fake.factory)
    if (!duringAuth) await client.catalog()
    fake.socket.send = () => { throw new Error('cannot send') }
    await expectRefusal(client.catalog(), 'network')
  }
})

test('WS state defaults absent tickets to zero and maps uncapped editions', async () => {
  const { client } = clientFor(frame => {
    if (frame.t === 'eco_get') return { t: 'eco_state', coins: 3, cards: {} }
    if (frame.t === 'eco_shop') return {
      t: 'eco_shop', drop: 'uncapped', items: [{ ...shopItems[0], edition_cap: null, remaining: null }],
    }
    return answer(frame)
  })
  assert.equal((await client.me()).tickets, 0)
  const { items } = await client.catalog()
  assert.equal(items[0].editionCap, Infinity)
  assert.equal(items[0].remaining, Infinity)
  client.close()
})
