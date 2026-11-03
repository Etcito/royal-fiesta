import { refuse } from '@royal-fiesta/sim/refusal'

/** Total local roster, including the human. The plural spelling takes precedence. */
export function localBotCount(query: URLSearchParams): number | null {
  const key = query.has('bots') ? 'bots' : 'bot'
  const raw = query.get(key)
  if (raw === null) return null
  const count = Number(raw)
  if (!/^\d+$/.test(raw) || count < 2 || count > 60) {
    const reason = `'${raw}' is not an integer in 2..60; fix ?${key}= (total penguins including you)`
    console.error(`[query] ${key}: ${reason}`)
    refuse('query', key, reason)
  }
  return count
}
