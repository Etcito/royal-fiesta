import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogItem, EconomyPort } from '@royal-fiesta/game/economy/contract'
import { createEconomyStub } from '@royal-fiesta/game/economy/stub'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { WidgetProps } from '../src/ui/screenMap.ts'
import type { UaaHost } from '../src/ui/uaaHost.ts'
import { EconomyScreens } from '../src/game/economyScreens.ts'
import type { TextFieldElement } from '../src/screens/commission.ts'

const CATALOG: CatalogItem[] = [
  { id: 'costume.hat', name: 'Hat', slot: 'head', rarity: 'common', asset: 'costume.hat',
    price: { coins: 10 }, editionCap: 0, sold: 0, remaining: 0 },
  { id: 'costume.suit', name: 'Suit', slot: 'body', rarity: 'common', asset: 'costume.suit',
    price: { coins: 20 }, editionCap: 5, sold: 0, remaining: 5 },
  { id: 'costume.boots', name: 'Boots', slot: 'bottom', rarity: 'common', asset: 'costume.boots',
    price: { coins: 30 }, editionCap: 5, sold: 0, remaining: 5 },
  { id: 'costume.aura', name: 'Aura', slot: 'special', rarity: 'epic', asset: 'costume.aura',
    price: { coins: 40 }, editionCap: 5, sold: 0, remaining: 5 },
]

function fakeField(): TextFieldElement {
  return {
    value: '',
    style: { left: '', top: '', width: '', height: '', display: '' },
    focus() {},
    blur() {},
    remove() {},
    addEventListener() {},
  }
}

interface Rig {
  stub: ReturnType<typeof createEconomyStub>
  screens: EconomyScreens
  host: UaaHost
  menus: MenuModel[]
  calls: string[]
  cues: string[]
  field: TextFieldElement
}

// The local player owns nothing but has one unclaimed gift: a friend bought nothing, so the local
// player's bought Aura is gifted out and back through the friend's inbox (stub.connect's seam).
async function setup(): Promise<Rig> {
  const stub = createEconomyStub({
    catalog: CATALOG,
    me: { playerId: 'local', coins: 1000, tickets: 12 },
  })
  await stub.buy('costume.aura', 'coins')
  await stub.gift('friend', 'costume.aura', 'from local')
  const friend = stub.connect('friend')
  const entries = await friend.inbox()
  assert.ok(entries[0])
  await friend.claim(entries[0].id)
  await friend.gift('local', 'costume.aura', 'A gift for you')

  const calls: string[] = []
  const port: EconomyPort = {
    ...stub,
    // The stub's Hat is capped at 0; the catalogue lies so the buy reaches the port's sold_out rule.
    async catalog() {
      const data = await stub.catalog()
      return {
        ...data,
        items: data.items.map(item => (item.id === 'costume.hat' ? { ...item, remaining: 1 } : item)),
      }
    },
    commission(slot, rarity, description) {
      calls.push(description)
      return stub.commission(slot, rarity, description)
    },
  }
  const menus: MenuModel[] = []
  const hud: Record<string, WidgetProps>[] = []
  const cues: string[] = []
  const noop = () => {}
  const host: UaaHost = {
    present(menu) { menus.push(menu) },
    setHud(props) { hud.push(props) },
    setLoading: noop,
    input: noop,
    frame: noop,
    resize: noop,
    widgetRect: id => (id === 'line-2' ? { x: 10, y: 20, w: 300, h: 24 } : null),
    currentScreen: () => menus.at(-1)?.screen ?? 'title',
    destroy: noop,
  }
  const field = fakeField()
  const screens = new EconomyScreens({
    port,
    host,
    cue: id => cues.push(id),
    banned: [],
    parent: { appendChild: child => child },
    createField: () => field,
  })
  assert.equal(hud.length, 0)
  return { stub, screens, host, menus, calls, cues, field }
}

