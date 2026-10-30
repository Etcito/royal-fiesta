// Build-time default relay (docs/wavedash.md, "Relay URL in the frame"). The Wavedash frame URL cannot carry ?server=,
// so a build made with VITE_RF_SERVER=wss://host/ws in its ENVIRONMENT (never a committed file) feeds the title's
// Play online only. Play stays in-page with bots; an explicit ?server= still puts the whole page online.
import { refuse } from '@royal-fiesta/sim/refusal'

// Read here, not in main.ts (a test evaluates main.ts as a script, where import.meta is invalid).
function buildServer(): string | undefined {
  return (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RF_SERVER
}

/** The default relay URL of this build, or null when the build has none. A set but malformed value is refused. */
export function defaultRelay(raw: string | undefined = buildServer()): string | null {
  if (raw === undefined || raw.trim() === '') return null
  const url = raw.trim()
  if (!/^wss?:\/\/\S+$/.test(url)) refuse('build', 'VITE_RF_SERVER', 'is not a ws:// or wss:// URL; rebuild with VITE_RF_SERVER=wss://host/ws')
  return url
}

/** The relay Play online uses: an explicit ?server= first, then the build default, else null (no relay to go to). */
export function onlineRelay(queryServer: string | null, buildDefault: string | null): string | null {
  return queryServer ?? buildDefault
}
