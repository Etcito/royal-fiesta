// InputDevices: one poll per local device with stored pad maps and press edges.
// The target and the pads are fakes, so the listeners see plain key objects.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { DevicePoll } from '../src/input/input.ts'
import { InputDevices } from '../src/input/input.ts'
import { DEFAULT_PAD_MAP, localPadMapStore } from '@royal-fiesta/game/client/padMap'
import type { PadMap } from '@royal-fiesta/game/client/padMap'
import { emptyControls } from '@royal-fiesta/game/client/inputMap'
import { mountTouchControls } from '../src/input/touch.ts'

type Listener = (event: unknown) => void

class FakeTarget {
  private readonly listeners = new Map<string, Listener[]>()

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const at = list.indexOf(listener)
    if (at !== -1) list.splice(at, 1)
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  key(code: string, kind: 'keydown' | 'keyup' = 'keydown', repeat = false): void {
    this.dispatch(kind, { code, repeat, shiftKey: false, preventDefault() {} })
  }

  get listenerCount(): number {
    let count = 0
    for (const list of this.listeners.values()) count += list.length
    return count
  }
}

interface FakePad {
  id: string
  index: number
  connected: boolean
  buttons: { pressed: boolean }[]
  axes: number[]
}

function fakePad(index: number, id = `pad-${index}`): FakePad {
  return {
    id,
    index,
    connected: true,
    buttons: Array.from({ length: 16 }, () => ({ pressed: false })),
    axes: [0, 0, 0, 0]
  }
}

const asGamepad = (pad: FakePad): Gamepad => pad as unknown as Gamepad

interface Touch {
  active: boolean
  read(out: { left: boolean; right: boolean; forward: boolean; back: boolean; stickX: number; stickY: number; jump: boolean; dive: boolean; grab: boolean }): void
}

function setup(pads: FakePad[], touch: Touch | null = null, maps = localPadMapStore(null)) {
  const target = new FakeTarget()
  const input = new InputDevices(
    target as unknown as HTMLElement,
    () => pads.map(asGamepad),
    maps,
    touch
  )
  const out: DevicePoll[] = []
  return { target, input, maps, out }
}

function mapWith(buttons: Partial<PadMap['buttons']> = {}): PadMap {
  return { ...DEFAULT_PAD_MAP, buttons: { ...DEFAULT_PAD_MAP.buttons, ...buttons } }
}

test('two connected pads poll as keyboard, pad:0, pad:1', () => {
  const { input, out } = setup([fakePad(0), fakePad(1)])
  const n = input.poll(out)
  assert.equal(n, 3)
  assert.deepEqual(out.slice(0, n).map(entry => entry.device), ['keyboard', 'pad:0', 'pad:1'])
})

test('a pad stored with jump = 3 jumps only on button 3', () => {
  const pads = [fakePad(0, 'pad-a')]
  const { input, maps, out } = setup(pads)
  maps.set('pad-a', mapWith({ jump: 3 }))
  input.poll(out)
  assert.equal(out[1].controls.jump, false)

  pads[0].buttons[0].pressed = true
  input.poll(out)
  assert.equal(out[1].controls.jump, false)

  pads[0].buttons[0].pressed = false
  pads[0].buttons[3].pressed = true
  input.poll(out)
  assert.equal(out[1].controls.jump, true)
})

test('pad join is one poll of edge, then false while held', () => {
  const pads = [fakePad(0, 'pad-a')]
  const { input, out } = setup(pads)
  input.poll(out)
  assert.equal(out[1].joinPressed, false)

  pads[0].buttons[9].pressed = true
  input.poll(out)
  assert.equal(out[1].joinPressed, true)

  input.poll(out)
  assert.equal(out[1].joinPressed, false)
})

test('keyboard Enter join is one poll of edge, then false while held', () => {
  const { target, input, out } = setup([])
  target.key('Enter')
  input.poll(out)
  assert.equal(out[0].joinPressed, true)

  input.poll(out)
  assert.equal(out[0].joinPressed, false)

  target.key('Enter', 'keyup')
  input.poll(out)
  assert.equal(out[0].joinPressed, false)
})

test('Escape pause is one poll of edge too', () => {
  const { target, input, out } = setup([])
  target.key('Escape')
  input.poll(out)
  assert.equal(out[0].pausePressed, true)
  input.poll(out)
  assert.equal(out[0].pausePressed, false)
})

test('touch is polled last when active, with no edges', () => {
  const touch: Touch = {
    active: true,
    read(out) {
      out.forward = true
      out.stickX = 0
      out.stickY = 0.5
      out.left = false
      out.right = false
      out.back = false
      out.jump = true
      out.dive = false
      out.grab = false
    }
  }
  const { input, out } = setup([fakePad(0)], touch)
  const n = input.poll(out)
  assert.equal(n, 3)
  assert.equal(out[2].device, 'touch')
  assert.equal(out[2].controls.jump, true)
  assert.equal(out[2].joinPressed, false)
  assert.equal(out[2].pausePressed, false)

  touch.active = false
  assert.equal(input.poll(out), 2)
})

