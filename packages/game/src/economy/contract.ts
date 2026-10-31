// No imports: deploy.sh ships this file alone next to the economy server.

export const RARITY_TICKETS = { common: 3, rare: 4, legendary: 5, epic: 6 } as const
export const COINS_PER_QUALIFY = 10
export const GIFT_LIMIT = { count: 5, windowMs: 86_400_000 } as const
export const ECONOMY_ERRORS = {
  unauthorized: 401, unknown_item: 404, not_found: 404, sold_out: 409, insufficient_funds: 409,
  already_owned: 409, not_owned: 409, already_claimed: 409, no_price: 400, invalid: 400,
  description_refused: 400, self_gift: 403, blocked: 403, rate_limited: 429,
} as const

export type Slot = 'head' | 'body' | 'bottom' | 'special'
export type Rarity = keyof typeof RARITY_TICKETS

export interface CatalogItem {
  id: string; name: string; slot: Slot; rarity: Rarity; asset: string
  price: { coins?: number; tickets?: number }
  editionCap: number; sold: number; remaining: number
}

export interface Me {
  playerId: string; coins: number; tickets: number; owned: string[]; inboxUnread: number
}

export interface InboxEntry {
  id: string; item: string | null
  sender: { kind: 'owner' | 'system' | 'player'; id: string | null }
  message: string; date: string; claimed: boolean
}

export interface Commission {
  id: string; playerId: string; slot: Slot; rarity: Rarity; description: string
  status: 'pending' | 'in_production' | 'shipped'; createdAt: string
}

export interface EconomyPort {
  catalog(): Promise<{ drop: string; items: CatalogItem[] }>
  me(): Promise<Me>
  buy(itemId: string, currency: 'coins' | 'tickets'): Promise<Me & { remaining: number }>
  commission(slot: Slot, rarity: Rarity, description: string): Promise<Commission>
  commissions(): Promise<Commission[]>
  queue(): Promise<Omit<Commission, 'playerId'>[]>
  inbox(): Promise<InboxEntry[]>
  claim(id: string): Promise<Me>
  gift(to: string, itemId: string, message: string): Promise<void>
  block(player: string): Promise<void>
  unblock(player: string): Promise<void>
}

function listedStatus(code: string): number | undefined {
  return Object.hasOwn(ECONOMY_ERRORS, code)
    ? ECONOMY_ERRORS[code as keyof typeof ECONOMY_ERRORS]
    : undefined
}

export class EconomyError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, reason: string, status = 500) {
    super(`${code}: ${reason}`)
    this.name = 'EconomyError'
    this.code = code
    this.status = listedStatus(code) ?? status
  }
}

export const DESCRIPTION_LIMITS = { min: 10, max: 280 } as const
const WORD_CHAR = '[\\p{L}\\p{M}\\p{N}_]'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function checkDescription(text: string, banned: readonly string[]): string | null {
  const trimmed = text.trim()
  const length = [...trimmed].length
  if (length < DESCRIPTION_LIMITS.min || length > DESCRIPTION_LIMITS.max) {
    return `description must be ${DESCRIPTION_LIMITS.min} to ${DESCRIPTION_LIMITS.max} characters, got ${length}`
  }
  const lower = trimmed.toLowerCase()
  if (lower.includes('://') || lower.includes('www.')) {
    return 'description must not contain a link'
  }
  for (const word of banned) {
    const term = word.trim()
    if (!term) continue
    const pattern = new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(term)}(?!${WORD_CHAR})`, 'iu')
    if (pattern.test(trimmed)) {
      return `description contains a banned word: ${term}`
    }
  }
  return null
}
