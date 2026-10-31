// gamesaloon economy protocol (CONTRACT r10). Authentication precedes all operations.
import { EconomyError } from './contract.ts'
import type { CatalogItem, Commission, EconomyPort, InboxEntry, Me } from './contract.ts'
import { globalWsFactory, type WsFactory, type WsLike } from '../net/ws.ts'

type Auth = { provider: 'wavedash' | 'guest'; token: string; name?: string; game: string }
type RoundReporter = {
  reportRound(matchId: string, round: number, playerWavedashId: string, kind: string): Promise<{ applied: boolean }>
}
type ShopItem = Omit<CatalogItem, 'editionCap' | 'remaining'> & {
  edition_cap: number | null; remaining: number | null
}
type WireCommission = Omit<Commission, 'playerId' | 'createdAt'> & { created_at: number }
type State = { coins: number; balances?: Record<string, number>; cards: Record<string, number> }
type Inbox = { entries: InboxEntry[]; unread: number }
type Pending = { resolve: (reply: unknown) => void; reject: (error: EconomyError) => void }

function refusal(reason: string): EconomyError {
  const code = reason === 'auth_required' || reason === 'auth_failed' ? 'unauthorized'
    : reason === 'tx_conflict' || reason === 'bad_message' || reason === 'bad_argument' ? 'invalid'
    : reason
  return new EconomyError(code, reason)
}

function network(error: unknown): EconomyError {
  return new EconomyError('network', error instanceof Error ? error.message : String(error), 0)
}

function commission(entry: WireCommission): Omit<Commission, 'playerId'> {
  const { created_at, ...rest } = entry
  return { ...rest, createdAt: new Date(created_at).toISOString() }
}

export function createEconomyClient(
  url: string, auth: Auth, ws: WsFactory = globalWsFactory(),
): EconomyPort & RoundReporter & { close(): void } {
  const prefix = Math.random().toString(36).slice(2) || 'eco'
  let counter = 0
  let socket: WsLike | undefined
  let ready: Promise<void> | undefined
  let rejectReady: ((error: EconomyError) => void) | undefined
  let stopped: EconomyError | undefined
  let playerId: string | undefined
  const pending = new Map<string, Pending>()

  function stop(error: EconomyError): void {
    if (stopped) return
    stopped = error
    rejectReady?.(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    socket?.close()
  }

  function connect(): Promise<void> {
    if (stopped) return Promise.reject(stopped)
    if (ready) return ready
    ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject
      try {
        const sock = socket = ws(url)
        let authSent = false
        const open = () => {
          if (authSent || stopped) return
          authSent = true
          try { sock.send(JSON.stringify({ t: 'auth', ...auth })) }
          catch (error) { stop(network(error)) }
        }
        sock.onopen = open
        sock.onclose = e => stop(network(e.reason || 'socket closed'))
        sock.onerror = () => stop(network('socket error'))
        sock.onmessage = e => {
          if (stopped || typeof e.data !== 'string') return
          let message: { t?: string; op?: string; reason?: string; player_id?: string }
          try { message = JSON.parse(e.data) }
          catch { return }
          if (!message || typeof message !== 'object') return
          if (authSent && playerId === undefined) {
            if (message.t === 'authed' && typeof message.player_id === 'string') {
              playerId = message.player_id
              resolve()
            } else if (message.t === 'error' && typeof message.reason === 'string') {
              stop(refusal(message.reason))
            }
            return
          }
          // Pushes and replies for other operations never settle a pending request.
          if (typeof message.op !== 'string') return
          const request = pending.get(message.op)
          if (!request) return
          pending.delete(message.op)
          if (message.t === 'error') request.reject(refusal(message.reason ?? 'unknown_error'))
          else request.resolve(message)
        }
        if (sock.readyState === 1) open()
        else if (sock.readyState >= 2) stop(network('socket closed'))
      } catch (error) { stop(network(error)) }
    })
    return ready
  }

  async function request<T>(t: string, fields: Record<string, unknown> = {}): Promise<T> {
    await connect()
    if (stopped) throw stopped
    const op = `${prefix}:${++counter}`
    return new Promise<T>((resolve, reject) => {
      pending.set(op, { resolve: reply => resolve(reply as T), reject })
      try { socket!.send(JSON.stringify({ t, ...fields, op })) }
      catch (error) { stop(network(error)) }
    })
  }

  async function catalog(): Promise<{ drop: string; items: CatalogItem[] }> {
    const shop = await request<{ drop: string; items: ShopItem[] }>('eco_shop')
    return { drop: shop.drop, items: shop.items.map(({ edition_cap, remaining, ...item }) => ({
      ...item,
      // The port uses numbers; an uncapped gamesaloon edition has no finite limit.
      editionCap: edition_cap ?? Infinity, remaining: remaining ?? Infinity,
    })) }
  }

  async function me(): Promise<Me> {
    const [state, inbox, shop] = await Promise.all([
      request<State>('eco_get'), request<Inbox>('eco_inbox'), catalog(),
    ])
    const shopIds = new Set(shop.items.map(item => item.id))
    return {
      playerId: playerId!, coins: state.coins, tickets: state.balances?.tickets ?? 0,
      owned: Object.keys(state.cards).filter(id => state.cards[id] >= 1 && shopIds.has(id)),
      inboxUnread: inbox.unread,
    }
  }

  return {
    catalog, me,
    async buy(itemId, currency) {
      const bought = await request<{ remaining: number | null }>('eco_shop_buy', { item: itemId, currency })
      return { ...await me(), remaining: bought.remaining ?? Infinity }
    },
    async commission(slot, rarity, description) {
      const reply = await request<{ commission: WireCommission }>('eco_commission', { slot, rarity, description })
      return { ...commission(reply.commission), playerId: playerId! }
    },
    async commissions() {
      const reply = await request<{ items: WireCommission[] }>('eco_commissions')
      return reply.items.map(entry => ({ ...commission(entry), playerId: playerId! }))
    },
    async queue() {
      const reply = await request<{ items: WireCommission[] }>('eco_queue')
      return reply.items.map(commission)
    },
    async inbox() { return (await request<Inbox>('eco_inbox')).entries },
    async claim(id) {
      await request('eco_claim', { id })
      return me()
    },
    async gift(to, itemId, message) { await request('eco_gift', { to, item: itemId, message }) },
    async block(player) { await request('eco_block', { player, blocked: true }) },
    async unblock(player) { await request('eco_block', { player, blocked: false }) },
    async reportRound(matchId, round, playerWavedashId, kind) {
      const reply = await request<{ applied: boolean }>('eco_round', {
        match_id: matchId, round, player: playerWavedashId, kind,
      })
      return { applied: reply.applied }
    },
    close() { stop(network('client closed')) },
  }
}
