// Community level pack: one JSON (manifest + the exact text of every file) that SDF Modeler publishes to Etcito and
// Royal Fiesta lists and loads (docs/community-levels.md). Isomorphic (Web Crypto only), so the modeler's publisher, the
// Etcito levels service (tools/levels/server.ts, strict validation on submit) and the game page share this one module.
//
// A pack carries the course plus the game assets it uses (meshes are not shipped: every client rebuilds them). Files are
// kept as TEXT, so a hash is over the very bytes a peer receives. The contentHash is the version of the level: an id is
// `<courseId>-<first 8 hex of contentHash>`, so a changed level is a new item and a match descriptor can pin it by hash.
import { refuse } from '@royal-fiesta/sim/refusal'
import { loadCourseV1 } from './courseV1.ts'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from './courseV1.ts'
import { parseGameAsset } from './gameAsset.ts'

export const LEVEL_PACK_FORMAT = 'etcito.level-pack'
export const LEVEL_PACK_VERSION = 1
export const LEVEL_GAME = 'royal-fiesta'
/** Bump when the sim or the validator changes in a way that makes a published level load differently. */
export const LEVEL_GAME_VERSION = 'v1'

/** The strict ceilings (the server enforces them on submit, a peer re-checks them at load). */
export const LEVEL_LIMITS = {
  maxFiles: 65,
  maxFileBytes: 1_500_000,
  maxPackBytes: 4_000_000,
  maxAssets: 64,
  maxTitle: 80,
  maxAuthor: 40,
} as const

/** Published course ids carry this prefix, so a community course never collides with a shipped one. */
export const COMMUNITY_COURSE_PREFIX = 'ugc-'

export interface LevelFileEntry { path: string; sha256: string; size: number }
export interface LevelManifest {
  format: typeof LEVEL_PACK_FORMAT
  version: typeof LEVEL_PACK_VERSION
  id: string
  game: typeof LEVEL_GAME
  title: string
  author: string
  gameVersion: string
  courseId: string
  contentHash: string
  files: LevelFileEntry[]
}
export interface LevelPack { manifest: LevelManifest; files: Record<string, string> }
/** What GET /levels lists for each level. */
export interface LevelListing {
  id: string; title: string; author: string; gameVersion: string; courseId: string; contentHash: string; size: number; createdAt: number
}

const COURSE_PATH = /^courses\/(ugc-[a-z0-9-]{1,36})\.course\.json$/
const ASSET_PATH = /^assets\/(candy|ice|jungle|neon|common)\/([a-z][a-z0-9]*(?:\.[a-z0-9-]+)+)\.asset\.json$/
const HEX64 = /^[0-9a-f]{64}$/
const LEVEL_ID = /^ugc-[a-z0-9-]{1,36}-[0-9a-f]{8}$/

const encoder = new TextEncoder()
export function utf8Length(text: string): number { return encoder.encode(text).length }

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text) as Uint8Array<ArrayBuffer>))
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** sha256 over the sorted `path\nsha256\n` lines: the level's version. */
export async function contentHashOf(files: readonly { path: string; sha256: string }[]): Promise<string> {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(f => `${f.path}\n${f.sha256}\n`)
  return sha256Hex(lines.join(''))
}

export function levelIdOf(courseId: string, contentHash: string): string { return `${courseId}-${contentHash.slice(0, 8)}` }

export interface PackInput { title: string; author: string; courseId: string; files: Record<string, string>; gameVersion?: string }

/** Builds the manifest over files that are already text (no validation: the server and the loader validate). */
export async function buildLevelPack(input: PackInput): Promise<LevelPack> {
  const entries: LevelFileEntry[] = []
  for (const path of Object.keys(input.files).sort()) {
    const text = input.files[path]
    entries.push({ path, sha256: await sha256Hex(text), size: utf8Length(text) })
  }
  const contentHash = await contentHashOf(entries)
  return {
    manifest: {
      format: LEVEL_PACK_FORMAT, version: LEVEL_PACK_VERSION, id: levelIdOf(input.courseId, contentHash), game: LEVEL_GAME,
      title: input.title, author: input.author, gameVersion: input.gameVersion ?? LEVEL_GAME_VERSION,
      courseId: input.courseId, contentHash, files: entries,
    },
    files: { ...input.files },
  }
}

