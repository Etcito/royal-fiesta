import { loadRaa } from '@etcito/raa'
import type { AssetInfo, Engine } from '@etcito/raa'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { CameraPose, QuatT, RenderPort, RenderStats, RenderTarget, Vec3T } from '@royal-fiesta/game/render/port'
import { refuse } from '@royal-fiesta/sim/refusal'
import { raaStatus } from './raaStatus.ts'

const AREA = 'render'
const WHERE = 'raa'

interface Live { root: number; instances: number[]; visible: boolean }

// RenderPort on @etcito/raa 0.1.0: one engine on one canvas. RAA has one camera and no scissor, so
// the port draws a single full-canvas viewport; several viewports refuse (docs/brick-gaps.md).
export async function createRaaPort(): Promise<RenderPort> {
  const status = await raaStatus()
  if (!status.available) refuse(AREA, WHERE, status.reason)
  return new RaaRenderPort()
}

class RaaRenderPort implements RenderPort {
  readonly kind = 'raa' as const
  private engine: Engine | null = null
  private canvas: HTMLCanvasElement | null = null
  private target: RenderTarget | null = null
  private assets: AssetInfo[] = []
  private assetByName = new Map<string, number>()
  private tints = new Map<string, number>()
  private live: (Live | null)[] = []
  private lastStats: RenderStats = { frameMs: 0, drawCalls: 0, triangles: 0, instances: 0, visible: 0 }

  async init(target: RenderTarget): Promise<void> {
    const p = 'RaaRenderPort.init'
    if (target.viewports.length !== 1) refuse(AREA, WHERE, `${p}: RAA draws one full-canvas viewport, got ${target.viewports.length}; use one canvas per client`)
    const [vp] = target.viewports
    if (vp.x !== 0 || vp.y !== 0 || vp.width !== target.width || vp.height !== target.height) {
      refuse(AREA, WHERE, `${p}: the viewport must cover the whole ${target.width}x${target.height} canvas`)
    }
    if (!(target.canvas instanceof HTMLCanvasElement)) refuse(AREA, WHERE, `${p}: pass an HTMLCanvasElement as the target canvas`)
    const raa = await loadRaa()
    this.engine = await raa.createEngine(target.canvas, { maxInstances: 4096 })
    this.engine.resize(target.width, target.height)
    this.engine.setLight({ direction: [-0.4, -1, -0.3], color: [1, 1, 1], intensity: 3 })
    this.engine.setAmbient({ color: [0.6, 0.7, 0.9], intensity: 0.3 })
    this.canvas = target.canvas
    this.target = target
  }

  registerAsset(name: string, asset: PrimsAsset): number {
    const known = this.assetByName.get(name)
    if (known !== undefined) return known
    const info = this.need().loadPrimsAsset(JSON.stringify(asset))
    this.assets.push(info)
    const handle = this.assets.length - 1
    this.assetByName.set(name, handle)
    return handle
  }

  createInstance(asset: number, tint: Vec3T | null): number {
    const engine = this.need()
    const info = this.assets[asset]
    if (info === undefined) refuse(AREA, WHERE, `unknown asset handle ${asset}; register the asset first with registerAsset`)
    const root = engine.addNode(null)
    const instances: number[] = []
    if (tint === null) {
      const spawned = engine.spawnAsset(info.id, root)
      instances.push(...spawned.instances)
    } else {
      // A tint replaces the asset's colours: every mesh draws with one tint material.
      const material = this.tintMaterial(tint)
      for (const mesh of info.meshes) {
        const node = engine.addNode(root)
        instances.push(engine.addInstance(node, mesh, material))
      }
    }
    this.live.push({ root, instances, visible: true })
    return this.live.length - 1
  }

  setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void {
    const live = this.liveOf(instance, 'setTransform')
    this.need().setTransform(live.root, [t[0], t[1], t[2]], [r[0], r[1], r[2], r[3]], [s[0], s[1], s[2]])
  }

  setVisible(instance: number, visible: boolean): void {
    const live = this.liveOf(instance, 'setVisible')
    live.visible = visible
    for (const id of live.instances) this.need().setVisible(id, visible)
  }

  destroyInstance(instance: number): void {
    const live = this.liveOf(instance, 'destroyInstance')
    this.need().removeNode(live.root)
    this.live[instance] = null
  }

  setCamera(viewport: number, cam: CameraPose): void {
    if (viewport !== 0) refuse(AREA, WHERE, `setCamera: viewport ${viewport} does not exist; RAA has one viewport (0)`)
    this.need().setCamera({ eye: [...cam.eye], target: [...cam.target], fovYDeg: cam.fovYDeg, near: cam.near, far: cam.far })
  }

  render(): RenderStats {
    const engine = this.need()
    const t0 = performance.now()
    engine.render(t0)
    const frameMs = performance.now() - t0
    const stats = engine.stats()
    let visible = 0
    for (const live of this.live) if (live !== null && live.visible) visible++
    this.lastStats = { frameMs, drawCalls: stats.drawCalls, triangles: stats.triangles, instances: stats.instances, visible }
    return this.lastStats
  }

  async capture(): Promise<Uint8Array | null> {
    if (this.canvas === null) return null
    const blob = await new Promise<Blob | null>((resolve) => this.canvas!.toBlob(resolve, 'image/png'))
    if (blob === null || blob.size === 0) return null
    return new Uint8Array(await blob.arrayBuffer())
  }

  dispose(): void {
    this.engine?.dispose()
    this.engine = null
    this.canvas = null
    this.target = null
  }

  private need(): Engine {
    if (this.engine === null || this.target === null) refuse(AREA, WHERE, 'the port is not initialised or was disposed; call init first')
    return this.engine
  }

  private liveOf(instance: number, what: string): Live {
    const live = this.live[instance]
    if (!live) refuse(AREA, WHERE, `${what}: unknown or destroyed instance ${instance}; pass a handle from createInstance`)
    return live
  }

  private tintMaterial(tint: Vec3T): number {
    if (tint.length !== 3 || !tint.every(Number.isFinite)) refuse(AREA, WHERE, 'tint is not 3 finite numbers; pass [r, g, b] or null')
    const key = tint.join(',')
    const known = this.tints.get(key)
    if (known !== undefined) return known
    const material = this.need().addMaterial({ color: [tint[0], tint[1], tint[2]], roughness: 0.6 })
    this.tints.set(key, material)
    return material
  }
}
