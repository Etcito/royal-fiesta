// Review diagram of the real document geometry and production capsule mapping.
// This is CPU-generated layout evidence, not a screenshot or a GPU render.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assetMapping, layoutScreen, loadUiDoc, parseUiAssetText, sampleAnim,
  type AssetCommand, type Rect, type UiAsset } from '@etcito/uaa'
import sharp from 'sharp'
import { capsuleMapping, mapCapsule } from '../apps/web/src/ui/buttonMapping.ts'

const uiDir = new URL('../ui/', import.meta.url)
const assets = new Map(readdirSync(uiDir).filter(n => n.endsWith('.ui.json')).map(n => {
  const asset = parseUiAssetText(readFileSync(new URL(n, uiDir), 'utf8'))
  return [asset.id, asset] as const
}))
const doc = loadUiDoc(JSON.parse(readFileSync(new URL('screens.ui-doc.json', uiDir), 'utf8')), assets)
const screen = doc.screens.find(s => s.id === 'settings')!
const guardScale = 1.08 // The same conservative envelope as uiAssets.test.ts.
const n = (v: number): string => v.toFixed(3)
const escape = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
const rectSvg = (r: Rect, attrs: string): string =>
  `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" ${attrs}/>`

function command(asset: UiAsset, rect: Rect, id: string): AssetCommand {
  return { kind: 'asset', widget: id, asset, rect, state: 'focus', list: asset.states.focus,
    mapping: capsuleMapping(asset, rect), opacity: 1, transform: [1, 0, 0, 1, 0, 0], clip: null, slots: [] }
}

function geometry(width: number, height: number) {
  const viewport = { width, height, pixelRatio: 1, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } }
  const layout = layoutScreen(doc, screen, viewport)
  const card = assets.get('panel.card')!
  const mapping = assetMapping(card.frame, card.nineSlice, layout.rects.get('card')!, layout.dpToPx)
  const bounds = card.states.normal.items.find(i => i.element === 'cushion')!.bounds
  const lo = mapping.toPx([bounds.min[0], bounds.max[1]])
  const hi = mapping.toPx([bounds.max[0], bounds.min[1]])
  const cushion = { x: lo[0], y: lo[1], w: hi[0] - lo[0], h: hi[1] - lo[1] }
  const buttons = screen.widgets.filter(w => w.type === 'button').map(w => {
    if (w.type !== 'button') throw new Error('expected button')
    const rect = layout.rects.get(w.id)!
    const asset = assets.get(w.asset)!
    const mapped = mapCapsule(command(asset, rect, w.id), screen.id, width > height).mapping
    const points = Object.values(asset.states).flatMap(state => [state.bounds.min, state.bounds.max])
      .map(p => mapped.toPx(p)).map(([x, y]) => [
        rect.x + rect.w / 2 + (x - rect.x - rect.w / 2) * guardScale,
        rect.y + rect.h / 2 + (y - rect.y - rect.h / 2) * guardScale,
      ])
    const xs = points.map(p => p[0]), ys = points.map(p => p[1])
    const envelope = { x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    const focusPeak = sampleAnim(w.anim!.focus!, 130, { rect, viewport }, 'in').scale
    return { id: w.id, label: w.text!.label, rect, envelope, focusPeak }
  })
  return { width, height, cushion, buttons }
}

const cases = [[360, 640], [720, 1280], [1280, 720], [1920, 1080]].map(([w, h]) => geometry(w, h))
const portrait = cases[0], landscape = cases[2]
const back = landscape.buttons.find(b => b.id === 'back')!
const cushionBottom = landscape.cushion.y + landscape.cushion.h
const focusBottom = back.envelope.y + back.envelope.h
const parts = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">',
  '<style>text{font-family:sans-serif;fill:#142940}.heading{font-weight:700;font-size:26px}.note{font-size:18px}</style>',
  '<rect width="1600" height="1000" fill="#f2f6fa"/>',
  '<text x="24" y="36" class="heading">Settings: required bounds and focus containment</text>',
  '<text x="24" y="66" class="note">Geometry diagram from the UI document and production mapping; not a GPU capture.</text>',
]

