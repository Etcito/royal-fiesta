import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  SETTINGS_PAGES, SETTINGS_ROW_SLOTS, type SettingsItem
} from '../../../packages/game/src/screens/settingsPages.ts'
import type { DocWidget, ScreensDoc } from '../src/ui/screenMap.ts'
import { settingsWidgetProps } from '../src/ui/settingsWidgets.ts'
import { settingsDraw, withSettingsWidgets } from '../src/ui/settingsWidgets.ts'
import { settingsLayoutFailures, type SettingsLayoutSample } from '../src/game/checks/settingsLayout.ts'
import { projectPlayer, settingsCamera, SettingsScene } from '../src/game/settingsScene.ts'
import { createFontRegistry, createUi, loadUiDoc, type UiFont } from '@etcito/uaa'
import { loadAssets } from '../src/ui/uaaHost.ts'
import { readdirSync } from 'node:fs'
import { NullRenderPort } from '../../../packages/game/src/render/nullPort.ts'
import { DEFAULT_SETTINGS } from '../../../packages/game/src/screens/settings.ts'
import { pageItems } from '../../../packages/game/src/screens/settingsPages.ts'
import type { CameraPose, Vec3T } from '../../../packages/game/src/render/port.ts'

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

test('unused slots hide their widgets and only the current card and tab mark are shown', () => {
  for (const page of SETTINGS_PAGES) {
    const props = settingsWidgetProps(page, [slider], null, 'start')
    for (let i = 1; i < SETTINGS_ROW_SLOTS; i++) {
      for (const kind of ['row', 'value', 'slider', 'switch', 'keycap']) assert.deepEqual(props[`${kind}-${i}`], { visible: false })
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

test('Settings draws readable labels, cap faces and switch thumbs across pause and viewport changes', () => {
  const uiDir = new URL('../../../ui/', import.meta.url)
  const assets = loadAssets(Object.fromEntries(readdirSync(uiDir).filter(n => n.endsWith('.ui.json'))
    .map(n => [n, readFileSync(new URL(n, uiDir), 'utf8')])))
  const doc = loadUiDoc(JSON.parse(readFileSync(new URL('screens.ui-doc.json', uiDir), 'utf8')), assets)
  const font: UiFont = { id: 'test:700', family: 'Fredoka', weight: 700, unitsPerEm: 1000, ascender: 800, descender: -200,
    glyph: index => ({ index, advance: 500, contours: [{ start: [0, 0], segs: [{ t: 'L', p: [400, 700] }] }] }), kerning: () => 0 }
  const fonts = createFontRegistry([])
  fonts.get = () => font
  const renderer = withSettingsWidgets({ kind: 'webgpu', resize() {}, render() {}, destroy() {} })
  const viewport = { width: 1280, height: 720, pixelRatio: 1, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }
  const ui = createUi({ doc, assets, fonts, renderer, viewport, nowMs: 0 })
  try {
    for (const [width, height] of [[640, 360], [1280, 720], [390, 844]]) {
      ui.resize({ ...viewport, width, height })
      for (const from of ['start', 'pause'] as const) {
        ui.show(from, { animate: false })
        ui.render()
        ui.show('settings', { animate: false })
        for (const page of SETTINGS_PAGES) {
          const items = page === 'graphics' ? Array.from({ length: 14 }, () => choice)
            : pageItems(page, DEFAULT_SETTINGS, { rebinding: null, reducedMotion: false })
          const props = settingsWidgetProps(page, items, 'row-0', from)
          for (const [id, value] of Object.entries(props)) ui.set(id, value)
          ui.render()
          const labels = [...SETTINGS_PAGES.map(p => ({ id: `tab-${p}`, text: p })),
            ...items.map((item, i) => ({ id: `row-${i}`, text: item.label }))].map(l => ({ ...l, rect: ui.rectOf(l.id) }))
          const panel = ui.rectOf(`card-${page}`)!
          const points: Vec3T[] = []
          for (const x of [-1.74, 1.74]) for (const y of [-1.2, 1.33]) for (const z of [-0.64, 0.64]) points.push([x, y, z])
          const previous: CameraPose = { eye: [0, 4, 7], target: [0, 0, 0], fovYDeg: 38, near: 0.1, far: 500 }
          const camera = settingsCamera(points, previous, panel, width, height)
          const sample: SettingsLayoutSample = {
            width, height, panel, player: projectPlayer(points, camera, width, height), labels, rows: items.length,
            bindings: page === 'controls' ? [0, 1, 2, 3, 4, 5, 6] : [],
            toggles: page === 'controls' ? [10] : page === 'gameplay' ? [0] : [], draw: settingsDraw(),
          }
          assert.deepEqual(settingsLayoutFailures(sample), [], `${from}/${page}/${width}x${height}`)
          assert.ok(settingsLayoutFailures({ ...sample, player: null }).some(s => s.includes('player')))
          assert.ok(settingsLayoutFailures({ ...sample, player: panel }).includes('panel covers the player'))
          assert.ok(settingsLayoutFailures({ ...sample, panel: { x: 0, y: 0, w: width, h: height } }).some(s => s.includes('area')))
          assert.ok(settingsLayoutFailures({ ...sample, draw: { ...sample.draw, labels: [] } }).some(s => s.includes('drawn label')))
          if (page === 'controls') {
            const noCaps = { ...sample.draw, widgets: sample.draw.widgets.filter(id => !id.startsWith('keycap-')) }
            assert.ok(settingsLayoutFailures({ ...sample, draw: noCaps }).some(s => s.includes('key-cap')))
            const noThumb = { ...sample.draw, widgets: sample.draw.widgets.filter(id => !/^switch-(on|off)-/.test(id)) }
            assert.ok(settingsLayoutFailures({ ...sample, draw: noThumb }).some(s => s.includes('thumb')))
          }
        }
      }
    }
  } finally { ui.destroy() }
})

test('key bindings select physical caps, and off toggles retain a thumb', () => {
  const props = settingsWidgetProps('controls', [capture, { ...toggle, fraction: 0, value: 'Off' }], null, 'pause')
  assert.equal(props['keycap-0'].visible, true)
  assert.equal(props['keycap-1'].visible, false)
  assert.equal(props['switch-off-1'].visible, true)
  assert.equal(props['switch-on-1'].visible, false)
})

test('scene evidence follows submitted player visibility and transforms instead of inventing a character', async () => {
  const target = new NullRenderPort()
  await target.init({ canvas: null, width: 1280, height: 720, viewports: [{ x: 0, y: 0, width: 1280, height: 720 }] })
  const scene = new SettingsScene()
  const readFrame = () => scene.frame
  const port = scene.wrap(target, 'penguin.body', () => ({ panel: { x: 514, y: 10, w: 736, h: 670 }, width: 1280, height: 720 }))
  const asset = port.registerAsset('penguin.body', { id: 'penguin.body' } as Parameters<typeof port.registerAsset>[1])
  const player = port.createInstance(asset, null)
  port.setTransform(player, [12, 3, -9], [0, 0.7071, 0, 0.7071], [1, 1, 1])
  port.setCamera(0, { eye: [12, 7, -2], target: [12, 3, -9], fovYDeg: 60, near: 0.1, far: 500 })
  port.render()
  assert.equal(readFrame()?.player, player)
  assert.ok(readFrame()!.bounds.x + readFrame()!.bounds.w < 514)
  port.setVisible(player, false)
  port.render()
  assert.equal(readFrame(), null)
  port.setVisible(player, true)
  port.render()
  assert.equal(readFrame()?.player, player)
  port.destroyInstance(player)
  port.render()
  assert.equal(readFrame(), null)
})
