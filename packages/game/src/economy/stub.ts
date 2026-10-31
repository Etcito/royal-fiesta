import {
  COINS_PER_QUALIFY, ECONOMY_ERRORS, EconomyError, GIFT_LIMIT, RARITY_TICKETS,
  checkDescription,
  type CatalogItem, type Commission, type EconomyPort, type InboxEntry, type Me,
} from './contract.ts'

const BANNED = ['fuck', 'shit', 'asshole', 'nazi', 'porn', 'casino', 'crypto'] as const

const DEFAULT_CATALOG: CatalogItem[] = [
  { id: 'costume.propeller-hat', name: 'Propeller Hat', slot: 'head', rarity: 'common',
    asset: 'costume.propeller-hat', price: { coins: 30, tickets: RARITY_TICKETS.common },
    editionCap: 20, sold: 0, remaining: 20 },
  { id: 'costume.pineapple-suit', name: 'Pineapple Suit', slot: 'body', rarity: 'common',
    asset: 'costume.pineapple-suit', price: { coins: 30, tickets: RARITY_TICKETS.common },
    editionCap: 20, sold: 0, remaining: 20 },
  { id: 'costume.fish-scarf', name: 'Fish Scarf', slot: 'bottom', rarity: 'common',
    asset: 'costume.fish-scarf', price: { coins: 30, tickets: RARITY_TICKETS.common },
    editionCap: 20, sold: 0, remaining: 20 },
  { id: 'costume.ghost-aura', name: 'Ghost Aura', slot: 'special', rarity: 'epic',
    asset: 'costume.ghost-aura', price: { coins: 200, tickets: RARITY_TICKETS.epic },
    editionCap: 5, sold: 0, remaining: 5 },
]

interface Player {
  playerId: string
  coins: number
  tickets: number
  owned: Set<string>
  inbox: InboxEntry[]
  blocked: Set<string>
  gifts: number[]
}

function refuse(code: keyof typeof ECONOMY_ERRORS, reason: string): never {
  throw new EconomyError(code, reason)
}

function catalogItem(item: CatalogItem): CatalogItem {
  return { ...item, price: { ...item.price }, remaining: item.editionCap - item.sold }
}

export function createEconomyStub(seed?: {
  catalog?: CatalogItem[]; me?: Partial<Me>
}): EconomyPort & {
  grant(kind: 'qualify' | 'win'): void
  connect(playerId: string): EconomyPort & { grant(kind: 'qualify' | 'win'): void }
} {
  const items = (seed?.catalog ?? DEFAULT_CATALOG).map(catalogItem)
  for (const item of items) {
    if (item.price.tickets !== undefined && item.price.tickets !== RARITY_TICKETS[item.rarity]) {
      refuse('invalid', `${item.id}: price.tickets must equal RARITY_TICKETS[${item.rarity}]`)
    }
  }
  const players = new Map<string, Player>()
  const allCommissions: Commission[] = []
  let sequence = 0
  const nextId = (kind: string): string => `${kind}-${++sequence}`
  const player = (playerId: string): Player => {
    let value = players.get(playerId)
    if (!value) {
      value = { playerId, coins: 0, tickets: 0, owned: new Set(), inbox: [],
        blocked: new Set(), gifts: [] }
      players.set(playerId, value)
    }
    return value
  }
  const local = player(seed?.me?.playerId ?? 'local')
  local.coins = seed?.me?.coins ?? 0
  local.tickets = seed?.me?.tickets ?? 0
  local.owned = new Set(seed?.me?.owned ?? [])
  function portFor(p: Player): EconomyPort & { grant(kind: 'qualify' | 'win'): void } {
    const me = (): Me => ({
      playerId: p.playerId, coins: p.coins, tickets: p.tickets,
      owned: [...p.owned], inboxUnread: p.inbox.filter(entry => !entry.claimed).length,
    })

    return {
      async catalog() { return { drop: 'offline', items: items.map(catalogItem) } },
      async me() { return me() },
      async buy(itemId, currency) {
        const item = items.find(candidate => candidate.id === itemId)
        if (!item) refuse('unknown_item', `unknown item: ${itemId}`)
        const price = item.price[currency]
        if (price === undefined) refuse('no_price', `${itemId} has no price in ${currency}`)
        if (p.owned.has(itemId)) refuse('already_owned', `already own ${itemId}`)
        if (item.sold >= item.editionCap) refuse('sold_out', `${itemId} is sold out`)
        if (p[currency] < price) refuse('insufficient_funds', `not enough ${currency}`)
        p[currency] -= price
        item.sold++
        p.owned.add(itemId)
        return { ...me(), remaining: item.editionCap - item.sold }
      },
      grant(kind) {
        if (kind === 'qualify') p.coins += COINS_PER_QUALIFY
        else if (kind === 'win') p.tickets++
      },
      async commission(slot, rarity, description) {
        const reason = checkDescription(description, BANNED)
        if (reason) refuse('description_refused', reason)
        const price = RARITY_TICKETS[rarity]
        if (p.tickets < price) refuse('insufficient_funds', 'not enough tickets')
        const entry: Commission = { id: nextId('commission'), playerId: p.playerId,
          slot, rarity, description: description.trim(), status: 'pending',
          createdAt: new Date(Date.now()).toISOString() }
        p.tickets -= price
        allCommissions.push(entry)
        return { ...entry }
      },
      async commissions() {
        return allCommissions.filter(entry => entry.playerId === p.playerId)
          .map(entry => ({ ...entry }))
      },
      async queue() {
        return allCommissions.map(({ playerId: _playerId, ...entry }) => entry)
      },
      async inbox() {
        return p.inbox.map(entry => ({ ...entry, sender: { ...entry.sender } }))
      },
      async claim(id) {
        const entry = p.inbox.find(candidate => candidate.id === id)
        if (!entry) refuse('not_found', `inbox entry not found: ${id}`)
        if (entry.claimed) refuse('already_claimed', `already claimed ${id}`)
        if (entry.item !== null) {
          if (p.owned.has(entry.item)) refuse('already_owned', `already own ${entry.item}`)
          p.owned.add(entry.item)
        }
        entry.claimed = true
        return me()
      },
      async gift(to, itemId, message) {
        if (to === p.playerId) refuse('self_gift', 'cannot gift to yourself')
        if (!p.owned.has(itemId)) refuse('not_owned', `do not own ${itemId}`)
        if (players.get(to)?.blocked.has(p.playerId)) {
          refuse('blocked', 'recipient has blocked the sender')
        }
        const now = Date.now()
        const recent = p.gifts.filter(date => date > now - GIFT_LIMIT.windowMs)
        if (recent.length >= GIFT_LIMIT.count) refuse('rate_limited', 'gift limit reached')
        const entry: InboxEntry = { id: nextId('gift'), item: itemId,
          sender: { kind: 'player', id: p.playerId }, message,
          date: new Date(now).toISOString(), claimed: false }
        p.owned.delete(itemId)
        player(to).inbox.push(entry)
        p.gifts = [...recent, now]
      },
      async block(id) { p.blocked.add(id) },
      async unblock(id) { p.blocked.delete(id) },
    }
  }

  return {
    ...portFor(local),
    connect(playerId: string) { return portFor(player(playerId)) },
  }
}
