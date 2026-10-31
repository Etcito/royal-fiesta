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

export function generateEconomyConfig(root = ROOT): EconomyConfig {
  const season = JSON.parse(readFileSync(resolve(root, SOURCE_CATALOG), 'utf8')) as SeasonCatalog
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
