import { startSceneOf, startSceneId } from '@royal-fiesta/game/startScene'
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
import { createSdfPort, gameRenderOptions } from '../../sdf/sdfPort.ts'
import type { GameRenderOptions, ResizablePort, ShadingMode, ShadingReport } from '../../sdf/sdfPort.ts'
import { loadGraphicsContract, GraphicsSettings } from '../../game/graphicsSettings.ts'
import type { SettingsStore } from '@royal-fiesta/game/screens/settings'
import { renderOptions } from '../../render/renderOptions.ts'
import { bakeTextures, loadSdfContent } from '../sdfLoad.ts'
import { mountShadingStatus } from '../shadingStatus.ts'
import { browserGameAssets, standInFrom, v1Dressing } from '../v1Data.ts'
import { registerCosmeticSkins } from '../cosmeticSkin.ts'
import penguinGraph from '../../../../../assets/common/penguin.animgraph.json?raw'

const HUB_ID = 'hub-plaza'
const PODIUM_ID = 'podium'
const CHARACTER_ID = 'penguin.body'

// The load report carries one structured value: the port's shading report under `normals`.
type ReportValue = number | string | readonly string[] | ShadingReport

interface Loaded {
  courses: CourseV1[]
  byId: ReadonlyMap<string, CourseV1>
  playlist: ResolvedCourse[]
  hub: ResolvedCourse | null
  podium: PodiumLayout | null
  meshed: Map<string, MeshedAsset>
  failed: ReadonlyMap<string, string>
  standIns: Map<string, PrimsAsset>
  report: Record<string, ReportValue>
  skinned: SkinnedCharacter | null
}

const SHADING_MODES: readonly ShadingMode[] = ['field', 'vertex', 'baked']
function isShading(value: unknown): value is ShadingMode {
  return SHADING_MODES.includes(value as ShadingMode)
}

// Site storage can be refused in a third-party frame: keep the options in memory for this visit, as main.ts does.
function pageStore(): SettingsStore {
  try {
    const storage = globalThis.localStorage
    storage.getItem('royal-fiesta')
    return storage
  } catch {
    const saved = new Map<string, string>()
    return { getItem: key => saved.get(key) ?? null, setItem: (key, value) => void saved.set(key, value) }
  }
}

// The Graphics page's saved choice (GRAPHICS_KEY, read through the MAMA contract and its legacy aliases).
async function storedShading(): Promise<ShadingMode | undefined> {
  try {
    const contract = await loadGraphicsContract()
    if (contract === null) return undefined
    const page = new GraphicsSettings(pageStore(), () => {})
    page.attach(contract)
    const shading = page.options.shading
    return isShading(shading) ? shading : undefined
  } catch {
    return undefined
  }
}

// The effective port options: the live Graphics choice (or the saved one before the page attaches) plus the address.
async function effectiveOptions(): Promise<Partial<GameRenderOptions> | undefined> {
  const live = renderOptions().shading
  const shading = isShading(live) ? live : await storedShading()
  if (shading === undefined) return undefined
  const search = typeof location === 'undefined' ? '' : location.search
  return gameRenderOptions(search, { shading })
}

