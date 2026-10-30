/// <reference types="vite/client" />
// V1 data fetched from a content root, with bundled render stand-ins and course dressing.
// Every import.meta.glob sits in a function body, so Node tests can import this module.
import type { CourseDressing, LoadProgress } from '@royal-fiesta/game/content'
import { loadCourseV1, V0_ASSET_MAP } from '@royal-fiesta/game/courseV1'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '@royal-fiesta/game/courseV1'
import { parseGameAsset } from '@royal-fiesta/game/gameAsset'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { parsePrims, PRIM_CAPS } from '@royal-fiesta/game/prims'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { PALETTE, PALETTE_NAMES } from '@royal-fiesta/game/render/palette'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { refuse } from '@royal-fiesta/sim/refusal'

const GLOB_PREFIX = '../../../../'
const ASSET_SUFFIX = '.asset.json'
const STAND_IN = ' (dev stand-in)'
const STAND_IN_RADIUS = 0.05

// S29: mesh = the saved .mesh path when the file exists; audio = the haa patches (audio/<id>.haa.json).
export interface ContentIndexV1 {
  assets: { id: string; world: string; path: string; hash: string; mesh?: string }[]
  courses: { id: string; path: string }[]
  audio: { id: string; path: string }[]
}
export type ContentIndex = ContentIndexV1
export interface ContentOptions { root?: string; fetch?: typeof fetch }

export function browserContentRoot(): string {
  const query = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('content')
  return query ?? import.meta.env?.VITE_RF_CONTENT_URL ?? 'content/'
}

// A community level (docs/community-levels.md): its verified files overlay the content root for this page. The course
// and the assets it carries join the index; every other path still comes from the root.
let overlay: Map<string, string> | null = null

/** Installs a verified community pack's files (path -> exact text) over the page's content. Call before any content read. */
export function installContentOverlay(files: Readonly<Record<string, string>>): void {
  overlay = new Map(Object.entries(files))
  contentIndex = null
  audioPatches = null
  gameAssets = null
}

function mergeOverlayIndex(base: ContentIndexV1, files: ReadonlyMap<string, string>): ContentIndexV1 {
  const merged: ContentIndexV1 = { assets: [...base.assets], courses: [...base.courses], audio: [...(base.audio ?? [])] }
  for (const [path, text] of files) {
    const course = /^courses\/([a-z0-9-]+)\.course\.json$/.exec(path)
    if (course !== null) {
      if (merged.courses.some(c => c.id === course[1])) refuse('community', path, `the game already has a course '${course[1]}'; the level cannot load`)
      merged.courses.push({ id: course[1], path })
      continue
    }
    const asset = /^assets\/([a-z]+)\/(.+)\.asset\.json$/.exec(path)
    if (asset === null) continue
    const hash = (JSON.parse(text) as { hash?: unknown }).hash
    if (typeof hash !== 'string') refuse('community', path, 'the asset has no hash')
    const same = merged.assets.find(a => a.id === asset[2])
    if (same !== undefined) {
      if (same.hash !== hash) refuse('community', path, `the game has an asset '${asset[2]}' with other content; the level cannot load`)
      continue
    }
    merged.assets.push({ id: asset[2], world: asset[1], path, hash })
  }
  return merged
}

function contentReader(options: ContentOptions) {
  const root = (options.root ?? browserContentRoot()).replace(/\/?$/, '/')
  const fetcher = options.fetch ?? globalThis.fetch
  return async (path: string): Promise<unknown> => {
    const local = overlay?.get(path)
    if (local !== undefined) return JSON.parse(local)
    const response = await fetcher(root + path, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`content: ${path}: HTTP ${response.status}`)
    const json = JSON.parse(await response.text()) as unknown
    return overlay !== null && path === 'index.json' ? mergeOverlayIndex(json as ContentIndexV1, overlay) : json
  }
}

let contentIndex: Promise<ContentIndexV1> | null = null
let audioPatches: Promise<ReadonlyMap<string, string>> | null = null

