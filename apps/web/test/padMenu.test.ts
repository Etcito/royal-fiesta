// PadMenu: every connected pad navigates menus without a seat; standard and non-standard pads, auto-repeat.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { UiEvent } from '../src/input/input.ts'
import { PadMenu, REPEAT_FIRST_MS, REPEAT_MS } from '../src/input/padMenu.ts'
import type { MenuPad } from '../src/input/padMenu.ts'

function pad(index: number, buttons = 17, axes = 4): MenuPad {
  return {
    index,
    connected: true,
    axes: Array.from({ length: axes }, () => 0),
    buttons: Array.from({ length: buttons }, () => ({ pressed: false })),
  }
}
const press = (p: MenuPad, i: number, on = true) => { (p.buttons as { pressed: boolean }[])[i].pressed = on }
function step(m: PadMenu, pads: (MenuPad | null)[], now: number, menu = true): UiEvent[] {
  const out: UiEvent[] = []
  m.update(pads, now, menu, out)
  return out
}

test('d-pad moves focus and adjusts on a pad with no seat', () => {
  const m = new PadMenu()
  const p = pad(0)
  press(p, 13)
  assert.deepEqual(step(m, [p], 0), [{ k: 'focus', dir: 1 }])
  press(p, 13, false)
  press(p, 12)
  assert.deepEqual(step(m, [p], 10), [{ k: 'focus', dir: -1 }])
  press(p, 12, false)
  press(p, 15)
  assert.deepEqual(step(m, [p], 20), [{ k: 'adjust', dir: 1 }])
  press(p, 15, false)
  press(p, 14)
  assert.deepEqual(step(m, [p], 30), [{ k: 'adjust', dir: -1 }])
})

test('left stick moves focus; a small tilt does nothing', () => {
  const m = new PadMenu()
  const p = pad(0)
  ;(p.axes as number[])[1] = 0.3
  assert.deepEqual(step(m, [p], 0), [])
  ;(p.axes as number[])[1] = 0.9
  assert.deepEqual(step(m, [p], 10), [{ k: 'focus', dir: 1 }])
  ;(p.axes as number[])[1] = 0
  ;(p.axes as number[])[0] = -0.9
  assert.deepEqual(step(m, [p], 20), [{ k: 'adjust', dir: -1 }])
})

test('a held direction repeats after the first delay, then at the repeat rate', () => {
  const m = new PadMenu()
  const p = pad(0)
  press(p, 13)
  assert.equal(step(m, [p], 0).length, 1)
  assert.equal(step(m, [p], REPEAT_FIRST_MS - 1).length, 0)
  assert.equal(step(m, [p], REPEAT_FIRST_MS).length, 1)
  assert.equal(step(m, [p], REPEAT_FIRST_MS + REPEAT_MS - 1).length, 0)
  assert.equal(step(m, [p], REPEAT_FIRST_MS + REPEAT_MS).length, 1)
  press(p, 13, false)
  assert.equal(step(m, [p], REPEAT_FIRST_MS + 2 * REPEAT_MS).length, 0)
})

test('button 0 selects, button 1 and start go back, each once per press', () => {
  const m = new PadMenu()
  const p = pad(1)
  press(p, 0)
  assert.deepEqual(step(m, [p], 0), [{ k: 'select' }])
  assert.deepEqual(step(m, [p], 10), [])
  press(p, 0, false)
  press(p, 1)
  assert.deepEqual(step(m, [p], 20), [{ k: 'back', pad: 'b' }])
  press(p, 1, false)
  press(p, 9)
  assert.deepEqual(step(m, [p], 30), [{ k: 'back', pad: 'start' }])
})

test('any connected pad drives the menu, not just the first', () => {
  const m = new PadMenu()
  const a = pad(0)
  const b = pad(2)
  press(b, 0)
  assert.deepEqual(step(m, [a, null, b], 0), [{ k: 'select' }])
})

test('a non-standard pad: hat axis 9 and the stick navigate, buttons 0 and 1 still confirm and cancel', () => {
  const m = new PadMenu()
  const p = pad(0, 12, 10)
  ;(p.axes as number[])[9] = 3.2857
  assert.deepEqual(step(m, [p], 0), [])
  ;(p.axes as number[])[9] = 0.14
  assert.deepEqual(step(m, [p], 10), [{ k: 'focus', dir: 1 }])
  ;(p.axes as number[])[9] = -1
  assert.deepEqual(step(m, [p], 20), [{ k: 'focus', dir: -1 }])
  ;(p.axes as number[])[9] = 3.2857
  press(p, 0)
  assert.deepEqual(step(m, [p], 30), [{ k: 'select' }])
})

test('outside menus only Start is reported, and a press held into a menu is not an edge', () => {
  const m = new PadMenu()
  const p = pad(0)
  press(p, 0)
  press(p, 13)
  assert.deepEqual(step(m, [p], 0, false), [])
  assert.deepEqual(step(m, [p], 10, true), [])
  press(p, 9)
  assert.deepEqual(step(m, [p], 20, false), [{ k: 'back', pad: 'start' }])
})