test('out entries are reused across polls', () => {
  const { input, out } = setup([fakePad(0)])
  input.poll(out)
  const first = out[0]
  input.poll(out)
  assert.equal(out[0], first)
})

test('after dispose key events no longer change the polls', () => {
  const { target, input, out } = setup([])
  target.key('KeyW')
  input.poll(out)
  assert.equal(out[0].controls.forward, true)

  input.dispose()
  assert.equal(target.listenerCount, 0)
  target.key('KeyD')
  input.poll(out)
  assert.equal(out[0].controls.right, false)
})

class FakeCanvas extends FakeTarget {
  className = ''
  style: Record<string, string> = {}
  width = 0
  height = 0
  rect = { left: 0, top: 0, width: 844, height: 390 }
  readonly captures = new Set<number>()
  readonly calls: { name: string; args: unknown[] }[] = []
  readonly context = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
    setTransform: (...args: number[]) => this.record('setTransform', args),
    clearRect: (...args: number[]) => this.record('clearRect', args),
    beginPath: () => this.record('beginPath', []),
    arc: (...args: number[]) => this.record('arc', args),
    fill: () => this.record('fill', [this.context.fillStyle]),
    stroke: () => this.record('stroke', []),
    fillText: (...args: unknown[]) => this.record('fillText', [this.context.font, ...args])
  }
  parent: FakeTouchRoot | null = null

  private record(name: string, args: unknown[]): void { this.calls.push({ name, args }) }
  getContext(kind: string) { assert.equal(kind, '2d'); return this.context }
  getBoundingClientRect() { return this.rect }
  setPointerCapture(id: number): void { this.captures.add(id) }
  hasPointerCapture(id: number): boolean { return this.captures.has(id) }
  releasePointerCapture(id: number): void { this.captures.delete(id) }
  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  pointer(type: string, pointerId: number, clientX: number, clientY: number): boolean {
    let prevented = false
    this.dispatch(type, { pointerId, clientX, clientY, preventDefault() { prevented = true } })
    return prevented
  }
}

class FakeTouchRoot {
  readonly children: FakeCanvas[] = []
  readonly view = Object.assign(new FakeTarget(), { devicePixelRatio: 3 })
  readonly ownerDocument = {
    defaultView: this.view,
    createElement(tag: string): FakeCanvas { assert.equal(tag, 'canvas'); return new FakeCanvas() }
  }
  appendChild(canvas: FakeCanvas): void { this.children.push(canvas); canvas.parent = this }
}

function setupTouch() {
  const root = new FakeTouchRoot()
  const touch = mountTouchControls(root as unknown as HTMLElement)
  return { root, canvas: root.children[0], touch, out: emptyControls() }
}

test('touch draws one overlay and all controls before any pointer input, with capped DPR', () => {
  const { root, canvas, touch } = setupTouch()
  assert.equal(touch.active, true)
  assert.equal(root.children.length, 1)
  assert.equal(canvas.className, 'rf-touch')
  assert.deepEqual(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    touchAction: 'none', pointerEvents: 'auto'
  })
  assert.equal(canvas.width, 1688)
  assert.equal(canvas.height, 780)
  assert.deepEqual(canvas.calls.find(c => c.name === 'setTransform')?.args, [2, 0, 0, 2, 0, 0])
  assert.deepEqual(canvas.calls.filter(c => c.name === 'arc').map(c => c.args.slice(0, 3)), [
    [90, 300, 60], [90, 300, 26], [774, 320, 34], [692, 320, 34], [774, 238, 34]
  ])
  const labels = canvas.calls.filter(c => c.name === 'fillText')
  assert.deepEqual(labels.map(c => c.args[1]), ['JUMP', 'DIVE', 'GRAB'])
  assert.ok(labels.every(c => String(c.args[0]).startsWith('bold ')))
  touch.dispose()
})

