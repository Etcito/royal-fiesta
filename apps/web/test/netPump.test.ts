import assert from 'node:assert/strict'
import test from 'node:test'
import { NetPump } from '../src/game/netPump.ts'

// A stand-in for the beat worker: the test posts the beats itself.
class FakeWorker {
  static last: FakeWorker | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  constructor() { FakeWorker.last = this }
  terminate(): void { this.terminated = true }
  beat(): void { this.onmessage?.() }
}

test('NetPump steps the flow only while no frame runs, and the next frame does not step that time again', () => {
  const g = globalThis as { Worker?: unknown }
  const saved = g.Worker
  g.Worker = FakeWorker
  try {
    let t = 0
    const steps: number[] = []
    const pump = new NetPump(dt => steps.push(dt), () => t)
    const w = FakeWorker.last!
    assert.ok(pump.running)
    // Frames every 16 ms: beats do nothing.
    for (let i = 0; i < 10; i++) {
      t += 16
      assert.equal(pump.frame(0.016), 0.016)
      w.beat()
    }
    assert.equal(steps.length, 0)
    // The window goes behind another one: no frames for 1 s, a beat every 16 ms.
    for (let i = 0; i < 62; i++) {
      t += 16
      w.beat()
    }
    const stepped = steps.reduce((a, b) => a + b, 0)
    assert.ok(steps.length > 50 && stepped > 0.85 && stepped <= 1, `beats stepped ${stepped.toFixed(3)} s in ${steps.length} steps`)
    assert.equal(pump.pumped, steps.length)
    // The window is drawn again: the rAF dt (capped at 0.1 s by the page) shrinks to the time since the last beat.
    t += 5
    assert.ok(Math.abs(pump.frame(0.1) - 0.005) < 1e-9)
    t += 16
    assert.equal(pump.frame(0.016), 0.016)
    pump.dispose()
    assert.ok(w.terminated && !pump.running)
  } finally {
    g.Worker = saved
  }
})
