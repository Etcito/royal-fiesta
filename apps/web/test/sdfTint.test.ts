import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { decodeMesh } from '../src/sdf/meshWire.ts'
import { assetSkin } from '../src/content/cosmeticSkin.ts'
import { restPoseSkin } from '@royal-fiesta/game/render/sceneView'
import { materialProgram } from '../src/sdf/materialProgram.ts'
import { checkPose, checkSkin } from '@royal-fiesta/game/render/nullPort'
import type { SkinnedAssetT } from '@royal-fiesta/game/render/port'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import * as raaSdfm from '@etcito/raa-sdfm'
import * as asyncPipelines from '../src/render/asyncPipelines.ts'

import type { CameraPose, RenderTarget, Viewport } from '@royal-fiesta/game/render/port'

const FIELDS = ['base_color', 'metallic', 'roughness', 'emissive', 'height']
const PLAIN = 'return MaterialFull(vec3f(1.0, 0.5, 0.1), 0.0, 0.5, vec3f(0.0), 0.0);'
// The S23 emit of input.player_color, as MAMA compiles it into the material body.
const PLAYER = 'let c = select(vec3f(0.5), mat_instance_tint.rgb, mat_instance_tint_set > 0.5); return MaterialFull(c, 0.0, 0.5, vec3f(0.0), 0.0);'
const FRAME = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

