// The podium screen's stage: three blocks and the top 3 beans, placed from a PodiumLayout, plus name anchors.
// View side only: the sim freezes the winners at course spawns, this builds a real podium instead.
import type { PodiumLayout } from '../content.ts'
import { cameraBasis } from '../client/cameraBasis.ts'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { refuse } from '@royal-fiesta/sim/refusal'
import { PALETTE } from './palette.ts'
import type { CameraPose, QuatT, RenderPort, Vec3T } from './port.ts'

export const PODIUM_ORIGIN: Vec3T = [0, 0, -1000]
// Place order: 1st centre and highest, 2nd on the camera's left, 3rd on its right.
export const PODIUM_PLACES: readonly { x: number; top: number }[] = [
  { x: 0, top: 1.5 }, { x: -2.2, top: 1.0 }, { x: 2.2, top: 0.6 },
]
export const PODIUM_TINTS: readonly Vec3T[] = [[1, 0.8, 0.2], [0.8, 0.82, 0.88], [0.8, 0.5, 0.25]]

// The V0 podium, far from every course. spots[i] is where place i+1 stands (top of its block);
// beans face +Z, so the camera stands on +Z and 2nd place (x < 0) is on the left of the frame.
export const PODIUM_V0_LAYOUT: PodiumLayout = Object.freeze({
  courseId: null,
  spots: Object.freeze(PODIUM_PLACES.map(({ x, top }) => Object.freeze({
    t: [PODIUM_ORIGIN[0] + x, PODIUM_ORIGIN[1] + top, PODIUM_ORIGIN[2]] as Vec3T, yawDeg: 0,
  }))),
  camera: Object.freeze({
    eye: [PODIUM_ORIGIN[0], PODIUM_ORIGIN[1] + 3, PODIUM_ORIGIN[2] + 7] as Vec3T,
    target: [PODIUM_ORIGIN[0], PODIUM_ORIGIN[1] + PODIUM_PLACES[1].top, PODIUM_ORIGIN[2]] as Vec3T,
    fovYDeg: 60, near: 0.1, far: 500,
  }),
})

export interface PodiumStageOptions {
  port: RenderPort
  viewport: number
  bean: PrimsAsset
  block: PrimsAsset
  // Default PODIUM_V0_LAYOUT. Exactly 3 spots; spots[0] is the top spot, where 1st place stands.
  layout?: PodiumLayout
  // Blocks run from floorY up to each spot. Default: the V0 podium floor.
  floorY?: number
}
export interface PodiumLabel { place: number; player: number; x: number; y: number }

const BLOCK_SIZE = 2
// The bean capsule is centred on its origin: 0.9 m cylinder + 2 * 0.4 m caps.
const BEAN_HALF = 0.85
const HEAD = 1.9
const BOB_M = 0.15
const BOB_HZ = 1.5
const IDENTITY: QuatT = [0, 0, 0, 1]
const UNIT: Vec3T = [1, 1, 1]

function boxSize(asset: PrimsAsset): Vec3T {
  for (const n of asset.nodes) {
    const s = n.params.size
    if ((n.kind === 'box' || n.kind === 'roundBox') && Array.isArray(s) && s.length === 3) {
      return [s[0] * n.transform.s[0], s[1] * n.transform.s[1], s[2] * n.transform.s[2]]
    }
  }
  return refuse('render', `PodiumStage block asset '${asset.id}'#/nodes`, 'no box or roundBox node with a size; pass the wall-block asset')
}

// Rotation about +Y that maps +Z onto the spot's yaw facing (as the scene view turns beans).
function yawQuat(yawDeg: number): QuatT {
  const half = (yawDeg * Math.PI) / 360
  return [0, Math.sin(half), 0, Math.cos(half)]
}

function checkLayout(layout: PodiumLayout, floorY: number): void {
  const p = 'PodiumStage layout'
  if (layout.spots.length !== 3) refuse('render', `${p}#/spots`, `${layout.spots.length} spots; pass exactly 3, the top spot first`)
  for (let i = 0; i < 3; i++) {
    const { t, yawDeg } = layout.spots[i]
    if (t.length !== 3 || !t.every(Number.isFinite) || !Number.isFinite(yawDeg)) {
      refuse('render', `${p}#/spots/${i}`, 'non-finite spot; pass finite t [x, y, z] and yawDeg')
    }
    if (!(t[1] > floorY)) refuse('render', `${p}#/spots/${i}/t/1`, `spot height ${t[1]} is not above the floor ${floorY}; raise the spot or lower floorY`)
  }
}

export class PodiumStage {
  private readonly port: RenderPort
  private readonly viewport: number
  private readonly layout: PodiumLayout
  private readonly beanAsset: number
  private readonly blocks: number[] = []
  private readonly beans: number[] = []
  private readonly beanPlayer: number[] = []
  private podium: number[] = []
  private timeS = 0
  private readonly cam: CameraPose

