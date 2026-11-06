import { resolveGameRigs } from '@royal-fiesta/game/rigReference'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { decodeMesh } from '../src/sdf/meshWire.ts'
import { assetSkin } from '../src/content/cosmeticSkin.ts'
import { restPoseSkin } from '@royal-fiesta/game/render/sceneView'
import { wornPalette } from '@royal-fiesta/game/anim/jiggle'
import { materialProgram } from '../src/sdf/materialProgram.ts'
import { checkPose, checkSkin } from '@royal-fiesta/game/render/nullPort'
import type { SkinnedAssetT } from '@royal-fiesta/game/render/port'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import * as raaSdfm from '@etcito/raa-sdfm'
import * as asyncPipelines from '../src/render/asyncPipelines.ts'
import * as renderOptions from '../src/render/renderOptions.ts'
import * as fieldAtlas from '../src/sdf/fieldAtlas.ts'
import * as fieldShading from '../src/sdf/fieldShading.ts'

import type { CameraPose, RenderTarget, Viewport } from '@royal-fiesta/game/render/port'

const FIELDS = ['base_color', 'metallic', 'roughness', 'emissive', 'height']
const PLAIN = 'return MaterialFull(vec3f(1.0, 0.5, 0.1), 0.0, 0.5, vec3f(0.0), 0.0);'
// The S23 emit of input.player_color, as MAMA compiles it into the material body.
const PLAYER = 'let c = select(vec3f(0.5), mat_instance_tint.rgb, mat_instance_tint_set > 0.5); return MaterialFull(c, 0.0, 0.5, vec3f(0.0), 0.0);'
const FRAME = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

interface ShadingReportLike {
  parts: number; field: number; vertex: number; texture: number; pending: number; pendingParts: readonly string[]; failed: number; refused: readonly string[]
  demoted: number; atlasFull: number; bytes: number; budget: number; errors: readonly string[]
}
interface Port {
  drawnParts(): { key: string; mode: string; reason?: string }[]
  worldBounds(): { key: string; min: number[]; max: number[] }[]
  setTransform(id: number, t: readonly number[], r: readonly number[], s: readonly number[]): void
  render(): void
  setShading(mode: 'field' | 'vertex' | 'baked'): void
  addTextured(assetId: string, meshed: unknown): void
  releaseAsset(handle: number): void
  engine: unknown; target: unknown
  shadingReport(): ShadingReportLike
  skinOf(id: string): SkinnedAssetT | undefined
  registerSkinned(id: string, skin: SkinnedAssetT): number
  setPose(id: number, pose: Float32Array): void
  flushPoses(engine: unknown): void
  init(target: RenderTarget): Promise<void>
  resize(w: number, h: number, dpr: number, views: Viewport[]): void
  setCamera(index: number, camera: CameraPose): void
  setPartFilter(instance: number, parts: readonly string[] | null): void
  setVisible(instance: number, visible: boolean): void
  prepare(progress: () => void, timing: () => void): Promise<void>
  registerAsset(name: string, asset: { id: string }): number
  createInstance(handle: number, tint: readonly number[] | null): number
  destroyInstance(handle: number): void
}

