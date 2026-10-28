import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { CameraPose, QuatT, RenderStats, RenderTarget, SkinnedAssetT, SkinnedRenderPort, Vec3T } from './port.ts'

const AREA = 'render'

function finite(v: readonly number[]): boolean {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false
  return true
}

function posInt(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

const MAX_JOINTS = 256

/** Checks S18 skin data for registerSkinned (shared by the ports); returns the rig bone count. */
export function checkSkin(area: string, path: string, skin: SkinnedAssetT): number {
  const bones = skin.rig?.bones
  if (!Array.isArray(bones) || bones.length === 0 || bones.length > MAX_JOINTS) {
    refuse(area, path, `the rig has ${Array.isArray(bones) ? bones.length : 'no'} bones; pass the S16 rig of the asset with 1..${MAX_JOINTS} bones`)
  }
  if (!Array.isArray(skin.parts)) refuse(area, path, 'skin.parts is not an array; pass the parts of the loaded raa-sdfm asset')
  let skinned = 0
  for (const part of skin.parts) {
    if (part.skin === undefined) continue
    const { joints, weights } = part.skin
    const where = `${path}#part:${part.name}`
    if (!(joints instanceof Uint16Array) || !(weights instanceof Float32Array)) refuse(area, where, 'skin needs Uint16Array joints and Float32Array weights')
    if (joints.length === 0 || joints.length % 4 !== 0 || weights.length !== joints.length) {
      refuse(area, where, `skin has ${joints.length} joints and ${weights.length} weights; pass 4 of each per vertex`)
    }
    for (let i = 0; i < joints.length; i++) {
      if (joints[i] >= bones.length) refuse(area, where, `joint ${joints[i]} at ${i} is outside the ${bones.length} rig bones`)
      if (!(weights[i] >= 0) || !Number.isFinite(weights[i])) refuse(area, where, `weight ${i} is not a finite non-negative number`)
    }
    skinned++
  }
  if (skinned === 0) refuse(area, path, 'no part carries a skin; register a rigged asset or use registerAsset')
  return bones.length
}

/** Checks a setPose argument: 16 finite floats per rig bone. */
export function checkPose(area: string, path: string, matrices: Float32Array, bones: number): void {
  if (!(matrices instanceof Float32Array) || matrices.length !== 16 * bones) {
    refuse(area, path, `the pose has ${matrices?.length} floats; pass 16 x ${bones} skin matrices in rig bone order`)
  }
  for (let i = 0; i < matrices.length; i++) if (!Number.isFinite(matrices[i])) refuse(area, path, `pose float ${i} is not finite`)
}

/** Validates and counts like a real port but draws nothing, so sim and client code run in Node. */
export class NullRenderPort implements SkinnedRenderPort {
  readonly kind = 'null' as const
  readonly calls = { registerAsset: 0, createInstance: 0, setTransform: 0, render: 0, setPose: 0 }
  private env: Readonly<Record<string, unknown>> | null = null
  private target: RenderTarget | null = null
  private assets = new Map<string, number>()
  private assetCount = 0
  // Asset handle -> rig bone count of a skinned asset.
  private skinBones = new Map<number, number>()
  // Instance handle -> its own copy of the last submitted pose; absent = rest.
  private poses = new Map<number, Float32Array>()
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

  registerSkinned(assetId: string, skin: SkinnedAssetT): number {
    const bones = checkSkin(AREA, `NullRenderPort.registerSkinned(${assetId})`, skin)
    const h = this.registerAsset(assetId, { id: assetId } as PrimsAsset)
    this.skinBones.set(h, bones)
    return h
  }

  setPose(instance: number, matrices: Float32Array): void {
    this.calls.setPose++
    const p = 'NullRenderPort.setPose'
    const bones = this.skinBones.get(this.get(p, instance).asset)
    if (bones === undefined) refuse(AREA, p, `instance ${instance} is not skinned; create it from a registerSkinned handle`)
    checkPose(AREA, p, matrices, bones)
    this.poses.set(instance, matrices.slice())
  }

  /** The last pose submitted for an instance, or null when it draws at rest. */
  poseOf(instance: number): Float32Array | null {
    return this.poses.get(instance) ?? null
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
    this.poses.delete(instance)
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
    this.skinBones.clear()
    this.poses.clear()
    this.live = []
  }

  private get(path: string, instance: number): { asset: number; visible: boolean } {
    const inst = Number.isInteger(instance) ? this.live[instance] : undefined
    if (!inst) refuse(AREA, path, `unknown or destroyed instance ${instance}; pass a handle from createInstance`)
    return inst
  }
}
