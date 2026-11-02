// Build-time economy endpoint (docs/network.md, M10): a build made with VITE_RF_ECONOMY=wss://host/ws in its
// ENVIRONMENT (never a committed file) talks to the economy service; without it the page keeps the offline stub.
// The value is read here, in a small function, so a test can pass one in.
import { refuse } from '@royal-fiesta/sim/refusal'
import { createEconomyClient } from '@royal-fiesta/game/economy/client'
import { RARITY_TICKETS, type EconomyPort, type Rarity } from '@royal-fiesta/game/economy/contract'
import { createEconomyStub, type EconomyConfig } from '@royal-fiesta/game/economy/stub'
import type { WsFactory } from '@royal-fiesta/game/net/ws'

function buildEconomy(): string | undefined {
  return (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RF_ECONOMY
}

/** The economy service URL of this build, or null when the build has none. A set but malformed value is refused. */
export function economyUrl(raw: string | undefined = buildEconomy()): string | null {
  if (raw === undefined || raw.trim() === '') return null
  const url = raw.trim()
  if (!/^wss?:\/\/\S+$/.test(url)) {
    refuse('build', 'VITE_RF_ECONOMY', 'is not a ws:// or wss:// URL; rebuild with VITE_RF_ECONOMY=wss://host/ws')
  }
  return url
}

/** The tiny synchronous store (localStorage or an in-memory fallback) the guest token is kept in. */
export interface EconomyStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const GUEST_TOKEN_KEY = 'rf.economy.guest'
export const GUEST_TOKEN_LENGTH = 24

/** The persisted guest token: 24 random base36 characters, created once and reused on later visits. */
export function guestToken(
  store: EconomyStore,
  random: { getRandomValues(array: Uint8Array): Uint8Array } = globalThis.crypto,
): string {
  const saved = store.getItem(GUEST_TOKEN_KEY)
  if (saved !== null && saved !== '') return saved
  const bytes = new Uint8Array(GUEST_TOKEN_LENGTH)
  random.getRandomValues(bytes)
  let token = ''
  for (const byte of bytes) token += (byte % 36).toString(36)
  store.setItem(GUEST_TOKEN_KEY, token)
  return token
}

/** The commission ticket price of each rarity: the config's value, else the shared contract constant. */
export function rarityPrices(config: EconomyConfig): Record<Rarity, number> {
  const prices = { ...RARITY_TICKETS } as Record<Rarity, number>
  const rarities = config.catalog.shop.rarities
  for (const rarity of Object.keys(prices) as Rarity[]) {
    const tickets = rarities[rarity]?.price.tickets
    if (tickets !== undefined) prices[rarity] = tickets
  }
  return prices
}

export interface GameEconomyOptions {
  /** economy/royal-fiesta.economy.json, imported with ?raw and parsed by the caller. */
  config: EconomyConfig
  /** economyUrl()'s value; null keeps the offline stub. */
  url?: string | null
  /** Where the guest token lives (localStorage, or memory when the frame refuses storage). */
  store: EconomyStore
  /** The display name the economy service knows this guest by. */
  name?: string
  /** The WebSocket factory (tests inject a recording fake; the page uses the global). */
  ws?: WsFactory
}

export interface GameEconomy {
  port: EconomyPort
  /** The offline stub when there is no URL (offline rewards are granted through it), else null. */
  stub: ReturnType<typeof createEconomyStub> | null
  banned: readonly string[]
  prices: Record<Rarity, number>
  close(): void
}

export function createGameEconomy(options: GameEconomyOptions): GameEconomy {
  const { config, store, name = 'Guest', ws } = options
  const url = options.url === undefined ? economyUrl() : options.url
  const banned = config.settings.filter.banned_words
  const prices = rarityPrices(config)
  if (url === null) {
    // Offline guest grant only; service-backed players keep the service's wallet and inventory.
    const owned = config.catalog.shop.slots.flatMap(slot => {
      const cheapest = config.catalog.shop.items.filter(item => item.slot === slot).sort((a, b) =>
        (a.price.coins ?? Infinity) - (b.price.coins ?? Infinity) ||
        (a.price.tickets ?? Infinity) - (b.price.tickets ?? Infinity) || a.id.localeCompare(b.id))[0]
      return cheapest ? [cheapest.id] : []
    })
    const stub = createEconomyStub({ config, me: { coins: 500, tickets: 20, owned } })
    return { port: stub, stub, banned, prices, close() {} }
  }
  const client = createEconomyClient(
    url,
    { provider: 'guest', token: guestToken(store), name, game: 'royal-fiesta' },
    ws,
  )
  return { port: client, stub: null, banned, prices, close: () => client.close() }
}
