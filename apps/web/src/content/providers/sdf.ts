// SDF content: the v1 courses, rendered from meshes the MAMA workers built through the SDF render port.
// The load reads courses and builds meshes only; the sim session never waits on or reads it (1.5).
import { attachRoundReport } from '@royal-fiesta/game/render/roundLoad'
import type { ContentProvider, CourseDressing, GameContent, LoadProgress, PodiumLayout } from '@royal-fiesta/game/content'
import { podiumLayoutOf, V0_ASSET_MAP } from '@royal-fiesta/game/courseV1'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort, RenderTarget, SkinPartT, SkinRigT } from '@royal-fiesta/game/render/port'
import type { SkinnedCharacter } from '@royal-fiesta/game/render/sceneView'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { MeshedAsset } from '../../sdf/mamaApi.ts'
import { createSdfPort } from '../../sdf/sdfPort.ts'
import { loadSdfContent } from '../sdfLoad.ts'
import { browserGameAssets, standInFrom, v1Dressing } from '../v1Data.ts'
import penguinGraph from '../../../../../assets/common/penguin.animgraph.json?raw'

const HUB_ID = 'hub-plaza'
const PODIUM_ID = 'podium'
const CHARACTER_ID = 'penguin.body'

interface Loaded {
  courses: CourseV1[]
  byId: ReadonlyMap<string, CourseV1>
  playlist: ResolvedCourse[]
  hub: ResolvedCourse
  podium: PodiumLayout
  meshed: Map<string, MeshedAsset>
  failed: ReadonlyMap<string, string>
  standIns: Map<string, PrimsAsset>
  report: Record<string, number | string | readonly string[]>
  skinned: SkinnedCharacter | null
}

function byIdOrder(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

class SdfContent implements GameContent {
  readonly id = 'sdf' as const
  private loaded: Loaded | null = null
  private onProgress: (p: LoadProgress) => void = () => {}

  // A missing MAMA refuses from loadSdfContent before any fetch; it never falls back to v1.
  async load(profile: ProfileName, onProgress: (p: LoadProgress) => void): Promise<void> {
    this.onProgress = onProgress
    const content = await loadSdfContent(profile, onProgress)
    const { all: courses, byId } = content.courses
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
    // Only the id reaches the mesh renderer. PodiumStage also needs the block bounds
    // to scale its platforms; retain that metadata without loading v0 primitives.
    const resolver = browserGameAssets()
    const standIns = new Map<string, PrimsAsset>()
    for (const id of [...content.meshed.keys(), ...content.failed.keys()].sort()) {
      const prims: PrimsAsset = {
        format: 'raa.prims', version: 0, id, name: id,
        budget: { triangles: 0, segments: 0 },
        nodes: [], materials: {}, anchors: {},
        collision: { mode: 'override', colliders: [] },
      }
      if (id === V0_ASSET_MAP['wall-block']) {
        const { asset } = await resolver.resolve(id)
        prims.nodes = standInFrom(asset, null).nodes
      }
      standIns.set(id, prims)
    }
    const skinned = await characterSkin(content.meshed.get(CHARACTER_ID), async () => (await resolver.resolve(CHARACTER_ID)).asset.document)
    this.loaded = { courses, byId, playlist, hub, podium: podiumLayoutOf(podiumCourse), meshed: content.meshed, failed: content.failed, standIns, report: content.report, skinned }
  }

  // The skinned character for SceneView (S18 skin and the S19 penguin graph); undefined keeps the rigid one.
  skinned(): SkinnedCharacter | undefined {
    return this.need('skinned').skinned ?? undefined
  }

  private need(what: string): Loaded {
    if (this.loaded === null) refuse('content', `sdf.${what}`, 'content is not loaded; await load() first')
    return this.loaded
  }

  playlist(): readonly ResolvedCourse[] {
    return this.need('playlist').playlist
  }

  course(id: string): ResolvedCourse {
    const loaded = this.need('course')
    const sim = loaded.byId.get(id)?.sim ?? null
    if (sim === null) {
      refuse('content', `sdf course '${id}'`, `unknown or view-only course; available: ${loaded.playlist.map(c => c.id).join(', ')}`)
    }
    return sim
  }

  hub(): ResolvedCourse {
    return this.need('hub').hub
  }

  podium(): PodiumLayout {
    return this.need('podium').podium
  }

  // An S12 asset id, or a v0 name the pages still use ('wall-block', 'bean').
  assets(name: string): PrimsAsset {
    const { standIns } = this.need('assets')
    const id = standIns.has(name) ? name : Object.hasOwn(V0_ASSET_MAP, name) ? V0_ASSET_MAP[name] : name
    const prims = standIns.get(id)
    if (prims === undefined) {
      refuse('content', `sdf asset '${name}'`, `unknown or unmeshed asset; available: ${[...standIns.keys()].join(', ')}`)
    }
    return prims
  }

  character(): PrimsAsset {
    return this.assets(CHARACTER_ID)
  }

  async createPort(target: RenderTarget): Promise<RenderPort> {
    const loaded = this.need('port')
    const start = performance.now()
    const port = await createSdfPort(target, loaded.meshed, loaded.failed, this.onProgress, span => {
      const history = loaded.report.bootTimeline
      loaded.report.bootTimeline = [...(Array.isArray(history) ? history : []), JSON.stringify(span)]
    })
    attachRoundReport(port, loaded.report)
    const end = performance.now()
    const history = loaded.report.bootTimeline
    loaded.report.bootTimeline = [...(Array.isArray(history) ? history : []), JSON.stringify({ step: 'RAA init / upload / shader warmup', start, end, ms: end - start })]
    return port
  }

  dressing(): CourseDressing {
    const loaded = this.need('dressing')
    return v1Dressing(loaded.courses, id => this.assets(id))
  }

  report(): Record<string, number | string | readonly string[]> {
    return this.need('report').report
  }
}

// The character's skin: the rig and clips of its document group, the joints and weights of its meshed parts
// (keyed like the render port keys parts), posed by assets/common/penguin.animgraph.json. Null when the meshed
// character carries no skin (meshed before skins were carried, or without a rig).
async function characterSkin(meshed: MeshedAsset | undefined, document: () => Promise<Record<string, unknown>>): Promise<SkinnedCharacter | null> {
  if (meshed === undefined) return null
  const payload = meshed.data as { groups: { group: string; parts: { partId: string; name: string; skin?: SkinPartT['skin'] }[] }[] }
  const parts: SkinPartT[] = []
  const keys = new Set<string>()
  for (const group of payload.groups) {
    for (const part of group.parts) {
      const key = keys.has(part.name) ? `${group.group}/${part.partId}` : part.name
      keys.add(key)
      if (part.skin !== undefined) parts.push({ name: key, skin: part.skin })
    }
  }
  if (parts.length === 0) return null
  const nodes = (await document()).nodes as Record<string, { rig?: SkinRigT; clips?: unknown[] }>
  const owner = Object.values(nodes).find(node => node.rig !== undefined)
  if (owner?.rig === undefined) return null
  return { assetId: CHARACTER_ID, skin: { rig: owner.rig, clips: owner.clips ?? [], parts }, graph: penguinGraph }
}

/** The content's skinned character, when it has one (SDF content with a meshed, rigged character). */
export function skinnedCharacterOf(content: GameContent): SkinnedCharacter | undefined {
  return content instanceof SdfContent ? content.skinned() : undefined
}

export const provider: ContentProvider = Object.freeze({
  id: 'sdf',
  priority: 2,
  create: (): GameContent => new SdfContent(),
})
