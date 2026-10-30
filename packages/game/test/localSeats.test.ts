import assert from 'node:assert/strict'
import test from 'node:test'
import { neutralInput } from '@royal-fiesta/sim/input'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { emptyControls } from '../src/client/inputMap.ts'
import { assignPads, LocalSeats } from '../src/client/localSeats.ts'
import type { KeyScheme, SeatDevices } from '../src/client/localSeats.ts'
import { splitRects } from '../src/render/splitScreen.ts'

const device = (keyboard: KeyScheme | null, pad: number | null): SeatDevices => ({ keyboard, pad })
const snapshot = (axes: number[] = [], pressed: number[] = []) => ({
  axes, buttons: Array.from({ length: 3 }, (_, i) => ({ pressed: pressed.includes(i) })),
})

test('assignPads assigns pads first and shares the remaining keyboard', () => {
  assert.deepEqual(assignPads(1, []), [device('all', null)])
  assert.deepEqual(assignPads(1, [0]), [device('all', 0)])
  assert.deepEqual(assignPads(2, []), [device('left', null), device('right', null)])
  assert.deepEqual(assignPads(2, [0]), [device(null, 0), device('all', null)])
  assert.deepEqual(assignPads(3, [0]), [device(null, 0), device('left', null), device('right', null)])
  assert.deepEqual(assignPads(4, [0, 1, 2, 3]), [device('all', 0), device(null, 1), device(null, 2), device(null, 3)])
  assert.deepEqual(assignPads(4, []), [device('left', null), device('right', null), device(null, null), device(null, null)])
  assert.deepEqual(assignPads(2, [2, 7, 9]), [device('all', 2), device(null, 7)])
})

test('assignPads refuses seat counts outside the integer range 1..4', () => {
  for (const seats of [0, -1, 5, 1.5, NaN, Infinity]) {
    assert.throws(() => assignPads(seats, []), (error: unknown) => {
      assert.ok(error instanceof RefusalError)
      assert.equal(error.area, 'client')
      assert.equal(error.path, 'assignPads')
      return true
    })
  }
})

test('left and right schemes keep movement and actions on their own seat', () => {
  const seats = new LocalSeats(assignPads(2, []))
  for (const [code, action, i] of [
    ['KeyW', 'forward', 0], ['KeyS', 'back', 0], ['KeyA', 'left', 0], ['KeyD', 'right', 0],
    ['Space', 'jump', 0], ['ShiftLeft', 'dive', 0], ['KeyE', 'grab', 0],
    ['ArrowUp', 'forward', 1], ['ArrowDown', 'back', 1], ['ArrowLeft', 'left', 1], ['ArrowRight', 'right', 1],
    ['Enter', 'jump', 1], ['NumpadEnter', 'jump', 1], ['ShiftRight', 'dive', 1], ['ControlRight', 'grab', 1],
  ] as const) {
    seats.key(code, true)
    assert.equal(seats.controls(i)[action], true, code)
    assert.deepEqual(seats.controls(1 - i), emptyControls(), code)
    seats.key(code, false)
    assert.deepEqual(seats.controls(i), emptyControls(), code)
  }
  seats.key('KeyQ', true)
  assert.deepEqual(seats.controls(0), emptyControls())
  assert.deepEqual(seats.controls(1), emptyControls())
})

test('all scheme supports aliases and releases each held code independently', () => {
  const seats = new LocalSeats(assignPads(1, []))
  for (const [a, b, action] of [
    ['KeyW', 'ArrowUp', 'forward'], ['KeyS', 'ArrowDown', 'back'],
    ['KeyA', 'ArrowLeft', 'left'], ['KeyD', 'ArrowRight', 'right'],
    ['ShiftLeft', 'ShiftRight', 'dive'],
  ] as const) {
    seats.key(a, true)
    seats.key(b, true)
    seats.key(a, false)
    assert.equal(seats.controls(0)[action], true)
    seats.key(b, false)
    assert.equal(seats.controls(0)[action], false)
  }
  for (const [code, action] of [['Space', 'jump'], ['KeyE', 'grab']] as const) {
    seats.key(code, true)
    assert.equal(seats.controls(0)[action], true)
    seats.key(code, false)
  }
  for (const code of ['Enter', 'NumpadEnter', 'ControlRight']) seats.key(code, true)
  assert.deepEqual(seats.controls(0), emptyControls())
})

test('pad snapshots affect only the seat holding that index, including look and buttons', () => {
  const seats = new LocalSeats(assignPads(4, [0, 1, 2, 3]))
  seats.pad(1, snapshot([0.7, -0.8, 0.2, -0.3], [0, 1, 2]))
  assert.deepEqual(seats.controls(1), { ...emptyControls(), stickX: 0.7, stickY: 0.8, jump: true, dive: true, grab: true })
  assert.deepEqual(seats.look(1), { x: 0.2, y: -0.3 })
  for (const i of [0, 2, 3]) {
    assert.deepEqual(seats.controls(i), emptyControls())
    assert.deepEqual(seats.look(i), { x: 0, y: 0 })
  }
  seats.pad(9, snapshot([1, 1], [0]))
  assert.deepEqual(seats.controls(0), emptyControls())
  seats.pad(1, null)
  assert.deepEqual(seats.controls(1), emptyControls())
  assert.deepEqual(seats.look(1), { x: 0, y: 0 })
})

