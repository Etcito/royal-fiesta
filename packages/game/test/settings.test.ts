import assert from 'node:assert/strict'
import test from 'node:test'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import {
  adjust, controlsFromKeys, DEFAULT_SETTINGS, describeRow, loadSettings, parseSettings, rebind, renderScale,
  saveSettings, SETTINGS_KEY, SETTINGS_ROWS, type SettingsStore
} from '../src/screens/settings.ts'

class MemoryStore implements SettingsStore {
  value: string | null = null
  getItem(key: string): string | null { assert.equal(key, SETTINGS_KEY); return this.value }
  setItem(key: string, value: string): void { assert.equal(key, SETTINGS_KEY); this.value = value }
}

test('defaults round-trip through the injected store', () => {
  const store = new MemoryStore()
  saveSettings(store, DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(store), { settings: DEFAULT_SETTINGS, error: null })
})

test('corrupt JSON returns defaults and a visible refusal message', () => {
  const store = new MemoryStore()
  store.value = '{'
  const loaded = loadSettings(store)
  assert.deepEqual(loaded.settings, DEFAULT_SETTINGS)
  assert.match(loaded.error ?? '', /\[settings\]/)
})

test('adjust clamps volume and cycles quality without mutating input', () => {
  const up = adjust({ ...DEFAULT_SETTINGS, volume: 100 }, { kind: 'volume' }, 1)
  assert.equal(up.volume, 100)
  assert.equal(DEFAULT_SETTINGS.volume, 80)
  assert.equal(adjust({ ...DEFAULT_SETTINGS, volume: 0 }, { kind: 'volume' }, -1).volume, 0)
  assert.equal(adjust(DEFAULT_SETTINGS, { kind: 'quality' }, 1).quality, 'low')
  assert.equal(adjust(DEFAULT_SETTINGS, { kind: 'quality' }, -1).quality, 'medium')
})

test('rebind refuses a duplicate and names the action already holding it', () => {
  assert.throws(() => rebind(DEFAULT_SETTINGS, 'jump', 'KeyW'), (error: unknown) => {
    assert.ok(error instanceof RefusalError)
    assert.match(error.message, /forward/)
    assert.match(error.message, /pick another key/)
    return true
  })
})

test('controlsFromKeys honors rebound jump and keeps arrow movement alternates', () => {
  const settings = rebind(DEFAULT_SETTINGS, 'jump', 'KeyJ')
  const controls = controlsFromKeys(new Set(['KeyJ', 'ArrowUp']), settings)
  assert.equal(controls.jump, true)
  assert.equal(controls.forward, true)
  assert.equal(controls.stickX, 0)
  assert.equal(controls.stickY, 0)
})

test('render scale matches each quality', () => {
  assert.deepEqual([renderScale('low'), renderScale('medium'), renderScale('high')], [0.5, 0.75, 1])
})


test('old saved JSON defaults only the absent camera settings', () => {
  const store = new MemoryStore()
  store.value = JSON.stringify({ keys: DEFAULT_SETTINGS.keys, volume: 30, quality: 'low' })
  assert.deepEqual(loadSettings(store), {
    settings: { ...DEFAULT_SETTINGS, volume: 30, quality: 'low' }, error: null
  })
  for (const field of ['mouseSensitivity', 'stickSensitivity', 'invertY'] as const) {
    const saved: Record<string, unknown> = { ...DEFAULT_SETTINGS, mouseSensitivity: 9, stickSensitivity: 2, invertY: true }
    delete saved[field]
    const parsed = parseSettings(saved)
    assert.equal(parsed[field], DEFAULT_SETTINGS[field])
  }
})

test('present invalid camera settings refuse with the field path and fix', () => {
  for (const field of ['mouseSensitivity', 'stickSensitivity'] as const) {
    for (const value of [0, 11, 5.5, '5', null, undefined, NaN, Infinity]) {
      assert.throws(() => parseSettings({ ...DEFAULT_SETTINGS, [field]: value }), (error: unknown) => {
        assert.ok(error instanceof RefusalError)
        assert.equal(error.message, `[settings] where#/${field}: must be an integer from 1 to 10; choose a value in that range`)
        return true
      })
    }
  }
  assert.throws(() => parseSettings({ ...DEFAULT_SETTINGS, invertY: 1 }), /where#\/invertY: must be a boolean; choose true or false/)
})

test('camera rows follow quality, step and clamp sensitivity, and toggle invert Y', () => {
  assert.deepEqual(SETTINGS_ROWS.slice(2, 5), [
    { kind: 'mouseSensitivity' }, { kind: 'stickSensitivity' }, { kind: 'invertY' }
  ])
  for (const kind of ['mouseSensitivity', 'stickSensitivity'] as const) {
    assert.equal(adjust(DEFAULT_SETTINGS, { kind }, 2)[kind], 6)
    assert.equal(adjust(DEFAULT_SETTINGS, { kind }, -2)[kind], 4)
    assert.equal(adjust({ ...DEFAULT_SETTINGS, [kind]: 10 }, { kind }, 1)[kind], 10)
    assert.equal(adjust({ ...DEFAULT_SETTINGS, [kind]: 1 }, { kind }, -1)[kind], 1)
    assert.equal(DEFAULT_SETTINGS[kind], 5)
  }
  for (const dir of [-1, 0, 1]) {
    const on = adjust(DEFAULT_SETTINGS, { kind: 'invertY' }, dir)
    assert.equal(on.invertY, true)
    assert.equal(adjust(on, { kind: 'invertY' }, dir).invertY, false)
  }
  assert.deepEqual(SETTINGS_ROWS.slice(2, 5).map(row => describeRow(row, DEFAULT_SETTINGS)), [
    'Mouse sensitivity 5', 'Stick sensitivity 5', 'Invert Y off'
  ])
  assert.equal(describeRow({ kind: 'invertY' }, { ...DEFAULT_SETTINGS, invertY: true }), 'Invert Y on')
  const changed = { ...DEFAULT_SETTINGS, mouseSensitivity: 2, stickSensitivity: 9, invertY: true }
  assert.deepEqual(rebind(changed, 'jump', 'KeyJ'), { ...changed, keys: { ...changed.keys, jump: 'KeyJ' } })
  assert.deepEqual(adjust(changed, { kind: 'reset' }, 1), DEFAULT_SETTINGS)
})

test('WASD and ZQSD physical codes move unless an alternate belongs to another action', () => {
  for (const code of ['KeyW', 'KeyZ']) assert.equal(controlsFromKeys(new Set([code]), DEFAULT_SETTINGS).forward, true)
  for (const code of ['KeyA', 'KeyQ']) assert.equal(controlsFromKeys(new Set([code]), DEFAULT_SETTINGS).left, true)
  const grabQ = controlsFromKeys(new Set(['KeyQ']), rebind(DEFAULT_SETTINGS, 'grab', 'KeyQ'))
  assert.equal(grabQ.left, false)
  assert.equal(grabQ.grab, true)
  const grabZ = controlsFromKeys(new Set(['KeyZ']), rebind(DEFAULT_SETTINGS, 'grab', 'KeyZ'))
  assert.equal(grabZ.forward, false)
  assert.equal(grabZ.grab, true)
})
