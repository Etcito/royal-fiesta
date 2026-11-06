import assert from 'node:assert/strict'
import test from 'node:test'
import { BUSES } from '../src/audio/catalog.ts'
import { AUDIO_SETTINGS_KEY, DEFAULT_BUS_VOLUMES } from '../src/audio/mix/volumes.ts'
import {
  adjust, cycle, DEFAULT_SETTINGS, KEY_ACTIONS, loadSettings, SETTINGS_KEY, SETTINGS_ROWS,
  type Settings, type SettingsStore
} from '../src/screens/settings.ts'
import {
  keyName, PAGE_ROWS, pageItems, rowItem, SETTINGS_ROW_SLOTS, TAB_LABELS, PAGE_TITLES, SETTINGS_PAGES,
  pageAfterScreen
} from '../src/screens/settingsPages.ts'

const ctx = { rebinding: null, reducedMotion: false }

class MemoryStore implements SettingsStore {
  value: string | null = null
  audio: string | null = null
  getItem(key: string): string | null {
    return key === SETTINGS_KEY ? this.value : key === AUDIO_SETTINGS_KEY ? this.audio : null
  }
  setItem(key: string, value: string): void {
    if (key === SETTINGS_KEY) this.value = value
    else this.audio = value
  }
}

function changed(): Settings {
  return {
    keys: { ...DEFAULT_SETTINGS.keys, forward: 'KeyI', jump: 'KeyJ' },
    volume: 30,
    buses: { ...DEFAULT_BUS_VOLUMES, music: 0.2, crowd: 0.4 },
    mouseSensitivity: 2,
    stickSensitivity: 9,
    invertY: true
  }
}

test('pages and tab labels cover the four Settings pages', () => {
  assert.deepEqual(SETTINGS_PAGES, ['audio', 'graphics', 'controls', 'gameplay'])
  assert.deepEqual(SETTINGS_PAGES.map(page => PAGE_TITLES[page]), [
    'Audio', 'Graphics', 'Controls', 'Gameplay & Accessibility'
  ])
  assert.deepEqual(SETTINGS_PAGES.map(page => TAB_LABELS[page]), [
    'Audio', 'Graphics', 'Controls', 'Gameplay'
  ])
  assert.equal(SETTINGS_ROW_SLOTS, 14)
})

test('page rows list audio, controls and gameplay in order', () => {
  assert.equal(PAGE_ROWS.audio.length, 7)
  assert.deepEqual(PAGE_ROWS.audio, [
    { kind: 'volume' },
    ...BUSES.map(bus => ({ kind: 'bus', bus })),
    { kind: 'reset', scope: 'audio' }
  ])
  assert.equal(PAGE_ROWS.controls.length, 12)
  assert.deepEqual(PAGE_ROWS.controls, [
    ...KEY_ACTIONS.map(action => ({ kind: 'key', action })),
    { kind: 'remap' },
    { kind: 'mouseSensitivity' }, { kind: 'stickSensitivity' }, { kind: 'invertY' },
    { kind: 'reset', scope: 'controls' }
  ])
  assert.equal(PAGE_ROWS.gameplay.length, 2)
  assert.deepEqual(PAGE_ROWS.gameplay, [{ kind: 'reducedMotion' }, { kind: 'reset', scope: 'all' }])
  assert.deepEqual(SETTINGS_ROWS, [...PAGE_ROWS.audio, ...PAGE_ROWS.controls, ...PAGE_ROWS.gameplay])
})

test('reset audio keeps changed keys, reset controls keeps changed volumes, reset all restores defaults', () => {
  const before = changed()
  const audio = adjust(before, { kind: 'reset', scope: 'audio' }, 1)
  assert.equal(audio.volume, DEFAULT_SETTINGS.volume)
  assert.deepEqual(audio.buses, DEFAULT_SETTINGS.buses)
  assert.deepEqual(audio.keys, before.keys)
  assert.equal(audio.mouseSensitivity, before.mouseSensitivity)
  assert.equal(audio.stickSensitivity, before.stickSensitivity)
  assert.equal(audio.invertY, before.invertY)

  const controls = adjust(before, { kind: 'reset', scope: 'controls' }, -1)
  assert.deepEqual(controls.keys, DEFAULT_SETTINGS.keys)
  assert.equal(controls.mouseSensitivity, DEFAULT_SETTINGS.mouseSensitivity)
  assert.equal(controls.stickSensitivity, DEFAULT_SETTINGS.stickSensitivity)
  assert.equal(controls.invertY, DEFAULT_SETTINGS.invertY)
  assert.equal(controls.volume, before.volume)
  assert.deepEqual(controls.buses, before.buses)

  assert.deepEqual(adjust(before, { kind: 'reset', scope: 'all' }, 1), DEFAULT_SETTINGS)
})

