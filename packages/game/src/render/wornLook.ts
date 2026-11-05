// The wardrobe's bin slots are independent of rig attachment slot names. Keep every selected piece.
import type { PrimsAsset } from '../prims.ts'
import type { RenderPort, SkinnedAssetT, Vec3T, QuatT } from './port.ts'
import { CosmeticJiggle, hasJiggle, wornPalette } from '../anim/jiggle.ts'

export interface WornLook {
  colour: number
  items: readonly { asset: PrimsAsset; mount: Vec3T; tint: Vec3T | null }[]
}

/**
 * How one setPose call may jiggle the worn cosmetics (anim/jiggle.ts): `dtS` the real frame time; `batch` a view's
 * shared CosmeticJiggle the caller flushes (else these mounts step their own, once per call); `local` whether the
 * wearer is the local player; `distance2` the squared distance to the camera.
 */
export interface WornJiggle { dtS: number; batch?: CosmeticJiggle; localWearer?: boolean; distance2?: number }

/** Penguin-bound cosmetics share the body pose; legacy rigid items retain their mount. */
export class WornMounts {
  private items: { asset: PrimsAsset; instance: number; mount: Vec3T; tint: Vec3T | null; skinned: boolean; skin?: SkinnedAssetT }[] = []
  private visible = true
  private readonly port: RenderPort
  private own: CosmeticJiggle | null = null
  private batch: CosmeticJiggle | null = null
  private placed: { t: Vec3T; r: QuatT; s: Vec3T } = { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }
  constructor(port: RenderPort) { this.port = port }
  sync(look: WornLook | null | undefined): void {
    const next = look?.items ?? []
    if (next.length === this.items.length && next.every((item, i) => item.asset === this.items[i].asset && sameVector(item.tint, this.items[i].tint) && sameVector(item.mount, this.items[i].mount))) return
    this.dispose()
    this.items = next.map(item => {
      const skin = this.port.skinOf?.(item.asset.id)
      const skinned = !!skin && !!this.port.registerSkinned && !!this.port.setPose
      const handle = skinned ? this.port.registerSkinned!(item.asset.id, skin!) : this.port.registerAsset(item.asset.id, item.asset)
      return { ...item, skinned, ...(skinned ? { skin } : {}), instance: this.port.createInstance(handle, item.tint) }
    })
    if (!this.visible) for (const item of this.items) this.port.setVisible(item.instance, false)
  }
  /**
   * Pose the skinned items from the wearer's skin matrices. A cosmetic with its own armature gets its palette from
   * the mount bone (wornPalette); with `jiggle`, its jiggle bones swing (placed where the last draw() put it).
   */
  setPose(matrices: Float32Array, jiggle?: WornJiggle): void {
    const { t, r, s } = this.placed
    let queued = false
    for (const item of this.items) {
      if (!item.skinned) continue
      if (jiggle !== undefined && item.skin && (item.skin.mount !== undefined || hasJiggle(item.skin))) {
        const batch = jiggle.batch ?? (this.own ??= new CosmeticJiggle())
        this.batch = batch
        batch.add(item.instance, item.skin, matrices, t, r, s, jiggle.localWearer ?? true, jiggle.distance2 ?? 0)
        queued ||= jiggle.batch === undefined
        continue
      }
      this.port.setPose!(item.instance, wornPalette(item.skin, matrices))
    }
    if (queued) this.own!.flush(jiggle!.dtS, (instance, palette) => this.port.setPose!(instance, palette))
  }
  draw(t: Vec3T, r: QuatT, s: Vec3T): void {
    this.placed = { t: [t[0], t[1], t[2]], r: [r[0], r[1], r[2], r[3]], s: [s[0], s[1], s[2]] }
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
  dispose(): void {
    for (const item of this.items) {
      this.batch?.release(item.instance)
      this.port.destroyInstance(item.instance)
    }
    this.items = []
  }
  /** Also frees the mounts' own jiggle world (a view's shared batch is the view's to dispose). */
  destroy(): void {
    this.dispose()
    this.own?.dispose()
    this.own = null
  }
}

function sameVector(a: Vec3T | null, b: Vec3T | null): boolean {
  return a === b || (a !== null && b !== null && a.every((v, i) => v === b[i]))
}