const source = readFileSync(new URL('../src/sdf/sdfPort.ts', import.meta.url), 'utf8')
// The port gets MAMA's field evaluator from virtual:rf-mama (sdfPort.ts fieldEvaluator); a stand-in of its shape here.
const FIELD = 'struct PmfSample { d: f32, g: vec3f, la: u32, lb: u32, t: f32 }\nfn pmf_eval(base: u32, p: vec3f) -> PmfSample { return PmfSample(0.0, p, 0u, 0u, 0.0); }'
const compiled = transpileModule(source + `\nexports.make = (meshed) => new SdfRenderPort(meshed, new Map(), ${JSON.stringify(FIELD)})\n` +
  `exports.makeWith = (meshed, render, contract) => new SdfRenderPort(meshed, new Map(), ${JSON.stringify(FIELD)}, render, contract)\n` +
  `exports.makeWithAtlas = (meshed, atlasBytes) => new SdfRenderPort(meshed, new Map(), null, undefined, null, atlasBytes)\n` +
  'exports.gameRenderOptions = gameRenderOptions\n', {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText
class FakeCanvas {}
let initEngine: ReturnType<typeof fakeEngine>['engine']

interface RenderOptions { shading: 'field' | 'vertex' | 'baked'; bakeTexelDensity: number; bakeMaxSize: number }
interface Contract {
  validate(input: unknown): { options: RenderOptions; issues: { key: string; message: string; fix: string }[] }
  specs: readonly { key: string; kind: string }[]
  bakeTextureSize(scale: number, options: RenderOptions): number
}
const exports = {} as {
  make(meshed: ReadonlyMap<string, unknown>): Port
  makeWith(meshed: ReadonlyMap<string, unknown>, render: RenderOptions, contract: Contract): Port
  makeWithAtlas(meshed: ReadonlyMap<string, unknown>, atlasBytes: number): Port
  gameRenderOptions: {
    (search?: string, chosen?: { shading?: string; normalsDebug?: boolean }): { shading: string; normalsDebug: boolean }
    (contract: Contract | null, given?: unknown, search?: string): RenderOptions
  }
}
const readiness = new WeakMap<object, (key: string) => asyncPipelines.PipelineReadiness>()
const warnings: string[] = []
const errors: string[] = []
runInNewContext(compiled, {
  console: { ...console, warn: (...args: unknown[]) => { warnings.push(args.join(' ')) }, error: (...args: unknown[]) => { errors.push(args.join(' ')) } },
  HTMLCanvasElement: FakeCanvas, exports, Float32Array, Float64Array, Uint32Array, performance, setTimeout, clearTimeout, URLSearchParams,
  require(id: string): unknown {
    if (id === '../game/checkProgress.ts') return { checkAwait: (_step: string, work: () => Promise<unknown>) => work() }
    if (id === '../render/raaEngine.ts') return { createRaaEngine: async () => initEngine }
    if (id === '../render/shaderCache.ts') return { installShaderCache() {} }
    if (id === '../render/asyncPipelines.ts') return { ...asyncPipelines, fieldReadiness: (device: object | undefined, key: string) =>
      (device === undefined ? undefined : readiness.get(device))?.(key) ?? asyncPipelines.fieldReadiness(device, key) }
    if (id === '../render/renderOptions.ts') return renderOptions
    if (id === '@royal-fiesta/game/render/nullPort') return { checkPose, checkSkin }
    if (id === './materialProgram.ts') return { materialProgram }
    if (id === './fieldAtlas.ts') return fieldAtlas
    if (id === './fieldShading.ts') return fieldShading
    if (id === '@etcito/raa-sdfm') return raaSdfm
    if (id === '@royal-fiesta/game/render/roundLoad') return { roundStep: (_name: string, fn: () => unknown) => fn(), renderFrame: (_port: unknown, fn: () => unknown) => fn() }
    if (id === '@royal-fiesta/sim/refusal') return { refuse: (...args: unknown[]) => { throw new Error(args.join(':')) } }
    return {}
  },
})

function material(name: string, body: string) {
  const key = [...name].map(c => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64)
  return { name, key, body, helpers: [], constants: [], fields: FIELDS }
}

function part(name: string, materialName: string | null) {
  return { name, partId: name, frame: FRAME, meshes: [{
    material: materialName, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: null, indices: new Uint32Array([0, 1, 2]),
  }] }
}

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const FIELD_NAME = 'pmf_eval_0123456789abcdef'
// A structurally valid field program (contract 'mama.field-program') for the port tests.
function fieldProgram(over: Record<string, unknown> = {}) {
  return {
    format: 'mama.field-program', version: 1,
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    labels: [{ material: null, color: [1, 0.4, 0.2], roughness: 0.5, metallic: 0 }],
    operands: [{ kind: 'box', label: 0, inv: IDENTITY16, scale: 1, half: [1, 1, 1], radius: 0 }],
    tree: [{ op: 'leaf', operand: 0 }],
    grid: null as null | { width: number; height: number; texels: Uint8Array },
    functionName: FIELD_NAME,
    wgsl: `fn ${FIELD_NAME}(p: vec3f, w: ptr<function, array<f32, 8>>) -> f32 { return 1.0; }`,
    ...over,
  }
}
function gridProgram(side = 4) {
  return fieldProgram({ operands: [{ kind: 'grid', label: 0, inv: IDENTITY16, scale: 1, origin: [-1, -1, -1], voxel: 1, size: [2, side, 2], at: [0, 0], range: 4 }], grid: { width: 4, height: side, texels: new Uint8Array(4 * side * 4) } })
}

// The fake engine records the calls; instance ids are handed out in order, mesh instances
// remember their mesh so a test can tell which part an instance draws.
function fakeEngine() {
  let next = 0
  const calls = {
    views: [] as Viewport[][], sizes: [] as number[][], cameras: [] as number[],
    visibility: new Map<number, boolean>(), nodes: new Map<number, number>(), removedMeshes: [] as number[],
    skinPoses: [] as { ids: Uint32Array; matrices: Float32Array }[],
    jointStreams: [] as unknown[],
    functionSources: new Map<string, string>(),
    functions: 0, surfaces: 0, meshes: 0, instances: 0, data: [] as Uint32Array[], freed: [] as number[],
    tints: new Map<number, number[][]>(), cleared: [] as number[], modes: new Map<number, string>(),
    meshOf: new Map<number, number>(), meshIds: [] as number[], nextInstance: 1000,
    single: [] as unknown[][], objectMaterials: new Map<number, number | null>(), descs: [] as Record<string, unknown>[],
    surfaceOf: new Map<number, Record<string, unknown>>(),
    textures: [] as { width: number; height: number; data: Uint8Array }[], removedTextures: [] as number[],
    instanceParams: [] as { instance: number; params: number[] }[],
  }
  const engine = {
    render() {}, stats: () => ({ drawCalls: 0, triangles: 0, instances: calls.instances }),
    removeMesh(id: number) { calls.removedMeshes.push(id) },
    resize(...args: number[]) { calls.sizes.push(args) },
    setViewports(views: Viewport[]) { calls.views.push(Array.from(views, v => ({ ...v }))) },
    setCamera() { calls.cameras.push(-1) },
    setViewportCamera(index: number) { calls.cameras.push(index) },
    setTransform() {},
    setVisible(id: number, visible: boolean) { calls.visibility.set(id, visible) },
    setLight() {}, setAmbient() {},
    addMaterialFunction(name: string, wgsl: string) { calls.functionSources.set(name, wgsl); calls.functions++ },
    addSurfaceMaterial(desc: Record<string, unknown>) { calls.surfaces++; calls.descs.push(desc); const id = ++next; calls.surfaceOf.set(id, desc); return id },
    addMaterialData(words: Uint32Array) { calls.data.push(words); return 4 + calls.data.slice(0, -1).reduce((n, w) => n + w.length, 0) },
    removeMaterialData(base: number) { calls.freed.push(base) },
    addTexture(texture: { width: number; height: number; data: Uint8Array }) { calls.textures.push(texture); return 100 + calls.textures.length },
    removeTexture(id: number) { calls.removedTextures.push(id) },
    setInstanceParams(instance: number, params: number[]) { calls.instanceParams.push({ instance, params: Array.from(params) }) },
    setSkinPoses(ids: Uint32Array, matrices: Float32Array) { calls.skinPoses.push({ ids, matrices }) },
    addMesh(desc: unknown) { calls.jointStreams.push(desc); calls.meshes++; const id = ++next; calls.meshIds.push(id); return id },
    addNode() { return ++next },
    removeNode() {},
    addMeshInstance(node: number, mesh: number) { calls.nodes.set(calls.nextInstance, node); calls.instances++; const id = calls.nextInstance++; calls.meshOf.set(id, mesh); return id },
    setInstanceTint(id: number, rgba: number[]) { calls.tints.set(id, [...(calls.tints.get(id) ?? []), Array.from(rgba)]) },
    clearInstanceTint(id: number) { calls.cleared.push(id) },
    setMaterialTintMode(handle: number, mode: string) { calls.modes.set(handle, mode) },
    setSingleMaterial(on: boolean | null, instance?: number) { calls.single.push([on, instance]) },
    setInstanceMaterial(instance: number, material: number | null) { calls.objectMaterials.set(instance, material) },
  }
  return { engine, calls }
}

function portFor(id: string, materials: unknown[], parts: unknown[], single?: boolean) {
  const meshed = new Map([[id, { assetId: id, data: { materials, groups: [{ group: 'g', parts, ...(single === undefined ? {} : { single }) }] } }]])
  const { engine, calls } = fakeEngine()
  const port = exports.make(meshed)
  port.engine = engine
  port.target = {}
  return { port, calls, handle: () => port.registerAsset(id, { id }) }
}

function portWithAtlas(id: string, materials: unknown[], parts: unknown[], atlasBytes: number) {
  const meshed = new Map([[id, { assetId: id, data: { materials, groups: [{ group: 'g', parts }] } }]])
  const { engine, calls } = fakeEngine()
  const port = exports.makeWithAtlas(meshed, atlasBytes)
  port.engine = engine
  port.target = {}
  return { port, calls, handle: () => port.registerAsset(id, { id }) }
}

function portWithRender(id: string, materials: unknown[], parts: unknown[], render: RenderOptions) {
  const meshed = new Map([[id, { assetId: id, data: { materials, groups: [{ group: 'g', parts }] } }]])
  const { engine, calls } = fakeEngine()
  const port = exports.makeWith(meshed, render, CONTRACT)
  port.engine = engine
  port.target = {}
  return { port, calls, handle: () => port.registerAsset(id, { id }) }
}

test('a part whose material graph holds input.player_color gets the palette tint in graph mode', async () => {
  const { port, calls, handle } = portFor('test.asset', [material('skin', PLAYER)], [part('body', 'skin')])
  await port.prepare(() => {}, () => {})
  assert.equal(calls.instances, 0, 'upload does not create warmup draws for off-screen assets')
  const h = handle()
  assert.deepEqual([...calls.modes.values()], ['graph'])
  port.createInstance(h, null)
  assert.equal(calls.tints.size, 0, 'an untinted instance gets no tint')
  for (const tint of PALETTE) port.createInstance(h, tint)
  assert.equal(calls.functions, 1)
  assert.equal(calls.surfaces, 1)
  assert.equal(calls.meshes, 1, 'every colour shares the graph material and geometry')
  assert.deepEqual([...calls.tints.values()].flat(), PALETTE.map(rgb => [...rgb, 1]))
  // RAA may hand a tinted instance id out again: an untinted instance then clears it.
  const tinted = calls.nextInstance - 1
  calls.nextInstance = tinted
  port.createInstance(h, null)
  assert.deepEqual(calls.cleared, [tinted])
})

test('a part named player-body with a plain material gets no tint', () => {
  const { port, calls, handle } = portFor('test.plain', [material('player-grey', PLAIN)], [part('player-body', 'player-grey')])
  const h = handle()
  for (const tint of PALETTE) port.createInstance(h, tint)
  assert.equal(calls.tints.size, 0)
  assert.equal(calls.modes.size, 0, 'a plain asset keeps the default multiply mode')
})

test('the fixed material of a graph asset is in graph mode and its part gets no tint', () => {
  const { port, calls, handle } = portFor('test.penguin', [material('skin', PLAYER), material('beak', PLAIN)],
    [part('body', 'skin'), part('beak', 'beak')])
  const h = handle()
  assert.equal(calls.surfaces, 2)
  assert.deepEqual([...calls.modes.values()], ['graph', 'graph'], 'both the player and the fixed material are in graph mode')
  port.createInstance(h, PALETTE[1])
  const [bodyMesh, beakMesh] = calls.meshIds
  const tinted = [...calls.tints.keys()].map(id => calls.meshOf.get(id))
  assert.deepEqual(tinted, [bodyMesh])
  assert.ok(!tinted.includes(beakMesh))
})

test('a prims asset (no SDF material) is still multiplied on a shared white surface', () => {
  const { port, calls, handle } = portFor('test.prims', [], [part('box', null)])
  const h = handle()
  const meshes = calls.meshes
  for (const tint of PALETTE) port.createInstance(h, tint)
  assert.equal(calls.meshes, meshes + 1, 'one white-surface mesh shared across all colours')
  assert.equal(calls.surfaces, 1)
  assert.equal(calls.modes.size, 0)
  assert.deepEqual([...calls.tints.values()].flat(), PALETTE.map(rgb => [...rgb, 1]))
})

const quarters = [
  { x: 0, y: 0, width: 100, height: 50 },
  { x: 100, y: 0, width: 100, height: 50 },
  { x: 0, y: 50, width: 100, height: 50 },
  { x: 100, y: 50, width: 100, height: 50 },
]
const camera: CameraPose = { eye: [0, 1, 2], target: [0, 0, 0], fovYDeg: 50, near: 0.1, far: 100 }
async function initViews(views: Viewport[]) {
  const fake = fakeEngine()
  initEngine = fake.engine
  const port = exports.make(new Map())
  await port.init({ canvas: new FakeCanvas(), width: 200, height: 100, viewports: views })
  return { port, calls: fake.calls }
}

test('four quarter viewports use half-width and half-height fractions and viewport cameras', async () => {
  const { port, calls } = await initViews(quarters)
  assert.deepEqual(calls.views, [[
    { x: 0, y: 0, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  ]])
  port.setCamera(2, camera)
  assert.deepEqual(calls.cameras, [2])
  for (const index of [-1, 4, 0.5, NaN]) assert.throws(() => port.setCamera(index, camera), /use an index/)
})

test('invalid viewport counts, bounds and overlaps are refused', async () => {
  await assert.rejects(initViews([quarters[0], quarters[0]]), /overlaps.*move or shrink/)
  for (const views of [[], [...quarters, quarters[0]]]) await assert.rejects(initViews(views), /1\.\.4/)
  for (const rect of [{ ...quarters[0], x: -1 }, { ...quarters[0], width: 201 }, { ...quarters[0], height: 0 }, { ...quarters[0], x: NaN }]) {
    await assert.rejects(initViews([rect]), /positive rectangle inside/)
  }
})

test('single full-canvas viewport keeps the existing camera path', async () => {
  const { port, calls } = await initViews([{ x: 0, y: 0, width: 200, height: 100 }])
  port.setCamera(0, camera)
  assert.deepEqual(calls.views, [])
  assert.deepEqual(calls.cameras, [-1])
  port.resize(400, 200, 2, [{ x: 0, y: 0, width: 400, height: 200 }])
  assert.deepEqual(calls.views, [])
})

test('resize forwards dpr and reapplies views, including returning to full canvas', async () => {
  const { port, calls } = await initViews(quarters)
  port.resize(400, 200, 1.5, quarters.map(v => ({ x: v.x * 2, y: v.y * 2, width: v.width * 2, height: v.height * 2 })))
  assert.deepEqual(calls.sizes, [[200, 100], [400, 200, 1.5]])
  assert.deepEqual(calls.views[1], calls.views[0])
  assert.throws(() => port.resize(400, 200, 2, [quarters[0], quarters[0]]), /overlaps/)
  assert.equal(calls.sizes.length, 2)
  port.resize(400, 200, 2, [{ x: 0, y: 0, width: 400, height: 200 }])
  assert.deepEqual(calls.views[2], [{ x: 0, y: 0, width: 1, height: 1 }])
  assert.throws(() => port.setCamera(2, camera), /use an index/)
})

test('a part kept by name with no mesh (a hidden collider) is a valid filter entry and draws nothing', () => {
  const hidden = { name: 'collider_0', partId: 'collider_0', frame: FRAME, meshes: [] }
  const { port, calls, handle } = portFor('test.hidden', [], [part('base', null), hidden, part('plank', null)])
  const instance = port.createInstance(handle(), null)
  port.setPartFilter(instance, ['plank', 'collider_0'])
  assert.deepEqual([...calls.visibility.values()], [false, true])
  assert.throws(() => port.setPartFilter(instance, ['collider_9']), /unknown part/)
})

test('part filter hides other parts and composes with instance visibility', () => {
  const { port, calls, handle } = portFor('test.parts', [], [part('body', null), part('beak', null)])
  const instance = port.createInstance(handle(), null)
  port.setPartFilter(instance, ['body'])
  assert.deepEqual([...calls.visibility.values()], [true, false])
  assert.throws(() => port.setPartFilter(instance, ['missing']), /unknown part/)
  assert.deepEqual([...calls.visibility.values()], [true, false])
  port.setVisible(instance, false)
  port.setPartFilter(instance, null)
  assert.deepEqual([...calls.visibility.values()], [false, false])
  port.setVisible(instance, true)
  assert.deepEqual([...calls.visibility.values()], [true, true])
  port.setPartFilter(instance, [])
  assert.deepEqual([...calls.visibility.values()], [false, false])
})

test('cosmetic variants tint fixed graph materials per instance without new meshes or surfaces', () => {
  const { port, calls, handle } = portFor('costume.jester-hat', [material('cloth', PLAIN)], [part('hat', 'cloth')])
  const h = handle()
  const meshes = calls.meshes, surfaces = calls.surfaces
  port.createInstance(h, null)
  port.createInstance(h, [0.12, 0.85, 0.78])
  port.createInstance(h, [1, 0.22, 0.48])
  assert.equal(calls.meshes, meshes)
  assert.equal(calls.surfaces, surfaces)
  assert.equal(new Set(calls.meshOf.values()).size, 1)
  assert.deepEqual([...calls.tints.values()].flat(), [[0.12, 0.85, 0.78, 1], [1, 0.22, 0.48, 1]])
  const reused = calls.nextInstance - 1
  calls.nextInstance = reused
  port.createInstance(h, null)
  assert.deepEqual(calls.cleared, [reused])
})


test('SDF cosmetic rendering uploads joint streams and submits the penguin matrices to RAA', () => {
  const { port, calls } = portFor('costume.skinned', [material('cloth', PLAIN)], [part('coat', 'cloth')])
  const skin: SkinnedAssetT = {rig:{name:'penguin',bones:[{name:'root',parent:null}]},parts:[{name:'coat',skin:{
    joints:new Uint16Array(12),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]),
  }}]}
  const handle=port.registerSkinned('costume.skinned',skin)
  assert.equal(port.skinOf('costume.skinned'),skin)
  assert.ok(calls.jointStreams.some(d => (d as {joints?:unknown}).joints === skin.parts[0].skin!.joints))
  const instance=port.createInstance(handle,null)
  const matrices=Float32Array.from(FRAME);matrices[13]=0.4
  port.setPose(instance,matrices)
  port.flushPoses(port.engine)
  assert.equal(calls.skinPoses.length,1)
  assert.equal(calls.skinPoses[0].ids.length,1)
  assert.deepEqual(Array.from(calls.skinPoses[0].matrices),Array.from(matrices))
})


// Owner 2026-11-05: a field part keeps its field shading when it is skinned. registerSkinned adds joints/weights to the
// part's mesh while the rest point and rest frame stay in mesh space (the space of the field program), the field
// material stays on every sub-mesh and the instance params reach the skinned instance; sdfm_posed_normal then carries
// the rest-space gradient through the skin, so the posed penguin and its worn cosmetics shade from their fields.
test('a skinned field part keeps its field material, instance params and rest streams', () => {
  const body = { ...part('body', 'skin'), fieldProgram: gridProgram() }
  const { port, calls } = portFor('test.skinned-field', [material('skin', PLAIN)], [body])
  const skin: SkinnedAssetT = { rig: { name: 'penguin', bones: [{ name: 'root', parent: null }] }, parts: [{ name: 'body', skin: {
    joints: new Uint16Array(12), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  } }] }
  const handle = port.registerSkinned('test.skinned-field', skin)
  const fieldHandle = [...calls.surfaceOf].find(([, desc]) => typeof desc.function === 'string' && desc.function.startsWith('pmf.'))?.[0]
  assert.ok(fieldHandle !== undefined, 'the field material is built')
  const skinned = calls.jointStreams.filter((d: any) => d.joints !== undefined) as {
    joints: Uint16Array; weights: Float32Array; positions: Float32Array
    colors?: Float32Array; uvs?: Float32Array; tangents?: Float32Array; subMeshes: { material?: number }[]
  }[]
  const field = skinned.find(d => d.subMeshes.length > 0 && d.subMeshes.every(s => s.material === fieldHandle))
  assert.ok(field !== undefined, 'the skinned field mesh keeps the field material on every sub-mesh')
  assert.equal(field.joints, skin.parts[0].skin!.joints)
  assert.equal(field.weights, skin.parts[0].skin!.weights)
  assert.ok(field.colors !== undefined && field.uvs !== undefined && field.tangents !== undefined, 'the rest point and rest frame streams are kept')
  assert.deepEqual(Array.from(field.colors!.subarray(0, 3)), Array.from(field.positions.subarray(0, 3)), 'the rest point stays mesh-space')
  const first = calls.nextInstance
  const instance = port.createInstance(handle, null)
  const params = calls.instanceParams.find(p => p.instance === first)
  assert.ok(params !== undefined, 'the skinned field instance gets its instance params')
  assert.equal(params.params[8], 4, 'the params name the field grid image width')
  const matrices = Float32Array.from(FRAME); matrices[13] = 0.4
  port.setPose(instance, matrices)
  port.flushPoses(port.engine)
  assert.equal(calls.skinPoses.length, 1)
  assert.ok(Array.from(calls.skinPoses[0].ids).includes(first), 'the skinned field instance is posed through flushPoses')
})

// A 'multiply' field part is tinted through its own field material: the tinted draw is the field twin of the white
// surface, never a vertex-coloured white copy (no white surface and no second mesh are built for the colourway).
test('a tinted multiply field part draws the field twin, not a white vertex copy', () => {
  const body = { ...part('body', null), fieldProgram: fieldProgram() }
  const { port, calls, handle } = portFor('test.tint-field', [], [body])
  const h = handle()
  const meshes = calls.meshes, surfaces = calls.surfaces
  const fieldHandle = [...calls.surfaceOf].find(([, desc]) => typeof desc.function === 'string' && desc.function.startsWith('pmf.'))?.[0]
  const first = calls.nextInstance
  port.createInstance(h, [0.9, 0.2, 0.4])
  assert.deepEqual(calls.tints.get(first), [[0.9, 0.2, 0.4, 1]], 'the colourway tint multiplies the field material')
  assert.equal(calls.surfaces, surfaces, 'no white surface is added for a field part')
  assert.equal(calls.meshes, meshes, 'the tinted instance reuses the field mesh')
  const mesh = calls.meshOf.get(first)!
  const desc = calls.jointStreams[calls.meshIds.indexOf(mesh)] as { subMeshes: { material?: number }[] }
  assert.ok(desc.subMeshes.length > 0 && desc.subMeshes.every(s => s.material === fieldHandle), 'the tinted draw keeps the field material')
})

test('a uniform frame scales geometry and field lookup together', () => {
  const frame = new Float64Array(FRAME); frame[0] = 2; frame[5] = 2; frame[10] = 2
  const body = { ...part('body', 'skin'), frame, fieldProgram: fieldProgram() }
  const { port, calls, handle } = portFor('test.scale', [material('skin', PLAIN)], [body])
  port.createInstance(handle(), null)
  const report = port.shadingReport()
  assert.equal(report.field, 1)
  assert.equal(report.vertex, 0)
  assert.equal(report.errors.length, 0)
  assert.ok(calls.instanceParams.some(p => p.params[3] === 2))
  const mesh = calls.jointStreams[0] as { positions: Float32Array }
  assert.deepEqual(Array.from(mesh.positions), Array.from(body.meshes[0].positions, v => v * 2))
})

test('a non-uniform field frame still refuses with the part name', () => {
  const frame = new Float64Array(FRAME); frame[0] = 2
  const body = { ...part('body', 'skin'), frame, fieldProgram: fieldProgram() }
  const { port, handle } = portFor('test.scale', [material('skin', PLAIN)], [body])
  handle()
  assert.equal(port.shadingReport().vertex, 1)
  assert.ok(port.shadingReport().errors.includes('test.scale#g/body: field frame has non-uniform scale; mesh normals'))
})

test('all committed catalog cosmetics upload their saved skin and render with the penguin idle pose', async () => {
  const root=new URL('../../../',import.meta.url)
  const body=JSON.parse(readFileSync(new URL('assets/common/penguin.body.asset.json',root),'utf8'))
  const owner=Object.values(body.document.nodes).find((n:any)=>n.rig) as any
  const matrices=restPoseSkin(owner.rig,12)
  for(const id of readdirSync(new URL('assets/common/',root)).filter(n=>/^costume\..*\.asset\.json$/.test(n)).map(n=>n.replace(/\.asset\.json$/,''))) {
    const document=JSON.parse(readFileSync(new URL(`assets/common/${id}.asset.json`,root),'utf8')).document
    const mesh=decodeMesh(new Uint8Array(readFileSync(new URL(`assets/common/${id}.mesh`,root))))
    const data=mesh.data as {groups:{parts:unknown[]}[]}
    const {engine,calls}=fakeEngine(), port=exports.make(new Map([[id,mesh]]))
    port.engine=engine;port.target={}
    const resolved = await resolveGameRigs(document, async (game,id) => game === body.game && id === body.id ? body.document : null)
    const skin=assetSkin(data,resolved,owner.rig)!
    const handle=port.registerSkinned(id,skin)
    const instance=port.createInstance(handle,null)
    // The palette the game draws: the penguin pose, or its mount bone for every bone of an own armature (jester hat).
    port.setPose(instance,wornPalette(skin,matrices))
    port.flushPoses(engine)
    assert.ok(calls.skinPoses[0].ids.length>0,`${id}: posed draw submitted`)
    assert.ok(calls.skinPoses[0].matrices.some((v,i)=>Math.abs(v-(i%16%5===0?1:0))>1e-4),`${id}: deforming matrices`)
    assert.equal(port.skinOf(id),skin)
  }
})

// Current saved meshes carry fieldProgram or a named fieldRefusal, including costume deformers.
test('saved penguin and costume parts retain complete geometry with fields or named fallbacks', () => {
  const root = new URL('../../../', import.meta.url)
  const ids = ['penguin.body', ...readdirSync(new URL('assets/common/', root))
    .filter(n => /^costume\..*\.mesh$/.test(n)).map(n => n.replace(/\.mesh$/, ''))]
  for (const id of ids) {
    const mesh = decodeMesh(new Uint8Array(readFileSync(new URL(`assets/common/${id}.mesh`, root))))
    const parts = (mesh.data as { groups: { parts: { fieldProgram?: unknown; fieldRefusal?: string; meshes: unknown[] }[] }[] })
      .groups.flatMap(g => g.parts).filter(p => p.meshes.length)
    for (const part of parts) assert.ok(part.fieldProgram || part.fieldRefusal, `${id}: missing field or refusal`)
    const { engine, calls } = fakeEngine()
    const port = exports.make(new Map([[id, mesh]]))
    const device = {}
    readiness.set(device, () => ({ status: 'ready' }))
    Object.assign(port, { engine, target: {}, gpuDevice: device })
    port.createInstance(port.registerAsset(id, { id }), null)
    const drawn = port.drawnParts()
    assert.equal(drawn.length, parts.length, `${id}: no dropped part`)
    for (const part of drawn) assert.ok(part.mode === 'field' || part.reason, `${part.key}: unnamed fallback`)
    const fields = drawn.filter(p => p.mode === 'field').length
    const shaded = calls.descs.filter(d => typeof d.function === 'string' && d.function.startsWith('pmf.'))
    assert.equal(shaded.length, fields, `${id}: a surface record for each field part`)
    assert.equal(calls.jointStreams.length, parts.length + fields, `${id}: resident vertex copy for each field`)
  }
})

// Owner 2026-11-04: while a part's SDF field pipelines compile, the part draws in vertex colour (its `?normals=vertex`
// copy) and swaps to the field the frame they are compiled: never omitted, never a ghost.
test('a shaded part draws its vertex-colour copy until every pipeline of its shading is compiled, then swaps', async () => {
  const root = new URL('../../../', import.meta.url)
  const id = 'penguin.body'
  const mesh = decodeMesh(new Uint8Array(readFileSync(new URL(`assets/common/${id}.mesh`, root))))
  const parts = (mesh.data as { groups: { parts: { meshes: unknown[] }[] }[] }).groups.flatMap(g => g.parts).filter(p => p.meshes.length)
  const resolvers: (() => void)[] = []
  class Device {
    createShaderModule(descriptor: { code: string }): object { return { code: descriptor.code } }
    createPipelineLayout(_descriptor: unknown): object { return {} }
    createRenderPipeline(_descriptor: unknown): object { return {} }
    createRenderPipelineAsync(_descriptor: unknown): Promise<object> { return new Promise(done => resolvers.push(() => done({}))) }
  }
  class Pass { setPipeline(): void {} drawIndexed(): void {} }
  class Context { canvas = new FakeCanvas(); configure(_config: unknown): void {} }
  asyncPipelines.installAsyncLitPipelines(Device.prototype, Pass.prototype, Context.prototype)
  const device = new Device(), context = new Context()
  context.configure({ device })
  const { engine, calls } = fakeEngine()
  const shadings: string[] = []
  const names: string[] = []
  const removed: number[] = []
  Object.assign(engine, {
    addMaterialFunction(name: string, wgsl: string) { calls.functions++; if (name.startsWith('pmf.')) { shadings.push(wgsl); names.push(name) } },
    removeNode(node: number) { removed.push(node) },
    render() {}, stats: () => ({ drawCalls: 0, triangles: 0, instances: 0 }),
  })
  const port = exports.make(new Map([[id, mesh]]))
  port.engine = engine; port.target = {}
  Object.assign(port, { canvas: context.canvas })
  port.createInstance(port.registerAsset(id, { id }), null)
  // The parts share the interpreter: the parts of one function swap together.
  const partsOf = (name: string) => calls.descs.filter(d => d.function === name).length
  assert.ok(shadings.length >= 1 && shadings.length <= parts.length, `${shadings.length} shading functions for ${parts.length} parts`)
  assert.equal(names.reduce((n, name) => n + partsOf(name), 0), parts.length)
  assert.equal(calls.instances, parts.length * 2, 'each part draws its shading and, meanwhile, its vertex-colour copy')
  const view = port as unknown as { render(): void; fallbackParts(): number }
  assert.equal(view.fallbackParts(), parts.length)
  view.render()
  assert.deepEqual(removed, [], 'nothing compiled yet: the copies stay')
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] })
  const request = (wgsl: string, pass: string) => device.createRenderPipeline({ label: 'raa.lit.pipeline', layout, vertex: { module: device.createShaderModule({
    code: `// raa variant: material sdff.x, pass ${pass}, msaa 1\n\n// raa section: prelude\n\n// raa section: material "sdff.x"\n${wgsl}\n// raa section: pass ${pass}\n` }) } })
  for (const wgsl of shadings) { request(wgsl, 'Shadow'); request(wgsl, 'Forward') }
  resolvers.splice(0, 1).forEach(done => done())
  await new Promise(resolve => setTimeout(resolve, 0))
  view.render()
  assert.deepEqual(removed, [], 'a compiled shadow variant alone does not swap')
  resolvers.splice(0, 1).forEach(done => done())
  await new Promise(resolve => setTimeout(resolve, 0))
  view.render()
  assert.equal([...calls.visibility.values()].filter(shown => !shown).length, parts.length, 'each pair has exactly one visible member')
  assert.deepEqual(removed, [], 'copies stay resident for live shading switches')
  assert.equal(view.fallbackParts(), parts.length - partsOf(names[0]))
  resolvers.splice(0).forEach(done => done())
  await new Promise(resolve => setTimeout(resolve, 0))
  view.render()
  assert.deepEqual(removed, [])
  for (let i = 0; i < parts.length; i++) {
    assert.equal(calls.visibility.get(1000 + i * 2), true)
    assert.equal(calls.visibility.get(1001 + i * 2), false)
  }
  assert.equal(view.fallbackParts(), 0)
})

