import { assetHash, parsePrims } from './prims.ts'
import type { PrimsAsset } from './prims.ts'
import { refuse } from '@royal-fiesta/sim/refusal'

export interface ResolvedAsset { name: string; asset: PrimsAsset; hash: number; origin: 'fixtures' | 'store' }
export interface AssetResolver { resolve(name: string): Promise<ResolvedAsset> }
export type ReadText = (repoRelPath: string) => Promise<string>
export interface ManifestEntry { sha256: string; size: number; type: string; version: number }
export interface Manifest { format: 'raa.manifest'; version: 0; entries: Record<string, ManifestEntry> }

export const ASSET_STORE_BASE = 'https://assets.etcito.com'
const SHA256 = /^[0-9a-f]{64}$/
const ASSET_NAME = /^[a-z0-9-]{1,48}$/

export function fixtureResolver(read: ReadText): AssetResolver {
  const cache = new Map<string, Promise<ResolvedAsset>>()
  return {
    resolve(name: string): Promise<ResolvedAsset> {
      const path = `fixtures/assets/${name}.prims.json`
      if (!ASSET_NAME.test(name)) refuse('assets', path, `invalid asset name '${name}'; use 1-48 lowercase letters, digits or hyphens`)
      let result = cache.get(name)
      if (!result) {
        result = read(path).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          refuse('assets', path, `cannot read asset '${name}': ${message}; add the file or fix the asset name`)
        }).then(text => {
          let json: unknown
          try { json = JSON.parse(text) } catch {
            refuse('assets', path, `invalid JSON for asset '${name}'; fix the file content`)
          }
          return { name, asset: parsePrims(json, path), hash: assetHash(text), origin: 'fixtures' }
        })
        cache.set(name, result)
      }
      return result
    },
  }
}

export function objectUrl(sha256: string, base = ASSET_STORE_BASE): string {
  if (!SHA256.test(sha256)) refuse('assets', `object:${sha256}`, `invalid sha256 '${sha256}'; use 64 lowercase hexadecimal characters`)
  return `${base}/objects/${sha256.slice(0, 2)}/${sha256}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pointerName(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1')
}

export function parseManifest(json: unknown, path: string): Manifest {
  if (!isObject(json)) refuse('assets', path, 'manifest must be an object; fix the manifest JSON')
  if (json.format !== 'raa.manifest') refuse('assets', `${path}#/format`, 'format must be "raa.manifest"; set the manifest format')
  if (json.version !== 0) refuse('assets', `${path}#/version`, 'version must be 0; use an raa.manifest v0 file')
  if (!isObject(json.entries)) refuse('assets', `${path}#/entries`, 'entries must be an object; add asset entries')
  const entries: Record<string, ManifestEntry> = {}
  for (const name of Object.keys(json.entries)) {
    const entry = json.entries[name]
    const base = `${path}#/entries/${pointerName(name)}`
    if (!isObject(entry)) refuse('assets', base, 'entry must be an object; fix the manifest entry')
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) refuse('assets', `${base}/sha256`, 'sha256 must be 64 lowercase hexadecimal characters; use the object hash')
    if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) refuse('assets', `${base}/size`, 'size must be an integer >= 0; use the object byte size')
    if (typeof entry.type !== 'string') refuse('assets', `${base}/type`, 'type must be a string; set the asset media type')
    if (typeof entry.version !== 'number' || !Number.isInteger(entry.version)) refuse('assets', `${base}/version`, 'version must be an integer; set the asset version')
    entries[name] = { sha256: entry.sha256, size: entry.size, type: entry.type, version: entry.version }
  }
  return { format: 'raa.manifest', version: 0, entries }
}

export function storeResolver(
  manifestSha256: string,
  fetchBytes: (url: string) => Promise<Uint8Array>,
  sha256Hex: (b: Uint8Array) => Promise<string>,
  base = ASSET_STORE_BASE,
): AssetResolver {
  const manifestUrl = objectUrl(manifestSha256, base)
  let manifestPromise: Promise<Manifest> | undefined
  const cache = new Map<string, Promise<ResolvedAsset>>()
  const getManifest = (): Promise<Manifest> => {
    if (!manifestPromise) {
      manifestPromise = fetchBytes(manifestUrl).then(async bytes => {
        const actual = await sha256Hex(bytes)
        if (actual !== manifestSha256) refuse('assets', `manifest:${manifestSha256}`, `sha256 mismatch: expected ${manifestSha256}, got ${actual}`)
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
          refuse('assets', `manifest:${manifestSha256}`, 'manifest is not valid UTF-8; store valid UTF-8 JSON')
        }
        let json: unknown
        try { json = JSON.parse(text) } catch {
          refuse('assets', `manifest:${manifestSha256}`, 'manifest is not valid JSON; fix the manifest content')
        }
        return parseManifest(json, `manifest:${manifestSha256}`)
      })
    }
    return manifestPromise
  }
  return {
    resolve(name: string): Promise<ResolvedAsset> {
      let result = cache.get(name)
      if (!result) {
        result = getManifest().then(async manifest => {
          const entry = manifest.entries[name]
          if (!entry) refuse('assets', `manifest:${manifestSha256}#/entries/${pointerName(name)}`, `unknown asset ${name} in manifest ${manifestSha256}; add it to the manifest`)
          const bytes = await fetchBytes(objectUrl(entry.sha256, base))
          const actual = await sha256Hex(bytes)
          if (actual !== entry.sha256) refuse('assets', `store:${name}`, `sha256 mismatch: expected ${entry.sha256}, got ${actual}`)
          if (bytes.byteLength !== entry.size) refuse('assets', `store:${name}`, `size mismatch: expected ${entry.size}, got ${bytes.byteLength}`)
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
            refuse('assets', `store:${name}`, 'asset is not valid UTF-8; store valid UTF-8 JSON')
          }
          let json: unknown
          try { json = JSON.parse(text) } catch {
            refuse('assets', `store:${name}`, 'asset is not valid JSON; fix the object content')
          }
          return { name, asset: parsePrims(json, `store:${name}`), hash: assetHash(text), origin: 'store' }
        })
        cache.set(name, result)
      }
      return result
    },
  }
}
