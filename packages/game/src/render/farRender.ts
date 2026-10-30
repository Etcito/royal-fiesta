// Far players: one simplified rigid figure per FAR seat, lighter than the near skinned characters.
// Display only: reads FarFeed's interpolated poses and never touches a simulation.
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { FarFeed } from '../net/farFeed.ts'
import { PALETTE } from './palette.ts'
import type { QuatT, RenderPort, Vec3T } from './port.ts'

// A far seat borrows its palette colour, pulled towards its own luminance and then towards white, so the
// bean still reads as the same player without competing with the full skinned figures near the camera.
const DESATURATE = 0.2
const LIGHTEN = 0.25
// The bean capsule is modelled at unit scale, as the scene view draws it.
const UNIT: Vec3T = [1, 1, 1]

/** The lighter, desaturated tint of one far seat. Seats beyond the palette wrap through it. */
export function farTint(seat: number): Vec3T {
  const n = PALETTE.length
  const i = ((Math.trunc(seat) % n) + n) % n
  const base = PALETTE[i]
  const lum = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2]
  const r = base[0] + (lum - base[0]) * DESATURATE
  const g = base[1] + (lum - base[1]) * DESATURATE
  const b = base[2] + (lum - base[2]) * DESATURATE
  return [r + (1 - r) * LIGHTEN, g + (1 - g) * LIGHTEN, b + (1 - b) * LIGHTEN]
}

export interface FarRendererOptions {
  port: RenderPort
  // The zone content supplies a separate low-poly, unskinned character asset.
  bean: PrimsAsset
  feed: FarFeed
  // Seats this peer simulates in a NEAR domain are drawn by the near scene, never here.
  holdsLocalSeat: (seat: number) => boolean
}

interface FarInstance {
  seat: number
  instance: number
  visible: boolean
  // The update() that last included this seat; older entries are hidden.
  frame: number
}

export class FarRenderer {
  private readonly port: RenderPort
  private readonly feed: FarFeed
  private readonly holdsLocalSeat: (seat: number) => boolean
  private readonly beanAsset: number
  // Indexed by seat; an entry survives while the seat is absent so its instance is reused on return.
  private readonly bySeat: (FarInstance | undefined)[] = []
  private readonly created: FarInstance[] = []
  private frame = 0

  constructor(opts: FarRendererOptions) {
    this.port = opts.port
    this.feed = opts.feed
    this.holdsLocalSeat = opts.holdsLocalSeat
    // A separate name prevents the near scene's skinned registration from replacing this LOD.
    this.beanAsset = opts.port.registerAsset('zone-far-bean', opts.bean)
  }

  get instanceCount(): number {
    return this.created.length
  }

  /** Draws the feed's interpolated poses at displayTick; every other seat is hidden. */
  update(displayTick: number): void {
    const frame = ++this.frame
    const shown = this.feed.read(displayTick, this.holdsLocalSeat)
    for (let i = 0; i < shown.length; i++) {
      const entity = shown[i]
      if (this.holdsLocalSeat(entity.seat) || !Number.isFinite(entity.x) || !Number.isFinite(entity.y) ||
        !Number.isFinite(entity.z) || !Number.isFinite(entity.yaw)) continue
      let entry = this.bySeat[entity.seat]
      if (entry === undefined) {
        entry = { seat: entity.seat, instance: this.port.createInstance(this.beanAsset, farTint(entity.seat)), visible: true, frame }
        this.bySeat[entity.seat] = entry
        this.created.push(entry)
      }
      entry.frame = frame
      const half = entity.yaw / 2
      const q: QuatT = [0, Math.sin(half), 0, Math.cos(half)]
      this.port.setTransform(entry.instance, [entity.x, entity.y, entity.z], q, UNIT)
      this.show(entry, true)
    }
    for (let i = 0; i < this.created.length; i++) {
      const entry = this.created[i]
      if (entry.frame !== frame) this.show(entry, false)
    }
  }

  dispose(): void {
    for (let i = 0; i < this.created.length; i++) this.port.destroyInstance(this.created[i].instance)
    this.created.length = 0
    this.bySeat.length = 0
    this.frame = 0
  }

  private show(entry: FarInstance, visible: boolean): void {
    if (entry.visible === visible) return
    this.port.setVisible(entry.instance, visible)
    entry.visible = visible
  }
}

// Low-poly rigid penguin silhouette, matching penguin.body's body-space dimensions.
// One mesh, no skeleton, animation, costume or fine facial geometry.
export function farFigureMesh() {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const rings = 6
  const segments = 10
  function oval(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number) {
    const start = positions.length / 3
    for (let row = 0; row <= rings; row++) {
      const latitude = Math.PI * row / rings
      for (let col = 0; col <= segments; col++) {
        const longitude = 2 * Math.PI * col / segments
        const x = Math.sin(latitude) * Math.cos(longitude)
        const y = Math.cos(latitude)
        const z = Math.sin(latitude) * Math.sin(longitude)
        positions.push(cx + rx * x, cy + ry * y, cz + rz * z)
        const length = Math.hypot(x / rx, y / ry, z / rz)
        normals.push(x / rx / length, y / ry / length, z / rz / length)
      }
    }
    for (let row = 0; row < rings; row++) for (let col = 0; col < segments; col++) {
      const a = start + row * (segments + 1) + col
      const b = a + segments + 1
      indices.push(a, a + 1, b, a + 1, b + 1, b)
    }
  }
  oval(0, -0.03, 0, 0.46, 0.79, 0.4)
  oval(0, 0.74, 0.02, 0.38, 0.38, 0.38)
  oval(-0.48, -0.12, 0, 0.16, 0.51, 0.19)
  oval(0.48, -0.12, 0, 0.16, 0.51, 0.19)
  oval(-0.23, -0.8, 0.13, 0.23, 0.13, 0.32)
  oval(0.23, -0.8, 0.13, 0.23, 0.13, 0.32)
  oval(0, 0.69, 0.4, 0.14, 0.09, 0.2)
  return {
    materials: [],
    groups: [{ group: 'far', parts: [{
      name: 'bean', partId: 'bean',
      frame: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      meshes: [{ material: null, positions: new Float32Array(positions), normals: new Float32Array(normals),
        uvs: null, indices: new Uint32Array(indices) }],
    }] }],
  }
}
