import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { materialProgram } from '../src/sdf/materialProgram.ts'
import { PALETTE } from '@royal-fiesta/game/render/palette'

const FIELDS = ['base_color', 'metallic', 'roughness', 'emissive', 'height']
const PLAIN = 'return MaterialFull(vec3f(1.0, 0.5, 0.1), 0.0, 0.5, vec3f(0.0), 0.0);'
// The S23 emit of input.player_color, as MAMA compiles it into the material body.
const PLAYER = 'let c = select(vec3f(0.5), mat_instance_tint.rgb, mat_instance_tint_set > 0.5); return MaterialFull(c, 0.0, 0.5, vec3f(0.0), 0.0);'
const FRAME = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

interface Port {
  engine: unknown; target: unknown
  prepare(progress: () => void, timing: () => void): Promise<void>
  registerAsset(name: string, asset: { id: string }): number
  createInstance(handle: number, tint: readonly number[] | null): number
  destroyInstance(handle: number): void
}

const source = readFileSync(new URL('../src/sdf/sdfPort.ts', import.meta.url), 'utf8')
const compiled = transpileModule(source + '\nexports.make = (meshed) => new SdfRenderPort(meshed)\n', {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText
const exports = {} as { make(meshed: ReadonlyMap<string, unknown>): Port }
runInNewContext(compiled, {
  exports, Float32Array, Float64Array, Uint32Array, performance,
  requestAnimationFrame: (callback: (time: number) => void) => callback(0),
  require(id: string): unknown {
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
    functions: 0, surfaces: 0, meshes: 0, instances: 0,
    tints: new Map<number, number[][]>(), cleared: [] as number[], modes: new Map<number, string>(),
    meshOf: new Map<number, number>(), meshIds: [] as number[], nextInstance: 1000,
  }
  const engine = {
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
