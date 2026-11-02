import assert from 'node:assert/strict'
import test from 'node:test'
import { checkAwait, checkPhase } from '../src/game/checkProgress.ts'

test('a phase names overlapping waits, preserves errors, and clears only settled waits', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = { __nmcCheck: { pageErrors: ['earlier error'] } } as any
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
  try {
    let release!: () => void
    const first = checkAwait('round content', () => new Promise<void>(resolve => { release = resolve }))
    await assert.rejects(checkAwait('lobby port', async () => { throw Error('port failed') }), /port failed/)
    checkPhase('returning to hub')
    assert.equal(target.__nmcCheck.phase, 'returning to hub')
    assert.equal(target.__nmcCheck.lastAwaitedStep, 'lobby port')
    assert.deepEqual(target.__nmcCheck.awaitingSteps, ['round content'])
    assert.deepEqual(target.__nmcCheck.pageErrors, ['earlier error'])
    assert.match(target.__nmcGpuProgress, /awaiting: round content/)
    release()
    await first
    assert.deepEqual(target.__nmcCheck.awaitingSteps, [])
    assert.match(target.__nmcGpuProgress, /awaiting: none/)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