function plot(g: ReturnType<typeof geometry>, x: number, y: number, scale: number): void {
  parts.push(`<g transform="translate(${x} ${y}) scale(${scale})">`)
  parts.push(rectSvg({ x: 0, y: 0, w: g.width, h: g.height }, 'fill="#e3ebf4" stroke="#8091a7"'))
  parts.push(rectSvg(g.cushion, 'fill="#fff9ed" stroke="#b16c00" stroke-width="2"'))
  for (const b of g.buttons) {
    const focused = b.id === 'back'
    parts.push(rectSvg(b.envelope, `fill="${focused ? '#b9efdb' : '#e2e8f6'}" stroke="${focused ? '#087f5b' : '#7d8bab'}"`))
    if (focused) parts.push(rectSvg(b.rect, 'fill="none" stroke="#2164bd" stroke-dasharray="4 3"'))
    parts.push(`<text x="${n(b.rect.x + b.rect.w / 2)}" y="${n(b.rect.y + b.rect.h / 2 + 4)}" text-anchor="middle" font-size="${g.width < 500 ? 9 : 13}">${escape(b.label)}</text>`)
  }
  parts.push('</g>')
}

plot(portrait, 24, 120, 0.82)
plot(landscape, 345, 120, 0.95)
parts.push('<text x="24" y="104" class="note">Portrait 360 × 640</text>')
parts.push('<text x="345" y="104" class="note">Landscape 1280 × 720 — all 18 rows</text>')
parts.push('<text x="24" y="680" class="note">Blue dashed: Back target</text>')
parts.push('<text x="24" y="710" class="note">Green: all-state paint envelope</text>')
parts.push('<text x="24" y="740" class="note">including a 1.08× scale guard.</text>')
parts.push('<text x="345" y="850" class="heading">Landscape Back: focus envelope at the cushion edge</text>')
parts.push('<g transform="translate(345 872)">')
const zoom = (r: Rect): Rect => ({ x: (r.x - back.rect.x) * 3, y: (r.y - back.rect.y) * 1.6, w: r.w * 3, h: r.h * 1.6 })
parts.push(rectSvg(zoom(back.envelope), 'fill="#b9efdb" stroke="#087f5b" stroke-width="2"'))
parts.push(rectSvg(zoom(back.rect), 'fill="none" stroke="#2164bd" stroke-dasharray="6 4" stroke-width="2"'))
const edgeY = (cushionBottom - back.rect.y) * 1.6
parts.push(`<path d="M 0 ${n(edgeY)} H 840" fill="none" stroke="#b16c00" stroke-width="2"/>`)
parts.push('</g>')
parts.push(`<text x="1210" y="890" class="note">Cushion: y = ${n(cushionBottom)} px</text>`)
parts.push(`<text x="1210" y="920" class="note">Paint: y ≤ ${n(focusBottom)} px</text>`)
parts.push('<text x="345" y="980" class="note">Document target: [140,214]..[420,264]. Only artwork is inset; pointer and keyboard activation are tested.</text>')
parts.push('</svg>')

const output = process.argv[2] ?? 'proofs/s3/m3/settings-layout'
mkdirSync(dirname(output), { recursive: true })
writeFileSync(`${output}.svg`, parts.join('\n') + '\n')
await sharp(Buffer.from(parts.join('\n'))).png().toFile(`${output}.png`)
writeFileSync(`${output}.json`, JSON.stringify({ evidence: 'layout geometry; not a GPU capture', guardScale, cases }) + '\n')
console.log(`${output}.{svg,png,json}: Back paint bottom ${n(focusBottom)} px, cushion bottom ${n(cushionBottom)} px`)
