// Split screen: the RAA port draws one full-canvas viewport, so each local seat owns a port, a camera,
// a scene view and a far renderer. The ports belong to the caller and must already be initialised.
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { Planar } from '../client/cameraBasis.ts'
import type { CourseDressing } from '../content.ts'
import type { FarFeed } from '../net/farFeed.ts'
import type { ZoneMatch } from '../net/zoneMatch.ts'
import { FarRenderer } from './farRender.ts'
import { OrbitCamera } from './orbitCamera.ts'
import type { RenderPort, Viewport } from './port.ts'
import { SceneView } from './sceneView.ts'
import type { SkinnedCharacter } from './sceneView.ts'
import { SeatSceneSim } from './seatSceneSim.ts'

export interface SplitScreenOptions {
  /** One already-initialised full-canvas port per pane; ports.length === localSeats.length. */
  readonly ports: readonly RenderPort[]
  /** This peer's seat ids, one pane each (1..4). */
  readonly localSeats: readonly number[]
  readonly course: ResolvedCourse
  /** Seats in the whole match, so every character of a local domain has a scene view. */
  readonly seatCount: number
  readonly assets: (name: string) => PrimsAsset
  readonly bean: PrimsAsset
  readonly character?: PrimsAsset
  readonly skinned?: SkinnedCharacter
  readonly dressing?: CourseDressing
  /** The display-only far stream, shared by every pane's FarRenderer. */
  readonly feed: FarFeed
}

interface Pane {
  readonly port: RenderPort
  readonly adapter: SeatSceneSim
  readonly orbit: OrbitCamera
  readonly scene: SceneView
  readonly far: FarRenderer
}

/** Integer canvas rectangles in canvas pixels, origin top left; the last column/row takes the odd pixel. */
export function splitRects(count: number, width: number, height: number): Viewport[] {
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    refuse('render', 'splitRects', `${count} is outside 1..4; split screen shows 1 to 4 panes`)
  }
  if (!Number.isInteger(width) || width < 1) {
    refuse('render', 'splitRects', `width ${width} is not a positive integer; pass canvas pixels`)
  }
  if (!Number.isInteger(height) || height < 1) {
    refuse('render', 'splitRects', `height ${height} is not a positive integer; pass canvas pixels`)
  }
  if (count === 1) return [{ x: 0, y: 0, width, height }]
  const left = Math.floor(width / 2)
  const right = width - left
  const top = Math.floor(height / 2)
  const bottom = height - top
  if (count === 2) {
    return [
      { x: 0, y: 0, width: left, height },
      { x: left, y: 0, width: right, height },
    ]
  }
  const lower: Viewport[] = [
    { x: 0, y: top, width: left, height: bottom },
    { x: left, y: top, width: right, height: bottom },
  ]
  if (count === 3) return [{ x: 0, y: 0, width, height: top }, ...lower]
  return [
    { x: 0, y: 0, width: left, height: top },
    { x: left, y: 0, width: right, height: top },
    ...lower,
  ]
}

export class SplitScreenLayout {
  private readonly panes: Pane[]

  constructor(options: SplitScreenOptions) {
    const seats = options.localSeats
    if (seats.length < 1 || seats.length > 4) {
      refuse('render', 'SplitScreenLayout.localSeats', `${seats.length} panes is outside 1..4; pass one local seat per pane`)
    }
    if (options.ports.length !== seats.length) {
      refuse('render', 'SplitScreenLayout.ports', `has ${options.ports.length} ports for ${seats.length} local seats; pass one full-canvas port per pane`)
    }
    if (!Number.isInteger(options.seatCount) || options.seatCount < 1) {
      refuse('render', 'SplitScreenLayout.seatCount', `${options.seatCount} is not a positive integer; pass the match seat count`)
    }
    for (let i = 0; i < seats.length; i++) {
      if (!Number.isInteger(seats[i]) || seats[i] < 0 || seats[i] >= options.seatCount) {
        refuse('render', `SplitScreenLayout.localSeats/${i}`, `${seats[i]} is outside 0..${options.seatCount - 1}; pass this peer's seat ids`)
      }
    }
    const panes: Pane[] = []
    try {
      for (let i = 0; i < seats.length; i++) {
        const port = options.ports[i]
        const adapter = new SeatSceneSim(options.course, options.seatCount)
        const orbit = new OrbitCamera()
        orbit.reset(0)
        const scene = new SceneView({
          port, viewport: 0, localPlayer: seats[i], assets: options.assets, bean: options.bean,
          character: options.character ?? options.bean, skinned: options.skinned, dressing: options.dressing,
          camera: (focus, dt, clip) => orbit.pose(focus, dt, clip),
        })
        const far = new FarRenderer({
          port, bean: options.bean, feed: options.feed,
          holdsLocalSeat: seat => adapter.holdsSeat(seat),
        })
        panes.push({ port, adapter, orbit, scene, far })
      }
    } catch (error) {
      for (let i = 0; i < panes.length; i++) {
        panes[i].far.dispose()
        panes[i].scene.dispose()
      }
      throw error
    }
    this.panes = panes
  }

  /** Refreshes each pane from the same match tick, then draws that pane's near scene and far rows. */
  update(match: ZoneMatch, alpha: number, dtS: number): void {
    const tick = match.stats.tick
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i]
      pane.adapter.refresh(match.domains, tick)
      pane.scene.update(pane.adapter as unknown as MatchSim, null, alpha, dtS)
      pane.far.update(tick)
    }
  }

  render(): void {
    for (let i = 0; i < this.panes.length; i++) this.panes[i].port.render()
  }

  /** Ground forward of pane i, for controlsToInput. */
  facing(i: number): Planar {
    return this.panes[i].orbit.ground()
  }

  /** Pane i's look stick; sensitivity 1 and no Y inversion, as the local client uses it. */
  look(i: number, x: number, y: number, dtS: number): void {
    this.panes[i].orbit.stick(x, y, dtS, 1, false)
  }

  /** Settles once every pane's characters finished loading their animation. */
  ready(): Promise<void> {
    return Promise.all(this.panes.map(pane => pane.scene.animationReady())).then(() => {})
  }

  /** Disposes the pane views; the caller keeps ownership of the ports. */
  dispose(): void {
    for (let i = 0; i < this.panes.length; i++) {
      this.panes[i].far.dispose()
      this.panes[i].scene.dispose()
    }
    this.panes.length = 0
  }
}