function fail(ptr: string, reason: string): never { return refuse('level-pack', ptr, reason) }

function plain(v: unknown, ptr: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(ptr, 'must be an object')
  return v as Record<string, unknown>
}

/** Shape, sizes and hashes only. A game client calls it before using any byte of a downloaded pack. */
export async function verifyLevelPack(input: unknown): Promise<LevelPack> {
  const root = plain(input, '#')
  for (const k of Object.keys(root)) if (k !== 'manifest' && k !== 'files') fail(`#/${k}`, `unknown key '${k}'`)
  const m = plain(root.manifest, '#/manifest')
  const allowed = ['format', 'version', 'id', 'game', 'title', 'author', 'gameVersion', 'courseId', 'contentHash', 'files']
  for (const k of Object.keys(m)) if (!allowed.includes(k)) fail(`#/manifest/${k}`, `unknown key '${k}'`)
  if (m.format !== LEVEL_PACK_FORMAT) fail('#/manifest/format', `must be '${LEVEL_PACK_FORMAT}'`)
  if (m.version !== LEVEL_PACK_VERSION) fail('#/manifest/version', `must be ${LEVEL_PACK_VERSION}`)
  if (m.game !== LEVEL_GAME) fail('#/manifest/game', `must be '${LEVEL_GAME}'`)
  const text = (k: string, max: number): string => {
    const v = m[k]
    if (typeof v !== 'string' || v.trim().length < 1 || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) fail(`#/manifest/${k}`, `must be a 1..${max} character string without control characters`)
    return v
  }
  text('title', LEVEL_LIMITS.maxTitle); text('author', LEVEL_LIMITS.maxAuthor); text('gameVersion', 32)
  if (typeof m.id !== 'string' || !LEVEL_ID.test(m.id)) fail('#/manifest/id', 'must be <courseId>-<8 hex of contentHash>')
  if (typeof m.contentHash !== 'string' || !HEX64.test(m.contentHash)) fail('#/manifest/contentHash', 'must be 64 lowercase hex characters')
  if (typeof m.courseId !== 'string' || !/^ugc-[a-z0-9-]{1,36}$/.test(m.courseId)) fail('#/manifest/courseId', `must be a course id starting with '${COMMUNITY_COURSE_PREFIX}'`)
  if (m.id !== levelIdOf(m.courseId, m.contentHash)) fail('#/manifest/id', 'does not match courseId and contentHash')
  const files = plain(root.files, '#/files')
  const list = m.files
  if (!Array.isArray(list) || list.length < 2 || list.length > LEVEL_LIMITS.maxFiles) fail('#/manifest/files', `must list 2..${LEVEL_LIMITS.maxFiles} files`)
  const entries: LevelFileEntry[] = []
  let total = 0
  const seen = new Set<string>()
  for (let i = 0; i < list.length; i++) {
    const e = plain(list[i], `#/manifest/files/${i}`)
    for (const k of Object.keys(e)) if (k !== 'path' && k !== 'sha256' && k !== 'size') fail(`#/manifest/files/${i}/${k}`, `unknown key '${k}'`)
    if (typeof e.path !== 'string' || typeof e.sha256 !== 'string' || !HEX64.test(e.sha256) || typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0) fail(`#/manifest/files/${i}`, 'needs path, a 64 hex sha256 and an integer size')
    if (seen.has(e.path)) fail(`#/manifest/files/${i}/path`, `duplicate path '${e.path}'`)
    seen.add(e.path)
    const body = files[e.path]
    if (typeof body !== 'string') fail(`#/files/${e.path}`, 'is listed in the manifest but missing from files')
    if (e.size > LEVEL_LIMITS.maxFileBytes) fail(`#/files/${e.path}`, `is over ${LEVEL_LIMITS.maxFileBytes} bytes`)
    if (utf8Length(body) !== e.size) fail(`#/files/${e.path}`, 'size does not match the manifest')
    if (await sha256Hex(body) !== e.sha256) fail(`#/files/${e.path}`, 'sha256 does not match the manifest')
    total += e.size
    entries.push({ path: e.path, sha256: e.sha256, size: e.size })
  }
  for (const path of Object.keys(files)) if (!seen.has(path)) fail(`#/files/${path}`, 'is not listed in the manifest')
  if (total > LEVEL_LIMITS.maxPackBytes) fail('#/files', `the pack is over ${LEVEL_LIMITS.maxPackBytes} bytes`)
  if (await contentHashOf(entries) !== m.contentHash) fail('#/manifest/contentHash', 'does not match the files')
  return input as LevelPack
}

