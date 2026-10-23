import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { CameraPose, QuatT, RenderPort, RenderStats, RenderTarget, Vec3T } from './port.ts'

const AREA = 'render'

function finite(v: readonly number[]): boolean {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false
  return true
}

function posInt(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

/** Validates and counts like a real port but draws nothing, so sim and client code run in Node. */
export class NullRenderPort implements RenderPort {
  readonly kind = 'null' as const
  readonly calls = { registerAsset: 0, createInstance: 0, setTransform: 0, render: 0 }
  private env: Readonly<Record<string, unknown>> | null = null
  private target: RenderTarget | null = null
  private assets = new Map<string, number>()
  private assetCount = 0
  // Index = instance handle; null once destroyed, so handles are never reused.
  private live: ({ asset: number; visible: boolean } | null)[] = []

  async init(target: RenderTarget): Promise<void> {
    const p = 'NullRenderPort.init'
    if (!posInt(target.width) || !posInt(target.height)) {
      refuse(AREA, p, `size ${target.width}x${target.height} is not a positive integer pair; pass whole pixel width and height`)
    }
    if (target.viewports.length === 0) refuse(AREA, p, 'no viewports; pass at least one viewport')
    for (let i = 0; i < target.viewports.length; i++) {
      const v = target.viewports[i]
      if (!posInt(v.width) || !posInt(v.height)) {
        refuse(AREA, p, `viewport ${i} has size ${v.width}x${v.height}; pass positive integer width and height`)
      }
    }
    this.target = target
  }

  registerAsset(name: string, _asset: PrimsAsset): number {
    this.calls.registerAsset++
    let h = this.assets.get(name)
    if (h === undefined) {
      h = this.assetCount++
      this.assets.set(name, h)
    }
    return h
  }

  createInstance(asset: number, tint: Vec3T | null): number {
    this.calls.createInstance++
    const p = 'NullRenderPort.createInstance'
    if (!Number.isInteger(asset) || asset < 0 || asset >= this.assetCount) {
      refuse(AREA, p, `unknown asset handle ${asset}; register the asset first with registerAsset`)
    }
    if (tint !== null && (tint.length !== 3 || !finite(tint))) {
      refuse(AREA, p, 'tint is not 3 finite numbers; pass [r, g, b] or null')
    }
    this.live.push({ asset, visible: true })
    return this.live.length - 1
  }

  setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void {
    this.calls.setTransform++
    this.get('NullRenderPort.setTransform', instance)
    if (!finite(t) || !finite(r) || !finite(s)) refuse(AREA, 'NullRenderPort.setTransform', 'non-finite component in t, r or s; pass finite numbers')
  }

  setVisible(instance: number, visible: boolean): void {
    this.get('NullRenderPort.setVisible', instance).visible = visible
  }

  destroyInstance(instance: number): void {
    this.get('NullRenderPort.destroyInstance', instance)
    this.live[instance] = null
  }

  setCamera(viewport: number, cam: CameraPose): void {
    const p = 'NullRenderPort.setCamera'
    const n = this.target ? this.target.viewports.length : 0
    if (!Number.isInteger(viewport) || viewport < 0 || viewport >= n) {
      refuse(AREA, p, `viewport ${viewport} is outside 0..${n - 1}; call init with enough viewports`)
    }
    if (!finite(cam.eye) || !finite(cam.target) || !finite([cam.fovYDeg, cam.near, cam.far])) {
      refuse(AREA, p, 'non-finite camera pose; pass finite numbers')
    }
  }

  setEnvironment(env: Readonly<Record<string, unknown>> | null): void {
    if (env !== null && (typeof env !== 'object' || Array.isArray(env))) {
      refuse(AREA, 'NullRenderPort.setEnvironment', 'environment is not an object; pass the course environment object or null')
    }
    this.env = env
  }

  get lastEnvironment(): Readonly<Record<string, unknown>> | null {
    return this.env
  }

  render(): RenderStats {
    const t0 = performance.now()
    this.calls.render++
    let instances = 0
    let visible = 0
    for (const inst of this.live) {
      if (inst === null) continue
      instances++
      if (inst.visible) visible++
    }
    return { frameMs: performance.now() - t0, drawCalls: 0, triangles: 0, instances, visible }
  }

  async capture(): Promise<Uint8Array | null> {
    return null
  }

  dispose(): void {
    this.target = null
    this.env = null
    this.assets.clear()
    this.assetCount = 0
    this.live = []
  }

  private get(path: string, instance: number): { asset: number; visible: boolean } {
    const inst = Number.isInteger(instance) ? this.live[instance] : undefined
    if (!inst) refuse(AREA, path, `unknown or destroyed instance ${instance}; pass a handle from createInstance`)
    return inst
  }
}
