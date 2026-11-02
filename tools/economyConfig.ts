// Royal Fiesta economy config generator.
// Builds economy/royal-fiesta.economy.json in the format of gamesaloon's
// schemas/game-economy.schema.json from the Season 1 catalogue, the shared rule
// constants and economy/banned-words.json, so no value is retyped.
//
// Import it on the server with:
//   npm run game:import -- economy/royal-fiesta.economy.json --game <handshake_game>
// Check that the committed file is current with:
//   npm run economy:config -- --check
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  COINS_PER_QUALIFY, DESCRIPTION_LIMITS, GIFT_LIMIT, RARITY_TICKETS,
} from '../packages/game/src/economy/contract.ts'
import type { Rarity, Slot } from '../packages/game/src/economy/contract.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SOURCE_CATALOG = 'economy/catalog.season1.json'
const SOURCE_BANNED = 'economy/banned-words.json'
const TARGET = 'economy/royal-fiesta.economy.json'

export interface SeasonItem {
  id: string
  name: string
  slot: Slot
  rarity: Rarity
  asset: string
  price: { coins?: number; tickets?: number }
  tint?: readonly [number, number, number]
  editionCap: number
}

export interface SeasonCatalog {
  drop: string
  items: SeasonItem[]
}

const SLOTS: readonly Slot[] = ['head', 'body', 'bottom', 'special']
const RARITIES = Object.keys(RARITY_TICKETS) as Rarity[]

export function buildEconomyConfig(season: SeasonCatalog, bannedWords: readonly string[]) {
  return {
    catalog: {
      cards: [],
      currencies: ['tickets'],
      shop: {
        drop: season.drop,
        slots: SLOTS.filter((slot) => season.items.some((item) => item.slot === slot)),
        rarities: Object.fromEntries(
          RARITIES.map((rarity) => [rarity, { price: { tickets: RARITY_TICKETS[rarity] } }]),
        ),
        items: season.items.map((item) => ({
          id: item.id,
          name: item.name,
          slot: item.slot,
          rarity: item.rarity,
          asset: item.asset,
          ...(item.tint === undefined ? {} : { tint: item.tint }),
          price: { ...item.price },
          edition_cap: item.editionCap,
        })),
        commission: { currency: 'tickets' },
      },
      round_rewards: {
        qualify: { coins: COINS_PER_QUALIFY },
        win: { currencies: { tickets: 1 } },
      },
    },
    products: [],
    settings: {
      filter: {
        min_length: DESCRIPTION_LIMITS.min,
        max_length: DESCRIPTION_LIMITS.max,
        banned_words: [...bannedWords],
        no_url: true,
      },
      gifts: { count: GIFT_LIMIT.count, window_ms: GIFT_LIMIT.windowMs },
    },
  }
}

export type EconomyConfig = ReturnType<typeof buildEconomyConfig>

/** Guard the published wardrobe: variants share a base mesh and carry only an instance tint. */
export function validateSeasonCatalog(season: SeasonCatalog): void {
  const ids = new Set(season.items.map(item => item.id))
  if (ids.size !== 36 || season.items.length !== 36) throw new Error('catalog: expected 36 unique cosmetics')
  for (const slot of SLOTS) {
    const items = season.items.filter(item => item.slot === slot)
    const bases = items.filter(item => item.id === item.asset)
    if (items.length !== 9 || bases.length !== 3) throw new Error(`catalog: ${slot} needs 3 bases and 6 variants`)
    for (const base of bases) {
      const variants = items.filter(item => item.asset === base.id && item.id !== base.id)
      if (base.tint !== undefined || variants.length !== 2) throw new Error(`catalog: ${base.id} needs two tinted variants`)
      const colours = new Set<string>()
      for (const variant of variants) {
        if (!variant.id.startsWith(base.id + '.') || !variant.tint || variant.tint.length !== 3 ||
          !variant.tint.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error(`catalog: invalid tint ${variant.id}`)
        colours.add(variant.tint.join(','))
        for (const currency of ['coins', 'tickets'] as const) {
          if (variant.price[currency] !== undefined && (variant.price[currency]! > (base.price[currency] ?? -1))) throw new Error(`catalog: variant price exceeds base ${variant.id}`)
        }
      }
      if (colours.size !== 2) throw new Error(`catalog: duplicate tints ${base.id}`)
    }
    if (items.some(item => !bases.some(base => base.id === item.asset))) throw new Error(`catalog: unknown base in ${slot}`)
  }
}

export function generateEconomyConfig(root = ROOT): EconomyConfig {
  const season = JSON.parse(readFileSync(resolve(root, SOURCE_CATALOG), 'utf8')) as SeasonCatalog
  validateSeasonCatalog(season)
  const bannedWords = JSON.parse(readFileSync(resolve(root, SOURCE_BANNED), 'utf8')) as string[]
  return buildEconomyConfig(season, bannedWords)
}

export function renderEconomyConfig(config: EconomyConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

export function main(argv: readonly string[]): number {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check')) {
    console.error('Usage: node --experimental-strip-types tools/economyConfig.ts [--check]')
    return 1
  }
  const target = resolve(ROOT, TARGET)
  const generated = renderEconomyConfig(generateEconomyConfig())
  if (argv[0] !== '--check') {
    writeFileSync(target, generated)
    return 0
  }
  let committed: string
  try {
    committed = readFileSync(target, 'utf8')
  } catch {
    console.error(`${TARGET} is missing; fix: npm run economy:config`)
    return 1
  }
  if (committed !== generated) {
    console.error(`${TARGET} differs from the Season 1 data; fix: npm run economy:config`)
    return 1
  }
  return 0
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
