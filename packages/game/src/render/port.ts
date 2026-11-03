import type { PrimsAsset } from '@royal-fiesta/game/prims'

export type Vec3T = readonly [number, number, number]
export type QuatT = readonly [number, number, number, number]
export interface Viewport { x: number; y: number; width: number; height: number }
export interface CameraPose { up?: Vec3T; eye: Vec3T; target: Vec3T; fovYDeg: number; near: number; far: number }
export interface RenderTarget { canvas: unknown | null; width: number; height: number; viewports: Viewport[] }
// S16 rig, S17 clips and S18 per-part skin as @etcito/raa-sdfm exposes them on a loaded asset.
// Ports read the bone order and the part streams; the rig and clips are carried unchanged.
export interface SkinRigT { readonly name: string; readonly bones: readonly { readonly name: string; readonly parent: string | null }[] }
export interface SkinPartT { readonly name: string; readonly skin?: { readonly joints: Uint16Array; readonly weights: Float32Array } }
export interface SkinnedAssetT { readonly rig: SkinRigT; readonly clips?: readonly unknown[]; readonly parts: readonly SkinPartT[] }
export interface RenderStats { frameMs: number; drawCalls: number; triangles: number; instances: number; visible: number }
// Live state of a port for checks: the asset names it has instances of, the live instance count and the
// GPU-side handles it holds. Ports without a table omit inventory.
export interface RenderInventory { assets: string[]; instances: number; meshes: number; textures: number; skinned: number }

export interface RenderPort {
  readonly kind: 'null' | 'raa'
  init(target: RenderTarget): Promise<void>
  registerRoad?(name: string, sweep: import('@royal-fiesta/sim/road').RoadData): number
  registerAsset(name: string, asset: PrimsAsset): number
  createInstance(asset: number, tint: Vec3T | null): number
  setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void
  setVisible(instance: number, visible: boolean): void
  destroyInstance(instance: number): void
  setCamera(viewport: number, cam: CameraPose): void
  // S13 course environment, passed to the renderer unchanged; null = renderer defaults.
  setEnvironment(env: Readonly<Record<string, unknown>> | null): void
  // S18 skinned characters. registerSkinned returns an asset handle for createInstance; setPose takes
  // 16 x rig.bones.length S16 skin matrices (column-major, bone order) and an unposed instance draws
  // at rest. Ports without skinning omit both and keep drawing the rigid parts.
  skinOf?(assetId: string): SkinnedAssetT | undefined
  registerSkinned?(assetId: string, skin: SkinnedAssetT): number
  setPose?(instance: number, matrices: Float32Array): void
  render(): RenderStats
  capture(): Promise<Uint8Array | null>
  dispose(): void
  // Optional live inventory (registered assets, instances, meshes, textures, skinned instances).
  inventory?(): RenderInventory
  // Optional: free a registered asset's GPU resources (meshes, textures and volume textures) and
  // forget its handle, so a later registerAsset of the same id re-uploads it. Callers destroy its
  // instances first; a port that cannot free a single asset omits this (dispose the port instead).
  releaseAsset?(handle: number): void
}

export type SkinnedRenderPort = RenderPort & Required<Pick<RenderPort, 'registerSkinned' | 'setPose'>>
