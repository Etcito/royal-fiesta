import { ZONE_DEFAULTS, classOf, validateZoneTuning } from '@gamesaloon/rollback/zones'
import type { ZoneTuning } from '@gamesaloon/rollback/zones'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { refuse } from '@royal-fiesta/sim/refusal'

/** Zone tuning for a Royal Fiesta match: the shared defaults plus the game's own settings. */
export const FIESTA_ZONE_TUNING = Object.freeze({
  ...ZONE_DEFAULTS,
  botTakeoverMs: 1500,
}) satisfies ZoneTuning

/** Measurement classes of one peer, as carried by its control words. */
export interface PeerClasses {
  readonly cpuClass: number
  readonly bwClass: number
  readonly latClass: number
}

const TUNING_KEYS = Object.keys(ZONE_DEFAULTS) as (keyof ZoneTuning)[]

// parseZonesFile already merged the sidecar over ZONE_DEFAULTS, so a value equal to the default is
// not an override: keep the game's own value (botTakeoverMs) unless the sidecar actually changed it.
function differs(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return true
    for (let i = 0; i < a.length; i++) if (differs(a[i], b[i])) return true
    return false
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return true
    for (const key of keys) if (differs(left[key], right[key])) return true
    return false
  }
  return a !== b
}

/** Applies a sidecar's tuning overrides over FIESTA_ZONE_TUNING and validates the result. */
export function mergeZoneTuning(zones: ZonesFile): ZoneTuning {
  const tuning = { ...FIESTA_ZONE_TUNING } as unknown as Record<keyof ZoneTuning, unknown>
  for (const key of TUNING_KEYS) {
    const value = zones.tuning[key]
    if (differs(value, ZONE_DEFAULTS[key])) tuning[key] = value
  }
  const merged = tuning as unknown as ZoneTuning
  try {
    validateZoneTuning(merged)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const prefix = '[zones] tuning: '
    const detail = message.startsWith(prefix) ? message.slice(prefix.length) : message
    const field = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(detail)
    refuse('zones', field ? `tuning/${field[0]}` : 'tuning', `${detail}; fix the tuning override`)
  }
  return merged
}

/** Maps measured cpu ms, bandwidth kbps and latency ms to classes through the tuning tables. */
export function peerClasses(
  cpuMs: number,
  bandwidthKbps: number,
  latencyMs: number,
  tuning: ZoneTuning = FIESTA_ZONE_TUNING,
): PeerClasses {
  return {
    cpuClass: classOf(cpuMs, tuning.cpuThresholdsMs),
    bwClass: classOf(bandwidthKbps, tuning.bwThresholdsKbps),
    latClass: classOf(latencyMs, tuning.latThresholdsMs),
  }
}
