import { roadMesh, type RoadData } from '@royal-fiesta/sim/road'
import { checkAwait } from '../game/checkProgress.ts'
// SDF render port: a RenderPort on the @etcito/raa release engine, fed with the upload payload the
// MAMA workers already produced (one mesh per part, split by material) and the graph materials
// compiled by @etcito/raa-sdfm's mapMaterial. The player colour (S23) reaches graph-mode materials
// through setInstanceTint; parts without any graph material keep RAA's post-material multiply.
import { roundStep, renderFrame } from '@royal-fiesta/game/render/roundLoad'
import type { Engine, MeshDesc, SubMeshDesc } from '@etcito/raa'
import { materialProgram } from './materialProgram.ts'
import { createRaaEngine } from '../render/raaEngine.ts'
import type { SdfmCompiledMaterial, SdfmMappedMaterial, SdfmPartShading } from '@etcito/raa-sdfm'
import { fieldPartShading, fieldSurfaceAttributes } from '@etcito/raa-sdfm'
import type { LoadProgress } from '@royal-fiesta/game/content'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { CameraPose, QuatT, RenderInventory, RenderStats, RenderTarget, SkinnedAssetT, SkinnedRenderPort, SkinRigT, Vec3T, Viewport } from '@royal-fiesta/game/render/port'
import { checkPose, checkSkin } from '@royal-fiesta/game/render/nullPort'
import { refuse } from '@royal-fiesta/sim/refusal'
import { applyCourseEnvironment, DEFAULT_LIGHT, DEFAULT_AMBIENT } from '../render/courseEnvironment.ts'
import { raaStatus } from '../render/raaStatus.ts'
import type { MeshedAsset } from './mamaApi.ts'
import { installShaderCache } from '../render/shaderCache.ts'
import { deviceOfCanvas, fieldReady, materialKey } from '../render/asyncPipelines.ts'

export interface ResizablePort extends SkinnedRenderPort {
  resize(cssW: number, cssH: number, dpr: number, viewports: Viewport[]): void
  setPartFilter(instance: number, parts: readonly string[] | null): void
}

// Release declarations may lag the sibling's m20/m21 API.
type SdfEngine = Engine & {
  setViewports(rects: Viewport[]): void
  setViewportCamera(index: number, cam: { eye: [number, number, number]; target: [number, number, number]; fovYDeg: number; near: number; far: number }): void
  resize(cssW: number, cssH: number, dpr: number): void
  setMaterialTintMode(handle: number, mode: 'graph' | 'multiply'): void
  clearInstanceTint(instance: number): void
  // RAA bbcece7 render option: one material per object (engine default off).
  setSingleMaterial(enabled: boolean): void
  setSingleMaterial(enabled: boolean | null, instance: number): void
  setInstanceMaterial(instance: number, material: number | null): void
}

const AREA = 'sdf'
const WHERE = 'sdf-port'

/**
 * How Paramesh surfaces are shaded: 'pixel' (default) evaluates the part's SDF field per fragment (its stored shading,
 * @etcito/raa-sdfm fieldPartShading, the same material as SDF Modeler's Game view: the field's gradient as the
 * normal and the shapes' materials mixed by the field, whatever the mesh density; nothing baked); 'vertex' keeps the
 * saved per-face materials and the interpolated vertex normals. `?normals=vertex` in the page address picks 'vertex'.
 */
export type NormalsMode = 'pixel' | 'vertex'
export function normalsMode(search: string = typeof location === 'undefined' ? '' : location.search): NormalsMode {
  return new URLSearchParams(search).get('normals') === 'vertex' ? 'vertex' : 'pixel'
}
/** `?normalsDebug`: per-pixel Paramesh surfaces show the normal lighting receives (0.5 + n / 2). */
function normalsDebug(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).has('normalsDebug')
}
const MAX_INSTANCES = 4096
const MAX_MATERIALS = 1024

// The payload of apps/web/src/sdf/mama/worker.ts: MAMA parts with per-material meshes.
interface PayloadMesh { material: string | null; positions: Float32Array; normals: Float32Array; uvs: Float32Array | null; indices: Uint32Array; colors?: Float32Array }
// shading: the part's per-pixel shading (MAMA field-program.ts savedPartShading, saved mesh format 3), or shadingError: why
// it has none. colors/look/single: one material per object (mama/singleMaterial.ts), on browser-meshed parts only.
interface PayloadPart { partId: string; name: string; frame: Float64Array; meshes: PayloadMesh[]; shading?: SdfmPartShading; shadingError?: string; look?: { roughness: number; metallic: number } }
interface PayloadGroup { group: string; parts: PayloadPart[]; single?: boolean }
interface Payload { groups: PayloadGroup[]; materials: SdfmCompiledMaterial[] }

// key = the raa-sdfm part name (group/partId when two parts share a name); joints = 1 + max joint of a skinned part.
// subMeshes keep `material` absent for MAMA's no-material faces (tintableParts fills them); a part drawn with its
// per-pixel shading has the one shading material on every sub-mesh (its desc then carries the rest-frame streams).
// object: the one standard material (white x vertex colour) the part draws while one material per object is on; absent =
// the part keeps its per-face materials (group tagged off, a player-colour graph, a mesh without colours, or shading).
// field: the materialKey of the part's per-pixel shading function; fallback: the same part as `?normals=vertex` draws it
// (its per-face materials or one material per object, vertex normals), shown while the shading's pipelines compile.
interface PartUpload { name: string; key: string; mesh: number; desc: MeshDesc; subMeshes: SubMeshDesc[]; t: [number, number, number]; r: [number, number, number, number]; joints?: number; tint: PartTint; object?: number; field?: string; fallback?: Fallback }
interface Fallback { mesh: number; desc: MeshDesc; subMeshes: SubMeshDesc[]; object?: number }
// graph: a material of the part holds input.player_color; multiply: a part with no SDF material (white fallback).
type PartTint = 'graph' | 'multiply' | 'none'
// bones/rig/clips only on a skinned visual, carried from the raa-sdfm asset.
// emptyParts: parts the mesher kept by name with no triangle (hidden colliders): a part filter may list them.
// data: the field-shading data blocks (RAA material data words) this upload added, freed with it.
interface Uploaded { assetId: string; parts: PartUpload[]; emptyParts?: string[]; tintedParts?: PartUpload[]; bones?: number; rig?: SkinRigT; clips?: readonly unknown[]; base?: number; data?: number[] }
interface SkinSlot { instance: number; part: PartUpload }
// pose = this character's own copy of its last setPose; null draws the rest pose.
// asset = the uploaded/handle index this instance was created from (for the live inventory).
// fallbacks: the vertex-colour copies of parts whose shading pipelines still compile (index into partNames); each goes
// the frame its part's shading can draw.
interface Live { asset: number; root: number; instances: number[]; partNames: string[]; emptyParts: readonly string[]; filter: ReadonlySet<string> | null; visible: boolean; bones: number; skin: SkinSlot[]; pose: Float32Array | null; fallbacks: LiveFallback[] }
interface LiveFallback { instance: number; node: number; part: PartUpload; index: number }