// Deliverable 4 (owner 2026-11-04): a part MAMA gave no field keeps vertex normals with one warning naming the asset and
// part; a part generated in code (no SDF document, neither shading nor shadingError) keeps them silently.
test('a part without a field warns once by name; a generated part stays silent', () => {
  const failed = { ...part('arm', 'skin'), shadingError: "the per-pixel SDF field cannot express 'arm' (no section)" }
  const { port, handle } = portFor('test.nofield', [material('skin', PLAIN)], [failed, part('generated', 'skin')])
  const before = warnings.length
  const h = handle()
  port.createInstance(h, null); port.createInstance(h, null)
  assert.deepEqual(warnings.slice(before), ["[sdf-port] test.nofield#part:arm: vertex normals (the per-pixel SDF field cannot express 'arm' (no section))"])
})

// Owner 2026-11-04: one material per object. A part whose meshes carry the blended colours draws one white standard
// material (setInstanceMaterial) with the part's roughness/metallic and the colours in its mesh; a group tagged off, or a
// mesh made before the colours, keeps its per-face materials (setSingleMaterial(false, instance)).
test('one material per object: coloured parts get a white object material, others stay per-face', () => {
  const coloured = (name: string, materialName: string, rgb: number[]) => {
    const p = part(name, materialName)
    return { ...p, look: { roughness: 0.3, metallic: 0.1 }, meshes: p.meshes.map(m => ({ ...m, colors: new Float32Array([...rgb, 1, ...rgb, 1, ...rgb, 1]) })) }
  }
  const on = portFor('test.single', [material('blue', PLAIN), material('red', PLAIN)], [{ ...coloured('ball', 'blue', [0, 0, 1]),
    meshes: [...coloured('ball', 'blue', [0, 0, 1]).meshes, ...coloured('ball', 'red', [1, 0, 0]).meshes] }])
  const instance = on.calls.nextInstance
  on.port.createInstance(on.handle(), null)
  const object = on.calls.objectMaterials.get(instance)
  assert.ok(object !== undefined && object !== null, 'the instance gets its object material')
  assert.equal(JSON.stringify(on.calls.descs.at(-1)), JSON.stringify({ color: [1, 1, 1], roughness: 0.3, metallic: 0.1 }))
  const desc = on.calls.jointStreams.at(-1) as { colors?: Float32Array }
  assert.deepEqual(Array.from(desc.colors ?? []), [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1])
  assert.equal(on.calls.single.length, 0)
  const off = portFor('test.off', [material('blue', PLAIN)], [coloured('ball', 'blue', [0, 0, 1])], false)
  const offInstance = off.calls.nextInstance
  off.port.createInstance(off.handle(), null)
  assert.equal(JSON.stringify(off.calls.single), JSON.stringify([[false, offInstance]]))
  assert.equal(off.calls.objectMaterials.size, 0)
  const old = portFor('test.old', [material('blue', PLAIN)], [part('ball', 'blue')])
  old.port.createInstance(old.handle(), null)
  assert.equal(old.calls.single.length, 1, 'a mesh without colours keeps its per-face materials')
})

