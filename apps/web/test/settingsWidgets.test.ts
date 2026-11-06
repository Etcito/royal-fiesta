import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  SETTINGS_PAGES, SETTINGS_ROW_SLOTS, type SettingsItem
} from '../../../packages/game/src/screens/settingsPages.ts'
import type { DocWidget, ScreensDoc } from '../src/ui/screenMap.ts'
import { settingsWidgetProps } from '../src/ui/settingsWidgets.ts'

const slider: SettingsItem = {
  label: 'Master volume', value: '70%', control: 'slider', fraction: 0.7,
  help: 'Sets the overall game volume.'
}
const choice: SettingsItem = {
  label: 'Quality', value: 'Medium', control: 'choice', index: 2, count: 5,
  help: 'Sets the scene quality.', nextLoad: true
}
const capture: SettingsItem = {
  label: 'Forward', value: 'W', control: 'capture', help: 'Press Enter, then press the new key.'
}
const toggle: SettingsItem = {
  label: 'Invert Y', value: 'On', control: 'toggle', fraction: 1,
  help: 'Flips the vertical direction of the camera.'
}

test('every returned widget exists on the settings screen', () => {
  const doc: ScreensDoc = JSON.parse(readFileSync(new URL('../../../ui/screens.ui-doc.json', import.meta.url), 'utf8'))
  const settings = doc.screens.find(s => s.id === 'settings')!
  const flatten = (widgets: readonly DocWidget[]): string[] => widgets.flatMap(w => [w.id, ...flatten(w.children ?? [])])
  const ids = new Set(flatten(settings.widgets))
  for (const page of SETTINGS_PAGES) {
    const props = settingsWidgetProps(page, Array.from({ length: SETTINGS_ROW_SLOTS }, () => slider), 'row-0', 'start')
    for (const id of Object.keys(props)) assert.ok(ids.has(id), `settings widget ${id} exists`)
  }
})

test('sliders and toggles use their own bars and preserve the value text', () => {
  const props = settingsWidgetProps('audio', [slider, toggle, { ...toggle, value: 'Off', fraction: 0 }], 'row-0', 'start')
  assert.deepEqual(props['row-0'], { text: 'Master volume', visible: true, disabled: false })
  assert.deepEqual(props['value-0'], { text: '70%', visible: true })
  assert.deepEqual(props['slider-0'], { value: 0.7, visible: true })
  assert.deepEqual(props['switch-0'], { value: 0.7, visible: false })
  assert.deepEqual(props['slider-1'], { value: 1, visible: false })
  assert.deepEqual(props['switch-1'], { value: 1, visible: true })
  assert.deepEqual(props['switch-2'], { value: 0, visible: true })
  assert.deepEqual(props.help, { text: slider.help })
})

test('choices have arrows and a count, captures have caps, and actions keep their value', () => {
  const props = settingsWidgetProps('graphics', [
    { ...choice, nextLoad: false }, capture, { label: 'Reset', value: '', control: 'action', help: 'Restores defaults.' }
  ], null, 'start')
  assert.equal(props['value-0'].text, '< Medium >  3/5')
  assert.equal(props['value-1'].text, '[ W ]')
  assert.equal(props['value-2'].text, '')
  assert.deepEqual(props['slider-0'], { visible: false, value: 0 })
  assert.deepEqual(props['switch-1'], { visible: false, value: 0 })
})

test('disabled focus explains the refusal and next-load focus explains when changes apply', () => {
  const disabled = { ...choice, disabled: 'not supported on this device' }
  const props = settingsWidgetProps('graphics', [disabled, choice], 'row-0', 'pause')
  assert.equal(props['row-0'].disabled, true)
  assert.equal(props.help.text, `${disabled.label}: ${disabled.disabled}`)
  assert.equal(props['value-1'].text, '< Medium >  3/5 (next load)')
  assert.equal(settingsWidgetProps('graphics', [disabled, choice], 'row-1', 'pause').help.text,
    `${choice.help} Applies when the next scene loads.`)
})

test('unused slots hide all four widgets and only the current card and tab mark are shown', () => {
  for (const page of SETTINGS_PAGES) {
    const props = settingsWidgetProps(page, [slider], null, 'start')
    for (let i = 1; i < SETTINGS_ROW_SLOTS; i++) {
      for (const kind of ['row', 'value', 'slider', 'switch']) assert.deepEqual(props[`${kind}-${i}`], { visible: false })
    }
    for (const p of SETTINGS_PAGES) {
      assert.deepEqual(props[`card-${p}`], { visible: p === page })
      assert.deepEqual(props[`tab-mark-${p}`], { visible: p === page, value: 1 })
    }
  }
})

test('help follows tabs, back, credits, and clears when no relevant widget is focused', () => {
  const help = (focused: string | null, backTo: 'start' | 'pause' = 'start') =>
    settingsWidgetProps('audio', [], focused, backTo).help.text
  for (const page of SETTINGS_PAGES) assert.equal(help(`tab-${page}`), 'Left/Right: switch page')
  assert.equal(help('back'), 'Back to the start screen')
  assert.equal(help('back', 'pause'), 'Back to the pause menu')
  assert.equal(help('act-credits'), 'Who made Royal Fiesta')
  for (const focused of [null, 'title', 'row-0', 'row-14', 'row-nope']) assert.equal(help(focused), '')
})
