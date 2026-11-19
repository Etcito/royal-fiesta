import assert from 'node:assert/strict'
import test from 'node:test'
import { rfScriptBytes } from '../src/egeHarness.ts'

test('character tuning constants and helpers match their hand-derived values', async () => {
  const wasm = await rfScriptBytes()
  const module = await WebAssembly.compile(wasm)
  const imports: Record<string, Record<string, () => number>> = { engine: {} }
  for (const item of WebAssembly.Module.imports(module)) {
    imports[item.module] ??= {}
    imports[item.module][item.name] = () => 0
  }
  const instance = await WebAssembly.instantiate(module, imports)
  const exported = instance.exports as Record<string, (...args: number[]) => number>
  const near = (name: string, actual: number, expected: number) => {
    assert.ok(Math.abs(actual - expected) <= 1e-12, `${name}: ${actual} != ${expected}`)
  }

  assert.equal(exported.strokeStartTick(), 15)
  assert.equal(exported.strokeTotalTicks(), 39)
  assert.equal(exported.strokeReadyTicks(), 30)
  assert.equal(exported.strokeElapsed(39), 0)
  assert.equal(exported.strokeElapsed(10), 29)
  assert.equal(exported.strokeElapsed(0), -1)
  near('iceWalkAccel midpoint', exported.iceWalkAccel(0.04), 0.15)
  near('iceWalkBrake midpoint', exported.iceWalkBrake(0.04), 0.095)
  near('iceWalkMaxRun midpoint', exported.iceWalkMaxRun(0.04), 0.925)
  near('iceWalkAccel low clamp', exported.iceWalkAccel(0.01), 0.05)
  near('iceWalkMaxRun high clamp', exported.iceWalkMaxRun(0.2), 1.1)
  near('surfaceMaxRun mud', exported.surfaceMaxRun(2), 0.6)
  near('surfaceBounce rubber', exported.surfaceBounce(3), 0.6)
  near('slideFriction ice', exported.slideFriction(1), 0.02)
  near('charTurnRate', exported.charTurnRate(), 4 * Math.PI)
})
