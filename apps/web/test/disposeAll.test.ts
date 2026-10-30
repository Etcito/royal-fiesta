// disposeAll: every cleanup step runs, and a cleanup error never replaces the error of the op itself.
import assert from 'node:assert/strict'
import test from 'node:test'
import { disposeAll } from '../src/game/disposeAll.ts'

const RECURSIVE = 'recursive use of an object detected which would lead to unsafe aliasing in rust'

// A stand-in for a wasm-bindgen object left borrowed by a call that threw through Rust frames.
class StuckEngine {
  dispose(): void { throw new Error(RECURSIVE) }
}
class Engine {
  disposed = false
  dispose(): void { this.disposed = true }
}

async function op(engines: (StuckEngine | Engine)[]): Promise<void> {
  let failed = false
  try {
    throw new Error('GPUValidationError: lit pipeline rejected')
  } catch (e) {
    failed = true
    throw e
  } finally {
    disposeAll(engines.map(e => () => e.dispose()), failed)
  }
}

test('the op error survives a cleanup that throws, and later steps still run', async () => {
  const healthy = new Engine()
  const logged: string[] = []
  const original = console.error
  console.error = (m: string) => { logged.push(m) }
  try {
    await assert.rejects(op([new StuckEngine(), healthy]), /GPUValidationError/)
  } finally {
    console.error = original
  }
  assert.equal(healthy.disposed, true)
  assert.equal(logged.length, 1)
  assert.match(logged[0], /recursive use/)
})

test('without an op error the first cleanup error is thrown after every step ran', () => {
  const healthy = new Engine()
  const original = console.error
  console.error = () => {}
  try {
    assert.throws(() => disposeAll([() => new StuckEngine().dispose(), () => healthy.dispose()], false), /recursive use/)
  } finally {
    console.error = original
  }
  assert.equal(healthy.disposed, true)
})