// MAMA game render options (core/game/render-options.ts) reach the port from the player settings and the page address;
// a stand-in of the contract here (MAMA is private).
const CONTRACT: Contract = {
  specs: [{ key: 'shading', kind: 'choice' }, { key: 'bakeTexelDensity', kind: 'number' }, { key: 'bakeMaxSize', kind: 'number' }],
  validate(input: unknown) {
    const options: RenderOptions = { shading: 'field', bakeTexelDensity: 256, bakeMaxSize: 512 }
    const issues: { key: string; message: string; fix: string }[] = []
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const ok = key === 'shading' ? ['field', 'vertex', 'baked'].includes(value as string) : typeof value === 'number' && Number.isFinite(value)
      if (ok) (options as unknown as Record<string, unknown>)[key] = value
      else issues.push({ key, message: `${key} ${String(value)} is invalid`, fix: `fix ${key}` })
    }
    return { options, issues }
  },
  bakeTextureSize: () => 64,
}

test('game render options: settings, then the page address on top; a bad value keeps its default with a warning', () => {
  assert.equal(exports.gameRenderOptions(CONTRACT, undefined, '').shading, 'field')
  assert.equal(exports.gameRenderOptions(CONTRACT, { shading: 'baked' }, '').shading, 'baked')
  const url = exports.gameRenderOptions(CONTRACT, { shading: 'baked' }, '?shading=vertex&bakeTexelDensity=128')
  assert.equal(url.shading, 'vertex')
  assert.equal(url.bakeTexelDensity, 128)
  assert.equal(exports.gameRenderOptions(CONTRACT, undefined, '?normals=vertex').shading, 'vertex')
  const before = warnings.length
  assert.equal(exports.gameRenderOptions(CONTRACT, undefined, '?shading=raytrace').shading, 'field')
  assert.ok(warnings.slice(before).some(w => w.includes('render-options:shading')))
  // No MAMA (a public clone): vertex normals.
  assert.equal(exports.gameRenderOptions(null, { shading: 'baked' }, '').shading, 'vertex')
})

