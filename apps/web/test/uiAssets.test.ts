import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { loadAssets } from '../src/ui/uaaHost.ts'
import { assetMapping, createFontRegistry, createUi, layoutScreen, loadUiDoc, layoutLine, parseUiAssetText, type AssetCommand, type UiFont, type Widget } from '@etcito/uaa'
import { containLogo, logoFile } from '../src/ui/logoRenderer.ts'
import { capsuleMapping, mapCapsule } from '../src/ui/buttonMapping.ts'

const uiDir = new URL('../../../ui/', import.meta.url)
const assets = loadAssets(Object.fromEntries(readdirSync(uiDir).filter(n => n.endsWith('.ui.json')).map(n => [n, readFileSync(new URL(n, uiDir), 'utf8')])))
const doc = loadUiDoc(JSON.parse(readFileSync(new URL('screens.ui-doc.json', uiDir), 'utf8')), assets)

function flatten(widgets: readonly Widget[]): Widget[] {
  return widgets.flatMap(w => [w, ...flatten(w.children ?? [])])
}

test('every pink button keeps a readable label in every state and orientation', () => {
  const asset = assets.get('button.primary')!
  const font: UiFont = { id: 'test:700', family: 'test', weight: 700, unitsPerEm: 1000, ascender: 800, descender: -200,
    glyph: codePoint => ({ index: codePoint, advance: 500, contours: [] }), kerning: () => 0 }
  let checked = 0
  for (const [width, height] of [[360, 640], [720, 1280], [1280, 720], [1920, 1080]]) {
    const viewport = { width, height, pixelRatio: 1, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }
    for (const screen of doc.screens) {
      const layout = layoutScreen(doc, screen, viewport)
      for (const widget of flatten(screen.widgets)) {
        if (widget.type !== 'button' || widget.asset !== asset.id) continue
        const mapping = capsuleMapping(asset, layout.rects.get(widget.id)!)
        for (const [state, list] of Object.entries(asset.states)) {
          const slot = list.textSlots[0]
          const centre: [number, number] = [(slot.box.min[0] + slot.box.max[0]) / 2, (slot.box.min[1] + slot.box.max[1]) / 2]
          const rect = layout.rects.get(widget.id)!
          const command: AssetCommand = { kind: 'asset', widget: widget.id, asset, rect, state: state as AssetCommand['state'], list,
            mapping, opacity: 1, transform: [1,0,0,1,0,0], clip: null,
            slots: [{ slot, text: 'Play', placed: { run: layoutLine(font, 'Play', slot.size * mapping.scaleAt(centre)), originX: 0, baselineY: 0, scale: 1 } }] }
          const placed = mapCapsule(command, screen.id, width > height).slots[0].placed
          assert.ok(placed.run.sizePx * placed.scale >= 25 * layout.dpToPx, `${screen.id}/${widget.id}/${state}: collapsed label`)
          checked++
        }
      }
    }
  }
  assert.ok(checked > 0)
})

test('both button assets keep circular end caps for wide, tall and narrow frames', () => {
  for (const id of ['button.primary', 'button.secondary']) {
    const asset = assets.get(id)!
    const source = JSON.parse(readFileSync(new URL(`${id}.ui.json`, uiDir), 'utf8'))
    const rim = source.drawing.layers.flatMap((l: { elements: { id: string; shape: { x: number; y: number; w: number; h: number; r: number } }[] }) => l.elements).find((e: { id: string }) => e.id === 'rim').shape
    for (const width of [60, 100, 220, 440, 540, 800]) for (const height of [60, 64, 100, 110]) {
      const mapping = capsuleMapping(asset, { x: 25, y: 40, w: width, h: height })
      for (const centreX of [rim.x + rim.r, rim.x + rim.w - rim.r]) {
        const centreY = rim.y + rim.h / 2
        const centre = mapping.toPx([centreX, centreY])
        const x = mapping.toPx([centreX < rim.x + rim.w / 2 ? centreX - rim.r : centreX + rim.r, centreY])
        const y = mapping.toPx([centreX, centreY + rim.r])
        assert.ok(Math.abs(Math.abs(x[0] - centre[0]) - Math.abs(y[1] - centre[1])) < 1e-8, `${id}/${width}x${height}: oval cap`)
      }
      for (const state of Object.values(asset.states)) for (const p of [state.bounds.min, state.bounds.max]) {
        const point = mapping.toPx(p)
        assert.ok(point[0] >= 25 - 1e-8 && point[0] <= 25 + width + 1e-8
          && point[1] >= 40 - 1e-8 && point[1] <= 40 + height + 1e-8, `${id}: paint exceeds its frame`)
      }
    }
  }
})

