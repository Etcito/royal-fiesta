// HTTP client of the S18 economy service. Only the injected fetchImpl is used.

import { EconomyError } from './contract.ts'
import type { CatalogItem, Commission, EconomyPort, InboxEntry, Me, Rarity, Slot } from './contract.ts'

type Method = 'GET' | 'POST' | 'DELETE'

const REASON_MAX = 200

function errorReason(text: string, response: Response): string {
  const trimmed = text.trim()
  if (trimmed) return trimmed.length > REASON_MAX ? `${trimmed.slice(0, REASON_MAX)}...` : trimmed
  return response.statusText || `HTTP ${response.status}`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function refusal(text: string, response: Response): EconomyError {
  const body = parseJson(text)
  if (body !== null && typeof body === 'object') {
    const { error, reason } = body as { error?: unknown; reason?: unknown }
    if (typeof error === 'string' && error) {
      const why = typeof reason === 'string' && reason ? reason : errorReason('', response)
      return new EconomyError(error, why, response.status)
    }
  }
  return new EconomyError(`http_${response.status}`, errorReason(text, response), response.status)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createEconomyClient(
  baseUrl: string,
  token: () => string,
  fetchImpl: typeof fetch,
): EconomyPort {
  const root = baseUrl.replace(/\/+$/, '')

  async function send(method: Method, path: string, body?: unknown): Promise<string> {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + token() }
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let response: Response
    let text: string
    try {
      response = await fetchImpl(root + path, init)
      text = await response.text()
    } catch (err) {
      throw new EconomyError('network', describe(err), 0)
    }
    if (!response.ok) throw refusal(text, response)
    return text
  }

  async function json<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const text = await send(method, path, body)
    const parsed = parseJson(text)
    if (parsed === undefined) {
      throw new EconomyError('bad_response', `${method} ${path} did not answer JSON`, 502)
    }
    return parsed as T
  }

  async function done(method: Method, path: string, body?: unknown): Promise<void> {
    await send(method, path, body)
  }

  const segment = encodeURIComponent

  return {
    catalog: () => json<{ drop: string; items: CatalogItem[] }>('GET', '/catalog'),
    me: () => json<Me>('GET', '/me'),
    buy: (itemId: string, currency: 'coins' | 'tickets') =>
      json<Me & { remaining: number }>('POST', '/buy', { itemId, currency }),
    commission: (slot: Slot, rarity: Rarity, description: string) =>
      json<Commission>('POST', '/commissions', { slot, rarity, description }),
    commissions: () => json<Commission[]>('GET', '/commissions'),
    queue: () => json<Omit<Commission, 'playerId'>[]>('GET', '/commissions/queue'),
    inbox: () => json<InboxEntry[]>('GET', '/inbox'),
    claim: (id: string) => json<Me>('POST', `/inbox/${segment(id)}/claim`),
    gift: (to: string, itemId: string, message: string) =>
      done('POST', '/gifts', { to, itemId, message }),
    block: (player: string) => done('POST', '/blocks', { player }),
    unblock: (player: string) => done('DELETE', `/blocks/${segment(player)}`),
  }
}