// The field program path (contract 'mama.field-program'): a part with a valid program shades per fragment through
// fieldShading.ts, a refused part keeps vertex normals and is named in the shading report.
test('a field part shades from its program and a refused part keeps vertex with its reason', async () => {
  const body = { ...part('body', 'skin'), fieldProgram: fieldProgram() }
  const arm = { ...part('arm', 'skin'), fieldRefusal: 'not a Paramesh part' }
  const { port, calls, handle } = portFor('test.field', [material('skin', PLAIN)], [body, arm])
  await port.prepare(() => {}, () => {})
  port.createInstance(handle(), null)
  const report = port.shadingReport()
  assert.equal(report.parts, 2)
  assert.equal(report.field, 1)
  assert.equal(report.vertex, 1)
  assert.ok(report.errors.includes('test.field#g/arm: not a Paramesh part'), report.errors.join('\n'))
  // The saved refusal is a named fallback, listed apart from runtime failures; the field part is not in it.
  assert.equal(report.refused.join(','), 'test.field#g/arm')
  assert.ok(calls.functions >= 1, 'the field evaluator and material are registered')
})

// The playable path uploads its shared field shader, grid textures and material data once: more instances, moving
// transforms and camera turns re-use them (no shader rebuild, no repeated data or texture upload).
test('playable field parts share one shader and keep their upload while instances move and the camera turns', async () => {
  const meshes = ['body', 'hat', 'scarf'].map(name => ({ ...part(name, 'skin'), fieldProgram: gridProgram() }))
  const { port, calls, handle } = portFor('test.play', [material('skin', PLAIN)], meshes)
  await port.prepare(() => {}, () => {})
  const asset = handle()
  const first = port.createInstance(asset, [1, 0.42, 0.62])
  const second = port.createInstance(asset, [0.33, 0.73, 1])
  const fieldFunctions = () => [...calls.functionSources.keys()].filter(name => name.startsWith('pmf.')).length
  assert.equal(port.shadingReport().field, 3)
  assert.equal(fieldFunctions(), 1, 'every part with the same label graphs shares one field material')
  const uploaded = { functions: calls.functions, data: calls.data.length, textures: calls.textures.length }
  Object.assign(port, { target: { viewports: [{}] } })
  for (let frame = 0; frame < 4; frame++) {
    port.setCamera(0, { eye: [frame, 1, 2], target: [0, 0, 0], fovYDeg: 60, near: 0.1, far: 500 })
    port.setTransform(first, [frame, 0, 0], [0, 0, 0, 1], [1, 1, 1])
    port.setTransform(second, [0, frame, 0], [0, 0, 0, 1], [1, 1, 1])
    port.render()
  }
  assert.equal(fieldFunctions(), 1)
  assert.equal(calls.functions, uploaded.functions, 'no shader is rebuilt')
  assert.equal(calls.data.length, uploaded.data, 'no material data is re-uploaded')
  assert.equal(calls.textures.length, uploaded.textures, 'no grid texture is re-uploaded')
})