test('cycle wraps sliders past their maximum and flips invert Y', () => {
  assert.equal(cycle({ ...DEFAULT_SETTINGS, volume: 100 }, { kind: 'volume' }).volume, 0)
  assert.equal(cycle(DEFAULT_SETTINGS, { kind: 'volume' }).volume, 90)
  const bus = { kind: 'bus', bus: 'music' } as const
  assert.equal(cycle({ ...DEFAULT_SETTINGS, buses: { ...DEFAULT_BUS_VOLUMES, music: 1 } }, bus).buses.music, 0)
  assert.equal(cycle(DEFAULT_SETTINGS, bus).buses.music, 0.9)
  assert.equal(cycle({ ...DEFAULT_SETTINGS, mouseSensitivity: 10 }, { kind: 'mouseSensitivity' }).mouseSensitivity, 1)
  assert.equal(cycle(DEFAULT_SETTINGS, { kind: 'stickSensitivity' }).stickSensitivity, 6)
  const inverted = cycle(DEFAULT_SETTINGS, { kind: 'invertY' })
  assert.equal(inverted.invertY, true)
  assert.equal(cycle(inverted, { kind: 'invertY' }).invertY, false)
})

test('key names match the display names the row items show', () => {
  assert.equal(keyName('KeyW'), 'W')
  assert.equal(keyName('Digit5'), '5')
  assert.equal(keyName('ShiftLeft'), 'Left Shift')
  assert.equal(keyName('ShiftRight'), 'Right Shift')
  assert.equal(keyName('ControlLeft'), 'Left Ctrl')
  assert.equal(keyName('Space'), 'Space')
  assert.equal(keyName('ArrowUp'), 'Up')
  assert.equal(keyName('ArrowDown'), 'Down')
  assert.equal(keyName('KeyF'), 'F')
  assert.equal(keyName('Numpad3'), 'Numpad3')
})

test('row items show volume, key capture, dive and the disabled reduced-motion toggle', () => {
  const volume = rowItem({ kind: 'volume' }, DEFAULT_SETTINGS, ctx)
  assert.equal(volume.label, 'Master volume')
  assert.equal(volume.value, '80%')
  assert.equal(volume.control, 'slider')
  assert.equal(volume.fraction, 0.8)

  const forward = rowItem({ kind: 'key', action: 'forward' }, DEFAULT_SETTINGS, ctx)
  assert.equal(forward.label, 'Forward')
  assert.equal(forward.value, 'W')
  assert.equal(forward.control, 'capture')

  const rebinding = rowItem({ kind: 'key', action: 'forward' }, DEFAULT_SETTINGS, { ...ctx, rebinding: 'forward' })
  assert.equal(rebinding.value, 'Press a key...')

  const dive = rowItem({ kind: 'key', action: 'dive' }, DEFAULT_SETTINGS, ctx)
  assert.equal(dive.value, 'Left Shift')

  const reduced = rowItem({ kind: 'reducedMotion' }, DEFAULT_SETTINGS, { ...ctx, reducedMotion: true })
  assert.equal(reduced.label, 'Reduced motion')
  assert.equal(reduced.value, 'On (system)')
  assert.equal(reduced.control, 'toggle')
  assert.equal(reduced.fraction, 1)
  assert.equal(reduced.disabled, 'follows your device reduce-motion setting')
  assert.ok(reduced.help.length > 0)

  for (const item of pageItems('audio', DEFAULT_SETTINGS, ctx).concat(pageItems('controls', DEFAULT_SETTINGS, ctx))) {
    assert.ok(item.help.length > 0)
  }
})

test('a save written before the page model loads unchanged through loadSettings', () => {
  const store = new MemoryStore()
  store.value = JSON.stringify({
    keys: { forward: 'KeyI', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'KeyJ', dive: 'ShiftRight', grab: 'KeyE' },
    volume: 42,
    buses: { music: 0.4, sfx: 0.6, ui: 0.8, ambience: 0.2, crowd: 1 },
    mouseSensitivity: 7,
    stickSensitivity: 3,
    invertY: true,
    quality: 'high'
  })
  assert.deepEqual(loadSettings(store), {
    settings: {
      keys: { forward: 'KeyI', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'KeyJ', dive: 'ShiftRight', grab: 'KeyE' },
      volume: 42,
      buses: { music: 0.4, sfx: 0.6, ui: 0.8, ambience: 0.2, crowd: 1 },
      mouseSensitivity: 7,
      stickSensitivity: 3,
      invertY: true
    },
    error: null
  })
})

// Run 12354: the landscape pass opened Settings a second time on Gameplay, the page the phone pass left.
test('pageAfterScreen opens Settings on Audio on entry and keeps the page otherwise', () => {
  assert.equal(pageAfterScreen('start', 'settings', 'gameplay'), 'audio')
  assert.equal(pageAfterScreen('pause', 'settings', 'controls'), 'audio')
  assert.equal(pageAfterScreen(null, 'settings', 'graphics'), 'audio')
  assert.equal(pageAfterScreen('settings', 'settings', 'controls'), 'controls')
  assert.equal(pageAfterScreen('credits', 'settings', 'gameplay'), 'gameplay')
  assert.equal(pageAfterScreen('settings', 'start', 'gameplay'), 'gameplay')
})
