import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { materialProgram } from '../src/sdf/materialProgram.ts'
import { PALETTE } from '@royal-fiesta/game/render/palette'

test('upload creates no draw pipelines and palette instances share graph materials and geometry', async () => {
  const calls = { functions: 0, surfaces: 0, meshes: 0, instances: 0, tints: [] as number[][] }
  let next = 0
  const engine = {
    addMaterialFunction() { calls.functions++ },
    addSurfaceMaterial() { calls.surfaces++; return ++next },
    addMesh() { calls.meshes++; return ++next },
    addNode() { return ++next },
    addMeshInstance() { calls.instances++; return ++next },
    setInstanceTint(_id: number, rgba: number[]) { calls.tints.push(rgba) },
  }
  const frame = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  const meshed = new Map([['test.asset', { assetId: 'test.asset', data: {
    materials: [{ name: 'player', key: 'a'.repeat(64), body: 'return MaterialFull(vec3f(1.0), 0.0, 0.5, vec3f(0.0), 0.0);', helpers: [], constants: [], fields: ['base_color', 'metallic', 'roughness', 'emissive', 'height'] }],
    groups: [{ group: 'test', parts: [{ name: 'part', partId: 'part', frame, meshes: [{
      material: 'player' as string | null, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: null, indices: new Uint32Array([0, 1, 2]),
    }] }] }],
  } }]])
  const source = readFileSync(new URL('../src/sdf/sdfPort.ts', import.meta.url), 'utf8')
  const compiled = transpileModule(source + '\nexports.make = () => new SdfRenderPort(meshed)\n', {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  interface Port {
    engine: unknown; target: unknown
    prepare(progress: () => void, timing: () => void): Promise<void>
    registerAsset(name: string, asset: { id: string }): number
    createInstance(handle: number, tint: readonly number[] | null): number
  }
  const exports = {} as { make(): Port }
  runInNewContext(compiled, {
    exports, meshed, Float32Array, Float64Array, Uint32Array, performance,
    requestAnimationFrame: (callback: (time: number) => void) => callback(0),
    require(id: string): unknown {
      if (id === './materialProgram.ts') return { materialProgram }
      if (id === '@royal-fiesta/game/render/roundLoad') return { roundStep: (_name: string, fn: () => unknown) => fn() }
      if (id === '@royal-fiesta/sim/refusal') return { refuse: (...args: unknown[]) => { throw new Error(args.join(':')) } }
      return {}
    },
  })
  const port = exports.make()
  port.engine = engine
  port.target = {}
  await port.prepare(() => {}, () => {})
  assert.equal(calls.instances, 0, 'upload does not create warmup draws for off-screen assets')
  const handle = port.registerAsset('test', { id: 'test.asset' })
  port.createInstance(handle, null)
  for (const tint of PALETTE) port.createInstance(handle, tint)
  assert.equal(calls.functions, 1)
  assert.equal(calls.surfaces, 1)
  assert.equal(calls.meshes, 1)
  assert.deepEqual(calls.tints.map(rgba => Array.from(rgba)), PALETTE.map(rgb => [...rgb, 1]))
  // A mesh without a graph keeps the old white fallback, shared across all colours.
  meshed.get('test.asset')!.data.groups[0].parts[0].meshes[0].material = null
  const fallbackPort = exports.make()
  fallbackPort.engine = engine
  fallbackPort.target = {}
  const fallback = fallbackPort.registerAsset('test', { id: 'test.asset' })
  const meshes = calls.meshes
  for (const tint of PALETTE) fallbackPort.createInstance(fallback, tint)
  assert.equal(calls.meshes, meshes + 1)
  assert.equal(calls.surfaces, 3)
})
