import { MAX_LOCAL_SEATS } from '@royal-fiesta/game/client/seats'
import { refuse } from '@royal-fiesta/sim/refusal'

/** One canvas with N human viewports; players takes precedence over local. */
export function localPlayerCount(query: URLSearchParams): number | null {
  const key = query.has('players') ? 'players' : 'local'
  const raw = query.get(key)
  if (raw === null) return null
  const count = Number(raw)
  if (!/^\d+$/.test(raw) || count < 1 || count > MAX_LOCAL_SEATS) {
    const reason = `'${raw}' is not an integer in 1..${MAX_LOCAL_SEATS}; fix ?${key}= (local human seats)`
    console.error(`[query] ${key}: ${reason}`)
    refuse('query', key, reason)
  }
  return count
}
