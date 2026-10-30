import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { materialProgram } from '../src/sdf/materialProgram.ts'
import { PALETTE } from '@royal-fiesta/game/render/palette'

import type { CameraPose, RenderTarget, Viewport } from '@royal-fiesta/game/render/port'

const FIELDS = ['base_color', 'metallic', 'roughness', 'emissive', 'height']
const PLAIN = 'return MaterialFull(vec3f(1.0, 0.5, 0.1), 0.0, 0.5, vec3f(0.0), 0.0);'
// The S23 emit of input.player_color, as MAMA compiles it into the material body.
const PLAYER = 'let c = select(vec3f(0.5), mat_instance_tint.rgb, mat_instance_tint_set > 0.5); return MaterialFull(c, 0.0, 0.5, vec3f(0.0), 0.0);'
const FRAME = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

interface Port {
  engine: unknown; target: unknown
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
runInNewContext(compiled, {
  HTMLCanvasElement: FakeCanvas, exports, Float32Array, Float64Array, Uint32Array, performance, setTimeout, clearTimeout, URLSearchParams,
  require(id: string): unknown {
    if (id === '../render/raaEngine.ts') return { createRaaEngine: async () => initEngine }
    if (id === '../render/shaderCache.ts') return { installShaderCache() {} }
    if (id === './materialProgram.ts') return { materialProgram }
    if (id === '@royal-fiesta/game/render/roundLoad') return { roundStep: (_name: string, fn: () => unknown) => fn() }
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
    functions: 0, surfaces: 0, meshes: 0, instances: 0,
    tints: new Map<number, number[][]>(), cleared: [] as number[], modes: new Map<number, string>(),
    meshOf: new Map<number, number>(), meshIds: [] as number[], nextInstance: 1000,
  }
  const engine = {
    resize(...args: number[]) { calls.sizes.push(args) },
    setViewports(views: Viewport[]) { calls.views.push(Array.from(views, v => ({ ...v }))) },
    setCamera() { calls.cameras.push(-1) },
    setViewportCamera(index: number) { calls.cameras.push(index) },
    setVisible(id: number, visible: boolean) { calls.visibility.set(id, visible) },
    setLight() {}, setAmbient() {},
    addMaterialFunction() { calls.functions++ },
    addSurfaceMaterial() { calls.surfaces++; return ++next },
    addMesh() { calls.meshes++; const id = ++next; calls.meshIds.push(id); return id },
    addNode() { return ++next },
    removeNode() {},
    addMeshInstance(_node: number, mesh: number) { calls.instances++; const id = calls.nextInstance++; calls.meshOf.set(id, mesh); return id },
    setInstanceTint(id: number, rgba: number[]) { calls.tints.set(id, [...(calls.tints.get(id) ?? []), Array.from(rgba)]) },
    clearInstanceTint(id: number) { calls.cleared.push(id) },
    setMaterialTintMode(handle: number, mode: string) { calls.modes.set(handle, mode) },
  }
  return { engine, calls }
}

function portFor(id: string, materials: unknown[], parts: unknown[]) {
  const meshed = new Map([[id, { assetId: id, data: { materials, groups: [{ group: 'g', parts }] } }]])
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
