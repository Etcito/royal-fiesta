// V0 content: fixture courses and prims assets, the bean as character, rendered by RAA.
import type { AssetResolver } from '@royal-fiesta/game/assets'
import { loadCourse } from '@royal-fiesta/game/course'
import { NO_DRESSING } from '@royal-fiesta/game/content'
import type { ContentProvider, CourseDressing, GameContent, LoadProgress, PodiumLayout } from '@royal-fiesta/game/content'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort, RenderTarget } from '@royal-fiesta/game/render/port'
import { PODIUM_V0_LAYOUT } from '@royal-fiesta/game/render/podiumStage'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import plazaJson from '../../../../../fixtures/courses/hub-plaza.course.json?raw'
import { browserAssetResolver, browserCourses, preloadAssets } from '../../client/sources.ts'
import { createRaaPort } from '../../render/raaPort.ts'
import { raaStatus } from '../../render/raaStatus.ts'

const PLAZA_PATH = 'fixtures/courses/hub-plaza.course.json'

interface Loaded {
  courses: ResolvedCourse[]
  hub: ResolvedCourse
  lookup: (name: string) => PrimsAsset
  names: string[]
}

function namesOf(courses: readonly ResolvedCourse[]): string[] {
  const names = ['bean']
  for (const c of courses) {
    for (const o of c.obstacles) if (!names.includes(o.asset)) names.push(o.asset)
  }
  return names
}

class V0Content implements GameContent {
  readonly id = 'v0' as const
  private loaded: Loaded | null = null

  async load(profile: ProfileName, onProgress: (p: LoadProgress) => void): Promise<void> {
    onProgress({ phase: 'courses', done: 0, total: 1, label: 'V0 fixtures' })
    const resolver: AssetResolver = browserAssetResolver()
    const courses = await browserCourses(profile)
    const hub = await loadCourse(JSON.parse(plazaJson), PLAZA_PATH, resolver)
    const lookup = await preloadAssets([...courses, hub], resolver)
    this.loaded = { courses, hub, lookup, names: namesOf([...courses, hub]) }
    onProgress({ phase: 'done', done: 1, total: 1, label: 'V0 fixtures' })
  }

  private need(what: string): Loaded {
    if (this.loaded === null) refuse('content', `v0.${what}`, 'content is not loaded; await load() first')
    return this.loaded
  }

  playlist(): readonly ResolvedCourse[] {
    return this.need('playlist').courses
  }

  course(id: string): ResolvedCourse {
    const loaded = this.need('course')
    const course = loaded.courses.find(c => c.id === id)
    if (course === undefined) {
      refuse('content', `v0 course '${id}'`, `unknown course; available: ${loaded.courses.map(c => c.id).join(', ')}`)
    }
    return course
  }

  hub(): ResolvedCourse {
    return this.need('hub').hub
  }

  podium(): PodiumLayout {
    return PODIUM_V0_LAYOUT
  }

  assets(name: string): PrimsAsset {
    return this.need('assets').lookup(name)
  }

  character(): PrimsAsset {
    return this.need('character').lookup('bean')
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
    return NO_DRESSING
  }

  report(): Record<string, number | string | readonly string[]> {
    const loaded = this.need('report')
    return {
      content: 'v0',
      courses: loaded.courses.length,
      courseIds: loaded.courses.map(c => c.id),
      assets: loaded.names.length,
    }
  }
}

export const provider: ContentProvider = Object.freeze({
  id: 'v0',
  priority: 0,
  create: (): GameContent => new V0Content(),
})
