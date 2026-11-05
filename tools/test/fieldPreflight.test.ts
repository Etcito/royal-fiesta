import assert from 'node:assert/strict'
import test from 'node:test'
import { fieldPreflight, preflightAssets } from '../fieldPreflight.ts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const MESH = [{ positions: new Float32Array([0, 0, 0, 1, 1, 1]) }]

function program(gridSide = 16): unknown {
  return {
    format: 'mama.field-program',
    version: 1,
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    labels: [{ material: null, color: [1, 0, 0], roughness: 0.5, metallic: 0.1 }],
    operands: [
      { kind: 'box', label: 0, inv: IDENTITY, scale: 1, half: [0.5, 0.5, 0.5], radius: 0.1 },
      { kind: 'grid', label: 0, inv: IDENTITY, scale: 1, origin: [-0.6, -0.6, -0.6], voxel: 0.3, size: [4, 4, 4], at: [0, 0], range: 1.5 },
    ],
    tree: [{ op: 'leaf', operand: 0 }, { op: 'leaf', operand: 1 }, { op: 'union', mode: 'smooth', radius: 0.1 }],
    grid: { width: gridSide, height: gridSide, texels: new Uint8Array(gridSide * gridSide * 4) },
    stats: { operands: 2, analytic: 1, sampled: 1 },
    functionName: 'pmf_eval_0123456789abcdef',
    wgsl: 'fn pmf_eval_0123456789abcdef(p: vec3f, w: ptr<function, array<f32, 8>>) -> f32 { return length(p) - 0.5; }',
  }
}

function asset(id: string, parts: unknown[]): { id: string; data: { groups: { group: string; parts: unknown[] }[]; materials: unknown[] } } {
  return { id, data: { groups: [{ group: 'g', parts }], materials: [] } }
}

test('fieldPreflight names every part outcome at once: field, refused, atlas-demoted, scaled frame, invalid', () => {
  const scaled = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const report = fieldPreflight([
    asset('a', [
      { partId: 'ok', frame: Float64Array.from(IDENTITY), meshes: MESH, fieldProgram: program() },
      { partId: 'warped', frame: Float64Array.from(IDENTITY), meshes: MESH, fieldRefusal: 'operand with a lattice, deformer or non-uniform scale' },
      { partId: 'scaled', frame: Float64Array.from(scaled), meshes: MESH, fieldProgram: program() },
      { partId: 'broken', frame: Float64Array.from(IDENTITY), meshes: MESH, fieldProgram: { format: 'other' } },
      { partId: 'record', frame: Float64Array.from(IDENTITY), meshes: MESH },
      { partId: 'collider', frame: Float64Array.from(IDENTITY), meshes: [], fieldProgram: program() },
    ]),
  ])
  const mode = Object.fromEntries(report.parts.map(p => [p.key, p.mode]))
  assert.deepEqual(mode, { 'a#g/ok': 'field', 'a#g/warped': 'refused', 'a#g/scaled': 'scaled', 'a#g/broken': 'invalid' })
  assert.deepEqual(report.hard.map(p => p.key), ['a#g/broken', 'a#g/scaled'])
  assert.match(report.parts.find(p => p.key === 'a#g/warped')!.reason, /lattice/)
})

test('fieldPreflight demotes the smallest parts first when the grids exceed the atlas budget', () => {
  const big = new Float32Array([0, 0, 0, 10, 10, 10])
  const report = fieldPreflight([
    asset('a', [
      { partId: 'small', frame: Float64Array.from(IDENTITY), meshes: MESH, fieldProgram: program(64) },
      { partId: 'large', frame: Float64Array.from(IDENTITY), meshes: [{ positions: big }], fieldProgram: program(64) },
    ]),
  ], 64 * 64 * 4)
  const mode = Object.fromEntries(report.parts.map(p => [p.key, p.mode]))
  assert.deepEqual(mode, { 'a#g/large': 'field', 'a#g/small': 'demoted' })
  assert.equal(report.hard.length, 0)
})

// The guard itself: the fieldShading op's saved world has no part the GPU op would fail on.
test('the saved sprint world has no hard field shading failure', async () => {
  const report = fieldPreflight(await preflightAssets('sprint'))
  assert.ok(report.parts.length > 100, `${report.parts.length} field-contract parts`)
  assert.deepEqual(report.hard.map(p => `${p.key}: ${p.reason}`), [])
})
