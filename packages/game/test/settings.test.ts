import assert from 'node:assert/strict'
import test from 'node:test'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { BUSES } from '../src/audio/catalog.ts'
import { AUDIO_SETTINGS_KEY, DEFAULT_BUS_VOLUMES } from '../src/audio/mix/volumes.ts'
import {
  adjust, controlsFromKeys, DEFAULT_SETTINGS, describeRow, loadSettings, parseSettings, rebind, renderScale,
  saveSettings, SETTINGS_KEY, SETTINGS_ROWS, KEY_ACTIONS, type SettingsStore
} from '../src/screens/settings.ts'

class MemoryStore implements SettingsStore {
  value: string | null = null
  audio: string | null = null
  getItem(key: string): string | null {
    assert.ok(key === SETTINGS_KEY || key === AUDIO_SETTINGS_KEY)
    return key === SETTINGS_KEY ? this.value : this.audio
  }
  setItem(key: string, value: string): void {
    assert.ok(key === SETTINGS_KEY || key === AUDIO_SETTINGS_KEY)
    if (key === SETTINGS_KEY) this.value = value
    else this.audio = value
  }
}

test('defaults round-trip through the injected store', () => {
  const store = new MemoryStore()
  saveSettings(store, DEFAULT_SETTINGS)
  assert.deepEqual(loadSettings(store), { settings: DEFAULT_SETTINGS, error: null })
})

test('bus rows follow invert Y in BUSES order and keep the key and reset rows', () => {
  assert.deepEqual(SETTINGS_ROWS.slice(5, 10), BUSES.map(bus => ({ kind: 'bus', bus })))
  assert.deepEqual(SETTINGS_ROWS.slice(10), [
    ...KEY_ACTIONS.map(action => ({ kind: 'key', action })), { kind: 'reset' }
  ])
})

test('bus adjustment steps one tenth, rounds and clamps without mutating input', () => {
  for (const bus of BUSES) {
    const row = { kind: 'bus', bus } as const
    const up = adjust(DEFAULT_SETTINGS, row, 2)
    assert.deepEqual(up.buses, { ...DEFAULT_BUS_VOLUMES, [bus]: 0.9 })
    assert.equal(adjust(DEFAULT_SETTINGS, row, -2).buses[bus], 0.7)
    assert.equal(adjust(DEFAULT_SETTINGS, row, 0).buses[bus], 0.8)
    assert.equal(adjust({ ...DEFAULT_SETTINGS, buses: { ...DEFAULT_BUS_VOLUMES, [bus]: 0.96 } }, row, 1).buses[bus], 1)
    assert.equal(adjust({ ...DEFAULT_SETTINGS, buses: { ...DEFAULT_BUS_VOLUMES, [bus]: 0.04 } }, row, -1).buses[bus], 0)
    assert.equal(adjust(up, row, 1).buses[bus], 1)
    assert.equal(adjust(adjust(up, row, 1), row, 1).buses[bus], 1)
    assert.equal(adjust({ ...DEFAULT_SETTINGS, buses: { ...DEFAULT_BUS_VOLUMES, [bus]: 0 } }, row, -1).buses[bus], 0)
    assert.deepEqual(adjust(up, { kind: 'reset' }, 1), DEFAULT_SETTINGS)
  }
  assert.deepEqual(DEFAULT_SETTINGS.buses, DEFAULT_BUS_VOLUMES)
})

test('describeRow labels each bus and shows its volume percentage', () => {
  assert.deepEqual(SETTINGS_ROWS.slice(5, 10).map(row => describeRow(row, DEFAULT_SETTINGS)), [
    'Music volume 80%', 'SFX volume 80%', 'UI volume 80%', 'Ambience volume 80%', 'Crowd volume 80%'
  ])
  assert.equal(describeRow({ kind: 'bus', bus: 'music' }, adjust(DEFAULT_SETTINGS, { kind: 'bus', bus: 'music' }, -1)), 'Music volume 70%')
})

test('legacy saves without buses load independent defaults', () => {
  const store = new MemoryStore()
  const { buses, ...legacy } = DEFAULT_SETTINGS
  store.value = JSON.stringify(legacy)
  const loaded = loadSettings(store)
  assert.equal(loaded.error, null)
  assert.deepEqual(loaded.settings.buses, DEFAULT_BUS_VOLUMES)
  assert.notStrictEqual(loaded.settings.buses, buses)
  assert.notStrictEqual(DEFAULT_SETTINGS.buses, DEFAULT_BUS_VOLUMES)
  for (const settings of [
    loadSettings(new MemoryStore()).settings,
    adjust(DEFAULT_SETTINGS, { kind: 'reset' }, 1),
    rebind(DEFAULT_SETTINGS, 'jump', 'KeyJ')
  ]) {
    assert.deepEqual(settings.buses, DEFAULT_BUS_VOLUMES)
    assert.notStrictEqual(settings.buses, DEFAULT_SETTINGS.buses)
  }
})

test('parseSettings parses present bus volumes with defaults and clamping', () => {
  assert.deepEqual(parseSettings({ ...DEFAULT_SETTINGS, buses: { music: 2, sfx: -1, ui: NaN } }).buses,
    { ...DEFAULT_BUS_VOLUMES, music: 1, sfx: 0 })
  assert.deepEqual(parseSettings({ ...DEFAULT_SETTINGS, buses: null }).buses, DEFAULT_BUS_VOLUMES)
})

test('saveSettings writes buses under AUDIO_SETTINGS_KEY as well as the full settings', () => {
  const store = new MemoryStore()
  const settings = adjust(DEFAULT_SETTINGS, { kind: 'bus', bus: 'crowd' }, -1)
  saveSettings(store, settings)
  assert.deepEqual(JSON.parse(store.value!), settings)
  assert.deepEqual(JSON.parse(store.audio!), settings.buses)
  assert.deepEqual(loadSettings(store), { settings, error: null })
})

test('loadSettings prefers the audio key, including when there is no general settings save', () => {
  const store = new MemoryStore()
  store.audio = JSON.stringify({ music: 0.2, crowd: 2 })
  for (const saved of [null, JSON.stringify({ ...DEFAULT_SETTINGS, volume: 30 })]) {
    store.value = saved
    const loaded = loadSettings(store)
    assert.equal(loaded.error, null)
    assert.equal(loaded.settings.volume, saved === null ? 80 : 30)
    assert.deepEqual(loaded.settings.buses, { ...DEFAULT_BUS_VOLUMES, music: 0.2, crowd: 1 })
  }
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
