import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FIELD_ATLAS_BYTES,
  fieldGridBytes,
  partDiag,
  planFieldAtlas,
  type PartFieldCost,
} from '../src/sdf/fieldAtlas.ts'

function part(key: string, diag: number, bytes: number): PartFieldCost {
  return { key, diag, bytes }
}

function positions(values: number[]): { positions: Float32Array } {
  return { positions: new Float32Array(values) }
}

test('parts are demoted by allocation bytes, then numeric input position', () => {
  const parts = [
    part('c#0/0', 2, 10),
    part('b#0/0', 1, 20),
    part('a#0/0', 1, 20),
    part('d#0/0', 1, 5),
  ]
  const plan = planFieldAtlas(parts, 0)
  assert.deepEqual(plan.demoted, ['d#0/0', 'c#0/0', 'b#0/0', 'a#0/0'])
  assert.equal(plan.field.size, 0)
  assert.equal(plan.bytes, 0)
})

test('it stops exactly when the total fits', () => {
  const parts = [part('a', 1, 60), part('b', 2, 60), part('c', 3, 10)]
  const plan = planFieldAtlas(parts, 100)
  assert.deepEqual(plan.demoted, ['c', 'a'])
  assert.equal(plan.bytes, 60)
  assert.equal(plan.budget, 100)
  assert.deepEqual([...plan.field], ['b'])
  const exact = planFieldAtlas(parts, 130)
  assert.deepEqual(exact.demoted, [])
  assert.equal(exact.bytes, 130)
})

test('zero-cost parts are kept and never demoted', () => {
  const parts = [part('analytic', 1, 0), part('grid', 2, 50)]
  const fits = planFieldAtlas(parts, 50)
  assert.deepEqual(fits.demoted, [])
  assert.deepEqual([...fits.field].sort(), ['analytic', 'grid'])
  const over = planFieldAtlas(parts, 49)
  assert.deepEqual(over.demoted, ['grid'])
  assert.deepEqual([...over.field], ['analytic'])
  assert.equal(over.bytes, 0)
})

test('the same input gives the same plan', () => {
  const parts = [part('c', 3, 9), part('a', 1, 8), part('b', 1, 7)]
  const first = planFieldAtlas(parts, 17)
  const second = planFieldAtlas(parts, 17)
  assert.deepEqual(first, second)
  const reordered = planFieldAtlas([...parts].reverse(), 17)
  assert.deepEqual(reordered, first)
})

test('the default budget is FIELD_ATLAS_BYTES', () => {
  assert.equal(planFieldAtlas([]).budget, FIELD_ATLAS_BYTES)
  assert.equal(planFieldAtlas([part('a', 1, 1)]).budget, FIELD_ATLAS_BYTES)
  assert.equal(planFieldAtlas([part('a', 1, 1)], 12).budget, 12)
  assert.equal(FIELD_ATLAS_BYTES, Math.floor(4096 * 4096 * 4 * 0.85))
})

test('an empty world has an empty plan', () => {
  const plan = planFieldAtlas([])
  assert.equal(plan.field.size, 0)
  assert.deepEqual(plan.demoted, [])
  assert.equal(plan.bytes, 0)
  assert.equal(plan.budget, FIELD_ATLAS_BYTES)
})

test('the diagonal is the bounding box of every position, 0 without a vertex', () => {
  assert.equal(partDiag([]), 0)
  assert.equal(partDiag([positions([])]), 0)
  assert.equal(partDiag([positions([0, 0, 0, 3, 4, 0])]), 5)
  assert.equal(partDiag([positions([-1, 0, 0]), positions([1, 3, 4])]), Math.sqrt(4 + 9 + 16))
  assert.equal(partDiag([positions([1, 2, 3])]), 0)
})

test('grid bytes are whole rgba8 texels of RAA\'s atlas', () => {
  // RAA's atlas is rgba8 (ATLAS_FORMAT = Rgba8Unorm), so one texel costs 4 bytes.
  assert.equal(fieldGridBytes(null), 0)
  assert.equal(fieldGridBytes({ width: 1, height: 1 }), 4)
  assert.equal(fieldGridBytes({ width: 4096, height: 2 }), 4096 * 2 * 4)
  assert.equal(fieldGridBytes({ width: 256, height: 256 }), 256 * 256 * 4)
})

import { planFieldPrograms, repackFieldProgram, sampleFieldGrid } from '../src/sdf/fieldAtlas.ts'
import type { FieldProgramLike, FieldGridOperandLike } from '../src/sdf/fieldShading.ts'