export interface ValidatedLevel { pack: LevelPack; course: CourseV1; assets: Map<string, ResolvedGameAsset> }

/** The strict validator (M6): verifyLevelPack, then every asset and the course load through the game's own readers. */
export async function validateLevelPack(input: unknown): Promise<ValidatedLevel> {
  const pack = await verifyLevelPack(input)
  const courses: string[] = []
  const assets = new Map<string, ResolvedGameAsset>()
  const parsed = new Map<string, unknown>()
  for (const [path, body] of Object.entries(pack.files)) {
    const course = COURSE_PATH.exec(path)
    const asset = ASSET_PATH.exec(path)
    if (course === null && asset === null) fail(`#/files/${path}`, 'is not a course (courses/ugc-<id>.course.json) or an asset (assets/<world>/<id>.asset.json)')
    if (/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(body)) fail(`#/files/${path}`, 'carries an external URL; a level references no remote content')
    let json: unknown
    try { json = JSON.parse(body) } catch { fail(`#/files/${path}`, 'is not valid JSON') }
    parsed.set(path, json)
    if (course !== null) courses.push(path)
  }
  if (courses.length !== 1) fail('#/files', `needs exactly one course file, found ${courses.length}`)
  const coursePath = courses[0]
  const assetPaths = Object.keys(pack.files).filter(p => p !== coursePath)
  if (assetPaths.length > LEVEL_LIMITS.maxAssets) fail('#/files', `has ${assetPaths.length} assets; the limit is ${LEVEL_LIMITS.maxAssets}`)
  for (const path of assetPaths) {
    const json = parsed.get(path)
    const asset = await parseGameAsset(json, path)
    const m = ASSET_PATH.exec(path)!
    if (asset.id !== m[2] || asset.world !== m[1]) fail(`#/files/${path}`, 'id/world do not match the file location')
    assets.set(asset.id, { asset, source: { path, json } })
  }
  const resolver: GameAssetResolver = {
    async resolve(id) {
      const found = assets.get(id)
      if (found === undefined) return fail(`asset ${id}`, `unknown asset '${id}'; the pack must carry every asset the course uses`)
      return found
    },
  }
  const course = await loadCourseV1(parsed.get(coursePath), coursePath, resolver)
  const stem = COURSE_PATH.exec(coursePath)![1]
  if (course.id !== stem || course.id !== pack.manifest.courseId) fail(`#/files/${coursePath}`, 'the course id must equal the file name and manifest.courseId')
  if (course.kind !== 'race' && course.kind !== 'survival') fail(`#/files/${coursePath}#/kind`, `a community level is a race or survival course, not '${course.kind}'`)
  if (course.sim === null) fail(`#/files/${coursePath}`, 'has no playable sim course')
  const unused = assetPaths.filter(p => !course.assetIds.includes(ASSET_PATH.exec(p)![2]))
  if (unused.length > 0) fail(`#/files/${unused[0]}`, 'is not used by the course; ship only the assets the course uses')
  return { pack, course, assets }
}
