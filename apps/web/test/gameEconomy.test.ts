// The build-time economy endpoint (platform/economy.ts): no URL keeps the offline stub from the config file; a
// URL authenticates a guest with one persisted token.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startScreen } from '@royal-fiesta/game/flow/startScreen'
import { shopModel, shopStep } from '@royal-fiesta/game/flow/shop'
import { RARITY_TICKETS, type Rarity } from '@royal-fiesta/game/economy/contract'
import type { EconomyConfig } from '@royal-fiesta/game/economy/stub'
import type { WsFactory, WsLike } from '@royal-fiesta/game/net/ws'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import {
  GUEST_TOKEN_KEY, GUEST_TOKEN_LENGTH, createGameEconomy, economyUrl, type EconomyStore,
} from '../src/platform/economy.ts'

const config = JSON.parse(
  readFileSync(new URL('../../../economy/royal-fiesta.economy.json', import.meta.url), 'utf8'),
) as EconomyConfig

interface FakeStore extends EconomyStore {
  values: Map<string, string>
  writes: Map<string, number>
}

function fakeStore(): FakeStore {
  const values = new Map<string, string>()
  const writes = new Map<string, number>()
  return {
    values, writes,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      values.set(key, value)
      writes.set(key, (writes.get(key) ?? 0) + 1)
    },
  }
}

test('economyUrl: no build value means offline, ws and wss are kept, anything else is refused', () => {
  assert.equal(economyUrl(undefined), null)
  assert.equal(economyUrl(''), null)
  assert.equal(economyUrl('   '), null)
  assert.equal(economyUrl('wss://x/ws'), 'wss://x/ws')
  assert.equal(economyUrl(' ws://127.0.0.1:8791/ws '), 'ws://127.0.0.1:8791/ws')
  assert.throws(() => economyUrl('http://x'), (e: unknown) =>
    e instanceof RefusalError && e.message.includes('VITE_RF_ECONOMY') && e.message.includes('wss://'))
})

test('without a url the stub carries the config catalogue, banned words and ticket prices', async () => {
  const economy = createGameEconomy({ config, url: null, store: fakeStore() })
  assert.notEqual(economy.stub, null)
  const { items } = await economy.port.catalog()
  assert.deepEqual(
    items.map(item => item.id),
    config.catalog.shop.items.map(item => item.id),
  )
  assert.deepEqual([...economy.banned], config.settings.filter.banned_words)
  for (const rarity of Object.keys(RARITY_TICKETS) as Rarity[]) {
    assert.equal(economy.prices[rarity], config.catalog.shop.rarities[rarity].price.tickets, rarity)
  }
  economy.close()
})

test('a rarity the config does not price falls back to RARITY_TICKETS', () => {
  const partial: EconomyConfig = {
    ...config,
    catalog: {
      ...config.catalog,
      shop: { ...config.catalog.shop, rarities: { common: { price: { tickets: 9 } } } },
    },
  }
  const economy = createGameEconomy({ config: partial, url: null, store: fakeStore() })
  assert.equal(economy.prices.common, 9)
  for (const rarity of ['rare', 'legendary', 'epic'] as const) {
    assert.equal(economy.prices[rarity], RARITY_TICKETS[rarity])
  }
})

interface Frame {
  t: string
  op?: string
  token?: string
  provider?: string
  name?: string
  game?: string
  [key: string]: unknown
}

function scriptedWs(): { factory: WsFactory; frames: Frame[]; urls: string[] } {
  const frames: Frame[] = []
  const urls: string[] = []
  const factory: WsFactory = url => {
    urls.push(url)
    const socket: WsLike & { readyState: number } = {
      readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(data) {
        const frame = JSON.parse(data) as Frame
        frames.push(frame)
        const reply = frame.t === 'auth'
          ? { t: 'authed', player_id: 'guest-player' }
          : frame.t === 'eco_shop'
            ? { t: 'eco_shop', drop: 'remote', items: [] }
            : { t: 'error', reason: 'invalid' }
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ ...reply, op: frame.op }) }))
      },
      close() {
        if (socket.readyState === 3) return
        socket.readyState = 3
        socket.onclose?.({ code: 1000, reason: 'closed by fake' })
      },
    }
    queueMicrotask(() => { socket.readyState = 1; socket.onopen?.() })
    return socket
  }
  return { factory, frames, urls }
}