// The page's index.json, fetched once (with options: a fresh, uncached read).
export function browserContentIndex(options?: ContentOptions): Promise<ContentIndexV1> {
  if (options === undefined && contentIndex !== null) return contentIndex
  const index = contentReader(options ?? {})('index.json') as Promise<ContentIndexV1>
  if (options === undefined) {
    contentIndex = index
    // A failed read is not kept: the next call fetches again.
    index.catch(() => { if (contentIndex === index) contentIndex = null })
  }
  return index
}

// Haa patch id -> absolute URL of its audio/<id>.haa.json against the content root (an index without audio has none).
export function browserAudioPatches(options?: ContentOptions): Promise<ReadonlyMap<string, string>> {
  if (options === undefined && audioPatches !== null) return audioPatches
  const root = (options?.root ?? browserContentRoot()).replace(/\/?$/, '/')
  const base = new URL(root, typeof location === 'undefined' ? undefined : location.href)
  const patches = browserContentIndex(options).then(index => new Map((index.audio ?? []).map(entry => [entry.id, new URL(entry.path, base).href])))
  if (options === undefined) {
    audioPatches = patches
    patches.catch(() => { if (audioPatches === patches) audioPatches = null })
  }
  return patches
}

let gameAssets: GameAssetResolver | null = null

// One entry per file stem; a stem found twice refuses when resolved.
export function browserGameAssets(options?: ContentOptions): GameAssetResolver {
  if (options === undefined && gameAssets !== null) return gameAssets
  const read = contentReader(options ?? {})
  let index: Promise<ContentIndex> | undefined
  const cache = new Map<string, Promise<ResolvedGameAsset>>()

  async function load(id: string): Promise<ResolvedGameAsset> {
    index ??= read('index.json') as Promise<ContentIndex>
    const entries = (await index).assets
    const found = entries.filter(entry => entry.id === id)
    if (found.length === 0) {
      const ids = [...new Set(entries.map(entry => entry.id))].sort()
      refuse('assets', `assets/*/${id}${ASSET_SUFFIX}`, `unknown asset id '${id}'; add the asset file or use one of: ${ids.join(', ') || '(none)'}`)
    }
    if (found.length > 1) {
      refuse('assets', found[1].path, `asset id '${id}' is also ${found[0].path}; ids are unique across assets/, rename one`)
    }
    const { path } = found[0]
    const slash = path.lastIndexOf('/')
    const stem = path.slice(slash + 1, -ASSET_SUFFIX.length)
    const folder = path.slice('assets/'.length, slash)
    const json = await read(path)
    const asset = await parseGameAsset(json, path)
    if (asset.id !== stem) refuse('assets', `${path}#/id`, `id '${asset.id}' does not match the file stem '${stem}'; rename the file or the id`)
    if (asset.world !== folder) {
      refuse('assets', `${path}#/world`, `world '${asset.world}' does not match the folder '${folder}'; move the file to assets/${asset.world}/`)
    }
    return { asset, source: { path, json } }
  }

  const resolver: GameAssetResolver = {
    resolve(id: string): Promise<ResolvedGameAsset> {
      let p = cache.get(id)
      if (p === undefined) {
        p = load(id)
        cache.set(id, p)
      }
      return p
    },
  }
  if (options === undefined) gameAssets = resolver
  return resolver
}

export interface V1Courses { courses: CourseV1[]; byId: ReadonlyMap<string, CourseV1> }

export async function loadV1Courses(onProgress: (p: LoadProgress) => void, options?: ContentOptions): Promise<V1Courses> {
  const read = contentReader(options ?? {})
  const index = await read('index.json') as ContentIndex
  const entries = [...index.courses].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const assets = browserGameAssets(options)
  const courses: CourseV1[] = []
  for (let i = 0; i < entries.length; i++) {
    const { path } = entries[i]
    courses.push(await loadCourseV1(await read(path), path, assets))
    onProgress({ phase: 'courses', done: i + 1, total: entries.length, label: path })
  }
  const assetIds = new Set<string>()
  for (const c of courses) for (const id of c.assetIds) assetIds.add(id)
  onProgress({ phase: 'assets', done: assetIds.size, total: assetIds.size, label: `${assetIds.size} assets` })
  courses.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { courses, byId: new Map(courses.map(c => [c.id, c])) }
}

// Stable colour per id, so a stand-in keeps its colour across reloads.
function paletteIndex(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % PALETTE.length
}