interface Port {
  engine: unknown; target: unknown
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
const compiled = transpileModule(source + '\nexports.make = (meshed) => new SdfRenderPort(meshed)\n', {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText
class FakeCanvas {}
let initEngine: ReturnType<typeof fakeEngine>['engine']

const exports = {} as { make(meshed: ReadonlyMap<string, unknown>): Port }
const warnings: string[] = []
runInNewContext(compiled, {
  console: { ...console, warn: (...args: unknown[]) => { warnings.push(args.join(' ')) } },
  HTMLCanvasElement: FakeCanvas, exports, Float32Array, Float64Array, Uint32Array, performance, setTimeout, clearTimeout, URLSearchParams,
  require(id: string): unknown {
    if (id === '../game/checkProgress.ts') return { checkAwait: (_step: string, work: () => Promise<unknown>) => work() }
    if (id === '../render/raaEngine.ts') return { createRaaEngine: async () => initEngine }
    if (id === '../render/shaderCache.ts') return { installShaderCache() {} }
    if (id === '../render/asyncPipelines.ts') return asyncPipelines
    if (id === '@royal-fiesta/game/render/nullPort') return { checkPose, checkSkin }
    if (id === './materialProgram.ts') return { materialProgram }
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

// The fake engine records the calls; instance ids are handed out in order, mesh instances
// remember their mesh so a test can tell which part an instance draws.
function fakeEngine() {
  let next = 0
  const calls = {
    views: [] as Viewport[][], sizes: [] as number[][], cameras: [] as number[],
    visibility: new Map<number, boolean>(),
    skinPoses: [] as { ids: Uint32Array; matrices: Float32Array }[],
    jointStreams: [] as unknown[],
    functions: 0, surfaces: 0, meshes: 0, instances: 0,
    tints: new Map<number, number[][]>(), cleared: [] as number[], modes: new Map<number, string>(),
    meshOf: new Map<number, number>(), meshIds: [] as number[], nextInstance: 1000,
    single: [] as unknown[][], objectMaterials: new Map<number, number | null>(), descs: [] as Record<string, unknown>[],
  }
  const engine = {
    resize(...args: number[]) { calls.sizes.push(args) },
    setViewports(views: Viewport[]) { calls.views.push(Array.from(views, v => ({ ...v }))) },
    setCamera() { calls.cameras.push(-1) },
    setViewportCamera(index: number) { calls.cameras.push(index) },
    setVisible(id: number, visible: boolean) { calls.visibility.set(id, visible) },
    setLight() {}, setAmbient() {},
    addMaterialFunction() { calls.functions++ },
    addSurfaceMaterial(desc: Record<string, unknown>) { calls.surfaces++; calls.descs.push(desc); return ++next },
    setSkinPoses(ids: Uint32Array, matrices: Float32Array) { calls.skinPoses.push({ ids, matrices }) },
    addMesh(desc: unknown) { calls.jointStreams.push(desc); calls.meshes++; const id = ++next; calls.meshIds.push(id); return id },
    addNode() { return ++next },
    removeNode() {},
    addMeshInstance(_node: number, mesh: number) { calls.instances++; const id = calls.nextInstance++; calls.meshOf.set(id, mesh); return id },
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


test('all committed catalog cosmetics upload their saved skin and render with the penguin idle pose', () => {
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
    const skin=assetSkin(data,document,owner.rig)!
    const handle=port.registerSkinned(id,skin)
    const instance=port.createInstance(handle,null)
    port.setPose(instance,matrices)
    port.flushPoses(engine)
    assert.ok(calls.skinPoses[0].ids.length>0,`${id}: posed draw submitted`)
    assert.ok(calls.skinPoses[0].matrices.some((v,i)=>Math.abs(v-(i%16%5===0?1:0))>1e-4),`${id}: deforming matrices`)
    assert.equal(port.skinOf(id),skin)
  }
})

// Owner 2026-11-04: normals and materials from the SDF in the shader, never baked. Every saved part of the penguin and
// the costumes carries its per-pixel shading (saved mesh format 2) and draws it: one sdff.* function per part on every
// sub-mesh, the rest point in the vertex colour and the rest frame in uv + tangent, no per-face material, no texture.
test('saved penguin and costume parts draw their per-pixel SDF shading on every sub-mesh', () => {
  const root=new URL('../../../',import.meta.url)
  for(const id of ['penguin.body',...readdirSync(new URL('assets/common/',root)).filter(n=>/^costume\..*\.mesh$/.test(n)).map(n=>n.replace(/\.mesh$/,''))]) {
    const mesh=decodeMesh(new Uint8Array(readFileSync(new URL(`assets/common/${id}.mesh`,root))))
    const parts=(mesh.data as {groups:{parts:{shading?:unknown;shadingError?:string;meshes:unknown[]}[]}[]}).groups.flatMap(g=>g.parts).filter(p=>p.meshes.length)
    for(const part of parts) assert.ok(part.shading,`${id}: saved part without shading (${part.shadingError})`)
    const {engine,calls}=fakeEngine(), port=exports.make(new Map([[id,mesh]]))
    const functions:string[]=[]
    engine.addMaterialFunction=((name:string)=>{functions.push(name);calls.functions++}) as typeof engine.addMaterialFunction
    port.engine=engine;port.target={}
    port.createInstance(port.registerAsset(id,{id}),null)
    assert.equal(functions.filter(f=>f.startsWith('sdff.')).length,parts.length,`${id}: one shading function per part`)
    const descs=calls.jointStreams as {colors?:Float32Array;uvs?:Float32Array;tangents?:Float32Array;positions:Float32Array;subMeshes:{material?:number}[]}[]
    // Each part uploads its vertex-colour copy first (drawn while its shading compiles), then its shaded mesh.
    assert.equal(descs.length,parts.length*2,`${id}: a vertex-colour copy and a shaded mesh per part`)
    for(let i=0;i<descs.length;i+=2){
      const fallback=descs[i],desc=descs[i+1]
      assert.equal(fallback.subMeshes.length,desc.subMeshes.length,`${id}: the copy draws the same sub-meshes`)
      assert.equal(new Set(desc.subMeshes.map(s=>s.material)).size,1,`${id}: every sub-mesh draws the part's shading`)
      assert.equal(desc.colors![0],desc.positions[0],`${id}: the vertex colour carries the rest point`)
      assert.ok(desc.uvs&&desc.tangents,`${id}: rest frame streams`)
    }
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
  const removed: number[] = []
  Object.assign(engine, {
    addMaterialFunction(name: string, wgsl: string) { calls.functions++; if (name.startsWith('sdff.')) shadings.push(wgsl) },
    removeNode(node: number) { removed.push(node) },
    render() {}, stats: () => ({ drawCalls: 0, triangles: 0, instances: 0 }),
  })
  const port = exports.make(new Map([[id, mesh]]))
  port.engine = engine; port.target = {}
  Object.assign(port, { canvas: context.canvas })
  port.createInstance(port.registerAsset(id, { id }), null)
  assert.equal(shadings.length, parts.length)
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
  assert.equal(removed.length, 1, 'the first part swaps the frame its shadow and forward variants are compiled')
  assert.equal(view.fallbackParts(), parts.length - 1)
  resolvers.splice(0).forEach(done => done())
  await new Promise(resolve => setTimeout(resolve, 0))
  view.render()
  assert.equal(removed.length, parts.length)
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
