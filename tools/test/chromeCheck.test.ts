import assert from 'node:assert/strict'
import test from 'node:test'
import { BOOT_REFUSAL, run } from '../../apps/web/src/game/checks/boot.ts'
import type { TourDeps, TourGame } from '../../apps/web/src/game/uiTour.ts'

test('checkBoot clicks Retry after the deliberate refusal and reaches loading then start', async () => {
  const old = { requestAnimationFrame: globalThis.requestAnimationFrame, window: globalThis.window, MouseEvent: globalThis.MouseEvent, PointerEvent: globalThis.PointerEvent }
  Object.assign(globalThis, { requestAnimationFrame: (callback: () => void) => { queueMicrotask(callback); return 0 }, window: {}, MouseEvent: Event, PointerEvent: Event })
  let disposed = false
  let clicked = false
  try {
    const deps = { boot: async onScreen => {
      let screen = 'error'
      let frames = 0
      console.error(`[error-screen] ${BOOT_REFUSAL}`)
      onScreen({ from: null, to: screen })
      return {
        host: { widgetRect: () => ({ x: 0, y: 0, w: 100, h: 30 }) },
        ui: { getBoundingClientRect: () => ({ left: 0, top: 0 }), dispatchEvent: (e: Event) => { if (e.type === 'click') clicked = true } },
        step: (dt: number) => {
          assert.equal(dt, 1 / 60)
          assert.equal(clicked, true)
          if (++frames === 1) return // Retry can take another frame to leave error.
          const next = screen === 'error' ? 'loading' : 'start'
          onScreen({ from: screen, to: next }); screen = next
        },
        dispose: () => { disposed = true },
      } as unknown as TourGame
    } } as TourDeps
    const result = await run({}, deps)
    assert.deepEqual(result.json, { ok: true, screen: 'start', transitions: ['error', 'loading', 'start'] })
    assert.equal(disposed, true)
  } finally { Object.assign(globalThis, old) }
})

test('checkBoot preserves an unexpected boot error and does not retry', async () => {
  const result = await run({}, { boot: async onScreen => {
    console.error('[error-screen] content failed')
    onScreen({ from: null, to: 'error' })
    return { dispose() {}, step() { assert.fail('must not retry') } } as unknown as TourGame
  } } as TourDeps)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'content failed')
})