export async function createSdfPort(target: RenderTarget, meshed: ReadonlyMap<string, MeshedAsset>,
  failed: ReadonlyMap<string, string> = new Map(),
  onProgress: (p: LoadProgress) => void = () => {},
  onTiming: (span: { step: string; start: number; end: number; ms: number }) => void = () => {}): Promise<ResizablePort> {
  const status = await raaStatus()
  if (!status.available) refuse(AREA, WHERE, status.reason)
  const port = new SdfRenderPort(meshed, failed, await fieldEvaluator())
  const start = performance.now()
  await checkAwait('RAA port initialization', () => port.init(target))
  const end = performance.now()
  onTiming({ step: 'RAA engine init', start, end, ms: end - start })
  try {
    await checkAwait('RAA mesh/material uploads', () => port.prepare(onProgress, onTiming))
    return port
  } catch (e) {
    port.dispose()
    throw e
  }
}

// MAMA's field evaluator (FIELD_PROGRAM_WGSL of core/paramesh/field-program-wgsl.ts), the text the one per-pixel shading
// interpreter embeds (@etcito/raa-sdfm fieldPartShading); null when this build has no MAMA (parts keep vertex normals).
// Imported here, not at the top, so Node tests can import this module.
async function fieldEvaluator(): Promise<string | null> {
  try {
    const mod = await import('virtual:rf-mama') as { FIELD_PROGRAM_WGSL?: unknown }
    return typeof mod.FIELD_PROGRAM_WGSL === 'string' && mod.FIELD_PROGRAM_WGSL !== '' ? mod.FIELD_PROGRAM_WGSL : null
  } catch {
    return null
  }
}

// A frame between uploads lets a loading screen paint; a timer bounds the wait, since requestAnimationFrame
// fires rarely or never in the GPU client browser (an off-screen cross-origin frame).
const UPLOAD_YIELD_MS = 50
function paintOrTimer(): Promise<void> {
  return new Promise<void>(resolve => {
    let frame: number | null = null
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (frame !== null) cancelAnimationFrame(frame)
      resolve()
    }
    const timer = setTimeout(done, UPLOAD_YIELD_MS)
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(done)
  })
}

class SdfRenderPort implements ResizablePort {
  readonly kind = 'raa' as const
  private readonly meshed: ReadonlyMap<string, MeshedAsset>
  private readonly failed: ReadonlyMap<string, string>
  private engine: SdfEngine | null = null
  private canvas: HTMLCanvasElement | null = null
  private target: RenderTarget | null = null
  private readonly uploaded: (Uploaded | undefined)[] = []
  private readonly handleOfId = new Map<string, number>()
  private readonly handleOfName = new Map<string, number>()
  private readonly functions = new Map<string, string>()
  private readonly live: (Live | null)[] = []
  // Game handles whose pose changed since the last render; flushed as one setSkinPoses batch.
  private readonly posed = new Set<number>()
  // RAA instances given a player colour; a later untinted instance with a reused id clears it.
  private readonly tinted = new Set<number>()
  private whiteSurface: number | null = null
  private readonly normals: NormalsMode = normalsMode()
  private readonly debugNormals = normalsDebug()
  // GPU handles this port created, for the live inventory (it creates no texture).
  private meshes = 0
  private lastStats: RenderStats = { frameMs: 0, drawCalls: 0, triangles: 0, instances: 0, visible: 0 }

  // MAMA's field evaluator text (fieldEvaluator), null without MAMA.
  private readonly field: string | null

  constructor(meshed: ReadonlyMap<string, MeshedAsset>, failed: ReadonlyMap<string, string> = new Map(), field: string | null = null) {
    this.meshed = meshed
    this.failed = failed
    this.field = field
  }

  async init(target: RenderTarget): Promise<void> {
    const p = 'SdfRenderPort.init'
    const rects = viewRects(target.width, target.height, target.viewports)
    if (!(target.canvas instanceof HTMLCanvasElement)) refuse(AREA, WHERE, `${p}: pass an HTMLCanvasElement as the target canvas`)
    installShaderCache()
    this.engine = await createRaaEngine(target.canvas, { maxInstances: MAX_INSTANCES, maxMaterials: MAX_MATERIALS }) as SdfEngine
    this.engine.resize(target.width, target.height)
    if (!fullView(rects)) this.engine.setViewports(rects)
    this.engine.setLight(DEFAULT_LIGHT)
    this.engine.setAmbient(DEFAULT_AMBIENT)
    // One PBR material per object (RAA render option, on by default); an asset group tagged 'per-face-materials' keeps
    // its per-face materials (createInstance turns it off per instance).
    this.engine.setSingleMaterial(true)
    this.canvas = target.canvas
    this.target = { ...target, viewports: target.viewports.map(v => ({ ...v })) }
  }

