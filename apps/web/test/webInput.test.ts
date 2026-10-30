// InputDevices: one poll per local device with stored pad maps and press edges.
// The target and the pads are fakes, so the listeners see plain key objects.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { DevicePoll } from '../src/input/input.ts'
import { InputDevices } from '../src/input/input.ts'
import { DEFAULT_PAD_MAP, localPadMapStore } from '@royal-fiesta/game/client/padMap'
import type { PadMap } from '@royal-fiesta/game/client/padMap'

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