test('a url authenticates as a guest with one 24-character token reused from the store', async () => {
  const store = fakeStore()
  const first = scriptedWs()
  const one = createGameEconomy({ config, url: 'wss://x/ws', store, name: 'Bean', ws: first.factory })
  assert.equal((await one.port.catalog()).drop, 'remote')
  const firstAuth = first.frames.find(frame => frame.t === 'auth')
  assert.ok(firstAuth, 'the first request authenticates')
  assert.equal(firstAuth.provider, 'guest')
  assert.equal(firstAuth.game, 'royal-fiesta')
  assert.equal(firstAuth.name, 'Bean')
  assert.match(firstAuth.token ?? '', /^[0-9a-z]+$/)
  assert.equal((firstAuth.token ?? '').length, GUEST_TOKEN_LENGTH)
  assert.equal(store.values.get(GUEST_TOKEN_KEY), firstAuth.token)
  assert.equal(store.writes.get(GUEST_TOKEN_KEY), 1)
  one.close()
  assert.deepEqual(first.urls, ['wss://x/ws'])

  const second = scriptedWs()
  const two = createGameEconomy({ config, url: 'wss://x/ws', store, name: 'Bean', ws: second.factory })
  await two.port.catalog()
  const secondAuth = second.frames.find(frame => frame.t === 'auth')
  assert.equal(secondAuth?.token, firstAuth.token, 'the stored token is reused')
  assert.equal(store.writes.get(GUEST_TOKEN_KEY), 1, 'the token is created once')
  two.close()
})

test('normal offline guest owns the three base items per slot and can buy into its wardrobe', async () => {
  const economy = createGameEconomy({ config, url: null, store: fakeStore() })
  const before = await economy.port.me()
  const { items } = await economy.port.catalog()
  assert.equal(before.coins, 500)
  assert.equal(before.tickets, 20)
  assert.equal(before.owned.length, 12)
  for (const slot of config.catalog.shop.slots) {
    const owned = items.filter(item => item.slot === slot && before.owned.includes(item.id))
    assert.equal(owned.length, 3)
    assert.ok(owned.every(item => item.id === item.asset))
  }
  const wardrobe = startScreen(before.owned, items, 0, { colour: 0, worn: {} })
  for (const bin of wardrobe.bins) assert.equal(bin.items.length, 3)
  const available = items.filter(item => !before.owned.includes(item.id))
  assert.equal(available.length, 24)
  for (const currency of ['coins', 'tickets'] as const) {
    const wallet = await economy.port.me()
    const item = available.find(item => item.price[currency] !== undefined && !wallet.owned.includes(item.id))!
    // Use the shop's confirmation path, with just this currency available.
    const shop = shopModel(items, { ...wallet, [currency === 'coins' ? 'tickets' : 'coins']: 0 })
    const row = shop.slots.findIndex(row => row.slot === item.slot)
    shop.focus = [row, shop.slots[row].items.findIndex(candidate => candidate.id === item.id)]
    const confirmation = shopStep({ ...shop, zone: 'grid' }, 'confirm')
    const request = shopStep(confirmation.model, 'confirm').buy!
    assert.deepEqual(request, { itemId: item.id, currency })
    const bought = await economy.port.buy(request.itemId, request.currency)
    assert.equal(bought[currency], wallet[currency] - item.price[currency]!)
    const after = await economy.port.me()
    assert.ok(after.owned.includes(item.id))
    const bins = startScreen(after.owned, items, 0, { colour: 0, worn: { [item.slot]: item.id } }).bins
    const bin = bins.find(bin => bin.slot === item.slot)!
    assert.equal(bin.items[bin.selected], item.id, 'the purchased item can be selected for wearing')
  }
  economy.close()
})