function gridProgram(shape: 'sphere' | 'box'): FieldProgramLike {
  const size = 40, voxel = 0.1, range = 5
  const op: FieldGridOperandLike = { kind: 'grid', label: 0, scale: 1,
    inv: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    origin: [-2, -2, -2], size: [size, size, size], voxel, range, at: [3, 2] }
  const width = size * size + 8, height = size * 3
  const texels = new Uint8Array(width * height * 4)
  for (let y = 0; y < size; y++) for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const p = [x, y, z].map(v => -2 + (v + 0.5) * voxel)
    const q = p.map(v => Math.abs(v) - 1)
    const d = shape === 'sphere' ? Math.hypot(...p) - 1 : Math.hypot(...q.map(v => Math.max(0, v))) + Math.min(0, Math.max(...q))
    const encoded = Math.round((d / range * 0.5 + 0.5) * 65535)
    const at = ((op.at[1] + y) * width + op.at[0] + z * size + x) * 4
    texels.set([encoded >> 8, encoded & 255, 0, 255], at)
  }
  return { format: 'mama.field-program', version: 1, bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    labels: [{ material: null, color: [1, 1, 1], roughness: 0.5, metallic: 0 }], operands: [op],
    tree: [{ op: 'leaf', operand: 0 }], grid: { width, height, texels }, functionName: 'pmf_eval_0123456789abcdef', wgsl: '' }
}

test('lossless shelf repack preserves every operand texel without changing the source', () => {
  const original = gridProgram('sphere')
  const op = original.operands[0] as FieldGridOperandLike
  original.operands = [op, { ...op, size: [20, 32, 20] }, { ...op, size: [16, 32, 16] }]
  const saved = original.grid!.texels.slice()
  const packed = repackFieldProgram(original)
  assert.ok(fieldGridBytes(packed.grid) < fieldGridBytes(original.grid))
  assert.ok(packed.grid!.width <= 4096)
  for (let i = 0; i < original.operands.length; i++) {
    const a = original.operands[i] as FieldGridOperandLike, b = packed.operands[i] as FieldGridOperandLike
    for (let y = 0; y < a.size[1]; y++) {
      const src = ((a.at[1] + y) * original.grid!.width + a.at[0]) * 4
      const dst = ((b.at[1] + y) * packed.grid!.width + b.at[0]) * 4
      assert.deepEqual(packed.grid!.texels.subarray(dst, dst + a.size[0] * a.size[2] * 4), saved.subarray(src, src + a.size[0] * a.size[2] * 4))
    }
  }
  assert.deepEqual(original.grid!.texels, saved)
  assert.deepEqual(op.at, [3, 2])
})

for (const shape of ['sphere', 'box'] as const) test(`resampled ${shape} distances stay within one new voxel`, () => {
  const original = gridProgram(shape)
  const sampled = repackFieldProgram(original, 12, 2)
  const old = original.operands[0] as FieldGridOperandLike, op = sampled.operands[0] as FieldGridOperandLike
  assert.equal(op.voxel, 0.2)
  for (let z = -2.5; z <= 2.5; z += 0.37) for (let y = -2.5; y <= 2.5; y += 0.39) for (let x = -2.5; x <= 2.5; x += 0.41) {
    const p = [x, y, z]
    assert.ok(Math.abs(sampleFieldGrid(original.grid!, old, p) - sampleFieldGrid(sampled.grid!, op, p)) <= op.voxel)
  }
})

test('global scale is deterministic, fits within one percent of its failing bound, and respects floors', () => {
  const program = gridProgram('sphere')
  const parts = [{ key: 'a', diag: 12, program }, { key: 'b', diag: 12, program }]
  const budget = 180000
  const a = planFieldPrograms(parts, budget), b = planFieldPrograms([...parts].reverse(), budget)
  assert.equal(a.fieldGridScale, b.fieldGridScale)
  assert.ok(a.fieldGridScale > 1)
  assert.equal(a.plan.demoted.length, 0)
  assert.ok(a.plan.bytes <= budget)
  const below = repackFieldProgram(program, 12, a.fieldGridScale / 1.01)
  assert.ok(fieldGridBytes(below.grid) * 2 > budget)
  const floor = planFieldPrograms(parts, 0)
  const op = floor.programs.get('a')!.operands[0] as FieldGridOperandLike
  assert.ok(Math.max(...op.size) >= 16)
  assert.ok(op.voxel <= 12 / 32)
  assert.deepEqual(floor.plan.demoted, ['a', 'b'])
})