test('touch stick and JUMP track simultaneous pointers and release independently', () => {
  const { canvas, touch, out } = setupTouch()
  assert.equal(canvas.pointer('pointerdown', 11, 90, 300), true)
  assert.equal(canvas.pointer('pointermove', 11, 150, 300), true)
  touch.read(out)
  assert.ok(Math.abs(out.stickX - 1) < 1e-12)
  assert.ok(Math.abs(out.stickY) < 1e-12)
  assert.equal(canvas.pointer('pointerdown', 22, 774, 320), true)
  assert.deepEqual([...canvas.captures], [11, 22])
  touch.read(out)
  assert.equal(out.jump, true)
  assert.equal(out.stickX, 1)
  assert.equal(canvas.calls.filter(c => c.name === 'fill').at(-3)?.args[0], 'rgba(120, 165, 255, 0.9)')
  canvas.pointer('pointermove', 22, 400, 100)
  touch.read(out)
  assert.equal(out.jump, true)
  assert.equal(out.stickX, 1)
  assert.equal(canvas.pointer('pointerup', 11, 150, 300), true)
  touch.read(out)
  assert.equal(out.stickX, 0)
  assert.equal(out.stickY, 0)
  assert.equal(out.jump, true)
  assert.equal(canvas.pointer('pointerup', 22, 400, 100), true)
  touch.read(out)
  assert.deepEqual(out, emptyControls())
  assert.equal(canvas.captures.size, 0)
  touch.dispose()
})

test('touch stick applies a radial dead zone, rescales, clamps and points up-positive', () => {
  const { canvas, touch, out } = setupTouch()
  // Coordinates are local to the canvas even when the root is offset on the page.
  canvas.rect.left = 20
  canvas.rect.top = 30
  canvas.pointer('pointerdown', 1, 110, 330)
  canvas.pointer('pointermove', 1, 115, 330)
  Object.assign(out, { left: true, right: true, forward: true, back: true })
  touch.read(out)
  assert.deepEqual(out, emptyControls())
  canvas.pointer('pointermove', 1, 110, 300)
  touch.read(out)
  assert.ok(Math.abs(out.stickY - (0.5 - 0.15) / 0.85) < 1e-12)
  canvas.pointer('pointermove', 1, 230, 210)
  touch.read(out)
  assert.ok(Math.abs(out.stickX - Math.SQRT1_2) < 1e-12)
  assert.ok(Math.abs(out.stickY - Math.SQRT1_2) < 1e-12)
  canvas.pointer('pointercancel', 1, 230, 210)
  touch.read(out)
  assert.deepEqual(out, emptyControls())
  touch.dispose()
})

test('touch assigns the stick only at pointerdown and keeps buttons held until release', () => {
  const { canvas, touch, out } = setupTouch()
  assert.equal(canvas.pointer('pointerdown', 99, 400, 100), false)
  assert.equal(canvas.pointer('pointermove', 99, 90, 300), false)
  canvas.pointer('pointerdown', 1, 170, 300) // Within the 90px acquisition radius; clamped to 60px.
  assert.equal(canvas.pointer('pointerdown', 2, 90, 300), false)
  canvas.pointer('pointerdown', 3, 692, 320)
  canvas.pointer('pointerdown', 4, 774, 238)
  canvas.pointer('pointerdown', 5, 774, 238)
  canvas.pointer('pointermove', 3, 90, 300)
  touch.read(out)
  assert.equal(out.stickX, 1)
  assert.equal(out.dive, true)
  assert.equal(out.grab, true)
  canvas.pointer('pointercancel', 4, 774, 238)
  touch.read(out)
  assert.equal(out.grab, true)
  canvas.pointer('pointerup', 5, 774, 238)
  canvas.pointer('pointercancel', 3, 90, 300)
  touch.read(out)
  assert.equal(out.grab, false)
  assert.equal(out.dive, false)
  touch.dispose()
})

test('touch resizes and redraws through ResizeObserver and cleans up on dispose', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  let resize = () => {}
  let observed: unknown
  let disconnected = false
  class FakeResizeObserver {
    constructor(callback: () => void) { resize = callback }
    observe(target: unknown): void { observed = target }
    disconnect(): void { disconnected = true }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous)
    else Reflect.deleteProperty(globalThis, 'ResizeObserver')
  })
  const { root, canvas, touch, out } = setupTouch()
  assert.equal(observed, root)
  canvas.rect.width = 1000
  canvas.rect.height = 500
  root.view.devicePixelRatio = 1.5
  const before = canvas.calls.length
  resize()
  assert.equal(canvas.width, 1500)
  assert.equal(canvas.height, 750)
  assert.ok(canvas.calls.length > before)
  canvas.pointer('pointerdown', 1, 150, 410)
  canvas.pointer('pointerdown', 2, 930, 430)
  touch.read(out)
  assert.equal(out.stickX, 1)
  assert.equal(out.jump, true)
  touch.dispose()
  assert.equal(touch.active, false)
  assert.equal(disconnected, true)
  assert.equal(root.children.length, 0)
  assert.equal(canvas.listenerCount, 0)
  assert.equal(canvas.captures.size, 0)
  const after = canvas.calls.length
  canvas.pointer('pointerdown', 3, 930, 430)
  resize()
  assert.equal(canvas.calls.length, after)
  touch.read(out)
  assert.deepEqual(out, emptyControls())
  touch.dispose()
})
