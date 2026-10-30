// Far players: one unskinned bean per FAR seat, drawn lighter than the near scene's skinned characters.
// Display only: reads FarFeed's interpolated poses and never touches a simulation.
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { FarFeed } from '../net/farFeed.ts'
import { PALETTE } from './palette.ts'
import type { QuatT, RenderPort, Vec3T } from './port.ts'

// A far seat borrows its palette colour, pulled towards its own luminance and then towards white, so the
// bean still reads as the same player without competing with the full skinned figures near the camera.
const DESATURATE = 0.45
const LIGHTEN = 0.35
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
  // The asset game pages preload as 'bean'; far players are always the unskinned prims bean.
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
    // Registering is idempotent per name, so the near scene and this renderer share the bean asset.
    this.beanAsset = opts.port.registerAsset('bean', opts.bean)
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
