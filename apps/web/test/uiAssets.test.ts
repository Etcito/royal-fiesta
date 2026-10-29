import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { assetMapping, layoutScreen, loadUiDoc, parseUiAssetText, type Widget } from '@etcito/uaa'
import { containLogo, logoFile } from '../src/ui/logoRenderer.ts'
import { capsuleMapping } from '../src/ui/buttonMapping.ts'

const uiDir = new URL('../../../ui/', import.meta.url)
const assets = new Map(readdirSync(uiDir).filter(n => n.endsWith('.ui.json')).map(n => {
  const asset = parseUiAssetText(readFileSync(new URL(n, uiDir), 'utf8'))
  return [asset.id, asset] as const
}))
const doc = loadUiDoc(JSON.parse(readFileSync(new URL('screens.ui-doc.json', uiDir), 'utf8')), assets)

function flatten(widgets: readonly Widget[]): Widget[] {
  return widgets.flatMap(w => [w, ...flatten(w.children ?? [])])
}

test('every pink button keeps a readable label in every state and orientation', () => {
  const asset = assets.get('button.primary')!
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
          assert.ok(slot.size * mapping.scaleAt(centre) >= 25 * layout.dpToPx, `${screen.id}/${widget.id}/${state}: collapsed label`)
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

test('Settings buttons and their focus bounds stay inside the panel cushion in both orientations', () => {
  const screen = doc.screens.find(s => s.id === 'settings')!
  const card = assets.get('panel.card')!
  const cushion = card.states.normal.items.find(i => i.element === 'cushion')!.bounds
  for (const [width, height] of [[360, 640], [720, 1280], [1280, 720], [1920, 1080]]) {
    const layout = layoutScreen(doc, screen, { width, height, pixelRatio: 1, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } })
    const panel = assetMapping(card.frame, card.nineSlice, layout.rects.get('card')!, layout.dpToPx)
    const lo = panel.toPx([cushion.min[0], cushion.max[1]])
    const hi = panel.toPx([cushion.max[0], cushion.min[1]])
    for (const w of flatten(screen.widgets)) {
      if (w.type !== 'button') continue
      const asset = assets.get(w.asset)!
      const rect = layout.rects.get(w.id)!
      const mapping = capsuleMapping(asset, rect)
      for (const state of Object.values(asset.states)) for (const p of [state.bounds.min, state.bounds.max]) {
        const point = mapping.toPx(p)
        // Include the focus bounce, not just the unanimated button rectangle.
        const x = rect.x + rect.w / 2 + (point[0] - rect.x - rect.w / 2) * 1.08
        const y = rect.y + rect.h / 2 + (point[1] - rect.y - rect.h / 2) * 1.08
        assert.ok(x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1], `${w.id}/${width}x${height}: outside cushion`)
      }
    }
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
