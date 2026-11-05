import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Agent, createServer, get } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { brickDir, brickSkip, missingBrick, repoRoot } from '../../../tools/bricks.ts'
import { startGameSaloon, type LocalServer } from '../src/gamesaloon.ts'
import { createEconomyClient } from '@royal-fiesta/game/economy/client'
import { RARITY_TICKETS, type CatalogItem } from '@royal-fiesta/game/economy/contract'
import { SHOP_COLUMNS, shopModel, shopStep } from '@royal-fiesta/game/flow/shop'
import { GIFT_MESSAGE } from '@royal-fiesta/game/flow/inbox'
import { commissionModel, commissionStep } from '@royal-fiesta/game/flow/commission'
import type { Action } from '@royal-fiesta/game/screens/nav'

// Loopback of the economy client against a local gamesaloon (memory store) that imports
// economy/royal-fiesta.economy.json and verifies Wavedash user JWTs against a JWKS served here.
const SKIP = 'gamesaloon-public not found: clone it next to this repo or set GAMESALOON_DIR'

let dir: string | null = null
try { dir = brickDir('gamesaloon-public') } catch {}

// gamesaloon src/economy/wavedash.ts: RS256, iss https://auth.wavedash.com, aud gameplay.wavedash.com, claims sub, gcid, exp.
const WAVEDASH_ISSUER = 'https://auth.wavedash.com'
const WAVEDASH_USER_AUD = 'gameplay.wavedash.com'
const KID = 'rf-loopback-1'
const GAME = 'royal-fiesta'

interface EconomyFile {
  catalog: { shop: { items: { id: string }[] }; round_rewards?: { qualify?: { coins?: number } } }
}

type Client = ReturnType<typeof createEconomyClient>

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function startJwks(jwk: Record<string, unknown>): Promise<{ server: Server; url: string }> {
  const body = JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] })
  const server = createServer((req, res) => {
    if (req.url !== '/.well-known/jwks.json') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, url: `http://127.0.0.1:${port}/.well-known/jwks.json` })
    })
  })
}

// node:http with a private Agent: the global agent honours NODE_USE_ENV_PROXY and would proxy 127.0.0.1.
function fetchLocal(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 2000, agent: new Agent() }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

