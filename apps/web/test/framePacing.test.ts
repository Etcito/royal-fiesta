import assert from 'node:assert/strict'
import test from 'node:test'
import { CAP60_MS, FramePacer, frameInterval } from '../src/game/framePacing.ts'

// Renders over `seconds` of rAF callbacks at `hz` and returns the rendered frame count.
function rendered(pacer: FramePacer, hz: number, seconds: number, jitter = 0): number {
  let count = 0
  const step = 1000 / hz
  for (let i = 0; i < hz * seconds; i++) {
    const now = 1000 + i * step + (i % 2 === 0 ? jitter : -jitter)
    if (pacer.shouldRender(now)) count++
  }
  return count
}

test('the 60 fps cap paces a fast display off rAF timestamps', () => {
  for (const hz of [120, 144, 165, 240]) {
    const fps = rendered(new FramePacer(() => CAP60_MS), hz, 10, 0.5) / 10
    assert.ok(fps > 57 && fps <= 61, `${hz} Hz renders ${fps} fps`)
  }
})

test('the cap renders every refresh of a 60 Hz display, jitter included', () => {
  assert.equal(rendered(new FramePacer(() => CAP60_MS), 60, 10, 0.5), 600)
  assert.equal(rendered(new FramePacer(() => CAP60_MS), 59.94, 100), 5994)
  // A display slightly faster than the cap never drifts out of the schedule.
  assert.equal(rendered(new FramePacer(() => CAP60_MS), 60.05, 100), 6005)
})

test('Vmax renders every display refresh', () => {
  assert.equal(rendered(new FramePacer(() => frameInterval('vmax')), 144, 10), 1440)
})

test('after a stall the pacer restarts from now instead of rendering a burst', () => {
  const pacer = new FramePacer(() => CAP60_MS)
  assert.ok(pacer.shouldRender(0))
  assert.ok(pacer.shouldRender(5000))
  assert.equal(pacer.shouldRender(5007), false)
  assert.ok(pacer.shouldRender(5017))
})

test('frameInterval caps anything but vmax at 60 fps', () => {
  assert.equal(frameInterval('vmax'), 0)
  assert.equal(frameInterval('cap60'), CAP60_MS)
  assert.equal(frameInterval(undefined), CAP60_MS)
})