// Pure: the v0 prims under the asset id, or a rounded box filling the asset bounds. Never collides.
export function standInFrom(asset: GameAsset, v0: PrimsAsset | null): PrimsAsset {
  if (v0 !== null) return { ...structuredClone(v0), id: asset.id, name: `${v0.name}${STAND_IN}` }
  const { min, max } = asset.bounds
  const size: [number, number, number] = [max.x - min.x, max.y - min.y, max.z - min.z]
  const radius = Math.min(STAND_IN_RADIUS, Math.min(size[0], size[1], size[2]) / 2)
  const k = paletteIndex(asset.id)
  const material = PALETTE_NAMES[k]
  const [r, g, b] = PALETTE[k]
  return {
    format: 'raa.prims', version: 0, id: asset.id, name: `${asset.name}${STAND_IN}`,
    budget: { ...PRIM_CAPS.defaultBudget },
    nodes: [{
      id: 'bounds', kind: 'roundBox', params: { size, radius },
      transform: { t: [(min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2], r: [0, 0, 0, 1], s: [1, 1, 1] },
      material, op: 'union',
    }],
    materials: { [material]: { color: [r, g, b], roughness: 0.6, metallic: 0, emissive: [0, 0, 0] } },
    anchors: {},
    collision: { mode: 'override', colliders: [] },
  }
}

let v0ByAssetId: Map<string, string> | null = null
let v0Prims: Map<string, PrimsAsset> | null = null

function v0PrimsOf(assetId: string): PrimsAsset | null {
  if (v0ByAssetId === null) v0ByAssetId = new Map(Object.entries(V0_ASSET_MAP).map(([name, id]) => [id, name]))
  const name = v0ByAssetId.get(assetId)
  if (name === undefined) return null
  if (v0Prims === null) {
    const files = import.meta.glob<string>('../../../../fixtures/assets/*.prims.json', { query: '?raw', import: 'default', eager: true })
    const parsed = new Map<string, PrimsAsset>()
    for (const key of Object.keys(files).sort()) {
      const path = key.slice(GLOB_PREFIX.length)
      parsed.set(path.slice('fixtures/assets/'.length, path.length - '.prims.json'.length), parsePrims(JSON.parse(files[key]), path))
    }
    v0Prims = parsed
  }
  const prims = v0Prims.get(name)
  if (prims === undefined) {
    refuse('content', `fixtures/assets/${name}.prims.json`, `V0_ASSET_MAP maps '${name}' to '${assetId}' but the fixture is not bundled; restore the fixture`)
  }
  return prims
}

export function standInPrims(asset: GameAsset): PrimsAsset {
  return standInFrom(asset, v0PrimsOf(asset.id))
}

// Decor is view only: instances on the port plus the course environment; leave removes what enter made on that
// same port. One dressing serves every client's port (and every viewport of a shared port), so the instances are
// kept per port, one entry per enter: a leave never destroys handles another port made.
export function v1Dressing(courses: readonly CourseV1[], prims: (id: string) => PrimsAsset): CourseDressing {
  const byId = new Map(courses.map(c => [c.id, c]))
  const entered = new Map<RenderPort, number[][]>()
  return {
    enter(port: RenderPort, courseId: string): void {
      const course = byId.get(courseId)
      if (course === undefined) {
        refuse('content', `courses/${courseId}.course.json`, `unknown v1 course '${courseId}'; use one of: ${[...byId.keys()].sort().join(', ')}`)
      }
      const handles = new Map<string, number>()
      const instances: number[] = []
      for (const d of course.decor) {
        let h = handles.get(d.asset)
        if (h === undefined) {
          h = port.registerAsset(d.asset, prims(d.asset))
          handles.set(d.asset, h)
        }
        const inst = port.createInstance(h, null)
        port.setTransform(inst, d.t, d.r, d.s)
        instances.push(inst)
      }
      const stack = entered.get(port)
      if (stack === undefined) entered.set(port, [instances])
      else stack.push(instances)
      port.setEnvironment(course.environment)
    },
    leave(port: RenderPort): void {
      const stack = entered.get(port)
      const instances = stack?.pop()
      if (stack !== undefined && stack.length === 0) entered.delete(port)
      if (instances !== undefined) for (const inst of instances) port.destroyInstance(inst)
    },
  }
}