  // Upload data only. The renderer requests pipelines for visible draws during gameplay;
  // off-screen course and costume shaders do not delay the first frame.
  async prepare(onProgress: (p: LoadProgress) => void, onTiming: (span: { step: string; start: number; end: number; ms: number }) => void): Promise<void> {
    const ids = [...this.meshed.keys()].sort()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      onProgress({ phase: 'upload', done: i, total: ids.length, label: `Uploading ${id}` })
      await checkAwait(`upload paint: ${id}`, () => paintOrTimer())
      const start = performance.now()
      this.registerAsset(id, { id } as PrimsAsset)
      const end = performance.now()
      onTiming({ step: `Mesh and material data: ${id}`, start, end, ms: end - start })
    }
    onProgress({ phase: 'upload', done: ids.length, total: ids.length, label: 'Assets uploaded' })
  }

  registerRoad(name: string, sweep: RoadData): number {
    const known = this.handleOfName.get(name)
    if (known !== undefined) return known
    const engine = this.need(), ribbon = roadMesh(sweep)
    const color = [1, 3, 5].map(i => parseInt(sweep.material.slice(i, i+2), 16)/255) as [number, number, number]
    const material = engine.addSurfaceMaterial({ color, roughness: sweep.surface === 'ice' ? .22 : .7 })
    const desc: MeshDesc = { positions: ribbon.positions, normals: ribbon.normals, uvs: ribbon.uvs, indices: ribbon.indices,
      subMeshes: [{ first: 0, count: ribbon.indices.length, material }] }
    const handle = this.uploaded.length
    this.uploaded.push({ assetId: name, parts: [{ name, key: name, mesh: this.addMesh(engine, desc), desc,
      subMeshes: desc.subMeshes!, t: [0,0,0], r: [0,0,0,1], tint: 'none' }] })
    this.handleOfName.set(name, handle)
    return handle
  }

  registerAsset(name: string, asset: PrimsAsset): number {
    const named = this.handleOfName.get(name)
    if (named !== undefined) return named
    const id = (asset as { id?: unknown }).id
    if (typeof id !== 'string' || id === '') {
      refuse(AREA, WHERE, `registerAsset('${name}'): the asset has no string id; the SDF port resolves the visual by S12 id`)
    }
    const known = this.handleOfId.get(id)
    if (known !== undefined) {
      this.handleOfName.set(name, known)
      return known
    }
    const meshed = this.meshed.get(id)
    // An asset the mesher refused at load (permissive load) gets a visual with no part: its instances draw nothing.
    const empty = meshed === undefined && this.failed.has(id)
    if (meshed === undefined && !empty) refuse(AREA, id, `not meshed; mesh asset '${id}' before the SDF port uploads it`)
    if (meshed !== undefined && meshed.assetId !== id) refuse(AREA, id, `the meshed entry says asset '${meshed.assetId}'; clear the mesh cache and remesh the asset`)
    const uploaded: Uploaded = meshed === undefined ? { assetId: id, parts: [] } : roundStep(`Mesh upload / materials: ${id}`, () => this.upload(id, meshed))
    const handle = this.uploaded.length
    this.uploaded.push(uploaded)
    this.handleOfId.set(id, handle)
    this.handleOfName.set(name, handle)
    return handle
  }

  // Mirrors @etcito/raa-sdfm's upload: one mesh per part with one sub-mesh per MAMA material, each
  // drawn with its own surface material built from the compiled graph; a part with its per-pixel shading draws the one
  // shading material on every sub-mesh instead (shadingMaterial).
  private upload(id: string, meshed: MeshedAsset): Uploaded {
    const payload = payloadOf(id, meshed)
    const engine = this.need()
    const handles = new Map<string, number>()
    const graph = new Set<string>()
    for (const compiled of payload.materials) {
      const mapped = mapCompiled(compiled, id)
      this.addFunction(mapped.functionName, mapped.wgsl)
      handles.set(compiled.name, engine.addSurfaceMaterial({ ...mapped.desc }))
      if (usesPlayerColour(compiled, mapped)) graph.add(compiled.name)
    }
    // An asset that uses the node puts its fixed materials in graph mode too: a tinted part may mix
    // them with a player-colour material, and in multiply mode the beak and feet would take the tint.
    if (graph.size > 0) for (const handle of new Set(handles.values())) engine.setMaterialTintMode(handle, 'graph')
    const parts: PartUpload[] = []
    const keys = new Set<string>()
    const emptyParts: string[] = []
    const data: number[] = []
    for (const group of payload.groups) {
      for (const part of group.parts) {
        if (part.meshes.length === 0) {
          emptyParts.push(part.name)
          continue
        }
        const built = partMesh(part, handles, graph, id)
        // One material per object: white x the blended vertex colours, with the part's roughness/metallic. A player-colour
        // part keeps its graph materials (the tint lives in them); a part with its per-pixel shading draws that instead,
        // and keeps this vertex-colour draw as its fallback while the shading compiles.
        const object = group.single !== false && built.desc.colors !== undefined && part.look !== undefined && built.tint !== 'graph'
          ? engine.addSurfaceMaterial({ color: [1, 1, 1], roughness: part.look.roughness, metallic: part.look.metallic }) : undefined
        let desc = built.desc
        let subMeshes = built.subMeshes
        const shaded = this.normals === 'pixel' ? this.shadingMaterial(id, part, payload.materials, graph.size > 0) : null
        let field: Pick<PartUpload, 'field' | 'fallback'> = {}
        if (shaded !== null) {
          data.push(shaded.data)
          // The rest point and rest frame the field reads (raa-sdfm fieldSurfaceAttributes) replace colours, uvs, tangents.
          subMeshes = subMeshes.map(sub => ({ ...sub, material: shaded.handle }))
          desc = { ...desc, ...fieldSurfaceAttributes(desc.positions, desc.normals), subMeshes }
          field = { field: materialKey(shaded.wgsl), fallback: {
            mesh: this.addMesh(engine, built.desc), desc: built.desc, subMeshes: built.subMeshes, ...(object !== undefined ? { object } : {}),
          } }
        }
        const mesh = this.addMesh(engine, desc)
        const { t, r } = frameToTr(part.frame)
        const key = keys.has(part.name) ? `${group.group}/${part.partId}` : part.name
        keys.add(key)
        parts.push({ name: part.name, key, mesh, desc, subMeshes, t, r, tint: built.tint, ...(shaded === null && object !== undefined ? { object } : {}), ...field })
      }
    }
    if (parts.length === 0) refuse(AREA, id, 'the meshed payload has no parts; save a game-asset group in SDF Modeler and remesh')
    return { assetId: id, parts, ...(emptyParts.length > 0 ? { emptyParts } : {}), ...(data.length > 0 ? { data } : {}) }
  }

  // Registers a material function once per name (a name is the hash of its code).
  private addFunction(name: string, wgsl: string): void {
    const known = this.functions.get(name)
    if (known !== undefined && known !== wgsl) refuse(AREA, WHERE, `material program hash collision: ${name}`)
    if (known !== undefined) return
    try {
      this.need().addMaterialFunction(name, wgsl)
    } catch (e) {
      if (raaCode(e) !== 'material.fn_duplicate') throw e
    }
    this.functions.set(name, wgsl)
  }

  // The per-pixel material of a part (owner 2026-11-04: normals and materials from the SDF in the shader, nothing
  // baked): its stored shading drawn by raa-sdfm fieldPartShading, the same code as SDF Modeler's Game view: ONE
  // interpreter function for every part whose materials are constant (the pipelines do not grow with the course), the
  // part itself a block of RAA material data words (its field program, operands, frame) named by the record's `data`. Null,
  // with one console warning naming the asset and part, when MAMA could not give the part a field (shadingError) or RAA
  // refuses the function: the part then keeps its per-face materials and vertex normals. A part with neither shading nor
  // shadingError was not made from an SDF document (MAMA writes one of the two for every meshed part; the zone's far-LOD
  // bean is generated in code): it keeps its vertex normals without a warning.
  private shadingMaterial(id: string, part: PayloadPart, materials: readonly SdfmCompiledMaterial[], graphMode: boolean): { handle: number; wgsl: string; data: number } | null {
    const where = `${id}#part:${part.name}`
    if (part.shading === undefined) {
      if (part.shadingError !== undefined) warnOnce(where, `vertex normals (${part.shadingError})`)
      return null
    }
    if (this.field === null) {
      warnOnce(where, 'vertex normals (this build has no MAMA field evaluator)')
      return null
    }
    const engine = this.need()
    let data: number | null = null
    try {
      const { name, wgsl, words, tintMode, missing } = fieldPartShading(part.shading, materials, { field: this.field, debug: this.debugNormals })
      if (missing.length > 0) warnOnce(`${where}:missing`, `material ${missing.map(m => `'${m}'`).join(', ')} not in the saved mesh; its shapes wear their colour`)
      this.addFunction(name, wgsl)
      data = engine.addMaterialData(words)
      const s = part.shading
      const handle = engine.addSurfaceMaterial(s.single ? { function: name, data, roughness: s.look.roughness, metallic: s.look.metallic } : { function: name, data, roughness: 0.5 })
      if (graphMode || tintMode === 'graph') engine.setMaterialTintMode(handle, 'graph')
      return { handle, wgsl, data }
    } catch (e) {
      if (data !== null) engine.removeMaterialData(data)
      warnOnce(where, `vertex normals (${messageOf(e)})`)
      return null
    }
  }

  // The rigid upload stays as is; skinned parts get a second mesh with the S18 joint/weight streams.
  // Later registerAsset calls of the id resolve to the skinned visual; a SceneView per match on the
  // same port registers it again and gets that visual back instead of a second upload.
  private readonly skins = new Map<string, SkinnedAssetT>()
  skinOf(assetId: string): SkinnedAssetT | undefined { return this.skins.get(assetId) }
  registerSkinned(assetId: string, skin: SkinnedAssetT): number {
    const bones = checkSkin(AREA, `registerSkinned(${assetId})`, skin)
    const known = this.handleOfId.get(assetId)
    if (known !== undefined && this.uploaded[known]!.bones !== undefined) {
      if (this.uploaded[known]!.bones !== bones) refuse(AREA, assetId, `already registered with ${this.uploaded[known]!.bones} bones, not ${bones}; pass the same raa-sdfm asset`)
      return known
    }
    const rigidHandle = this.registerAsset(assetId, { id: assetId } as PrimsAsset)
    const streams = new Map(skin.parts.map(part => [part.name, part.skin]))
    const engine = this.need()
    const parts = this.uploaded[rigidHandle]!.parts.map((part): PartUpload => {
      const s = streams.get(part.key)
      if (s === undefined) return part
      const vertices = part.desc.positions.length / 3
      if (s.joints.length !== vertices * 4) {
        refuse(AREA, `${assetId}#part:${part.key}`, `the skin has ${s.joints.length / 4} vertices and the mesh ${vertices}; remesh the asset from the same document`)
      }
      let max = 0
      for (let i = 0; i < s.joints.length; i++) if (s.joints[i] > max) max = s.joints[i]
      const desc: MeshDesc = { ...part.desc, joints: s.joints, weights: s.weights }
      const fallback = part.fallback === undefined ? {} : { fallback: this.fallbackMesh(engine, part.fallback, { ...part.fallback.desc, joints: s.joints, weights: s.weights }) }
      return { ...part, desc, mesh: this.addMesh(engine, desc), joints: max + 1, ...fallback }
    })
    if (!parts.some(part => part.joints !== undefined)) refuse(AREA, assetId, 'no skinned part matches a meshed part name; pass the parts of the same raa-sdfm asset')
    const handle = this.uploaded.length
    this.uploaded.push({ assetId, parts, bones, rig: skin.rig, clips: skin.clips ?? [], base: rigidHandle })
    this.handleOfId.set(assetId, handle)
    this.skins.set(assetId, skin)
    for (const [name, h] of this.handleOfName) if (h === rigidHandle) this.handleOfName.set(name, handle)
    return handle
  }

  setPose(instance: number, matrices: Float32Array): void {
    const live = this.liveOf(instance, 'setPose')
    if (live.bones === 0) refuse(AREA, WHERE, `setPose: instance ${instance} is not skinned; create it from a registerSkinned handle`)
    checkPose(AREA, WHERE, matrices, live.bones)
    live.pose = matrices.slice()
    this.posed.add(instance)
  }

  createInstance(asset: number, tint: Vec3T | null): number {
    const uploaded = this.uploaded[asset]
    if (uploaded === undefined) refuse(AREA, WHERE, `createInstance: unknown asset handle ${asset}; register the asset first with registerAsset`)
    if (tint !== null && (tint.length !== 3 || !tint.every(Number.isFinite))) refuse(AREA, WHERE, 'tint is not 3 finite numbers; pass [r, g, b] or null')
    const parts = tint === null ? uploaded.parts : this.tintableParts(uploaded)
    const engine = this.need()
    const root = engine.addNode(null)
    const instances: number[] = []
    const skin: SkinSlot[] = []
    const fallbacks: LiveFallback[] = []
    const add = (node: number, mesh: number, object: number | undefined, part: PartUpload): number => {
      const instance = engine.addMeshInstance(node, mesh)
      if (object !== undefined) engine.setInstanceMaterial(instance, object)
      else engine.setSingleMaterial(false, instance)
      // Cosmetic colourways multiply the existing fixed materials on the same mesh.
      // The character keeps its graph-selected skin tint so its beak and feet stay fixed.
      if (tint !== null && (part.tint !== 'none' || uploaded.assetId.startsWith('costume.'))) {
        engine.setInstanceTint(instance, [tint[0], tint[1], tint[2], 1])
        this.tinted.add(instance)
      } else if (this.tinted.delete(instance)) engine.clearInstanceTint(instance)
      if (part.joints !== undefined) skin.push({ instance, part })
      return instance
    }
    const device = this.device()
    parts.forEach((part, index) => {
      instances.push(add(engine.addNode(root, part.t, part.r), part.mesh, part.object, part))
      // While the part's shading pipelines compile, its vertex-colour copy draws in its place (owner 2026-11-04: never
      // omitted, never a ghost); render() removes the copy the frame the shading can draw.
      if (part.fallback !== undefined && !fieldReady(device, part.field!)) {
        const node = engine.addNode(root, part.t, part.r)
        fallbacks.push({ instance: add(node, part.fallback.mesh, part.fallback.object, part), node, part, index })
      }
    })
    this.live.push({ asset, root, instances, partNames: parts.map(part => part.name), emptyParts: uploaded.emptyParts ?? [], filter: null, visible: true, bones: uploaded.bones ?? 0, skin, pose: null, fallbacks })
    return this.live.length - 1
  }

  // The GPUDevice RAA configured this port's canvas with (asyncPipelines tracks its pipelines per device).
  private gpuDevice: object | undefined
  private device(): object | undefined {
    return this.gpuDevice ??= this.canvas === null ? undefined : deviceOfCanvas(this.canvas)
  }

  /** Parts drawn in vertex colour because their shading pipelines still compile, over the visible instances. */
  fallbackParts(): number {
    let count = 0
    for (const live of this.live) if (live !== null && live.visible) count += live.fallbacks.length
    return count
  }

  // Each vertex-colour copy goes the frame its part's shading has every requested pipeline compiled: the shading then
  // draws in the same render, so the part is never missing and never drawn twice past that frame.
  private swapFallbacks(engine: SdfEngine): void {
    const device = this.device()
    for (const live of this.live) {
      if (live === null || live.fallbacks.length === 0) continue
      live.fallbacks = live.fallbacks.filter(copy => {
        if (!fieldReady(device, copy.part.field!)) return true
        engine.removeNode(copy.node)
        this.tinted.delete(copy.instance)
        live.skin = live.skin.filter(slot => slot.instance !== copy.instance)
        return false
      })
    }
  }

  /**
   * The rigid assets the scene on this port has instances of, in upload order (skinned visuals and their rigid bases
   * left out): a port uploads every meshed asset of the content, a course draws only some of them.
   */
  warmableAssets(): string[] {
    const bases = new Set(this.uploaded.flatMap(entry => entry?.base === undefined ? [] : [entry.base]))
    const used = new Set(this.live.flatMap(live => live === null ? [] : [live.asset]))
    return [...this.handleOfId].filter(([, handle]) => {
      const entry = this.uploaded[handle]
      return entry !== undefined && entry.bones === undefined && !bases.has(handle) && used.has(handle)
    }).sort((a, b) => a[1] - b[1]).map(([id]) => id)
  }

  /**
   * The warm-up draw of a loading screen: one tiny instance of each listed asset (warmableAssets() when absent) just in
   * front of the viewport-0 camera, drawn once and removed, so RAA requests now every pipeline their parts need instead
   * of when they come into view. Skinned visuals are left to their scene: their posed variants need a pose.
   */
  warmPipelines(assetIds: readonly string[] = this.warmableAssets()): void {
    const engine = this.need()
    const camera = this.lastCamera ?? { eye: [0, 0, 0] as Vec3T, target: [0, 0, -1] as Vec3T, fovYDeg: 60, near: 0.1, far: 100 }
    if (this.lastCamera === null) this.setCamera(0, camera)
    const forward = [0, 1, 2].map(i => camera.target[i] - camera.eye[i])
    const length = Math.hypot(forward[0], forward[1], forward[2]) || 1
    const ahead = Math.max(camera.near * 4, 0.5)
    const at: Vec3T = [0, 1, 2].map(i => camera.eye[i] + forward[i] / length * ahead) as unknown as Vec3T
    const created: number[] = []
    for (const id of assetIds) {
      const handle = this.handleOfId.get(id)
      if (handle === undefined || this.uploaded[handle] === undefined) continue
      const instance = this.createInstance(handle, null)
      this.setTransform(instance, at, [0, 0, 0, 1], [1e-3, 1e-3, 1e-3])
      created.push(instance)
    }
    if (created.length === 0) return
    this.flushPoses(engine)
    engine.render(performance.now())
    for (const instance of created) this.destroyInstance(instance)
  }

  private fallbackMesh(engine: SdfEngine, fallback: Fallback, desc: MeshDesc): Fallback {
    return { ...fallback, desc, mesh: this.addMesh(engine, desc) }
  }

  setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void {
    const live = this.liveOf(instance, 'setTransform')
    this.need().setTransform(live.root, [t[0], t[1], t[2]], [r[0], r[1], r[2], r[3]], [s[0], s[1], s[2]])
  }

  setVisible(instance: number, visible: boolean): void {
    const live = this.liveOf(instance, 'setVisible')
    live.visible = visible
    this.applyVisibility(live)
  }

  setPartFilter(instance: number, parts: readonly string[] | null): void {
    const live = this.liveOf(instance, 'setPartFilter')
    if (parts !== null) for (const part of parts) {
      if (!live.partNames.includes(part) && !live.emptyParts.includes(part)) refuse(AREA, WHERE, `setPartFilter: unknown part '${part}'; use a part name from this asset`)
    }
    live.filter = parts === null ? null : new Set(parts)
    this.applyVisibility(live)
  }

  private applyVisibility(live: Live): void {
    const engine = this.need()
    const shown = (i: number): boolean => live.visible && (live.filter === null || live.filter.has(live.partNames[i]))
    live.instances.forEach((id, i) => engine.setVisible(id, shown(i)))
    for (const copy of live.fallbacks) engine.setVisible(copy.instance, shown(copy.index))
  }

  destroyInstance(instance: number): void {
    const live = this.liveOf(instance, 'destroyInstance')
    this.need().removeNode(live.root)
    this.live[instance] = null
    this.posed.delete(instance)
  }

  // Frees the asset's RAA meshes and forgets its handles, so a later registerAsset
  // of the same id re-uploads it. A skinned visual also frees the rigid upload it grew from.
  releaseAsset(handle: number): void {
    const uploaded = this.uploaded[handle]
    if (uploaded === undefined) return
    if (uploaded.base !== undefined) this.releaseUpload(uploaded.base)
    this.releaseUpload(handle)
  }

  private releaseUpload(handle: number): void {
    const uploaded = this.uploaded[handle]
    if (uploaded === undefined) return
    const engine = this.engine
    // Any instance still pointing at the asset goes with it (callers destroy them first).
    for (let i = 0; i < this.live.length; i++) {
      const live = this.live[i]
      if (live === null || live.asset !== handle) continue
      if (engine !== null) engine.removeNode(live.root)
      this.live[i] = null
      this.posed.delete(i)
    }
    const all = [...uploaded.parts, ...(uploaded.tintedParts ?? [])]
    if (engine !== null) {
      for (const mesh of all.flatMap(part => part.fallback === undefined ? [part.mesh] : [part.mesh, part.fallback.mesh])) {
        try { engine.removeMesh(mesh) } catch (e) { if (raaCode(e) !== 'api.unknown_handle') throw e }
      }
    }
    if (engine !== null) for (const base of uploaded.data ?? []) engine.removeMaterialData(base)
    this.meshes -= all.length + uploaded.parts.filter(part => part.fallback !== undefined).length
    this.uploaded[handle] = undefined
    for (const [name, h] of this.handleOfName) if (h === handle) this.handleOfName.delete(name)
    for (const [id, h] of this.handleOfId) if (h === handle) this.handleOfId.delete(id)
  }

  setCamera(viewport: number, cam: CameraPose): void {
    const engine = this.need()
    const count = this.target!.viewports.length
    if (!Number.isInteger(viewport) || viewport < 0 || viewport >= count) {
      refuse(AREA, WHERE, `setCamera: viewport ${viewport} does not exist; use an index from 0 to ${count - 1}`)
    }
    const camera = { eye: [...cam.eye] as [number, number, number], target: [...cam.target] as [number, number, number], fovYDeg: cam.fovYDeg, near: cam.near, far: cam.far, ...(cam.up ? { up: [...cam.up] as [number, number, number] } : {}) }
    if (count === 1) engine.setCamera(camera)
    else engine.setViewportCamera(viewport, camera)
    if (viewport === 0) this.lastCamera = cam
  }

  // The viewport-0 camera last set (warmPipelines draws in front of it).
  private lastCamera: CameraPose | null = null

  resize(cssW: number, cssH: number, dpr: number, viewports: Viewport[]): void {
    const engine = this.need()
    const rects = viewRects(cssW, cssH, viewports)
    if (!Number.isFinite(dpr) || dpr <= 0) refuse(AREA, WHERE, 'resize: dpr must be finite and positive; pass the device pixel ratio')
    const previous = this.target!
    const wasFull = fullView(viewRects(previous.width, previous.height, previous.viewports))
    engine.resize(cssW, cssH, dpr)
    // Reset a previous split layout too; the default full-canvas path needs no view call.
    if (!fullView(rects) || !wasFull) engine.setViewports(rects)
    this.target = { ...previous, width: cssW, height: cssH, viewports: viewports.map(v => ({ ...v })) }
  }

  // Everything is checked before the engine is touched, so a refusal never applies half an environment.
  setEnvironment(env: Readonly<Record<string, unknown>> | null): void {
    applyCourseEnvironment(this.need(), env, AREA, 'SdfRenderPort.setEnvironment')
  }

  render(): RenderStats {
    const engine = this.need()
    const t0 = performance.now()
    this.swapFallbacks(engine)
    this.flushPoses(engine)
    renderFrame(this, () => engine.render(t0))
    const frameMs = performance.now() - t0
    const stats = engine.stats()
    let visible = 0
    for (const live of this.live) if (live !== null && live.visible) visible++
    this.lastStats = { frameMs, drawCalls: stats.drawCalls, triangles: stats.triangles, instances: stats.instances, visible }
    return this.lastStats
  }

  // Assets are permanent in the upload table; the live inventory names the ones that still have an
  // instance, so a released lobby no longer reports its plaza or bean.
  inventory(): RenderInventory {
    const live = this.live.filter((entry): entry is Live => entry !== null)
    const liveHandles = new Set(live.map(entry => entry.asset))
    const assets = [...this.handleOfName].filter(([, handle]) => liveHandles.has(handle)).map(([name]) => name)
    return {
      assets: [...new Set(assets)].sort(),
      instances: live.length,
      meshes: this.meshes,
      textures: 0,
      skinned: live.filter(entry => entry.bones > 0).length,
    }
  }

  private addMesh(engine: SdfEngine, desc: MeshDesc): number {
    this.meshes++
    return engine.addMesh(desc)
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
    this.posed.clear()
  }

  // One RAA setSkinPoses call per frame for every character posed since the last frame. Each part
  // gets the first 16 x J matrices of its character's pose, moved into the part's mesh space.
  private flushPoses(engine: Engine): void {
    if (this.posed.size === 0) return
    const ids: number[] = []
    const slices: Float32Array[] = []
    let floats = 0
    for (const handle of this.posed) {
      const live = this.live[handle]
      if (!live || live.pose === null) continue
      for (const slot of live.skin) {
        const slice = partPose(live.pose, slot.part)
        ids.push(slot.instance)
        slices.push(slice)
        floats += slice.length
      }
    }
    this.posed.clear()
    if (ids.length === 0) return
    const matrices = new Float32Array(floats)
    let offset = 0
    for (const slice of slices) {
      matrices.set(slice, offset)
      offset += slice.length
    }
    engine.setSkinPoses(Uint32Array.from(ids), matrices)
  }

  private need(): SdfEngine {
    if (this.engine === null || this.target === null) refuse(AREA, WHERE, 'the port is not initialised or was disposed; call init first')
    return this.engine
  }

  private liveOf(instance: number, what: string): Live {
    const live = this.live[instance]
    if (!live) refuse(AREA, WHERE, `${what}: unknown or destroyed instance ${instance}; pass a handle from createInstance`)
    return live
  }

  // Graphs share their original meshes. Material-less parts keep the multiply tint on a white
  // standard surface; that surface and geometry are shared by every tint colour too.
  private tintableParts(uploaded: Uploaded): PartUpload[] {
    if (uploaded.tintedParts !== undefined) return uploaded.tintedParts
    const engine = this.need()
    uploaded.tintedParts = uploaded.parts.map(part => {
      if (part.tint !== 'multiply') return part
      const white = this.whiteSurface ??= engine.addSurfaceMaterial({ color: [1, 1, 1], roughness: 0.6 })
      const subMeshes = part.subMeshes.map(sub => ({ ...sub, material: sub.material ?? white }))
      const desc = { ...part.desc, subMeshes }
      if (part.fallback === undefined) return { ...part, desc, subMeshes, mesh: this.addMesh(engine, desc) }
      const fallbackSubMeshes = part.fallback.subMeshes.map(sub => ({ ...sub, material: sub.material ?? white }))
      const fallback = this.fallbackMesh(engine, { ...part.fallback, subMeshes: fallbackSubMeshes }, { ...part.fallback.desc, subMeshes: fallbackSubMeshes })
      return { ...part, desc, subMeshes, mesh: this.addMesh(engine, desc), fallback }
    })
    return uploaded.tintedParts
  }
}