const settingsPages = { audio: 7, graphics: 14, controls: 12, gameplay: 2 }

test('Settings buttons and their 1.08 focus envelopes stay in each page cushion', () => {
  const screen = doc.screens.find(s => s.id === 'settings')!
  const card = assets.get('panel.card')!
  const cushion = card.states.normal.items.find(i => i.element === 'cushion')!.bounds
  for (const [width, height] of [[360, 640], [720, 1280], [1280, 720], [1920, 1080]]) {
    const layout = layoutScreen(doc, screen, { width, height, pixelRatio: 1, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } })
    for (const [page, count] of Object.entries(settingsPages)) {
      for (const w of flatten(screen.widgets)) {
        if (w.type !== 'button') continue
        const row = /^row-(\d+)$/.exec(w.id)
        if (row && Number(row[1]) >= count) continue
        const panelId = row ? `card-${page}` : 'card-graphics'
        const panel = assetMapping(card.frame, card.nineSlice, layout.rects.get(panelId)!, layout.dpToPx)
        const lo = panel.toPx([cushion.min[0], cushion.max[1]])
        const hi = panel.toPx([cushion.max[0], cushion.min[1]])
        const rect = layout.rects.get(w.id)!
        const asset = assets.get(w.asset)!
        const command: AssetCommand = { kind: 'asset', widget: w.id, asset, rect, state: 'normal',
          list: asset.states.normal, mapping: capsuleMapping(asset, rect),
          opacity: 1, transform: [1, 0, 0, 1, 0, 0], clip: null, slots: [] }
        const mapped = mapCapsule(command, screen.id, width > height)
        assert.deepEqual(mapped.rect, rect, 'painting must preserve the pointer target')
        // Check the full pointer target as well as every state's painted focus envelope.
        const points = [[rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h],
          ...Object.values(asset.states).flatMap(state => [state.bounds.min, state.bounds.max].map(p => mapped.mapping.toPx(p)))]
        for (const [px, py] of points) {
          const x = rect.x + rect.w / 2 + (px - rect.x - rect.w / 2) * 1.08
          const y = rect.y + rect.h / 2 + (py - rect.y - rect.h / 2) * 1.08
          assert.ok(x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1], `${page}/${w.id}/${width}x${height}: outside cushion`)
        }
      }
    }
  }
})

test('Settings exposes the page, tab and row control widget contract', () => {
  const screen = doc.screens.find(s => s.id === 'settings')!
  const widgets = new Map(screen.widgets.map(w => [w.id, w]))
  const expected = new Map<string, Widget['type']>([
    ['title', 'label'], ['back', 'button'], ['act-credits', 'button'],
    ['line-0', 'label'], ['help', 'label'], ['hint', 'label']
  ])
  for (const page of Object.keys(settingsPages)) {
    expected.set(`card-${page}`, 'panel')
    expected.set(`tab-${page}`, 'button')
    expected.set(`tab-mark-${page}`, 'progress')
  }
  for (let i = 0; i < 14; i++) {
    expected.set(`row-${i}`, 'button')
    expected.set(`value-${i}`, 'label')
    expected.set(`slider-${i}`, 'progress')
    expected.set(`switch-${i}`, 'group')
    expected.set(`keycap-${i}`, 'panel')
  }
  assert.deepEqual([...widgets.keys()].sort(), [...expected.keys()].sort())
  assert.equal(screen.initialFocus, 'row-0')
  for (const [id, type] of expected) {
    const w = widgets.get(id)!
    assert.equal(w.type, type, id)
    if (w.type === 'panel') assert.equal(w.asset, 'panel.card')
    if (w.type === 'button') {
      assert.equal(w.asset, 'button.secondary')
      assert.equal(w.action, id.startsWith('row-') ? 'row' : id === 'act-credits' ? 'credits' : id)
    }
    if (w.type === 'progress') {
      assert.equal(w.track, 'bar.track')
      assert.equal(w.fill, 'bar.progress')
      assert.equal(w.value, id.startsWith('tab-mark-') ? 1 : 0)
    }
    if (w.type === 'label') {
      assert.ok(w.size >= (id === 'help' || id === 'hint' ? 20 : 26))
      assert.equal(w.color, '#5a2a00')
      if (id.startsWith('value-')) assert.equal(w.align, 'right')
    }
  }
  for (const orientation of ['rect', 'landscape'] as const) {
    const graphics = widgets.get('card-graphics')![orientation]!
    const first = widgets.get('row-0')![orientation]!
    const second = widgets.get('row-1')![orientation]!
    const pitch = second.offsetMin![1] - first.offsetMin![1]
    for (let i = 0; i < 14; i++) {
      const row = widgets.get(`row-${i}`)![orientation]!
      const value = widgets.get(`value-${i}`)![orientation]!
      assert.equal(row.offsetMin![0], first.offsetMin![0], 'rows use one column')
      assert.equal(row.offsetMin![1] - first.offsetMin![1], i * pitch)
      for (const control of ['slider', 'switch']) {
        const bar = widgets.get(`${control}-${i}`)![orientation]!
        assert.ok(bar.offsetMin![0] > row.offsetMax![0] && bar.offsetMax![0] < value.offsetMin![0])
        assert.equal(bar.offsetMin![1] + bar.offsetMax![1], row.offsetMin![1] + row.offsetMax![1])
        if (control === 'switch') assert.equal(bar.offsetMax![0] - bar.offsetMin![0], 70)
      }
    }
    for (const page of Object.keys(settingsPages)) {
      const tab = widgets.get(`tab-${page}`)![orientation]!
      const mark = widgets.get(`tab-mark-${page}`)![orientation]!
      assert.ok(mark.offsetMin![1] > tab.offsetMax![1], 'tab marks sit below their buttons')
    }
    for (const [page, rows] of Object.entries(settingsPages)) {
      const card = widgets.get(`card-${page}`)![orientation]!
      assert.deepEqual(card.offsetMin, graphics.offsetMin)
      assert.equal(graphics.offsetMax![1] - card.offsetMax![1], (14 - rows) * pitch)
      assert.ok(card.offsetMax![1] > widgets.get(`row-${rows - 1}`)![orientation]!.offsetMax![1])
    }
  }
  const hint = widgets.get('hint')!
  assert.equal(hint.type === 'label' && hint.text, 'Up/Down choose - Left/Right adjust or switch page - Enter select - Esc back')
})