test('keyboard and pad actions stay held until both sources release', () => {
  const seats = new LocalSeats(assignPads(1, [0]))
  for (const [code, action, button] of [['Space', 'jump', 0], ['ShiftLeft', 'dive', 1], ['KeyE', 'grab', 2]] as const) {
    seats.key(code, true)
    seats.pad(0, snapshot([], [button]))
    seats.key(code, false)
    assert.equal(seats.controls(0)[action], true)
    seats.key(code, true)
    seats.pad(0, snapshot())
    assert.equal(seats.controls(0)[action], true)
    seats.key(code, false)
    assert.equal(seats.controls(0)[action], false)
  }
})

test('sample reuses out and applies camera movement, with stick priority above the deadzone', () => {
  const seats = new LocalSeats(assignPads(1, [0]))
  const controls = seats.controls(0)
  const out = neutralInput()
  seats.key('KeyW', true)
  assert.equal(seats.sample(0, { x: 1, z: 0 }, out), out)
  assert.equal(out.moveX, 1)
  seats.sample(0, { x: 0, z: 1 }, out)
  assert.equal(out.moveZ, 1)
  seats.pad(0, snapshot([0.1, 0]))
  seats.sample(0, { x: 0, z: 1 }, out)
  assert.equal(out.moveZ, 1)
  seats.pad(0, snapshot([1, 0]))
  seats.sample(0, { x: 0, z: 1 }, out)
  assert.equal(out.moveX, -1)
  assert.equal(out.moveZ, 0)
  assert.equal(seats.controls(0), controls)
})

test('seats without a device remain neutral and can be driven by takeover bots', () => {
  const seats = new LocalSeats(assignPads(4, []))
  assert.deepEqual([0, 1, 2, 3].map(i => seats.hasDevice(i)), [true, true, false, false])
  seats.key('KeyW', true)
  seats.key('ArrowUp', true)
  seats.pad(0, snapshot([1, 1], [0, 1, 2]))
  for (const i of [2, 3]) assert.deepEqual(seats.controls(i), emptyControls())
  const withPads = new LocalSeats(assignPads(4, [0, 1, 2, 3]))
  assert.deepEqual([0, 1, 2, 3].map(i => withPads.hasDevice(i)), [true, true, true, true])
})

test('splitRects lays out 1 to 4 panes exactly at 1920x1080', () => {
  assert.deepEqual(splitRects(1, 1920, 1080), [
    { x: 0, y: 0, width: 1920, height: 1080 },
  ])
  assert.deepEqual(splitRects(2, 1920, 1080), [
    { x: 0, y: 0, width: 960, height: 1080 },
    { x: 960, y: 0, width: 960, height: 1080 },
  ])
  assert.deepEqual(splitRects(3, 1920, 1080), [
    { x: 0, y: 0, width: 1920, height: 540 },
    { x: 0, y: 540, width: 960, height: 540 },
    { x: 960, y: 540, width: 960, height: 540 },
  ])
  assert.deepEqual(splitRects(4, 1920, 1080), [
    { x: 0, y: 0, width: 960, height: 540 },
    { x: 960, y: 0, width: 960, height: 540 },
    { x: 0, y: 540, width: 960, height: 540 },
    { x: 960, y: 540, width: 960, height: 540 },
  ])
})

test('splitRects covers odd canvases without gaps or overlap', () => {
  const width = 1281
  const height = 721
  for (let count = 1; count <= 4; count++) {
    const rects = splitRects(count, width, height)
    let area = 0
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]
      assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.width) && Number.isInteger(r.height))
      assert.ok(r.width > 0 && r.height > 0)
      area += r.width * r.height
      for (let j = i + 1; j < rects.length; j++) {
        const o = rects[j]
        const overlapX = Math.min(r.x + r.width, o.x + o.width) > Math.max(r.x, o.x)
        const overlapY = Math.min(r.y + r.height, o.y + o.height) > Math.max(r.y, o.y)
        assert.ok(!(overlapX && overlapY), `rectangles ${i} and ${j} overlap for ${count} panes`)
      }
    }
    assert.equal(area, width * height, `area for ${count} panes`)
  }
})

test('splitRects refuses counts outside 1..4', () => {
  for (const count of [0, 5]) {
    assert.throws(() => splitRects(count, 1920, 1080), (error: unknown) => {
      assert.ok(error instanceof RefusalError)
      assert.equal(error.area, 'render')
      assert.equal(error.path, 'splitRects')
      return true
    })
  }
})
