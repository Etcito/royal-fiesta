import { pixelViewports, splitLayout } from '@royal-fiesta/game/client/splitLayout'
import type { WornLook } from '@royal-fiesta/game/render/wornLook'
// One networked ZoneMatch drawn by this page: the match itself is created by the caller over a real
// transport and passed in on every update. Seats in this peer's local domains are near (SceneView);
// every other seat comes from the display-only FAR stream, posed by the same SceneView. The match is never
// simulated here and is never disposed here: the caller owns it.
import type { CourseDressing } from '@royal-fiesta/game/content'
import { FarFeed } from '@royal-fiesta/game/net/farFeed'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { renderFrame } from '@royal-fiesta/game/render/roundLoad'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { CostumeSet, SkinnedCharacter } from '@royal-fiesta/game/render/sceneView'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort, RenderTarget } from '@royal-fiesta/game/render/port'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { DomainSceneSim } from './domainSceneSim.ts'
import { browserAssetResolver, preloadAssets } from '../client/sources.ts'

export interface ZoneNetSceneOptions {
  canvas: HTMLCanvasElement
  /** One followed round seat per local human viewport. */
  followSeats?: number[]
  /** Shared with the input owner; standalone zone viewers may own their camera. */
  orbit?: OrbitCamera
  width?: number
  height?: number
  /** The resolved course the networked match plays. */
  course: ResolvedCourse
  /** Builds the render port, normally zoneContent('sprint').createPort. */
  createPort: (target: RenderTarget) => Promise<RenderPort>
  /** Fixture asset lookup; defaults to preloadAssets([course], browserAssetResolver()). */
  assets?: (name: string) => PrimsAsset
  /** The full normal-match character asset for SceneView. */
  character?: PrimsAsset
  /** SceneView's fallback asset; assets('bean') when absent. */
  bean?: PrimsAsset
  /** Normal-match skin and animation graph for all characters. */
  skinned?: SkinnedCharacter
  look?: () => WornLook | null
  costumes?: CostumeSet
  wardrobe?: (player: number) => CostumeSet | null | undefined
  dressing?: CourseDressing
  /** Only the large single-world offline show opts into presentation culling. */
  crowdCull?: boolean
}

/** A scene whose assets and render port are ready; attach() then builds the rest synchronously. */
export interface PreparedZoneNetScene {
  /**
   * seatCount: all seats of the networked match (seats in local domains are drawn near); firstLocalSeat: the first
   * seat this machine owns, which the camera follows. Call once, after the room is matched.
   */
  attach(seatCount: number, firstLocalSeat: number): ZoneNetScene
  /** Releases the port when the scene is never attached. */
  dispose(): void
}

export interface ZoneNetScene {
  /** Pass as farSink to createZoneMatch before it is constructed. */
  readonly cameras: readonly SceneView['camera'][]
  readonly camera: SceneView['camera']
  readonly feed: FarFeed
  /** Refreshes the near adapter from the match, then the character scene. */
  update(match: ZoneMatch, alpha: number, dtS: number): void
  render(): void
  /** Settles once the near characters' animation finished loading (they draw at rest until then). */
  ready(): Promise<void>
  capture(): Promise<Uint8Array | null>
  /** Releases the character scene and the port; the match belongs to the caller. */
  dispose(): void
}

/**
 * Loads the assets and creates the render port, the slow part of mounting (RAA engine creation is serialized per
 * page). A zone peer runs it before it queues: once the room is matched the other peers are already simulating, and
 * a peer that sends nothing for lostAfterMs (3 s) is dropped by some of them and not by others.
 */
export async function prepareZoneNetScene(options: ZoneNetSceneOptions): Promise<PreparedZoneNetScene> {
  const assets = options.assets ?? await preloadAssets([options.course], browserAssetResolver())
  const bean = options.bean ?? assets('bean')
  const character = options.character ?? bean

  const width = Math.max(1, options.width ?? options.canvas.width)
  const height = Math.max(1, options.height ?? options.canvas.height)
  const target: RenderTarget = {
    canvas: options.canvas, width, height, viewports: pixelViewports(splitLayout(options.followSeats?.length ?? 1, false), width, height, 1),
  }
  const port = await options.createPort(target)
  let attached = false
  return {
    attach(seatCount, firstLocalSeat) {
      if (attached) throw new Error('[zone] prepareZoneNetScene: attach() was already called')
      attached = true
      return attachScene(options, port, assets, bean, character, seatCount, firstLocalSeat)
    },
    dispose() {
      if (attached) return
      attached = true
      port.dispose()
    },
  }
}

function attachScene(options: ZoneNetSceneOptions, port: RenderPort, assets: (name: string) => PrimsAsset,
  bean: PrimsAsset, character: PrimsAsset, seatCount: number, localSeat: number): ZoneNetScene {
  const feed = new FarFeed()
  const adapter = new DomainSceneSim(options.course, seatCount)
  const orbit = options.orbit ?? new OrbitCamera()
  orbit.reset(0)
  const layout = splitLayout(options.followSeats?.length ?? 1, false)
  const scenes = (options.followSeats ?? [localSeat]).map((seat, viewport) => new SceneView({
    port, viewport, localPlayer: seat, assets, bean,
    character, skinned: options.skinned, dressing: options.dressing,
    crowdAspect: options.crowdCull ? () => {
      const cell = layout[viewport]
      return (options.canvas.width / options.canvas.height) * cell.width / cell.height
    } : undefined,
    look: options.look, costumes: options.costumes, wardrobe: options.wardrobe,
    // Third-person orbit around the local seat, so the near pack and nearby far rows stay in frame.
    camera: viewport === 0 ? (focus, dt, clip) => orbit.pose(focus, dt, clip) : undefined,
  }))
  const scene = scenes[0]
  let disposed = false
  let latest: ZoneMatch | null = null

  const render = (): void => { if (!disposed) renderFrame(port, () => port.render()) }
  return {
    get cameras() { return scenes.map(pane => pane.camera) },
    get camera() { return scene.camera },
    feed,
    update(match, alpha, dtS) {
      if (disposed) return
      latest = match
      adapter.refresh(match.domains, match.stats.tick, feed)
      for (const pane of scenes) pane.update(adapter as unknown as MatchSim, null, alpha, dtS)
    },
    render,
    async ready() {
      // update() may have returned at the loading-paint gate before creating any instances.
      // Do not release the show's simulation until that gate, animation and first render finish.
      while (!disposed && scenes.some(pane => pane.loadedCourse !== options.course)) {
        if (latest === null) return
        adapter.refresh(latest.domains, latest.stats.tick, feed)
        for (const pane of scenes) pane.update(adapter as unknown as MatchSim, null, 1, 0)
        if (scenes.some(pane => pane.loadedCourse !== options.course)) await new Promise<void>(resolve => setTimeout(resolve, 1))
      }
      if (disposed) return
      await Promise.all(scenes.map(pane => pane.animationReady()))
      render()
    },
    capture: () => disposed ? Promise.resolve(null) : port.capture(),
    dispose() {
      if (disposed) return
      disposed = true
      for (const pane of scenes) pane.dispose()
      port.dispose()
    },
  }
}