// One console warning per asset part and reason per page (several ports may upload the same asset).
const warned = new Set<string>()
function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[sdf-port] ${key.replace(/:missing$/, '')}: ${text}`)
}

function fullView(rects: Viewport[]): boolean {
  return rects.length === 1 && rects[0].x === 0 && rects[0].y === 0 && rects[0].width === 1 && rects[0].height === 1
}

function viewRects(width: number, height: number, viewports: Viewport[]): Viewport[] {
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) {
    refuse(AREA, WHERE, 'canvas dimensions must be finite and positive; pass its width and height')
  }
  if (viewports.length < 1 || viewports.length > 4) refuse(AREA, WHERE, 'use 1..4 viewports inside the canvas')
  for (const [i, v] of viewports.entries()) {
    if (![v.x, v.y, v.width, v.height].every(Number.isFinite) || v.x < 0 || v.y < 0 || v.width <= 0 || v.height <= 0 || v.x + v.width > width || v.y + v.height > height) {
      refuse(AREA, WHERE, `viewport ${i} is outside the canvas or has an invalid size; use a positive rectangle inside ${width}x${height}`)
    }
    for (const other of viewports.slice(0, i)) {
      if (v.x < other.x + other.width && other.x < v.x + v.width && v.y < other.y + other.height && other.y < v.y + v.height) {
        refuse(AREA, WHERE, `viewport ${i} overlaps another viewport; move or shrink the rectangles so only their edges touch`)
      }
    }
  }
  return viewports.map(v => ({ x: v.x / width, y: v.y / height, width: v.width / width, height: v.height / height }))
}

// The rig poses the asset space; a part mesh lives in its frame F, so each skin matrix S becomes
// F^-1 * S * F (identity frames skip this).
function partPose(pose: Float32Array, part: PartUpload): Float32Array {
  const out = pose.slice(0, 16 * part.joints!)
  const [x, y, z, w] = part.r
  if (part.t.every(v => v === 0) && x === 0 && y === 0 && z === 0) return out
  const f = trMatrix(part.t, part.r)
  const inv = trMatrix([0, 0, 0], [-x, -y, -z, w])
  const back = mul4(inv, [-part.t[0], -part.t[1], -part.t[2], 1])
  inv[12] = back[0]
  inv[13] = back[1]
  inv[14] = back[2]
  const m = new Array<number>(16)
  for (let j = 0; j < out.length; j += 16) {
    for (let c = 0; c < 4; c++) {
      const col = mul4(Array.from(out.subarray(j, j + 16)), [f[c * 4], f[c * 4 + 1], f[c * 4 + 2], f[c * 4 + 3]])
      for (let r = 0; r < 4; r++) m[c * 4 + r] = col[r]
    }
    for (let c = 0; c < 4; c++) out.set(mul4(inv, m.slice(c * 4, c * 4 + 4)), j + c * 4)
  }
  return out
}

// Column-major rigid TRS matrix of a translation and a unit quaternion [x, y, z, w].
function trMatrix(t: readonly number[], q: readonly number[]): number[] {
  const [x, y, z, w] = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0], t[1], t[2], 1,
  ]
}

// Column-major 4x4 matrix times a 4-vector.
function mul4(m: readonly number[], v: readonly number[]): number[] {
  const out = [0, 0, 0, 0]
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[r] += m[c * 4 + r] * v[c]
  return out
}

function payloadOf(id: string, meshed: MeshedAsset): Payload {
  const data = meshed.data
  if (!isRecord(data)) return badPayload(id, 'data is not an object')
  if (!Array.isArray(data.groups)) return badPayload(id, 'data.groups is not an array')
  if (!Array.isArray(data.materials)) return badPayload(id, 'data.materials is not an array')
  for (const group of data.groups) {
    if (!isRecord(group) || !Array.isArray(group.parts)) return badPayload(id, 'a group has no parts array')
    for (const part of group.parts) {
      if (!isRecord(part)) return badPayload(id, 'a part is not an object')
      if (!(part.frame instanceof Float64Array) || part.frame.length !== 16) return badPayload(id, 'a part frame is not 16 Float64 numbers')
      if (!Array.isArray(part.meshes)) return badPayload(id, 'a part has no meshes array')
      for (const mesh of part.meshes) {
        if (!isRecord(mesh)) return badPayload(id, 'a mesh is not an object')
        if (!(mesh.positions instanceof Float32Array) || !(mesh.normals instanceof Float32Array) || !(mesh.indices instanceof Uint32Array)) {
          return badPayload(id, 'a mesh lacks Float32 positions/normals or Uint32 indices')
        }
        if (mesh.positions.length % 3 !== 0 || mesh.normals.length !== mesh.positions.length || mesh.indices.length % 3 !== 0) {
          return badPayload(id, 'a mesh has inconsistent vertex or index counts')
        }
        if (mesh.uvs !== null && !(mesh.uvs instanceof Float32Array)) return badPayload(id, 'a mesh has a non-Float32 uvs')
      }
    }
  }
  for (const material of data.materials) {
    if (!isRecord(material) || typeof material.name !== 'string' || typeof material.key !== 'string' || typeof material.body !== 'string' ||
      !Array.isArray(material.helpers) || !Array.isArray(material.constants) || !Array.isArray(material.fields)) {
      return badPayload(id, 'a compiled material lacks name/key/body/helpers/constants/fields')
    }
  }
  return data as unknown as Payload
}

// S23: a material takes the player colour when its graph holds input.player_color, which alone emits
// mat_instance_tint. The built raa-sdfm types do not declare tintMode yet, hence the WGSL fallback.
function usesPlayerColour(compiled: SdfmCompiledMaterial, mapped: SdfmMappedMaterial): boolean {
  if ((mapped as { tintMode?: unknown }).tintMode === 'graph') return true
  return [compiled.body, ...compiled.helpers.map(helper => helper.wgsl)].some(text => /\bmat_instance_tint\b/.test(text))
}

// One MeshDesc per part: MAMA meshes concatenated, one sub-mesh per material, first use first.
function partMesh(part: PayloadPart, handles: ReadonlyMap<string, number>, graph: ReadonlySet<string>, assetId: string): { desc: MeshDesc; subMeshes: SubMeshDesc[]; tint: PartTint } {
  const byMaterial = new Map<string | null, PayloadMesh[]>()
  for (const mesh of part.meshes) {
    const list = byMaterial.get(mesh.material)
    if (list === undefined) byMaterial.set(mesh.material, [mesh])
    else list.push(mesh)
  }
  const ordered = [...byMaterial.values()].flat()
  let vertices = 0
  let indexCount = 0
  for (const mesh of ordered) {
    vertices += mesh.positions.length / 3
    indexCount += mesh.indices.length
  }
  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const withUvs = ordered.some((mesh) => mesh.uvs !== null)
  const uvs = withUvs ? new Float32Array(vertices * 2) : null
  const indices = new Uint32Array(indexCount)
  const subMeshes: SubMeshDesc[] = []
  let base = 0
  let first = 0
  for (const [material, meshes] of byMaterial) {
    const start = first
    for (const mesh of meshes) {
      positions.set(mesh.positions, base * 3)
      normals.set(mesh.normals, base * 3)
      if (uvs !== null && mesh.uvs !== null) uvs.set(mesh.uvs, base * 2)
      for (let i = 0; i < mesh.indices.length; i++) indices[first + i] = mesh.indices[i] + base
      base += mesh.positions.length / 3
      first += mesh.indices.length
    }
    const sub: SubMeshDesc = { first: start, count: first - start }
    if (material !== null) {
      const handle = handles.get(material)
      if (handle === undefined) refuse(AREA, `${assetId}#part:${part.name}`, `uses material '${material}' that MAMA did not build; fix the material graph in SDF Modeler`)
      sub.material = handle
    }
    subMeshes.push(sub)
  }
  const desc: MeshDesc = { positions, normals, indices, subMeshes }
  if (uvs !== null) desc.uvs = uvs
  // One material per object: the vertex colours (graph materials ignore them; only the object material multiplies them).
  if (ordered.every(mesh => mesh.colors instanceof Float32Array && mesh.colors.length === mesh.positions.length / 3 * 4)) {
    const colors = new Float32Array(vertices * 4)
    let at = 0
    for (const mesh of ordered) { colors.set(mesh.colors!, at * 4); at += mesh.positions.length / 3 }
    desc.colors = colors
  }
  const materials = [...byMaterial.keys()]
  const tint: PartTint = materials.some(m => m !== null && graph.has(m)) ? 'graph'
    : graph.size === 0 && materials.every(m => m === null) ? 'multiply' : 'none'
  return { desc, subMeshes, tint }
}

