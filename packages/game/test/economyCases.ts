// Shared rule scenarios: seed/prepare the stub; script the same final operation on the wire.
import type { CatalogItem, EconomyPort } from '../src/economy/contract.ts'
import { GIFT_LIMIT } from '../src/economy/contract.ts'
import type { createEconomyStub } from '../src/economy/stub.ts'

type Stub = ReturnType<typeof createEconomyStub>
type Port = EconomyPort & {
  reportRound?(match: string, round: number, player: string, kind: string): Promise<{ applied: boolean }>
}
interface Scenario {
  seed?: Parameters<typeof createEconomyStub>[0]
  prepare?: (stub: Stub) => Promise<EconomyPort>
  run: (port: Port) => Promise<unknown>
}
interface RuleCase {
  name: string
  // null denotes the successful, idempotent round replay rather than a refusal.
  code: string | null
  setup: () => Scenario
}

const hat = (overrides: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'hat', name: 'Hat', slot: 'head', rarity: 'common', asset: 'hat',
  price: { coins: 10 }, editionCap: 10, sold: 0, remaining: 10, ...overrides,
})
const buy = (currency: 'coins' | 'tickets' = 'coins') => (port: Port) => port.buy('hat', currency)
const gift = (port: Port) => port.gift('friend', 'hat', 'a gift')

export const economyCases: readonly RuleCase[] = [
  { name: 'sold out', code: 'sold_out', setup: () => ({
    seed: { catalog: [hat({ sold: 10 })], me: { coins: 50 } }, run: buy(),
  }) },
  { name: 'no price', code: 'no_price', setup: () => ({
    seed: { catalog: [hat()], me: { tickets: 10 } }, run: buy('tickets'),
  }) },
  { name: 'already owned', code: 'already_owned', setup: () => ({
    seed: { catalog: [hat()], me: { coins: 50, owned: ['hat'] } }, run: buy(),
  }) },
  { name: 'insufficient funds', code: 'insufficient_funds', setup: () => ({
    seed: { catalog: [hat()], me: { coins: 0 } }, run: buy(),
  }) },
  ...[
    ['too short', 'tiny'], ['link', 'please see https://example.test'], ['banned word', 'a casino hat please'],
  ].map(([name, description]): RuleCase => ({
    name: `description refused: ${name}`, code: 'description_refused', setup: () => ({
      seed: { me: { tickets: 10 } }, run: port => port.commission('head', 'rare', description),
    }),
  })),
  { name: 'self gift', code: 'self_gift', setup: () => ({
    seed: { me: { playerId: 'local', owned: ['hat'] } },
    run: port => port.gift('local', 'hat', 'a gift'),
  }) },
  { name: 'blocked', code: 'blocked', setup: () => ({
    seed: { me: { owned: ['hat'] } },
    prepare: async stub => { await stub.connect('friend').block('local'); return stub }, run: gift,
  }) },
  { name: 'rate limited', code: 'rate_limited', setup: () => ({
    seed: { me: { owned: ['hat', ...Array.from({ length: GIFT_LIMIT.count }, (_, i) => `gift-${i}`)] } },
    prepare: async stub => {
      for (let i = 0; i < GIFT_LIMIT.count; i++) await stub.gift('friend', `gift-${i}`, 'a gift')
      return stub
    }, run: gift,
  }) },
  { name: 'already claimed', code: 'already_claimed', setup: () => ({
    seed: { me: { owned: ['hat'] } },
    prepare: async stub => {
      await stub.gift('friend', 'hat', 'a gift')
      const friend = stub.connect('friend')
      await friend.claim('gift-1')
      return friend
    }, run: port => port.claim('gift-1'),
  }) },
  { name: 'not owned', code: 'not_owned', setup: () => ({ run: gift }) },
  { name: 'round reward replay applied:false', code: null, setup: () => ({
    run: async port => {
      if (!port.reportRound) throw new Error('round reporting is only available on the gamesaloon client')
      await port.reportRound('match-1', 0, 'wavedash-player', 'qualify')
      return port.reportRound('match-1', 0, 'wavedash-player', 'qualify')
    },
  }) },
]
