import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadInventory, requireProblems, selectRows, type InventoryRow } from '../engineRoundCapture.ts'

function row(overrides: Record<string, unknown> = {}) {
  return { id: 'fiesta', milestone: 'm2', filename: 'fiesta-run.png', args: { course: 'fiesta' }, require: [], description: 'A run', held_constant: [], ...overrides }
}

function withInventory(rows: unknown[], run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-round-'))
  const path = join(dir, 'inventory.json')
  try { writeFileSync(path, JSON.stringify(rows)); run(path) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('loadInventory validates row fields and args at their pointers', () => {
  withInventory([row()], path => assert.equal(loadInventory(path)[0].milestone, 'm2'))
  const cases: [unknown[], RegExp][] = [
    [[row(), row({ filename: 'second.png' })], /inventory\.json#\/1\/id/],
    [[row(), row({ id: 'second' })], /inventory\.json#\/1\/filename/],
    [[row({ filename: 'Bad.PNG' })], /inventory\.json#\/0\/filename/],
    [[row({ args: { course: 'fiesta', extra: true } })], /inventory\.json#\/0\/args\/extra/],
    [[row({ milestone: 'm9' })], /inventory\.json#\/0\/milestone/],
  ]
  for (const [rows, pointer] of cases) withInventory(rows, path => assert.throws(() => loadInventory(path), pointer))
})

test('requireProblems evaluates E8 operators and nested facts', () => {
  assert.deepEqual(requireProblems({ seats: 8 }, ['seats eq 8']), [])
  assert.match(requireProblems({ seats: 7 }, ['seats eq 8'])[0], /got 7/)
  assert.deepEqual(requireProblems({ bodies: 21 }, ['bodies gt 20']), [])
  assert.deepEqual(requireProblems({ tick: 120 }, ['tick ge 120']), [])
  assert.deepEqual(requireProblems({ faults: 0 }, ['faults lt 1']), [])
  assert.deepEqual(requireProblems({ gpuErrors: [] }, ['gpuErrors empty']), [])
  assert.match(requireProblems({ gpuErrors: ['x'] }, ['gpuErrors empty'])[0], /got \["x"\]/)
  assert.deepEqual(requireProblems({ local: { travelZ: 2 } }, ['local.travelZ gt 1']), [])
  assert.deepEqual(requireProblems({}, ['missing eq 1']), ['missing eq 1: fact missing is absent'])
  assert.deepEqual(requireProblems({}, ['broken']), ["broken: not 'broken'"])
})

test('selectRows preserves file order for the requested milestone', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', milestone: 'm3' }), row({ id: 'c' })] as unknown as InventoryRow[]
  assert.deepEqual(selectRows(rows, 'm2').map(item => item.id), ['a', 'c'])
})