// A field label naming a saved material (registered by RAA as 'sdfm.buffer_<hash>', not a WGSL identifier) embeds
// that material's graph in the part's field material instead of calling it by its registry name.
test('a field label with a saved material embeds its graph and the part still shades from its program', async () => {
  const labelled = fieldProgram({ labels: [{ material: 'skin', color: [1, 0.4, 0.2], roughness: 0.5, metallic: 0 }] })
  const body = { ...part('body', 'skin'), fieldProgram: labelled }
  const { port, calls, handle } = portFor('test.label', [material('skin', PLAIN)], [body])
  await port.prepare(() => {}, () => {})
  port.createInstance(handle(), null)
  const report = port.shadingReport()
  assert.equal(report.field, 1, report.errors.join('\n'))
  assert.equal(report.vertex, 0)
  const fieldMaterial = [...calls.functionSources].find(([name]) => name.startsWith('pmf.'))
  assert.ok(fieldMaterial, 'the field material is registered')
  assert.ok(fieldMaterial[1].includes('fn pmf_graph_0('), fieldMaterial[1])
  assert.ok(fieldMaterial[1].includes('vec3f(1.0, 0.5, 0.1)'), 'the label graph body is embedded')
  assert.ok(!fieldMaterial[1].includes('sdfm.'), 'no registry name is called')
})

// An atlas_full addTexture demotes that one part to vertex: it is counted, named and logged, and never thrown.
test('texture.atlas_full demotes the part to vertex and is logged, never thrown', async () => {
  const body = { ...part('body', 'skin'), fieldProgram: gridProgram() }
  const { port, calls, handle } = portFor('test.full', [material('skin', PLAIN)], [body])
  ;(port.engine as { addTexture: () => number }).addTexture = () => { throw { code: 'texture.atlas_full' } }
  const before = errors.length
  await assert.doesNotReject(port.prepare(() => {}, () => {}))
  port.createInstance(handle(), null)
  const report = port.shadingReport()
  assert.equal(report.atlasFull, 1)
  assert.equal(report.field, 0)
  assert.equal(report.vertex, 1)
  assert.equal(calls.textures.length, 0)
  assert.ok(errors.slice(before).includes('[sdf-port] texture.atlas_full test.full#g/body'), errors.join('\n'))
})

// The field atlas plan runs once over the world before any upload and demotes by allocation cost: the cheap part
// with the larger diagonal goes before the expensive small one (the landed fieldAtlas fallback order).
test('a too-small atlas budget demotes the cheapest part first', async () => {
  const meshOf = (name: string, side: number) => ({
    ...part(name, 'skin'), meshes: [{ ...part(name, 'skin').meshes[0], positions: new Float32Array([0, 0, 0, side, 0, 0, 0, side, 0]) }],
  })
  const wide = { ...meshOf('wide', 10), fieldProgram: gridProgram(2) }
  const tiny = { ...meshOf('tiny', 1), fieldProgram: gridProgram(4) }
  const bytes = 4 * 4 * 4
  const { port, calls, handle } = portWithAtlas('test.budget', [material('skin', PLAIN)], [wide, tiny], bytes)
  await port.prepare(() => {}, () => {})
  port.createInstance(handle(), null)
  const report = port.shadingReport()
  assert.equal(report.demoted, 1)
  assert.equal(report.field, 1)
  assert.equal(report.vertex, 1)
  assert.equal(report.bytes, bytes)
  assert.equal(report.budget, bytes)
  assert.equal(calls.textures.length, 1)
  assert.ok(report.errors.includes('test.budget#g/wide: atlas budget: smaller parts first'), report.errors.join('\n'))
})

// Vertex mode keeps fields resident so switching to SDF can reuse the upload.
test('?normals=vertex shows every part vertex and keeps the field resident', async () => {
  const chosen = exports.gameRenderOptions('?normals=vertex', { shading: 'field' })
  assert.equal(chosen.shading, 'vertex')
  assert.equal(exports.gameRenderOptions('', {}).shading, 'field')
  assert.equal(exports.gameRenderOptions('?normalsDebug', {}).normalsDebug, true)
  const body = { ...part('body', 'skin'), fieldProgram: gridProgram() }
  const { port, calls, handle } = portWithRender('test.vertex', [material('skin', PLAIN)], [body],
    { shading: 'vertex', bakeTexelDensity: 0, bakeMaxSize: 0 })
  await port.prepare(() => {}, () => {})
  port.createInstance(handle(), null)
  const report = port.shadingReport()
  assert.equal(calls.textures.length, 1)
  assert.equal(report.field, 0)
  assert.equal(report.vertex, report.parts)
  assert.ok(report.errors.some(line => line.endsWith(': vertex mode')), report.errors.join('\n'))
})

/** A recording stand-in for a GPUDevice: draws nothing, maps readback buffers filled with a pattern. */
function bakeDevice() {
  let live = 0
  const device = {
    get live() { return live },
    queue: { writeBuffer() {}, submit() {} },
    createShaderModule: ({ label }: { label: string }) => ({ label }),
    createRenderPipelineAsync: async (d: { label: string }) => ({ label: d.label, getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createBuffer: ({ size }: { size: number }) => {
      live++
      let bytes: Uint8Array | null = null
      return { size, destroy: () => { live-- }, mapAsync: async () => { bytes = new Uint8Array(size).fill(200) }, getMappedRange: () => bytes!.buffer, unmap() {} }
    },
    createTexture: () => { live++; return { createView: () => ({}), destroy: () => { live-- } } },
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, draw() {}, end() {} }),
      copyTextureToBuffer() {}, finish: () => ({}),
    }),
  }
  return device
}

// Modern field programs keep their geometry while the content provider prepares baked textures.
test('saved field program stays visible when baked mode has no baked texture yet', async () => {
  const id = 'costume.golden-crown'
  const mesh = decodeMesh(new Uint8Array(readFileSync(new URL(`../../../assets/common/${id}.mesh`, import.meta.url))))
  const { engine } = fakeEngine()
  const port = exports.makeWith(new Map([[id, mesh]]), { shading: 'baked', bakeTexelDensity: 256, bakeMaxSize: 512 }, CONTRACT)
  const device = bakeDevice()
  readiness.set(device, () => ({ status: 'ready' }))
  Object.assign(port, { engine, target: {}, gpuDevice: device })
  await port.prepare(() => {}, () => {})
  port.createInstance(port.registerAsset(id, { id }), null)
  assert.ok(port.drawnParts().length > 0)
  for (const part of port.drawnParts()) assert.equal(part.mode, 'field')
  assert.equal(port.shadingReport().pending, 0)
})

function controlledField(id: string) {
  const body = { ...part('body', null), fieldProgram: gridProgram() }
  const setup = portFor(id, [], [body])
  const device = {}
  const state: { current: asyncPipelines.PipelineReadiness; keys: string[] } = { current: { status: 'pending' }, keys: [] }
  readiness.set(device, key => { state.keys.push(key); return state.current })
  Object.assign(setup.port, { gpuDevice: device })
  return { ...setup, state }
}

test('pending field pairs draw both members (RAA requests the field pipeline), swap on the next ready render and switch shading live', () => {
  const { port, calls, handle, state } = controlledField('test.live')
  const h = handle()
  const first = calls.nextInstance
  const instance = port.createInstance(h, [0.2, 0.4, 0.8])
  const pair = (field: boolean, vertex: boolean) => {
    assert.equal(calls.visibility.get(first), field)
    assert.equal(calls.visibility.get(first + 1), vertex)
  }
  assert.equal(calls.nodes.get(first), calls.nodes.get(first + 1), 'both members share the part node')
  assert.deepEqual(calls.tints.get(first), calls.tints.get(first + 1), 'the tint reaches both members')
  assert.equal(port.shadingReport().pending, 1)
  assert.equal(port.drawnParts()[0].mode, 'vertex')
  assert.equal(port.drawnParts()[0].reason, 'field pipeline pending')
  const fieldSource = [...calls.functionSources].find(([name]) => name.startsWith('pmf.'))?.[1]
  assert.ok(fieldSource)
  assert.equal(state.keys[0], asyncPipelines.materialKey(fieldSource), 'readiness matches the WGSL RAA composes')
  pair(true, true)
  port.setShading('vertex')
  pair(false, true)
  assert.equal(port.shadingReport().pending, 0)
  port.setShading('field')
  pair(true, true)
  assert.equal(port.shadingReport().pending, 1)
  assert.deepEqual([...port.shadingReport().pendingParts], ['test.live#g/body'], 'the report names the part it waits on')
  port.render()
  pair(true, true)
  state.current = { status: 'ready' }
  pair(true, true)
  port.render()
  pair(true, false)
  assert.equal(port.shadingReport().pending, 0)
  assert.equal(port.drawnParts()[0].mode, 'field')
  const another = calls.nextInstance
  port.createInstance(h, null)
  assert.equal(port.drawnParts().length, 2, 'draw report counts repeated placements independently')
  assert.equal(calls.instances, 4, 'even a ready material creates both resident members')
  assert.equal(calls.visibility.get(another), true)
  assert.equal(calls.visibility.get(another + 1), false)
  assert.ok(state.keys.every(key => key === state.keys[0]), 'the material query uses one stable key')
  state.current = { status: 'pending' }
  port.render()
  pair(true, false)
  port.setShading('vertex')
  pair(false, true)
  assert.equal(port.shadingReport().vertex, 1)
  assert.equal(calls.removedTextures.length, 0, 'field textures stay resident')
  port.setShading('baked')
  pair(true, false)
  port.setShading('field')
  pair(true, false)
  port.setVisible(instance, false)
  pair(false, false)
  port.render()
  pair(false, false)
  port.setVisible(instance, true)
  port.setPartFilter(instance, [])
  pair(false, false)
  port.setShading('vertex')
  port.render()
  pair(false, false)
  port.setPartFilter(instance, null)
  pair(false, true)
  port.setShading('field')
  pair(true, false)
  port.releaseAsset(h)
  assert.equal(calls.removedMeshes.length, 2, 'both field and vertex meshes are freed once')
  assert.equal(new Set(calls.removedMeshes).size, 2)
  assert.deepEqual(calls.removedTextures, [101])
})