test('lossless fit needs no resampling and runtime grids are cached separately from saved data', () => {
  const program = gridProgram('box')
  const plan = planFieldPrograms([{ key: 'box', diag: 12, program }], 40 ** 3 * 4)
  assert.equal(plan.fieldGridScale, 1)
  assert.equal(plan.resampledParts, 0)
  assert.equal(plan.plan.demoted.length, 0)
  assert.equal(plan.programs.get('box'), repackFieldProgram(program, 12, 1))
  assert.notEqual(plan.programs.get('box')!.grid!.texels, program.grid!.texels)
})

test('shared allocation keys cost once and demote every reference together', () => {
  const shared = part('shared', 1, 40)
  const parts = [shared, part('unique', 1, 60), shared]
  assert.equal(planFieldAtlas(parts, 100).demoted.length, 0)
  const plan = planFieldAtlas(parts, 60)
  assert.deepEqual(plan.demoted, ['shared'])
  assert.equal(plan.bytes, 60)
  assert.deepEqual([...plan.field], ['unique'])
  const program = slabProgram([2, 2, 2])
  const instance = { key: 'shared', diag: 0, program }
  const packed = planFieldPrograms([instance, instance], fieldGridBytes(program.grid))
  assert.equal(packed.plan.bytes, fieldGridBytes(program.grid))
  assert.equal(packed.plan.demoted.length, 0)
  assert.equal(packed.fieldGridScale, 1)
})

test('equal costs use numeric candidate positions beyond index nine', () => {
  const parts = Array.from({ length: 12 }, (_, i) => part(`part-${11 - i}`, 12 - i, 4))
  assert.deepEqual(planFieldAtlas(parts, 4).demoted, parts.slice(0, 11).map(p => p.key))
})

test('a resource retained into the next scene keeps its existing admission cost', () => {
  // The wall is still uploaded for the previous scene when the next one prepares; the later
  // reference must not count it twice or move it in the cheapest-first order.
  const parts = [part('kept.floor', 1, 40), part('shared.wall', 2, 20), part('next.ramp', 3, 10), part('shared.wall', 2, 30)]
  const plan = planFieldAtlas(parts, 60)
  assert.deepEqual(plan.demoted, ['next.ramp'])
  assert.deepEqual([...plan.field], ['kept.floor', 'shared.wall'])
  assert.equal(plan.bytes, 60)
})

test('retained and next-scene resources share one budget and every part keeps a tier', () => {
  const retained = [part('old.floor', 4, 30), part('old.wall', 3, 20)]
  const next = [part('new.ramp', 2, 10), part('new.flag', 1, 5)]
  const plan = planFieldAtlas([...retained, ...next], 40)
  // Overflow demotes several cheapest candidates, retained ones included, until the rest fits.
  assert.deepEqual(plan.demoted, ['new.flag', 'new.ramp', 'old.wall'])
  assert.deepEqual([...plan.field], ['old.floor'])
  assert.equal(plan.bytes, 30)
  // Complete retained geometry: a demoted part changes tier, it is never dropped.
  assert.deepEqual([...plan.field, ...plan.demoted].sort(), [...retained, ...next].map(p => p.key).sort())
  assert.equal(new Set(plan.demoted).size, plan.demoted.length)
})

function slabProgram(size: [number, number, number]): FieldProgramLike {
  const p = gridProgram('box')
  p.operands = [{ ...(p.operands[0] as FieldGridOperandLike), size, at: [0, 0] }]
  p.grid = { width: size[0] * size[2], height: size[1], texels: new Uint8Array(size[0] * size[1] * size[2] * 4) }
  return p
}

test('shelf overflow falls back even when texture bytes fit the normal atlas budget', () => {
  const program = slabProgram([48, 64, 48])
  const parts = Array.from({ length: 65 }, (_, i) => ({ key: `part-${i}`, diag: 0, program }))
  const { plan } = planFieldPrograms(parts)
  assert.ok(fieldGridBytes(program.grid) * parts.length < FIELD_ATLAS_BYTES)
  assert.deepEqual(plan.demoted, ['part-0'])
  assert.equal(plan.field.size, 64)
  assert.equal(plan.bytes, fieldGridBytes(program.grid) * 64, 'distinct uploads of one program still cost separately')
  assert.deepEqual(planFieldPrograms(parts).plan, plan)
})

test('texture id exhaustion also falls back before RAA allocation', () => {
  const program = slabProgram([2, 2, 2])
  const parts = Array.from({ length: 1024 }, (_, i) => ({ key: `part-${i}`, diag: 0, program }))
  const { plan } = planFieldPrograms(parts)
  assert.deepEqual(plan.demoted, ['part-0'])
  assert.equal(plan.field.size, 1023)
})