test('Settings Back still focuses and activates at the edge of its full pointer target', () => {
  const back = doc.screens.find(s => s.id === 'settings')!.widgets.find(w => w.id === 'back')!
  for (const [width, height] of [[360, 640], [1280, 720]]) {
    const ui = createUi({ doc, assets, fonts: createFontRegistry([]), renderer: null,
      viewport: { width, height, pixelRatio: 1, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }, nowMs: 0 })
    try {
      ui.show('settings', { animate: false })
      const rect = ui.rectOf('back')!
      const actions: string[] = []
      ui.on('action', e => actions.push(e.action))
      const at = { x: rect.x + rect.w / 2, y: rect.y + rect.h - 0.1 }
      ui.input({ kind: 'pointer', phase: 'down', ...at })
      assert.equal(ui.focused(), 'back')
      ui.input({ kind: 'pointer', phase: 'up', ...at })
      ui.input({ kind: 'activate', phase: 'down' })
      ui.input({ kind: 'activate', phase: 'up' })
      assert.deepEqual(actions, ['back', 'back'])
    } finally { ui.destroy() }
  }
})

test('logo delivery uses AVIF for PNG sources and accepts SVG directly', () => {
  assert.equal(logoFile({ sha256: 'hash', format: 'png' }), 'images/hash.avif')
  assert.equal(logoFile({ sha256: 'hash', format: 'svg' }), 'images/hash.svg')
})

test('all logo placements preserve the PNG proportions and fit their responsive rects', () => {
  const logo = JSON.parse(readFileSync(new URL('logo.json', uiDir), 'utf8')) as { width: number; height: number }
  for (const [width, height] of [[360, 640], [720, 1280], [1280, 720], [1920, 1080]]) {
    for (const screen of doc.screens) {
      const layout = layoutScreen(doc, screen, { width, height, pixelRatio: 2, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } })
      for (const widget of flatten(screen.widgets)) {
        if (widget.type !== 'icon' || widget.asset !== 'logo.crown') continue
        const rect = layout.rects.get(widget.id)!
        const image = containLogo(rect, logo.width, logo.height)
        assert.ok(Math.abs(image.w / image.h - logo.width / logo.height) < 1e-10)
        assert.ok(image.x >= rect.x && image.y >= rect.y)
        assert.ok(image.x + image.w <= rect.x + rect.w + 1e-8)
        assert.ok(image.y + image.h <= rect.y + rect.h + 1e-8)
        assert.ok(image.x >= 0 && image.y >= 0 && image.x + image.w <= width && image.y + image.h <= height)
      }
    }
  }
})
