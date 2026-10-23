// V1 content: S13 courses and S12 assets from the repository, rendered with dev stand-ins (no MAMA).
import type { ContentProvider, CourseDressing, GameContent, LoadProgress, PodiumLayout } from '@royal-fiesta/game/content'
import { podiumLayoutOf, V0_ASSET_MAP } from '@royal-fiesta/game/courseV1'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort, RenderTarget } from '@royal-fiesta/game/render/port'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import { createRaaPort } from '../../render/raaPort.ts'
import { raaStatus } from '../../render/raaStatus.ts'
import { browserGameAssets, loadV1Courses, standInPrims, v1Dressing } from '../v1Data.ts'

const HUB_ID = 'hub-plaza'
const PODIUM_ID = 'podium'
const CHARACTER_ID = 'penguin.body'

interface Loaded {
  courses: CourseV1[]
  byId: ReadonlyMap<string, CourseV1>
  playlist: ResolvedCourse[]
  hub: ResolvedCourse
  podium: PodiumLayout
  standIns: Map<string, PrimsAsset>
}

function byIdOrder(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

class V1Content implements GameContent {
  readonly id = 'v1' as const
  private loaded: Loaded | null = null

  async load(profile: ProfileName, onProgress: (p: LoadProgress) => void): Promise<void> {
    const { courses, byId } = await loadV1Courses(onProgress)
    const playlist: ResolvedCourse[] = []
    for (const c of courses) {
      if ((c.kind === 'race' || c.kind === 'survival') && c.sim !== null && c.sim.profiles.includes(profile)) playlist.push(c.sim)
    }
    playlist.sort(byIdOrder)
    const hubs = courses.filter(c => c.kind === 'hub')
    if (hubs.length !== 1) {
      refuse('content', 'courses/*.course.json', `expected exactly one kind hub course, found ${hubs.length} (${hubs.map(c => c.id).join(', ') || 'none'}); keep courses/${HUB_ID}.course.json as the only hub`)
    }
    const hub = hubs[0].sim
    if (hub === null) refuse('content', `courses/${hubs[0].id}.course.json`, 'the hub course has no sim course; fix the hub course')
    const podiumCourse = byId.get(PODIUM_ID)
    if (podiumCourse === undefined || podiumCourse.kind !== 'podium') {
      refuse('content', `courses/${PODIUM_ID}.course.json`, `no kind podium course '${PODIUM_ID}'; add courses/${PODIUM_ID}.course.json`)
    }
    const podium = podiumLayoutOf(podiumCourse)

    const ids = new Set<string>([CHARACTER_ID])
    for (const c of courses) for (const id of c.assetIds) ids.add(id)
    const sorted = [...ids].sort()
    const resolver = browserGameAssets()
    const standIns = new Map<string, PrimsAsset>()
    for (const id of sorted) {
      const { asset } = await resolver.resolve(id)
      standIns.set(id, standInPrims(asset))
    }
    this.loaded = { courses, byId, playlist, hub, podium, standIns }
    onProgress({ phase: 'done', done: sorted.length, total: sorted.length, label: 'V1 courses' })
  }

  private need(what: string): Loaded {
    if (this.loaded === null) refuse('content', `v1.${what}`, 'content is not loaded; await load() first')
    return this.loaded
  }

  playlist(): readonly ResolvedCourse[] {
    return this.need('playlist').playlist
  }

  course(id: string): ResolvedCourse {
    const loaded = this.need('course')
    const sim = loaded.byId.get(id)?.sim ?? null
    if (sim === null) {
      refuse('content', `v1 course '${id}'`, `unknown or view-only course; available: ${loaded.playlist.map(c => c.id).join(', ')}`)
    }
    return sim
  }

  hub(): ResolvedCourse {
    return this.need('hub').hub
  }

  podium(): PodiumLayout {
    return this.need('podium').podium
  }

  // An asset id, or a v0 name the M1 pages still use ('wall-block', 'bean').
  assets(name: string): PrimsAsset {
    const { standIns } = this.need('assets')
    const id = standIns.has(name) ? name : Object.hasOwn(V0_ASSET_MAP, name) ? V0_ASSET_MAP[name] : name
    const prims = standIns.get(id)
    if (prims === undefined) {
      refuse('content', `v1 asset '${name}'`, `unknown asset; available: ${[...standIns.keys()].join(', ')}`)
    }
    return prims
  }

  character(): PrimsAsset {
    return this.assets(CHARACTER_ID)
  }

  // No silent null-port fallback: a missing RAA is the page's refusal.
  async createPort(target: RenderTarget): Promise<RenderPort> {
    const status = await raaStatus()
    if (!status.available) refuse('render', 'raa', status.reason)
    const port = await createRaaPort()
    await port.init(target)
    return port
  }

  dressing(): CourseDressing {
    const loaded = this.need('dressing')
    return v1Dressing([...loaded.byId.values()], id => this.assets(id))
  }

  report(): Record<string, number | string | readonly string[]> {
    const loaded = this.need('report')
    return {
      content: 'v1',
      courses: loaded.playlist.length,
      courseIds: loaded.playlist.map(c => c.id),
      assets: loaded.standIns.size,
      standIns: loaded.standIns.size,
      podium: PODIUM_ID,
      hub: HUB_ID,
    }
  }
}

export const provider: ContentProvider = Object.freeze({
  id: 'v1',
  priority: 1,
  create: (): GameContent => new V1Content(),
})
