// One networked ZoneMatch drawn by this page: the match itself is created by the caller over a real
// transport and passed in on every update. Seats in this peer's local domains are near (SceneView);
// every other seat comes from the display-only FAR stream (FarFeed/FarRenderer). The match is never
// simulated here and is never disposed here: the caller owns it.
import type { CourseDressing } from '@royal-fiesta/game/content'
import { FarFeed } from '@royal-fiesta/game/net/farFeed'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import { FarRenderer } from '@royal-fiesta/game/render/farRender'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { SkinnedCharacter } from '@royal-fiesta/game/render/sceneView'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort, RenderTarget } from '@royal-fiesta/game/render/port'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchSim, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import type { BodyRef, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import type { Pose } from '@royal-fiesta/sim/vec'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { browserAssetResolver, preloadAssets } from '../client/sources.ts'

export interface ZoneNetSceneOptions {
  canvas: HTMLCanvasElement
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
  /** The asset FarRenderer draws (and SceneView's fallback); assets('bean') when absent. */
  bean?: PrimsAsset
  /** Normal-match skin and animation graph for the near characters. */
  skinned?: SkinnedCharacter
  dressing?: CourseDressing
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
  readonly feed: FarFeed
  /** Refreshes the near adapter from the match, then the near scene and the far renderer. */
  update(match: ZoneMatch, alpha: number, dtS: number): void
  render(): void
  /** Settles once the near characters' animation finished loading (they draw at rest until then). */
  ready(): Promise<void>
  capture(): Promise<Uint8Array | null>
  /** Releases the far renderer, the near scene and the port; the match belongs to the caller. */
  dispose(): void
}

// Copied from apps/web/src/zone/zoneView.ts (M4, private DomainSceneSim): SceneView reads a
// MatchSim-shaped view, so roster seats are mapped onto the local peer's domains and a seat in no
// local domain is parked, which hides it in SceneView and leaves it to FarRenderer.
class DomainSceneSim {
  tick = 0
  readonly setup: { playerCount: number }
  private readonly courseData: ResolvedCourse
  private readonly seatDomain: (FiestaDomain | undefined)[]
  private readonly state: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: -1,
  }
  private reference: FiestaDomain | null = null

  constructor(course: ResolvedCourse, seatCount: number) {
    this.courseData = course
    this.setup = { playerCount: seatCount }
    this.seatDomain = new Array<FiestaDomain | undefined>(seatCount).fill(undefined)
  }

  refresh(domains: readonly FiestaDomain[], tick: number): void {
    this.seatDomain.fill(undefined)
    this.reference = null
    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i]
      if (this.reference === null) this.reference = domain
      const seats = domain.seats
      for (let s = 0; s < seats.length; s++) {
        const seat = seats[s]
        if (seat >= 0 && seat < this.seatDomain.length) this.seatDomain[seat] = domain
      }
    }
    this.tick = tick
  }

  holdsSeat(seat: number): boolean {
    return seat >= 0 && seat < this.seatDomain.length && this.seatDomain[seat] !== undefined
  }

  phase(out: MatchViewState): MatchViewState {
    out.tick = this.tick
    out.phase = Phase.playing
    out.courseIndex = 0
    return out
  }

  course(): ResolvedCourse {
    return this.courseData
  }

  character(p: number, out: CharacterView): CharacterView {
    const domain = this.seatDomain[p]
    if (domain === undefined) {
      out.pos.x = 0; out.pos.y = 0; out.pos.z = 0
      out.vel.x = 0; out.vel.y = 0; out.vel.z = 0
      out.facing.x = 0; out.facing.z = 1
      out.mode = CharMode.parked
      out.status = 0
      out.parked = true
      out.teleportTick = -1
      return out
    }
    const state = domain.state(p, this.state)
    out.pos.x = state.pos.x; out.pos.y = state.pos.y; out.pos.z = state.pos.z
    out.vel.x = state.vel.x; out.vel.y = state.vel.y; out.vel.z = state.vel.z
    out.facing.x = state.facing.x; out.facing.z = state.facing.z
    out.mode = state.mode
    out.status = domain.status(p)
    out.parked = state.mode === CharMode.parked
    out.teleportTick = state.teleportTick
    return out
  }

  obstacleCount(): number {
    return this.courseData.obstacles.length
  }

  obstacleSpec(i: number): ObstacleSpec {
    return this.courseData.obstacles[i]
  }

  obstaclePose(i: number, out: Pose): Pose {
    const domain = this.reference
    if (domain === null) return motionPose(this.courseData.obstacles[i], 0, 0, out)
    return domain.obstacles.pose(i, domain.tick, out)
  }

  // SceneView builds one instance per mechanism body from the item list (MatchSim has the same two calls).
  mechanismItemCount(): number {
    return this.reference?.mechanisms.spec()?.items.length ?? 0
  }

  mechanismItem(i: number): MechItem {
    const item = this.reference?.mechanisms.spec()?.items[i]
    if (item === undefined) throw new Error(`no mechanism item ${i}; pass a loaded item index`)
    return item
  }

  mechanismBodyPose(ref: BodyRef, out: Pose): boolean {
    const domain = this.reference
    return domain !== null && domain.mechanisms.bodyPose(domain.ctx, ref, out)
  }

  mechanismEvents(fromTick: number, out: MechEvent[]): number {
    const domain = this.reference
    return domain === null ? 0 : domain.mechanisms.events(fromTick, out)
  }

  signal(id: string): boolean {
    const domain = this.reference
    return domain !== null && domain.mechLogic.signal(id)
  }

  // SceneView wraps step() to observe each simulation tick; the zone session steps its own domains.
  step(_inputs: readonly PlayerInput[]): void {}
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
    canvas: options.canvas, width, height, viewports: [{ x: 0, y: 0, width, height }],
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
  const orbit = new OrbitCamera()
  orbit.reset(0)
  const scene = new SceneView({
    port, viewport: 0, localPlayer: localSeat, assets, bean,
    character, skinned: options.skinned, dressing: options.dressing,
    // Third-person orbit around the local seat, so the near pack and nearby far rows stay in frame.
    camera: (focus, dt, clip) => orbit.pose(focus, dt, clip),
  })
  const far = new FarRenderer({
    port, bean, feed, holdsLocalSeat: seat => adapter.holdsSeat(seat),
  })
  let disposed = false

  return {
    feed,
    update(match, alpha, dtS) {
      if (disposed) return
      adapter.refresh(match.domains, match.stats.tick)
      scene.update(adapter as unknown as MatchSim, null, alpha, dtS)
      far.update(match.stats.tick)
    },
    render: () => { if (!disposed) port.render() },
    ready: () => scene.animationReady(),
    capture: () => disposed ? Promise.resolve(null) : port.capture(),
    dispose() {
      if (disposed) return
      disposed = true
      far.dispose()
      scene.dispose()
      port.dispose()
    },
  }
}