test('open shop shows Loading…, then down+confirm buys and the focused row shows OWNED', async () => {
  const s = await setup()
  const opening = s.screens.open('shop')
  assert.equal(s.menus.at(-1)?.lines[6], 'Loading…')
  await opening
  assert.equal(s.menus.at(-1)?.lines[6], '')

  await s.screens.action('shop', 'right')
  await s.screens.action('shop', 'down')
  await s.screens.action('shop', 'confirm')
  assert.equal(s.screens.shop?.confirm?.itemId, 'costume.suit')
  await s.screens.action('shop', 'confirm')
  assert.deepEqual(s.cues, ['ui.hover', 'ui.hover', 'ui.buy'])
  const body = s.menus.at(-1)!.lines[2]
  assert.match(body, /Suit .* OWNED/)
  assert.ok((await s.stub.me()).owned.includes('costume.suit'))
  s.screens.close()
})

test('a sold-out buy surfaces the port refusal in the status line', async () => {
  const s = await setup()
  await s.screens.open('shop')
  await s.screens.action('shop', 'down')
  await s.screens.action('shop', 'confirm')
  await s.screens.action('shop', 'confirm')
  assert.match(s.menus.at(-1)!.lines[6], /^sold_out: /)
  assert.deepEqual(s.cues, ['ui.hover', 'ui.buy', 'ui.error'])
  assert.equal((await s.stub.me()).owned.includes('costume.hat'), false)
})

test('open inbox then confirm claims the gift into the collection', async () => {
  const s = await setup()
  const opening = s.screens.open('inbox')
  assert.equal(s.menus.at(-1)?.lines[5], 'Loading…')
  await opening
  assert.match(s.menus.at(-1)!.lines[0], /From friend · costume\.aura · new/)
  await s.screens.action('inbox', 'confirm')
  assert.ok((await s.stub.me()).owned.includes('costume.aura'))
  assert.deepEqual(s.cues, ['ui.inbox', 'ui.click'])
  assert.equal(await s.screens.refreshCount(), 0)
})

test('open commission with text and submit spends tickets and shows the pending queue line', async () => {
  const s = await setup()
  const opening = s.screens.open('commission')
  assert.equal(s.menus.at(-1)?.lines[4], 'Loading…')
  await opening
  const tickets = (await s.stub.me()).tickets

  s.screens.text('A crown for the champion')
  assert.equal(s.menus.at(-1)!.lines[2], 'A crown for the champion')
  for (let i = 0; i < 3; i++) await s.screens.action('commission', 'down')
  await s.screens.action('commission', 'confirm')

  assert.equal((await s.stub.me()).tickets, tickets - 3)
  const lines = s.menus.at(-1)!.lines
  assert.ok(lines.some(line => line.startsWith('pending · head · common · A crown')), lines.join(' | '))
  assert.deepEqual(s.cues, ['ui.hover', 'ui.hover', 'ui.hover', 'ui.ticket'])
})

test('a URL description is refused locally and never calls port.commission', async () => {
  const s = await setup()
  await s.screens.open('commission')
  s.screens.text('See https://example.com for the hat')
  for (let i = 0; i < 3; i++) await s.screens.action('commission', 'down')
  await s.screens.action('commission', 'confirm')
  assert.equal(s.calls.length, 0)
  assert.match(s.menus.at(-1)!.lines[4], /link/)
  assert.equal((await s.stub.me()).tickets, 12)
})

test('refreshCount reports the unread inbox count for the start badge', async () => {
  const s = await setup()
  assert.equal(await s.screens.refreshCount(), 1)
})


test('the catalog grid click buys the clicked item through the shared purchase path', async () => {
  const s = await setup()
  s.host.widgetRect = id => id === 'catalog-card-0-0' ? { x: 10, y: 10, w: 100, h: 30 } : null
  await s.screens.open('shop')
  await s.screens.action('shop', 'right')
  const before = await s.stub.me()
  assert.equal(s.screens.pickShop(20, 20), true)
  assert.equal((await s.stub.me()).coins, before.coins)
  assert.ok(s.screens.shop?.confirm)
  await s.screens.action('shop', 'confirm')
  const after = await s.stub.me()
  assert.equal(after.coins, before.coins - 20)
  assert.ok(after.owned.includes('costume.suit'))
  assert.deepEqual(s.screens.shop?.focus, [1, 0])
  assert.equal(s.screens.pickShop(900, 900), false)
  s.screens.close()
  assert.equal(s.screens.pickShop(20, 20), false)
})
