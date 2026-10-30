import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PAD_MAP } from '@royal-fiesta/game/client/padMap'
import type { PadMap, PadMapStore } from '@royal-fiesta/game/client/padMap'
import { mountPadRemap } from '../src/input/padRemapScreen.ts'

interface Text { text: string; y: number }

function setup(t: { after(fn: () => void): void }) {
  let texts: Text[] = []
  const noop = () => {}
  const ctx = {
    setTransform: noop, clearRect: noop, fillRect: noop, translate: noop, scale: noop,
    fillText(text: string, _x: number, y: number) { texts.push({ text, y }) }
  }
  const canvas = {
    style: {}, width: 0, height: 0, className: '',
    setAttribute: noop, addEventListener: noop, removeEventListener: noop, remove: noop,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 700 })
  }
  const root = {
    ownerDocument: { createElement: () => canvas },
    appendChild: noop,
    dispatchEvent: () => true
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      devicePixelRatio: 1,
      addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, fn) },
      removeEventListener: noop,
      setInterval: () => 1,
      clearInterval: noop
    }
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const store: PadMapStore = {
    get: () => DEFAULT_PAD_MAP,
    set: (_id: string, _map: PadMap) => {},
    reset: () => {}
  } as unknown as PadMapStore
  const screen = mountPadRemap(root as unknown as HTMLElement, store, () => [])
  const key = (code: string) =>
    listeners.get('keydown')?.({ code, key: code, repeat: false, stopPropagation: noop, preventDefault: noop })
  return { screen, key, take: () => { const out = texts; texts = []; return out } }
}

test('remap prompt keeps the listening Jump row showing its assigned button', t => {
  const { screen, key, take } = setup(t)
  const before = take()
  const jumpButton = `Button ${DEFAULT_PAD_MAP.buttons.jump}`
  assert.ok(before.some(entry => entry.text.startsWith(jumpButton)))

  key('Enter')
  const drawn = take()
  const prompt = drawn.find(entry => entry.text === 'Press a button for Jump...')
  assert.ok(prompt, 'prompt is shown for Jump')
  const buttonOnPromptRow = drawn.find(entry => entry.y === prompt.y && entry.text.startsWith('Button '))
  assert.ok(buttonOnPromptRow, 'Jump row still shows its assigned button while listening')
  assert.ok(buttonOnPromptRow.text.startsWith(jumpButton))
  screen.close()
})
