// SDF render port: a RenderPort on the @etcito/raa release engine, fed with the upload payload the
// MAMA workers already produced (one mesh per part, split by material) and the graph materials
// compiled by @etcito/raa-sdfm's mapMaterial. RAA applies per-instance tint after the graph.
import { roundStep, renderFrame } from '@royal-fiesta/game/render/roundLoad'
import { loadRaa } from '@etcito/raa'
import type { Engine, MeshDesc, SubMeshDesc } from '@etcito/raa'
import { materialProgram } from './materialProgram.ts'
import type { SdfmCompiledMaterial, SdfmMappedMaterial } from '@etcito/raa-sdfm'
import type { LoadProgress } from '@royal-fiesta/game/content'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { CameraPose, QuatT, RenderPort, RenderStats, RenderTarget, Vec3T } from '@royal-fiesta/game/render/port'
import { refuse } from '@royal-fiesta/sim/refusal'
import { applyCourseEnvironment, DEFAULT_LIGHT, DEFAULT_AMBIENT } from '../render/courseEnvironment.ts'
import { raaStatus } from '../render/raaStatus.ts'
import type { MeshedAsset } from './mamaApi.ts'
import { installShaderCache } from '../render/shaderCache.ts'

const AREA = 'sdf'
const WHERE = 'sdf-port'
const MAX_INSTANCES = 4096
const MAX_MATERIALS = 1024

// The payload of apps/web/src/sdf/mama/worker.ts: MAMA parts with per-material meshes.
interface PayloadMesh { material: string | null; positions: Float32Array; normals: Float32Array; uvs: Float32Array | null; indices: Uint32Array }
interface PayloadPart { partId: string; name: string; frame: Float64Array; meshes: PayloadMesh[] }
interface PayloadGroup { group: string; parts: PayloadPart[] }
interface Payload { groups: PayloadGroup[]; materials: SdfmCompiledMaterial[] }

interface PartUpload { name: string; mesh: number; desc: MeshDesc; subMeshes: SubMeshDesc[]; t: [number, number, number]; r: [number, number, number, number] }
interface Uploaded { assetId: string; parts: PartUpload[]; tintedParts?: PartUpload[] }
interface Live { root: number; instances: number[]; visible: boolean }

export async function createSdfPort(target: RenderTarget, meshed: ReadonlyMap<string, MeshedAsset>,
  failed: ReadonlyMap<string, string> = new Map(),
  onProgress: (p: LoadProgress) => void = () => {},
  onTiming: (span: { step: string; start: number; end: number; ms: number }) => void = () => {}): Promise<RenderPort> {
  const status = await raaStatus()
  if (!status.available) refuse(AREA, WHERE, status.reason)
  const port = new SdfRenderPort(meshed, failed)
  const start = performance.now()
  await port.init(target)
  const end = performance.now()
  onTiming({ step: 'RAA engine init', start, end, ms: end - start })
  try {
    await port.prepare(onProgress, onTiming)
    return port
  } catch (e) {
    port.dispose()
    throw e
  }
}

class SdfRenderPort implements RenderPort {
  readonly kind = 'raa' as const
  private readonly meshed: ReadonlyMap<string, MeshedAsset>
  private readonly failed: ReadonlyMap<string, string>
  private engine: Engine | null = null
  private canvas: HTMLCanvasElement | null = null
  private target: RenderTarget | null = null
  private readonly uploaded: Uploaded[] = []
  private readonly handleOfId = new Map<string, number>()
  private readonly handleOfName = new Map<string, number>()
  private readonly functions = new Map<string, string>()
  private readonly live: (Live | null)[] = []
  private whiteSurface: number | null = null
  private lastStats: RenderStats = { frameMs: 0, drawCalls: 0, triangles: 0, instances: 0, visible: 0 }

  constructor(meshed: ReadonlyMap<string, MeshedAsset>, failed: ReadonlyMap<string, string> = new Map()) {
    this.meshed = meshed
    this.failed = failed
  }

  // Same target rule as raa-port: RAA has one camera and no scissor, so one full-canvas viewport.
  async init(target: RenderTarget): Promise<void> {
    const p = 'SdfRenderPort.init'
    if (target.viewports.length !== 1) refuse(AREA, WHERE, `${p}: RAA draws one full-canvas viewport, got ${target.viewports.length}; use one canvas per client`)
    const [vp] = target.viewports
    if (vp.x !== 0 || vp.y !== 0 || vp.width !== target.width || vp.height !== target.height) {
      refuse(AREA, WHERE, `${p}: the viewport must cover the whole ${target.width}x${target.height} canvas`)
    }
    if (!(target.canvas instanceof HTMLCanvasElement)) refuse(AREA, WHERE, `${p}: pass an HTMLCanvasElement as the target canvas`)
    installShaderCache()
    const raa = await loadRaa()
    this.engine = await raa.createEngine(target.canvas, { maxInstances: MAX_INSTANCES, maxMaterials: MAX_MATERIALS })
    this.engine.resize(target.width, target.height)
    this.engine.setLight(DEFAULT_LIGHT)
    this.engine.setAmbient(DEFAULT_AMBIENT)
    this.canvas = target.canvas
    this.target = target
  }

