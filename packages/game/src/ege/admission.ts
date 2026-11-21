import { refuse } from '@royal-fiesta/sim/refusal'
import type { EngineModuleIdentity } from '../../../../tools/egeScripts.ts'

const AREA = 'ege-online'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads the engine module identity out of one lobby payload; every invalid value yields null and never throws. */
export function parseEngineIdentity(value: unknown): EngineModuleIdentity | null {
  if (!isObject(value) || value.backend !== 'engine') return null
  const schemaKey = value.schemaKey
  const moduleKey = value.moduleKey
  if (typeof schemaKey !== 'number' || !Number.isSafeInteger(schemaKey) || schemaKey < 0) return null
  if (typeof moduleKey !== 'string' || moduleKey.length < 1 || moduleKey.length > 256) return null
  return { backend: 'engine', schemaKey, moduleKey }
}

/**
 * Handoff: Engine online share 3/5: online runtime preparation and confirmed rules stepping calls
 * requireEnginePeers(local: EngineModuleIdentity, opponents: readonly unknown[]): void with the local offer and
 * ZoneMatched.opps; it refuses a malformed local identity or a missing/mismatched peer identity and returns when
 * every opponent matches. requireLegacyPeers refuses the first payload that carries an `engine` key, and
 * parseEngineIdentity reads one identity back out of a lobby payload.
 * State/keys: EngineModuleIdentity {backend, schemaKey, moduleKey} from each payload's `engine` key.
 */
export function requireEnginePeers(local: EngineModuleIdentity, opponents: readonly unknown[]): void {
  const mine = parseEngineIdentity(local)
  if (!mine) {
    refuse(AREA, 'lobby.local.engine', 'the local offer has no valid engine module identity; rebuild the page so the scripts plugin publishes one')
  }
  for (let i = 0; i < opponents.length; i++) {
    const payload = opponents[i]
    const peer = isObject(payload) ? parseEngineIdentity(payload.engine) : null
    if (!peer) {
      refuse(AREA, `lobby.opps/${i}.engine`, 'missing or malformed engine module identity; reload every client on the same ?engine=1 build')
    }
    if (peer.backend !== mine.backend || peer.schemaKey !== mine.schemaKey || peer.moduleKey !== mine.moduleKey) {
      refuse(AREA, `lobby.opps/${i}.engine`, `module identity mismatch: local ${mine.moduleKey}/${mine.schemaKey}, peer ${peer.moduleKey}/${peer.schemaKey}; reload every client on the same ?engine=1 build`)
    }
  }
}

/** Legacy shows accept only payloads without an engine identity; the first payload carrying one refuses. */
export function requireLegacyPeers(opponents: readonly unknown[]): void {
  for (let i = 0; i < opponents.length; i++) {
    const payload = opponents[i]
    if (isObject(payload) && Object.hasOwn(payload, 'engine')) {
      refuse(AREA, `lobby.opps/${i}.engine`, 'an ?engine=1 client joined a legacy show; reload every client with the same backend')
    }
  }
}