// RAA asks for a lit pipeline only when it draws a visible instance (raa-lit draw_lit over camera_draws), so a field
// member hidden while pending would never compile and the part would wait forever (fieldShading op, run 11992: 180 s).
test('a pending field member stays drawn until RAA has compiled its pipeline from that draw', () => {
  const { port, calls, handle } = controlledField('test.requested')
  const first = calls.nextInstance
  port.createInstance(handle(), null)
  let requested = false
  readiness.set((port as unknown as { gpuDevice: object }).gpuDevice, () => ({ status: requested ? 'ready' : 'pending' }))
  for (let frame = 0; frame < 3 && !requested; frame++) {
    requested = calls.visibility.get(first) === true
    port.render()
  }
  assert.ok(requested, 'the field member is visible while pending, so its pipeline is requested')
  port.render()
  assert.equal(port.shadingReport().pending, 0)
  assert.equal(calls.visibility.get(first), true)
  assert.equal(calls.visibility.get(first + 1), false)
})

test('a failed field keeps its vertex copy and reports the shader rejection by part key', () => {
  const { port, calls, handle, state } = controlledField('test.shader-failed')
  const h = handle()
  const first = calls.nextInstance
  const instance = port.createInstance(h, null)
  port.createInstance(h, null)
  assert.equal(port.shadingReport().pending, 1, 'two instances of the same part count once')
  state.current = { status: 'failed', reason: 'invalid layout; previous error: too many bindings' }
  port.render()
  assert.equal(calls.visibility.get(first), false)
  assert.equal(calls.visibility.get(first + 1), true)
  const report = port.shadingReport()
  assert.equal(report.pending, 0)
  assert.equal(report.failed, 1)
  assert.ok(report.errors.includes('test.shader-failed#g/body: shader invalid layout; previous error: too many bindings'))
  port.setShading('vertex')
  port.setShading('field')
  assert.equal(calls.visibility.get(first), false)
  assert.equal(calls.visibility.get(first + 1), true)
  port.setVisible(instance, false)
  assert.equal(calls.visibility.get(first + 1), false)
  port.setVisible(instance, true)
  port.setPartFilter(instance, [])
  port.render()
  assert.equal(calls.visibility.get(first), false)
  assert.equal(calls.visibility.get(first + 1), false)
})

test('a pending skinned pair receives poses on both members and keeps its last pose when switched', () => {
  const { port, calls, state } = controlledField('test.skin-pair')
  const skin: SkinnedAssetT = { rig: { name: 'penguin', bones: [{ name: 'root', parent: null }] }, parts: [{ name: 'body', skin: {
    joints: new Uint16Array(12), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  } }] }
  const h = port.registerSkinned('test.skin-pair', skin)
  const first = calls.nextInstance
  const instance = port.createInstance(h, [0.1, 0.2, 0.3])
  const matrices = Float32Array.from(FRAME); matrices[13] = 0.6
  port.setPose(instance, matrices)
  port.render()
  assert.deepEqual(Array.from(calls.skinPoses[0].ids), [first, first + 1])
  assert.deepEqual(Array.from(calls.skinPoses[0].matrices), [...matrices, ...matrices])
  state.current = { status: 'ready' }
  port.render()
  port.setShading('vertex')
  assert.equal(calls.visibility.get(first), false)
  assert.equal(calls.visibility.get(first + 1), true)
  matrices[13] = 0.9
  port.setPose(instance, matrices)
  port.render()
  assert.deepEqual(Array.from(calls.skinPoses[1].ids), [first, first + 1])
  port.setShading('field')
  assert.equal(calls.visibility.get(first), true)
  assert.equal(calls.visibility.get(first + 1), false)
  port.releaseAsset(h)
  assert.equal(calls.removedMeshes.length, 4, 'both rigid and skinned pairs are freed')
  assert.equal(new Set(calls.removedMeshes).size, 4)
  assert.deepEqual(calls.removedTextures, [101], 'the base owns the shared field texture')
})

test('a field pair keeps its vertex object material and the field material on their respective members', () => {
  const mesh = part('body', 'paint')
  const body = { ...mesh, fieldProgram: fieldProgram(), look: { roughness: 0.3, metallic: 0.1 },
    meshes: mesh.meshes.map(m => ({ ...m, colors: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]) })) }
  const { port, calls, handle } = portFor('test.single-pair', [material('paint', PLAIN)], [body])
  const first = calls.nextInstance
  port.createInstance(handle(), null)
  assert.equal(calls.objectMaterials.has(first), false, 'the field draw keeps its per-fragment material')
  assert.ok(calls.single.some(([on, id]) => on === false && id === first))
  const vertexMaterial = calls.objectMaterials.get(first + 1)
  assert.ok(vertexMaterial !== undefined && vertexMaterial !== null)
  assert.equal(JSON.stringify(calls.surfaceOf.get(vertexMaterial)), JSON.stringify({ color: [1, 1, 1], roughness: 0.3, metallic: 0.1 }))
})

// The explicit 'baked' choice (contract 'baked-part-textures'): the worker's baked baseColor/normal/orm maps drive a
// third member per part, shown only in 'baked' mode; the field/vertex pair stays resident.
function bakedData(over: Record<string, unknown> = {}) {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    baseColor: { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) },
    normal: { width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) },
    orm: { width: 1, height: 1, data: new Uint8Array([255, 128, 0, 255]) },
    ...over,
  }
}

function portWithBaked(id: string, body: Record<string, unknown>) {
  const meshed = new Map([[id, { assetId: id, data: { materials: [material('skin', PLAIN)], groups: [{ group: 'g', parts: [body] }] } }]])
  const { engine, calls } = fakeEngine()
  const port = exports.make(meshed)
  port.engine = engine
  port.target = {}
  const device = {}
  const state: { current: asyncPipelines.PipelineReadiness } = { current: { status: 'ready' } }
  readiness.set(device, () => state.current)
  Object.assign(port, { gpuDevice: device })
  return { port, calls, meshed, state, handle: () => port.registerAsset(id, { id }) }
}

test('baked texture: addTextured adds a textured member per part; baked mode shows it and leaving hides it', () => {
  const id = 'test.baked'
  const body = { ...part('body', 'skin'), fieldProgram: fieldProgram(), baked: bakedData() }
  const { port, calls, meshed, handle } = portWithBaked(id, body)
  const h = handle()
  const first = calls.nextInstance
  port.createInstance(h, [0.2, 0.4, 0.8])
  assert.equal(calls.instances, 2, 'the field/vertex pair')
  assert.equal(calls.textures.length, 0, 'nothing is baked before addTextured')
  port.addTextured(id, meshed.get(id))
  assert.equal(calls.instances, 3, 'a third member per part')
  const textured = first + 2
  assert.equal(calls.nodes.get(textured), calls.nodes.get(first), 'the textured member shares the part node')
  assert.deepEqual(calls.tints.get(textured), calls.tints.get(first), 'the tint reaches the textured member')
  assert.equal(calls.textures.length, 3, 'baseColor, normal and orm')
  assert.ok(calls.functionSources.has('rf.textured'), 'the one textured material function is registered')
  assert.equal(calls.visibility.get(textured), false, 'hidden while the field draws')
  port.render()
  assert.equal(calls.visibility.get(first), true)
  assert.equal(calls.visibility.get(first + 1), false)
  port.setShading('baked')
  assert.equal(calls.visibility.get(first), false)
  assert.equal(calls.visibility.get(first + 1), false)
  assert.equal(calls.visibility.get(textured), true)
  const report = port.shadingReport()
  assert.equal(report.texture, 1)
  assert.equal(report.field, 0)
  assert.equal(report.pending, 0)
  port.setShading('field')
  assert.equal(calls.visibility.get(first), true)
  assert.equal(calls.visibility.get(textured), false)
  assert.equal(port.shadingReport().texture, 0)
  port.releaseAsset(h)
  assert.equal(calls.removedMeshes.length, 3, 'the field, vertex and textured meshes are freed')
  assert.deepEqual([...calls.removedTextures].sort(), [101, 102, 103], 'the three baked textures are freed')
})

