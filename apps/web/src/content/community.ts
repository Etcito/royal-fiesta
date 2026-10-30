/// <reference types="vite/client" />
// Community levels on the page (docs/community-levels.md): the Etcito levels base URL, the list, and a hash-verified pack.
// Only offered when a base URL is configured: VITE_RF_LEVELS_URL in the build ENVIRONMENT (like VITE_RF_SERVER, never a
// committed file) or ?levels= on the page. The shipped levels never need it.
import { LEVEL_GAME_VERSION, verifyLevelPack } from '@royal-fiesta/game/levelPack'
import type { LevelListing, LevelPack } from '@royal-fiesta/game/levelPack'
import { refuse } from '@royal-fiesta/sim/refusal'

const URL_RE = /^https?:\/\/\S+$/

/** The levels service base (…/levels) or null when this page has none. A set but malformed value is refused. */
export function communityBase(search: string, buildValue: string | undefined = import.meta.env?.VITE_RF_LEVELS_URL): string | null {
  const raw = new URLSearchParams(search).get('levels') ?? buildValue
  if (raw === undefined || raw.trim() === '') return null
  const url = raw.trim().replace(/\/+$/, '')
  if (!URL_RE.test(url)) refuse('build', 'VITE_RF_LEVELS_URL', 'is not an http(s) URL; use the levels base such as https://host/levels')
  return url
}

export async function listCommunityLevels(base: string, fetcher: typeof fetch = fetch): Promise<LevelListing[]> {
  const res = await fetcher(base, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`community levels: HTTP ${res.status}`)
  const body = await res.json() as { levels?: LevelListing[] }
  return Array.isArray(body.levels) ? body.levels : []
}

/** Downloads a pack and verifies its hashes before any byte is used; `contentHash` pins the exact version when given. */
export async function loadCommunityPack(base: string, id: string, contentHash?: string, fetcher: typeof fetch = fetch): Promise<LevelPack> {
  if (!/^ugc-[a-z0-9-]{1,36}-[0-9a-f]{8}$/.test(id)) refuse('community', 'level', `'${id}' is not a community level id`)
  const res = await fetcher(`${base}/${id}`)
  if (!res.ok) throw new Error(`community level ${id}: HTTP ${res.status}`)
  const pack = await verifyLevelPack(await res.json())
  if (pack.manifest.id !== id) refuse('community', 'level', `the server sent '${pack.manifest.id}' for '${id}'`)
  if (contentHash !== undefined && pack.manifest.contentHash !== contentHash) refuse('community', 'level', 'the level changed: its content hash is not the one pinned')
  if (pack.manifest.gameVersion !== LEVEL_GAME_VERSION) refuse('community', 'level', `made for game version '${pack.manifest.gameVersion}', this build is '${LEVEL_GAME_VERSION}'`)
  return pack
}
