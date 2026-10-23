/// <reference types="vite/client" />
// V1 data in the browser: S12 assets and S13 courses bundled by Vite, render stand-ins and course dressing.
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

interface AssetEntry { path: string; folder: string; load: () => Promise<string> }

let gameAssets: GameAssetResolver | null = null

// One entry per file stem; a stem found twice refuses when resolved (ids are unique across assets/).
export function browserGameAssets(): GameAssetResolver {
  if (gameAssets !== null) return gameAssets
  const files = import.meta.glob<string>('../../../../assets/**/*.asset.json', { query: '?raw', import: 'default' })
  const entries = new Map<string, AssetEntry[]>()
  for (const key of Object.keys(files).sort()) {
    if (!key.startsWith(GLOB_PREFIX)) continue
    const path = key.slice(GLOB_PREFIX.length)
    const slash = path.lastIndexOf('/')
    const stem = path.slice(slash + 1, path.length - ASSET_SUFFIX.length)
    const folder = path.slice('assets/'.length, slash)
    const list = entries.get(stem) ?? []
    list.push({ path, folder, load: files[key] })
    entries.set(stem, list)
  }
  const cache = new Map<string, Promise<ResolvedGameAsset>>()

  async function load(id: string): Promise<ResolvedGameAsset> {
    const found = entries.get(id)
    if (found === undefined) {
      const ids = [...entries.keys()].sort()
      refuse('assets', `assets/*/${id}${ASSET_SUFFIX}`, `unknown asset id '${id}'; add the asset file or use one of: ${ids.join(', ') || '(none)'}`)
    }
    if (found.length > 1) {
      refuse('assets', found[1].path, `asset id '${id}' is also ${found[0].path}; ids are unique across assets/, rename one`)
    }
    const { path, folder } = found[0]
    const json: unknown = JSON.parse(await found[0].load())
    const asset = await parseGameAsset(json, path)
    if (asset.id !== id) refuse('assets', `${path}#/id`, `id '${asset.id}' does not match the file stem '${id}'; rename the file or the id`)
    if (asset.world !== folder) {
      refuse('assets', `${path}#/world`, `world '${asset.world}' does not match the folder '${folder}'; move the file to assets/${asset.world}/`)
    }
    return { asset, source: { path, json } }
  }

  gameAssets = {
    resolve(id: string): Promise<ResolvedGameAsset> {
      let p = cache.get(id)
      if (p === undefined) {
        p = load(id)
        cache.set(id, p)
      }
      return p
    },
  }
  return gameAssets
}

export interface V1Courses { courses: CourseV1[]; byId: ReadonlyMap<string, CourseV1> }

export async function loadV1Courses(onProgress: (p: LoadProgress) => void): Promise<V1Courses> {
  const files = import.meta.glob<string>('../../../../courses/*.course.json', { query: '?raw', import: 'default' })
  const keys = Object.keys(files).filter(k => k.startsWith(GLOB_PREFIX)).sort()
  const assets = browserGameAssets()
  const courses: CourseV1[] = []
  for (let i = 0; i < keys.length; i++) {
    const path = keys[i].slice(GLOB_PREFIX.length)
    const text = await files[keys[i]]()
    courses.push(await loadCourseV1(JSON.parse(text), path, assets))
    onProgress({ phase: 'courses', done: i + 1, total: keys.length, label: path })
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

// Decor is view only: instances on the port plus the course environment; leave removes what enter made.
export function v1Dressing(courses: readonly CourseV1[], prims: (id: string) => PrimsAsset): CourseDressing {
  const byId = new Map(courses.map(c => [c.id, c]))
  let instances: number[] = []
  return {
    enter(port: RenderPort, courseId: string): void {
      const course = byId.get(courseId)
      if (course === undefined) {
        refuse('content', `courses/${courseId}.course.json`, `unknown v1 course '${courseId}'; use one of: ${[...byId.keys()].sort().join(', ')}`)
      }
      const handles = new Map<string, number>()
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
      port.setEnvironment(course.environment)
    },
    leave(port: RenderPort): void {
      for (const inst of instances) port.destroyInstance(inst)
      instances = []
    },
  }
}