function stopJwks(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

test('economy client loopback: shop buy, gift and claim, commission against gamesaloon', {
  skip: brickSkip(dir === null ? SKIP : null),
  timeout: 300_000,
}, async () => {
  if (dir === null) assert.fail(missingBrick(SKIP))
  const started = Date.now()
  const economyPath = join(repoRoot(), 'economy', 'royal-fiesta.economy.json')
  const config = JSON.parse(readFileSync(economyPath, 'utf8')) as EconomyFile
  const configIds = new Set(config.catalog.shop.items.map(item => item.id))
  const qualifyCoins = config.catalog.round_rewards?.qualify?.coins ?? 0
  assert.ok(qualifyCoins > 0, `${economyPath}: round_rewards.qualify.coins must be positive`)

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwt = (sub: string): string => {
    const nowSec = Math.floor(Date.now() / 1000)
    const head = b64url({ alg: 'RS256', typ: 'JWT', kid: KID })
    const payload = b64url({ iss: WAVEDASH_ISSUER, aud: WAVEDASH_USER_AUD, sub, gcid: GAME, iat: nowSec, exp: nowSec + 3600 })
    const signature = sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), privateKey).toString('base64url')
    return `${head}.${payload}.${signature}`
  }

  let jwks: Server | undefined
  let server: LocalServer | undefined
  const clients: Client[] = []
  const client = (auth: Parameters<typeof createEconomyClient>[1]): Client => {
    const made = createEconomyClient(server!.url, auth)
    clients.push(made)
    return made
  }
  try {
    const served = await startJwks(publicKey.export({ format: 'jwk' }) as Record<string, unknown>)
    jwks = served.server
    assert.equal(await fetchLocal(served.url), 200, `JWKS at ${served.url}`)
    server = await startGameSaloon({ env: { ECONOMY_IMPORT_FILE: economyPath, WAVEDASH_JWKS_URL: served.url } })

    const reporter = client({ provider: 'guest', token: `rf-loopback-reporter-${Date.now()}`, name: 'Reporter', game: GAME })
    let listed: CatalogItem[] = []
    try { listed = (await reporter.catalog()).items } catch {}
    if (!listed.some(item => configIds.has(item.id))) {
      assert.fail(`gamesaloon at ${dir} did not import ECONOMY_IMPORT_FILE (needs the memory-mode economy import)`)
    }

    const A = client({ provider: 'wavedash', token: jwt('wa'), name: 'Alice', game: GAME })
    const B = client({ provider: 'wavedash', token: jwt('wb'), name: 'Bob', game: GAME })
    const catalog = (await A.catalog()).items
    let meA = await A.me()
    // B signs in now: a gift only reaches a Wavedash id that already has a player.
    const meB0 = await B.me()
    assert.equal(meB0.playerId === meA.playerId, false)

    // The cheapest coin item still on sale, first in shop order on a tie.
    const shop0 = shopModel(catalog, meA)
    let target: { row: number; column: number; item: CatalogItem } | null = null
    shop0.slots.forEach((slot, row) => slot.items.forEach((item, column) => {
      if (item.price.coins === undefined || item.remaining <= 0 || item.owned) return
      if (target === null || item.price.coins < target.item.price.coins!) target = { row, column, item }
    }))
    assert.ok(target, 'the shop lists no coin item on sale')
    const { row, column, item } = target as { row: number; column: number; item: CatalogItem }
    const price = item.price.coins!

    const rounds = Math.max(0, Math.ceil((price - meA.coins) / qualifyCoins))
    for (let r = 0; r < rounds; r++) assert.equal((await reporter.reportRound('m1', r, 'wa', 'qualify')).applied, true)
    for (let r = 0; r <= 2; r++) assert.equal((await reporter.reportRound('m1', r, 'wa', 'win')).applied, true)
    meA = await A.me()
    assert.ok(meA.coins >= price, `coins ${meA.coins} after ${rounds} qualify rounds, price ${price}`)
    assert.ok(meA.tickets >= 3, `tickets ${meA.tickets} after 3 win rounds`)

    // Keyboard arrows/Enter and pad d-pad/A reach shopStep as these actions (flowAction, screens/nav.ts). The shop opens
    // on the tab bar: right to the item's slot tab, down into its grid of SHOP_COLUMNS, down/right to the item, then
    // confirm opens the confirmation and a second confirm buys.
    let shop = shopModel((await A.catalog()).items, meA)
    const moves: Action[] = [
      ...Array<Action>(row).fill('right'), 'down',
      ...Array<Action>(Math.floor(column / SHOP_COLUMNS)).fill('down'), ...Array<Action>(column % SHOP_COLUMNS).fill('right'),
    ]
    for (const action of moves) shop = shopStep(shop, action).model
    assert.deepEqual(shop.focus, [row, column])
    const asked = shopStep(shop, 'confirm')
    assert.equal(asked.buy, null)
    assert.deepEqual(asked.model.confirm, { itemId: item.id, currency: 'coins' })
    const step = shopStep(asked.model, 'confirm')
    assert.deepEqual(step.buy, { itemId: item.id, currency: 'coins' })
    const remainingBefore = shop.slots[row].items[column].remaining
    const bought = await A.buy(step.buy!.itemId, step.buy!.currency)
    assert.ok(bought.owned.includes(item.id), `owned ${JSON.stringify(bought.owned)} lacks ${item.id}`)
    assert.equal(bought.remaining, remainingBefore - 1)
    assert.equal(bought.coins, meA.coins - price)

    await A.gift('wb', item.id, GIFT_MESSAGE)
    assert.equal((await A.me()).owned.includes(item.id), false)
    const entries = await B.inbox()
    const entry = entries.find(e => e.item === item.id && !e.claimed)
    assert.ok(entry, `B's inbox lacks ${item.id}: ${JSON.stringify(entries)}`)
    assert.equal(entry.message, GIFT_MESSAGE)
    assert.equal(entry.sender.kind, 'player')
    const meB = await B.claim(entry.id)
    assert.ok(meB.owned.includes(item.id), `B owned ${JSON.stringify(meB.owned)} lacks ${item.id}`)
    assert.equal(meB.inboxUnread, 0)

    const banned = JSON.parse(readFileSync(join(repoRoot(), 'economy', 'banned-words.json'), 'utf8')) as string[]
    const description = 'A tall striped candy hat with a little bell on top'
    let cm = commissionModel(bought.tickets, banned)
    cm = commissionStep(cm, { text: description }).model
    for (const action of ['down', 'down', 'down'] as const) cm = commissionStep(cm, action).model
    const submitted = commissionStep(cm, 'confirm')
    assert.deepEqual(submitted.submit, { slot: 'head', rarity: 'common', description })
    const { slot, rarity } = submitted.submit!
    const made = await A.commission(slot, rarity, description)
    assert.equal(made.status, 'pending')
    assert.equal((await A.me()).tickets, bought.tickets - RARITY_TICKETS[rarity])
    assert.ok((await A.queue()).some(c => c.description === description), 'the public queue lacks the commission')
    console.log(`shop loopback: ${item.id} for ${price} coins, gift claimed, commission ${made.id} in ${Date.now() - started} ms`)
  } finally {
    for (const made of clients) made.close()
    await server?.stop()
    if (jwks) await stopJwks(jwks)
  }
})