test('baked texture: texture.atlas_full keeps the field pair and names the error', () => {
  const id = 'test.baked-full'
  const body = { ...part('body', 'skin'), fieldProgram: fieldProgram(), baked: bakedData() }
  const { port, calls, meshed, handle } = portWithBaked(id, body)
  const h = handle()
  const first = calls.nextInstance
  port.createInstance(h, null)
  ;(port.engine as { addTexture: () => number }).addTexture = () => { throw { code: 'texture.atlas_full' } }
  const before = errors.length
  port.addTextured(id, meshed.get(id))
  assert.equal(calls.instances, 2, 'no textured member is added')
  const report = port.shadingReport()
  assert.equal(report.atlasFull, 1)
  assert.ok(report.errors.includes(`${id}#g/body: texture.atlas_full`), report.errors.join('\n'))
  assert.ok(errors.slice(before).includes(`[sdf-port] texture.atlas_full ${id}#g/body`))
  port.render()
  assert.equal(calls.visibility.get(first), true)
  assert.equal(calls.visibility.get(first + 1), false)
  port.setShading('baked')
  assert.equal(calls.visibility.get(first), true, 'the part keeps the field rule')
  assert.equal(calls.visibility.get(first + 1), false)
})

test('baked texture: a bakedRefusal part stays on its field pair with the reason named', () => {
  const id = 'test.baked-refused'
  const body = { ...part('body', 'skin'), fieldProgram: fieldProgram(), bakedRefusal: 'bakeMeshTextures: no source' }
  const { port, calls, meshed, handle } = portWithBaked(id, body)
  port.createInstance(handle(), null)
  port.addTextured(id, meshed.get(id))
  assert.equal(calls.instances, 2)
  assert.ok(port.shadingReport().errors.includes(`${id}#g/body: bakeMeshTextures: no source`), port.shadingReport().errors.join('\n'))
})

test('baked texture: a skinned textured member receives the same pose', () => {
  const id = 'test.baked-skin'
  const body = { ...part('body', 'skin'), fieldProgram: fieldProgram(), baked: bakedData({
    joints: new Uint16Array(12), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  }) }
  const { port, calls, meshed } = portWithBaked(id, body)
  const skin: SkinnedAssetT = { rig: { name: 'penguin', bones: [{ name: 'root', parent: null }] }, parts: [{ name: 'body', skin: {
    joints: new Uint16Array(12), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  } }] }
  const h = port.registerSkinned(id, skin)
  const first = calls.nextInstance
  const instance = port.createInstance(h, null)
  port.addTextured(id, meshed.get(id))
  assert.equal(calls.instances, 3)
  const matrices = Float32Array.from(FRAME); matrices[13] = 0.7
  port.setPose(instance, matrices)
  port.render()
  assert.deepEqual(Array.from(calls.skinPoses[0].ids), [first, first + 1, first + 2], 'the textured member gets a skin slot')
  port.setShading('baked')
  assert.equal(calls.visibility.get(first + 2), true)
})


test('isolated mechanism scene keeps both saved hammer fields and bounds follow the current pose', () => {
  const id = 'candy.pendulum-hammer'
  const mesh = decodeMesh(new Uint8Array(readFileSync(new URL(`../../../assets/candy/${id}.mesh`, import.meta.url))))
  const port = exports.make(new Map([[id, mesh]]))
  const { engine } = fakeEngine()
  port.engine = { ...engine, setTransform() {} }
  port.target = {}
  const instance = port.createInstance(port.registerAsset(id, { id }), null)
  assert.equal(port.shadingReport().demoted, 0, 'unrelated worlds must not spend a close-up scene atlas')
  assert.equal(port.shadingReport().field, 2, 'head and arm retain per-fragment fields')
  const rest = port.worldBounds()
  assert.equal(rest.length, 2, 'hidden colliders have no mesh bounds')
  port.setTransform(instance, [7, 3, -2], [0, 0, 1, 0], [1, 1, 1])
  const posed = port.worldBounds()
  for (let i = 0; i < rest.length; i++) {
    assert.ok(Math.abs(posed[i].min[0] - (7 - rest[i].max[0])) < 1e-6)
    assert.ok(Math.abs(posed[i].max[1] - (3 - rest[i].min[1])) < 1e-6)
    assert.ok(Math.abs(posed[i].min[2] - (rest[i].min[2] - 2)) < 1e-6)
  }
  port.setPartFilter(instance, ['head'])
  assert.equal(port.worldBounds().length, 1)
  port.setVisible(instance, false)
  assert.equal(port.worldBounds().length, 0)
})

// Card 7143: a round selected behind the visible hub (its SceneLayer hidden) prepares through its own instances. It was
// reported ready with zero preparation jobs and revealed with pending field parts; now it stays pending until its
// field shading is ready, hands off complete, and a failed part keeps its copy while the hub stays untouched.
test('a hidden selected scene prepares its own field shading before the visibility handoff', async () => {
  const { SceneLayer } = await import('@royal-fiesta/game/render/sceneLayer')
  const { prepareCourse, courseWarmed } = await import('../src/render/pipelineGate.ts')
  const root = new URL('../../../', import.meta.url)
  const id = 'penguin.body'
  const mesh = decodeMesh(new Uint8Array(readFileSync(new URL(`assets/common/${id}.mesh`, root))))
  const scene = (status: 'pending' | 'ready' | 'failed') => {
    const { engine, calls } = fakeEngine()
    const port = exports.make(new Map([[id, mesh]]))
    const device = {}
    let state: asyncPipelines.PipelineReadiness = { status: 'ready' }
    readiness.set(device, () => state)
    Object.assign(port, { engine, target: { viewports: [{ x: 0, y: 0, width: 640, height: 360 }] }, gpuDevice: device })
    // The course environment is not under test here (its module is a stub in this context).
    Object.assign(port, { setEnvironment() {} })
    const hub = new SceneLayer(port as never), round = new SceneLayer(port as never)
    const handle = port.registerAsset(id, { id })
    const before = calls.nextInstance
    hub.port.createInstance(handle, null)
    const hubMembers = Array.from({ length: calls.nextInstance - before }, (_, i) => before + i)
    port.render()
    // The round's field pipelines are still compiling when it is selected; it is created behind the visible hub.
    state = status === 'failed' ? { status: 'failed', reason: 'bad wgsl' } : { status: 'pending' }
    round.setVisible(false)
    const start = calls.nextInstance
    round.port.createInstance(handle, null)
    const roundMembers = Array.from({ length: calls.nextInstance - start }, (_, i) => start + i)
    const gated = round.port as unknown as { warmableAssets(): string[]; fallbackParts(): number }
    return { port, calls, hub, round, gated, hubMembers, roundMembers, ready: () => { state = { status: 'ready' } } }
  }
  const parts = (mesh.data as { groups: { parts: { meshes: unknown[] }[] }[] }).groups.flatMap(g => g.parts).filter(p => p.meshes.length).length

  // Pending preparation: the hidden round is the scene its layer prepares and counts, the hub is complete.
  const pending = scene('pending')
  assert.deepEqual([...pending.gated.warmableAssets()], [id], 'the hidden selected scene has preparation work')
  assert.equal(pending.gated.fallbackParts(), parts, 'its pending field parts are counted while hidden')
  assert.equal((pending.hub.port as unknown as { fallbackParts(): number }).fallbackParts(), 0)
  let settled = false
  const prepared = prepareCourse(pending.round.port, 'round', { timeoutMs: 5_000 }).then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(settled, false, 'never ready while the hidden scene still has pending field parts')
  assert.ok(pending.roundMembers.every(m => pending.calls.visibility.get(m) === false), 'the selected scene stays hidden while pending')
  assert.ok(pending.hubMembers.some(m => pending.calls.visibility.get(m) === true), 'the previous scenery stays visible')

  // Successful handoff: once the shading compiles, readiness resolves without a frame and the reveal draws fields only.
  pending.ready()
  await prepared
  assert.equal(courseWarmed(pending.round.port, 'round'), true)
  pending.hub.setVisible(false)
  pending.round.setVisible(true)
  const drawn = pending.port.drawnParts()
  assert.equal(drawn.length, parts)
  assert.equal(drawn.filter(p => p.reason === 'field pipeline pending').length, 0, 'no pending field part is revealed')

  // Failure retention: a failed part is not waited on, keeps its vertex copy with its reason; the hub is untouched.
  const failed = scene('failed')
  assert.equal(failed.gated.fallbackParts(), 0)
  assert.ok(failed.roundMembers.every(m => failed.calls.visibility.get(m) === false), 'a failed selected scene stays hidden')
  assert.ok(failed.hubMembers.some(m => failed.calls.visibility.get(m) === true), 'the previous scenery is retained')
  failed.hub.setVisible(false)
  failed.round.setVisible(true)
  const kept = failed.port.drawnParts()
  assert.equal(kept.length, parts, 'no dropped part')
  assert.ok(kept.every(p => p.mode === 'vertex' && p.reason !== undefined), 'each failed part draws its named copy')
})