  // Upload data only. The renderer requests pipelines for visible draws during gameplay;
  // off-screen course and costume shaders do not delay the first frame.
  async prepare(onProgress: (p: LoadProgress) => void, onTiming: (span: { step: string; start: number; end: number; ms: number }) => void): Promise<void> {
    const ids = [...this.meshed.keys()].sort()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      onProgress({ phase: 'upload', done: i, total: ids.length, label: `Uploading ${id}` })
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const start = performance.now()
      this.registerAsset(id, { id } as PrimsAsset)
      const end = performance.now()
      onTiming({ step: `Mesh and material data: ${id}`, start, end, ms: end - start })
    }
    onProgress({ phase: 'upload', done: ids.length, total: ids.length, label: 'Assets uploaded' })
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
  // drawn with its own surface material built from the compiled graph.
  private upload(id: string, meshed: MeshedAsset): Uploaded {
    const payload = payloadOf(id, meshed)
    const engine = this.need()
    const handles = new Map<string, number>()
    for (const compiled of payload.materials) {
      const mapped = mapCompiled(compiled, id)
      const known = this.functions.get(mapped.functionName)
      if (known !== undefined && known !== mapped.wgsl) refuse(AREA, WHERE, `material program hash collision: ${mapped.functionName}`)
      if (known === undefined) {
        try {
          engine.addMaterialFunction(mapped.functionName, mapped.wgsl)
        } catch (e) {
          if (raaCode(e) !== 'material.fn_duplicate') throw e
        }
        this.functions.set(mapped.functionName, mapped.wgsl)
      }
      const base = engine.addSurfaceMaterial({ ...mapped.desc })
      handles.set(compiled.name, base)
    }
    const parts: PartUpload[] = []
    for (const group of payload.groups) {
      for (const part of group.parts) {
        const built = partMesh(part, handles, id)
        const mesh = engine.addMesh(built.desc)
        const { t, r } = frameToTr(part.frame)
        parts.push({ name: part.name, mesh, desc: built.desc, subMeshes: built.subMeshes, t, r })
      }
    }
    if (parts.length === 0) refuse(AREA, id, 'the meshed payload has no parts; save a game-asset group in SDF Modeler and remesh')
    return { assetId: id, parts }
  }

  createInstance(asset: number, tint: Vec3T | null): number {
    const uploaded = this.uploaded[asset]
    if (uploaded === undefined) refuse(AREA, WHERE, `createInstance: unknown asset handle ${asset}; register the asset first with registerAsset`)
    if (tint !== null && (tint.length !== 3 || !tint.every(Number.isFinite))) refuse(AREA, WHERE, 'tint is not 3 finite numbers; pass [r, g, b] or null')
    const parts = tint === null ? uploaded.parts : this.tintableParts(uploaded)
    const engine = this.need()
    const root = engine.addNode(null)
    const instances: number[] = []
    for (const part of parts) {
      const node = engine.addNode(root, part.t, part.r)
      const instance = engine.addMeshInstance(node, part.mesh)
      if (tint !== null) engine.setInstanceTint(instance, [tint[0], tint[1], tint[2], 1])
      instances.push(instance)
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

  // Everything is checked before the engine is touched, so a refusal never applies half an environment.
  setEnvironment(env: Readonly<Record<string, unknown>> | null): void {
    applyCourseEnvironment(this.need(), env, AREA, 'SdfRenderPort.setEnvironment')
  }

  render(): RenderStats {
    const engine = this.need()
    const t0 = performance.now()
    renderFrame(this, () => engine.render(t0))
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

  // Graphs share their original meshes. Material-less parts used a white standard surface
  // for tint before; keep that surface and geometry shared by every tint colour too.
  private tintableParts(uploaded: Uploaded): PartUpload[] {
    if (uploaded.tintedParts !== undefined) return uploaded.tintedParts
    const engine = this.need()
    uploaded.tintedParts = uploaded.parts.map(part => {
      if (part.subMeshes.every(sub => sub.material !== undefined)) return part
      this.whiteSurface ??= engine.addSurfaceMaterial({ color: [1, 1, 1], roughness: 0.6 })
      const subMeshes = part.subMeshes.map(sub => ({ ...sub, material: sub.material ?? this.whiteSurface! }))
      const desc = { ...part.desc, subMeshes }
      return { ...part, desc, subMeshes, mesh: engine.addMesh(desc) }
    })
    return uploaded.tintedParts
  }
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

// One MeshDesc per part: MAMA meshes concatenated, one sub-mesh per material, first use first.
function partMesh(part: PayloadPart, handles: ReadonlyMap<string, number>, assetId: string): { desc: MeshDesc; subMeshes: SubMeshDesc[] } {
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
  return { desc, subMeshes }
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