  constructor(opts: PodiumStageOptions) {
    this.port = opts.port
    this.viewport = opts.viewport
    this.layout = opts.layout ?? PODIUM_V0_LAYOUT
    const floorY = opts.floorY ?? PODIUM_ORIGIN[1]
    checkLayout(this.layout, floorY)
    const blockAsset = this.port.registerAsset('wall-block', opts.block)
    this.beanAsset = this.port.registerAsset('bean', opts.bean)
    const size = boxSize(opts.block)
    for (let i = 0; i < 3; i++) {
      const { t, yawDeg } = this.layout.spots[i]
      const top = t[1] - floorY
      const b = this.port.createInstance(blockAsset, PODIUM_TINTS[i])
      // The box is centred on its origin, so its centre sits halfway between the floor and the spot.
      this.port.setTransform(b, [t[0], floorY + top / 2, t[2]], yawQuat(yawDeg), [BLOCK_SIZE / size[0], top / size[1], BLOCK_SIZE / size[2]])
      this.blocks.push(b)
      this.beans.push(this.createBean(i, i))
      this.beanPlayer.push(i)
    }
    this.hide()
    const c = this.layout.camera
    this.cam = { eye: [c.eye[0], c.eye[1], c.eye[2]], target: [c.target[0], c.target[1], c.target[2]], fovYDeg: c.fovYDeg, near: c.near, far: c.far }
  }

  get camera(): CameraPose {
    return this.cam
  }

  /** podium = player indices in place order (1 to 3 entries). */
  show(podium: readonly number[]): void {
    if (podium.length < 1 || podium.length > 3) {
      refuse('render', 'PodiumStage.show', `podium has ${podium.length} entries; pass 1 to 3 player indices in place order`)
    }
    for (let i = 0; i < podium.length; i++) {
      const p = podium[i]
      if (!Number.isInteger(p) || p < 0 || p >= PALETTE.length) {
        refuse('render', `PodiumStage.show#/${i}`, `player ${p} is outside 0..${PALETTE.length - 1}; pass a player index`)
      }
    }
    this.podium = podium.slice()
    for (let i = 0; i < 3; i++) {
      this.port.setVisible(this.blocks[i], true)
      const used = i < podium.length
      if (used && this.beanPlayer[i] !== podium[i]) {
        // The port cannot retint an instance.
        this.port.destroyInstance(this.beans[i])
        this.beans[i] = this.createBean(podium[i], i)
        this.beanPlayer[i] = podium[i]
      }
      this.port.setVisible(this.beans[i], used)
    }
    this.timeS = 0
    this.placeBeans()
  }

  update(dtS: number): void {
    this.timeS += dtS
    this.placeBeans()
    this.port.setCamera(this.viewport, this.cam)
  }

  /** Pixel anchors above each shown bean's head, in place order. */
  labels(width: number, height: number): PodiumLabel[] {
    const { eye, target, fovYDeg } = this.cam
    let fx = target[0] - eye[0]
    let fy = target[1] - eye[1]
    let fz = target[2] - eye[2]
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz)
    fx /= fl
    fy /= fl
    fz /= fl
    // Screen-right comes from cameraBasis (1.6); up' = right x forward.
    const { right } = cameraBasis(eye, target)
    const rx = right.x
    const rz = right.z
    const ux = -rz * fy
    const uy = rz * fx - rx * fz
    const uz = rx * fy
    const t = Math.tan((fovYDeg * Math.PI) / 360)
    const aspect = width / height
    const out: PodiumLabel[] = []
    for (let i = 0; i < this.podium.length; i++) {
      const [px, py, pz] = this.headPoint(i)
      const dx = px - eye[0]
      const dy = py - eye[1]
      const dz = pz - eye[2]
      const depth = dx * fx + dy * fy + dz * fz
      const nx = (dx * rx + dz * rz) / (depth * t * aspect)
      const ny = (dx * ux + dy * uy + dz * uz) / (depth * t)
      out.push({ place: i + 1, player: this.podium[i], x: ((nx + 1) / 2) * width, y: ((1 - ny) / 2) * height })
    }
    return out
  }

  hide(): void {
    for (let i = 0; i < 3; i++) {
      this.port.setVisible(this.blocks[i], false)
      this.port.setVisible(this.beans[i], false)
    }
  }

  dispose(): void {
    for (const h of this.blocks) this.port.destroyInstance(h)
    for (const h of this.beans) this.port.destroyInstance(h)
    this.blocks.length = 0
    this.beans.length = 0
    this.podium = []
  }

  private createBean(player: number, place: number): number {
    const h = this.port.createInstance(this.beanAsset, PALETTE[player])
    this.port.setVisible(h, false)
    this.port.setTransform(h, this.beanPos(place), yawQuat(this.layout.spots[place].yawDeg), UNIT)
    return h
  }

  private bob(place: number): number {
    // 0..BOB_M so the winner never sinks into its block.
    return place === 0 ? BOB_M * 0.5 * (1 - Math.cos(2 * Math.PI * BOB_HZ * this.timeS)) : 0
  }

  private beanPos(place: number): [number, number, number] {
    const { t } = this.layout.spots[place]
    return [t[0], t[1] + BEAN_HALF + this.bob(place), t[2]]
  }

  private headPoint(place: number): [number, number, number] {
    const { t } = this.layout.spots[place]
    return [t[0], t[1] + HEAD + this.bob(place), t[2]]
  }

  private placeBeans(): void {
    for (let i = 0; i < this.podium.length; i++) {
      this.port.setTransform(this.beans[i], this.beanPos(i), yawQuat(this.layout.spots[i].yawDeg), UNIT)
    }
  }
}