function byIdOrder(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export class SdfContent implements GameContent {
  private readonly courseId?: string
  constructor(courseId?: string) { this.courseId = courseId }
  readonly id = 'sdf' as const
  private loaded: Loaded | null = null
  private onProgress: (p: LoadProgress) => void = () => {}
  // One content can feed several ports (one per seat); every live port gets the same shading choice and baked textures.
  private readonly ports: ResizablePort[] = []
  private removeStatus: (() => void) | null = null
  private shading: ShadingMode = 'field'
  private readonly baked = new Map<string, MeshedAsset>()
  private readonly bakeQueue: string[] = []
  private readonly baking = new Set<string>()

  // A missing MAMA refuses from loadSdfContent before any fetch; it never falls back to v1.
  async load(profile: ProfileName, onProgress: (p: LoadProgress) => void): Promise<void> {
    this.onProgress = onProgress
    const content = await loadSdfContent(profile, onProgress, this.courseId)
    const { all: courses, byId } = content.courses
    const playlist: ResolvedCourse[] = []
    for (const c of courses) {
      if ((c.kind === 'race' || c.kind === 'survival') && c.sim !== null && c.sim.profiles.includes(profile)) playlist.push(c.sim)
    }
    playlist.sort(byIdOrder)
    const hubs = courses.filter(c => c.kind === 'hub')
    if (this.courseId === undefined && hubs.length !== 1) {
      refuse('content', 'courses/*.course.json', `expected exactly one kind hub course, found ${hubs.length} (${hubs.map(c => c.id).join(', ') || 'none'}); keep courses/${HUB_ID}.course.json as the only hub`)
    }
    const hub = hubs[0]?.sim ?? null
    if (this.courseId === undefined && hub === null) refuse('content', `courses/${hubs[0].id}.course.json`, 'the hub course has no sim course; fix the hub course')
    const podiumCourse = byId.get(PODIUM_ID)
    if (this.courseId === undefined && (podiumCourse === undefined || podiumCourse.kind !== 'podium')) {
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
    this.loaded = { courses, byId, playlist, hub, podium: podiumCourse === undefined ? null : podiumLayoutOf(podiumCourse), meshed: content.meshed, failed: content.failed, standIns, report: content.report, skinned }
  }

  meshData(): Pick<Loaded, 'meshed' | 'failed'> { return this.need('meshes') }

  /** Expected instance parts come from the level, independently of the renderer's uploads. */
  captureLevel(id: string): { parts: string[]; assets: string[]; instances: number } {
    const loaded = this.need('capture level')
    const course = loaded.byId.get(id)
    if (!course?.sim) throw new Error(`fieldShading: missing level ${id}`)
    const sim = course.sim
    const placements = [...course.decor, ...sim.obstacles, ...(sim.mechanisms?.items ?? [])]
    const parts: string[] = []
    for (const place of placements) {
      const mesh = loaded.meshed.get(place.asset)
      if (!mesh) throw new Error(`fieldShading: missing ${place.asset}: ${loaded.failed.get(place.asset) ?? 'not loaded'}`)
      const payload = mesh.data as { groups: { group: string; parts: {
        partId: string; meshes: { positions: Float32Array }[]
      }[] }[] }
      for (const group of payload.groups) for (const part of group.parts) {
        if (part.meshes.some(m => m.positions.length > 0)) parts.push(`${place.asset}#${group.group}/${part.partId}`)
      }
    }
    console.info(`[fieldShading] ${id}: ${placements.length} authored instances, ${parts.length} authored parts; ` +
      `${sim.obstacles.length} obstacles, ${course.decor.length} decorations, ${sim.mechanisms?.items.length ?? 0} mechanisms`)
    return { parts, assets: [...new Set(placements.map(p => p.asset))], instances: placements.length }
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
    const hub = this.need('hub').hub
    if (hub === null) refuse('content', 'hub', 'round content has no hub')
    return hub
  }

  startScene(season: number | string) {
    const course = this.need('start').byId.get(startSceneId(season))
    if (!course) return refuse('content', `start-season${season}`, 'missing season start scene')
    return startSceneOf(course)
  }

  podium(): PodiumLayout {
    const podium = this.need('podium').podium
    if (podium === null) refuse('content', 'podium', 'round content has no podium')
    return podiumLayoutOf(this.need('podium').byId.get(PODIUM_ID)!, id => this.assets(id))
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

  async createPort(target: RenderTarget, overrides?: Partial<GameRenderOptions>, assetIds?: readonly string[]): Promise<RenderPort> {
    const loaded = this.need('port')
    const start = performance.now()
    const options = { ...await effectiveOptions(), ...overrides }
    const meshed = assetIds === undefined ? loaded.meshed : new Map([...loaded.meshed].filter(([id]) => assetIds.includes(id)))
    const port = await createSdfPort(target, meshed, loaded.failed, this.onProgress, span => {
      const history = loaded.report.bootTimeline
      loaded.report.bootTimeline = [...(Array.isArray(history) ? history : []), JSON.stringify(span)]
    }, undefined, options)
    this.ports.push(port)
    if (options?.shading !== undefined) this.shading = options.shading
    if (this.shading !== 'field') port.setShading(this.shading)
    for (const [id, meshed] of this.baked) port.addTextured(id, meshed)
    this.removeStatus ??= mountShadingStatus({
      report: () => this.ports[0]?.shadingReport() ?? { pending: 0, failed: 0, vertex: 0, errors: [] },
      bakesLeft: () => this.bakesLeft(),
      mode: () => this.shading,
    })
    if (this.shading === 'baked') this.requestTextures()
    await this.registerCosmetics(port, meshed)
    attachRoundReport(port, loaded.report as Record<string, number | string | readonly string[]>)
    const end = performance.now()
    const history = loaded.report.bootTimeline
    loaded.report.bootTimeline = [...(Array.isArray(history) ? history : []), JSON.stringify({ step: 'RAA init / upload / shader warmup', start, end, ms: end - start })]
    const dispose = port.dispose.bind(port)
    port.dispose = () => {
      const at = this.ports.indexOf(port)
      if (at >= 0) this.ports.splice(at, 1)
      if (this.ports.length === 0) {
        this.removeStatus?.()
        this.removeStatus = null
      }
      dispose()
    }
    return port
  }

  /** The Graphics shading choice, applied live: 'baked' first asks the workers for the baked textures of every asset. */
  setShading(mode: ShadingMode): void {
    this.shading = mode
    if (mode === 'baked') this.requestTextures()
    for (const port of this.ports) port.setShading(mode)
  }

  private bakesLeft(): number {
    return this.bakeQueue.length + this.baking.size
  }

  private requestTextures(): void {
    const loaded = this.loaded
    if (loaded === null) return
    for (const id of [...loaded.meshed.keys()].sort()) {
      if (this.baked.has(id) || this.baking.has(id) || this.bakeQueue.includes(id)) continue
      this.bakeQueue.push(id)
    }
    this.pumpBakes()
  }

  // At most two worker bakes at a time; each result is uploaded to every live port as it arrives.
  private pumpBakes(): void {
    while (this.baking.size < 2 && this.bakeQueue.length > 0) {
      const id = this.bakeQueue.shift()!
      this.baking.add(id)
      void (async () => {
        try {
          const asset = (await browserGameAssets().resolve(id)).asset
          const meshed = await bakeTextures(asset)
          this.baked.set(id, meshed)
          for (const port of this.ports) port.addTextured(id, meshed)
        } catch (e) {
          console.warn(`[content] baked textures for ${id} are not drawn: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          this.baking.delete(id)
          this.pumpBakes()
        }
      })()
    }
  }

  /** Registers the skinned cosmetics of `meshed` on `port`; every port that draws worn cosmetics needs it. */
  async registerCosmetics(port: RenderPort, meshed: ReadonlyMap<string, MeshedAsset>): Promise<number> {
    const skinned = this.need('port').skinned
    if (!skinned) return 0
    const resolver = browserGameAssets()
    return registerCosmeticSkins(port, meshed, skinned.skin.rig, async id => (await resolver.resolve(id)).asset.document, CHARACTER_ID)
  }

  dressing(): CourseDressing {
    const loaded = this.need('dressing')
    return v1Dressing(loaded.courses, id => this.assets(id))
  }

  report(): Record<string, number | string | readonly string[]> {
    const loaded = this.need('report')
    const port = this.ports[0]
    if (port !== undefined) loaded.report.normals = port.shadingReport()
    return loaded.report as Record<string, number | string | readonly string[]>
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
