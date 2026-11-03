// The wardrobe's bin slots are independent of rig attachment slot names. Keep every selected piece.
import type { PrimsAsset } from '../prims.ts'
import type { RenderPort, Vec3T, QuatT } from './port.ts'

export interface WornLook {
  colour: number
  items: readonly { asset: PrimsAsset; mount: Vec3T; tint: Vec3T | null }[]
}

/** Penguin-bound cosmetics share the body pose; legacy rigid items retain their mount. */
export class WornMounts {
  private items: { asset: PrimsAsset; instance: number; mount: Vec3T; tint: Vec3T | null; skinned: boolean }[] = []
  private visible = true
  private readonly port: RenderPort
  constructor(port: RenderPort) { this.port = port }
  sync(look: WornLook | null | undefined): void {
    const next = look?.items ?? []
    if (next.length === this.items.length && next.every((item, i) => item.asset === this.items[i].asset && sameVector(item.tint, this.items[i].tint) && sameVector(item.mount, this.items[i].mount))) return
    this.dispose()
    this.items = next.map(item => {
      const skin = this.port.skinOf?.(item.asset.id)
      const skinned = !!skin && !!this.port.registerSkinned && !!this.port.setPose
      const handle = skinned ? this.port.registerSkinned!(item.asset.id, skin!) : this.port.registerAsset(item.asset.id, item.asset)
      return { ...item, skinned, instance: this.port.createInstance(handle, item.tint) }
    })
    if (!this.visible) for (const item of this.items) this.port.setVisible(item.instance, false)
  }
  setPose(matrices: Float32Array): void {
    for (const item of this.items) if (item.skinned) this.port.setPose!(item.instance, matrices)
  }
  draw(t: Vec3T, r: QuatT, s: Vec3T): void {
    for (const item of this.items) {
      if (item.skinned) { this.port.setTransform(item.instance, t, r, s); continue }
      const x = item.mount[0] * s[0], y = item.mount[1] * s[1], z = item.mount[2] * s[2]
      const [qx, qy, qz, qw] = r
      const ux = 2 * (qy * z - qz * y), uy = 2 * (qz * x - qx * z), uz = 2 * (qx * y - qy * x)
      this.port.setTransform(item.instance, [t[0] + x + qw * ux + qy * uz - qz * uy,
        t[1] + y + qw * uy + qz * ux - qx * uz, t[2] + z + qw * uz + qx * uy - qy * ux], r, s)
    }
  }
  setVisible(on: boolean): void {
    if (on === this.visible) return
    this.visible = on
    for (const item of this.items) this.port.setVisible(item.instance, on)
  }
  dispose(): void { for (const item of this.items) this.port.destroyInstance(item.instance); this.items = [] }
}

function sameVector(a: Vec3T | null, b: Vec3T | null): boolean {
  return a === b || (a !== null && b !== null && a.every((v, i) => v === b[i]))
}
