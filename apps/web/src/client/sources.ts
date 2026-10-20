/// <reference types="vite/client" />
// Browser data sources: fixtures bundled by Vite, the asset store reached through fetch at call time.
import { fixtureResolver, storeResolver } from '@royal-fiesta/game/assets'
import type { AssetResolver } from '@royal-fiesta/game/assets'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import type { CourseEntry } from '@royal-fiesta/game/courseSet'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'

const FIXTURES = import.meta.glob<string>('../../../../fixtures/**/*.json', { query: '?raw', import: 'default', eager: true })
const GLOB_PREFIX = '../../../../'
const COURSE_FILE = /^fixtures\/courses\/[^/]+\.course\.json$/
const ASSET_FILE = /^fixtures\/assets\/[^/]+\.prims\.json$/

// Repo-relative path -> file text.
const files = new Map<string, string>()
for (const key of Object.keys(FIXTURES)) {
  if (key.startsWith(GLOB_PREFIX)) files.set(key.slice(GLOB_PREFIX.length), FIXTURES[key])
}

let fixtures: AssetResolver | undefined

export function browserAssetResolver(): AssetResolver {
  if (!fixtures) {
    fixtures = fixtureResolver(async path => {
      const text = ASSET_FILE.test(path) ? files.get(path) : undefined
      if (text === undefined) throw new Error('not bundled by import.meta.glob')
      return text
    })
  }
  return fixtures
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let res: Response
  try {
    res = await globalThis.fetch(url)
  } catch (e) {
    refuse('files', url, `fetch failed: ${(e as Error).message}; check the network and the asset store`)
  }
  if (!res.ok) refuse('files', url, `fetch failed: HTTP ${res.status}; check the manifest and object hashes`)
  return new Uint8Array(await res.arrayBuffer())
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  let hex = ''
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0')
  return hex
}

function manifestOf(json: unknown): string | null {
  const m = (json as { assetsManifest?: unknown } | null)?.assetsManifest
  return typeof m === 'string' ? m : null
}

function assetNamesOf(json: unknown): string[] {
  const obstacles = (json as { obstacles?: unknown } | null)?.obstacles
  if (!Array.isArray(obstacles)) return []
  const names: string[] = []
  for (let i = 0; i < obstacles.length; i++) {
    const asset = (obstacles[i] as { asset?: unknown } | null)?.asset
    if (typeof asset === 'string') names.push(asset)
  }
  return names
}

// matchCourses takes one resolver, so asset names route to the source their course names.
function routedResolver(entries: readonly CourseEntry[]): AssetResolver {
  const route = new Map<string, { manifest: string | null; path: string }>()
  for (let i = 0; i < entries.length; i++) {
    const manifest = manifestOf(entries[i].json)
    const names = assetNamesOf(entries[i].json)
    for (let j = 0; j < names.length; j++) {
      const prev = route.get(names[j])
      if (prev && prev.manifest !== manifest) {
        refuse('course', entries[i].path, `asset '${names[j]}' comes from ${manifest ?? 'fixtures'} here but from ${prev.manifest ?? 'fixtures'} in ${prev.path}; use one source per asset name`)
      }
      if (!prev) route.set(names[j], { manifest, path: entries[i].path })
    }
  }
  const stores = new Map<string, AssetResolver>()
  return {
    resolve(name) {
      const manifest = route.get(name)?.manifest ?? null
      if (manifest === null) return browserAssetResolver().resolve(name)
      let store = stores.get(manifest)
      if (!store) {
        store = storeResolver(manifest, fetchBytes, sha256Hex)
        stores.set(manifest, store)
      }
      return store.resolve(name)
    },
  }
}

export async function browserCourses(profile: ProfileName): Promise<ResolvedCourse[]> {
  // Load order is part of determinism: code-unit order by path.
  const paths = [...files.keys()].filter(p => COURSE_FILE.test(p)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const entries: CourseEntry[] = []
  for (let i = 0; i < paths.length; i++) {
    let json: unknown
    try {
      json = JSON.parse(files.get(paths[i]) as string)
    } catch (e) {
      refuse('course', paths[i], `invalid JSON: ${(e as Error).message}; fix the file syntax`)
    }
    entries.push({ path: paths[i], json })
  }
  return matchCourses(entries, routedResolver(entries), profile)
}

export async function preloadAssets(courses: readonly ResolvedCourse[], resolver: AssetResolver): Promise<(name: string) => PrimsAsset> {
  const names = ['bean']
  for (let i = 0; i < courses.length; i++) {
    const obstacles = courses[i].obstacles
    for (let j = 0; j < obstacles.length; j++) {
      if (!names.includes(obstacles[j].asset)) names.push(obstacles[j].asset)
    }
  }
  const loaded = new Map<string, PrimsAsset>()
  for (let i = 0; i < names.length; i++) loaded.set(names[i], (await resolver.resolve(names[i])).asset)
  // SceneView needs a synchronous lookup: anything not preloaded is a refusal, not a late fetch.
  return (name: string): PrimsAsset => {
    const asset = loaded.get(name)
    if (!asset) refuse('assets', name, `asset '${name}' was not preloaded; add it to a course or to preloadAssets`)
    return asset
  }
}