// Translation and rotation of a column-major 4x4 MAMA part frame; a frame scale is not carried.
function frameToTr(f: Float64Array): { t: [number, number, number]; r: [number, number, number, number] } {
  const t: [number, number, number] = [f[12], f[13], f[14]]
  const col = (c: number): [number, number, number] => {
    const x = f[c * 4]
    const y = f[c * 4 + 1]
    const z = f[c * 4 + 2]
    const len = Math.hypot(x, y, z) || 1
    return [x / len, y / len, z / len]
  }
  const [c0, c1, c2] = [col(0), col(1), col(2)]
  const [m00, m10, m20] = c0
  const [m01, m11, m21] = c1
  const [m02, m12, m22] = c2
  const trace = m00 + m11 + m22
  let q: [number, number, number, number]
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]
  }
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return { t, r: [q[0] / n, q[1] / n, q[2] / n, q[3] / n] }
}

function mapCompiled(material: SdfmCompiledMaterial, assetId: string): SdfmMappedMaterial {
  try {
    return materialProgram(material)
  } catch (e) {
    refuse(AREA, `${assetId}#material:${material.name}`, `${messageOf(e)}; fix the material graph in SDF Modeler`)
  }
}

function raaCode(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null
  const code = (e as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function badPayload(id: string, what: string): never {
  return refuse(AREA, id, `the meshed payload is malformed (${what}); clear the mesh cache and remesh the asset`)
}
