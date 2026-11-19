import assert from 'node:assert/strict'
import test from 'node:test'
import { rfScriptBytes } from '../src/egeHarness.ts'

test('seat route and respawn helpers match hand-derived values', async () => {
  const wasm = await rfScriptBytes()
  const module = await WebAssembly.compile(wasm)
  const imports: Record<string, Record<string, () => number>> = { engine: {} }
  for (const item of WebAssembly.Module.imports(module)) {
    imports[item.module] ??= {}
    imports[item.module][item.name] = () => 0
  }
  const instance = await WebAssembly.instantiate(module, imports)
  const fn = instance.exports as Record<string, (...args: number[]) => number>
  const near = (name: string, actual: number, expected: number) => {
    assert.ok(Math.abs(actual - expected) <= 1e-12, `${name}: ${actual} != ${expected}`)
  }

  assert.equal(fn.subTick(2, -2, 1), 16384)
  assert.equal(fn.subTick(3, 3, 0), 0)
  assert.equal(fn.subTick(0, -1, 5), 0)
  assert.equal(fn.subTick(10, 0, -5), 65535)
  assert.equal(fn.respawnSlotCount(0), 1)
  assert.equal(fn.respawnSlotCount(8), 8)
  assert.equal(fn.respawnSlotCount(20), 12)
  assert.equal(fn.dueRespawn(-1, 100), 0)
  assert.equal(fn.dueRespawn(100, 99), 0)
  assert.equal(fn.dueRespawn(100, 100), 1)
  near('slot 0 x', fn.respawnSlotX(0, 15, 0, 1, 0, 8, 1.2), 1.8)
  near('slot 0 z', fn.respawnSlotZ(0, 15, 0, 1, 0, 8, 1.2), 16.2)
  near('slot 5 x', fn.respawnSlotX(0, 15, 0, 1, 5, 8, 1.2), 0.6)
  near('slot 5 z', fn.respawnSlotZ(0, 15, 0, 1, 5, 8, 1.2), 15)
  near('slot 9 x', fn.respawnSlotX(0, 15, 0, 1, 9, 8, 1.2), 0.6)
  near('slot 9 z', fn.respawnSlotZ(0, 15, 0, 1, 9, 8, 1.2), 16.2)
  near('rotated slot 0 x', fn.respawnSlotX(2, 3, 1, 0, 0, 12, 1), 3)
  near('rotated slot 0 z', fn.respawnSlotZ(2, 3, 1, 0, 0, 12, 1), 1.5)
  assert.equal(fn.nextSlot(9, 8), 1)
  assert.equal(fn.nextSlot(3, 0), 0)
  assert.equal(fn.nextCursor(7, 8), 0)
  assert.equal(fn.nextCursor(2, 8), 3)
  assert.equal(fn.gateCrossed(1, 1, 0, 0, -1), 0)
  assert.equal(fn.gateCrossed(1, 1, 0, 0, 0), -1)
  assert.equal(fn.gateCrossed(1, 1, 1, -1, -1), -1)
  assert.equal(fn.gateCrossed(0, 3, 2, 2, 0), 2)
  assert.equal(fn.gateCrossed(0, 3, 0, 0, 1), -1)
  assert.equal(fn.finishCrossed(1, 1, 0, 0, 0), 2)
  assert.equal(fn.finishCrossed(1, 1, 0, -1, 0), 0)
  assert.equal(fn.finishCrossed(1, 2, 0, 0, 0), 1)
  assert.equal(fn.finishCrossed(0, 1, 0, -1, 0), 2)
})
