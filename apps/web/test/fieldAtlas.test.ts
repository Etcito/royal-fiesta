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

test('parts are demoted by diagonal, then bytes, then key', () => {
  const parts = [
    part('c#0/0', 2, 10),
    part('b#0/0', 1, 20),
    part('a#0/0', 1, 20),
    part('d#0/0', 1, 5),
  ]
  const plan = planFieldAtlas(parts, 0)
  assert.deepEqual(plan.demoted, ['d#0/0', 'a#0/0', 'b#0/0', 'c#0/0'])
  assert.equal(plan.field.size, 0)
  assert.equal(plan.bytes, 0)
})

test('it stops exactly when the total fits', () => {
  const parts = [part('a', 1, 60), part('b', 2, 60), part('c', 3, 10)]
  const plan = planFieldAtlas(parts, 100)
  assert.deepEqual(plan.demoted, ['a'])
  assert.equal(plan.bytes, 70)
  assert.equal(plan.budget, 100)
  assert.deepEqual([...plan.field].sort(), ['b', 'c'])
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
