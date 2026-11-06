// Regenerate only Settings; preserve the authored bytes of every other screen.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RectSpec, Screen, Widget } from '@etcito/uaa'
import { PAGE_ROWS, SETTINGS_PAGES, SETTINGS_ROW_SLOTS, TAB_LABELS } from '../packages/game/src/screens/settingsPages.ts'
import { MAX_FILE_BYTES } from './guard.ts'

type Box = [number, number, number, number]
type Geometry = {
  card: Box
  title: Box
  back: Box
  credits: Box
  tabs: Box
  tabGap: number
  markY: number
  status: Box
  help: Box
  hint: Box
  row: Box
  pitch: number
  bottomPad: number
  slider: [number, number]
  toggle: [number, number]
  value: [number, number]
}

// All coordinates are dp relative to the screen centre, with y down.
const geometry: Record<'portrait' | 'landscape', Geometry> = {
  portrait: {
    card: [-336, 20, 336, 0],
    title: [-180, 62, 180, 102],
    back: [-284, 62, -188, 102],
    credits: [188, 62, 284, 102],
    tabs: [-284, 114, -148, 154], tabGap: 8, markY: 159,
    status: [-284, 166, 284, 198],
    help: [-284, 200, 284, 230],
    hint: [-310, 540, 310, 612],
    row: [-284, 238, 20, 278], pitch: 44, bottomPad: 42,
    slider: [36, 156], toggle: [50, 120], value: [168, 284]
  },
  landscape: {
    card: [-126, -350, 610, 0],
    title: [10, -310, 474, -276],
    back: [-70, -310, 26, -276],
    credits: [458, -310, 554, -276],
    tabs: [-70, -270, 80, -236], tabGap: 8, markY: -231,
    status: [-90, -225, 574, -201],
    help: [-90, -201, 574, -177],
    hint: [-600, 332, 600, 358],
    row: [-70, -168, 230, -138], pitch: 32, bottomPad: 42,
    slider: [246, 400], toggle: [280, 350], value: [414, 574]
  }
}
const pages = SETTINGS_PAGES.map(id => ({
  id, label: TAB_LABELS[id], rows: id === 'graphics' ? SETTINGS_ROW_SLOTS : PAGE_ROWS[id].length
}))

function rect([x0, y0, x1, y1]: Box, top = false): RectSpec {
  return { anchorMin: [0.5, top ? 0 : 0.5], anchorMax: [0.5, top ? 0 : 0.5], offsetMin: [x0, y0], offsetMax: [x1, y1] }
}

function placement(box: (g: Geometry) => Box) {
  return { rect: rect(box(geometry.portrait), true), landscape: rect(box(geometry.landscape)) }
}

function button(id: string, text: string, action: string, box: (g: Geometry) => Box): Widget {
  return { id, type: 'button', asset: 'button.secondary', text: { label: text }, action,
    ...placement(box), anim: { focus: { kind: 'bounce', duration: 200 }, press: { kind: 'pop', duration: 150 } } }
}

function label(id: string, text: string, box: (g: Geometry) => Box, size = 26, align: 'center' | 'right' = 'center'): Widget {
  return { id, type: 'label', text, font: { family: 'Fredoka', weight: 700 }, size,
    color: '#5a2a00', align, ...placement(box) }
}

function progress(id: string, box: (g: Geometry) => Box, value = 0): Widget {
  return { id, type: 'progress', track: 'bar.track', fill: 'bar.progress', value, ...placement(box) }
}

function rowBox(g: Geometry, i: number): Box {
  return [g.row[0], g.row[1] + i * g.pitch, g.row[2], g.row[3] + i * g.pitch]
}

export function settingsScreen(): Screen {
  // The host supplies page/card/mark and row-control visibility through widget props.
  const widgets: Widget[] = pages.map(page => ({
    id: `card-${page.id}`, type: 'panel', asset: 'panel.card',
    ...placement(g => [g.card[0], g.card[1], g.card[2], rowBox(g, page.rows - 1)[3] + g.bottomPad])
  }))
  // Graphics shows as many rows as the render-options contract fills: one card per count (settingsCardId).
  for (let rows = 0; rows < SETTINGS_ROW_SLOTS; rows++) {
    widgets.push({ id: `card-graphics-${rows}`, type: 'panel', asset: 'panel.card',
      ...placement(g => [g.card[0], g.card[1], g.card[2], rowBox(g, rows - 1)[3] + g.bottomPad]) })
  }
  widgets.push(
    label('title', 'Settings', g => g.title, 30),
    button('back', 'Back', 'back', g => g.back),
    button('act-credits', 'Credits', 'credits', g => g.credits)
  )
  pages.forEach((page, i) => {
    const tab = (g: Geometry): Box => {
      const stride = g.tabs[2] - g.tabs[0] + g.tabGap
      return [g.tabs[0] + i * stride, g.tabs[1], g.tabs[2] + i * stride, g.tabs[3]]
    }
    widgets.push(button(`tab-${page.id}`, page.label, `tab-${page.id}`, tab))
    widgets.push(progress(`tab-mark-${page.id}`, g => [tab(g)[0] + 8, g.markY, tab(g)[2] - 8, g.markY + 3], 1))
  })
  widgets.push(
    label('line-0', '', g => g.status),
    label('help', '', g => g.help, 20),
    label('hint', 'Up/Down choose - Left/Right adjust or switch page - Enter select - Esc back', g => g.hint, 20)
  )
  for (let i = 0; i < SETTINGS_ROW_SLOTS; i++) {
    const bar = (g: Geometry, x: [number, number]): Box => {
      const row = rowBox(g, i), y = (row[1] + row[3]) / 2
      return [x[0], y - 6, x[1], y + 6]
    }
    widgets.push(
      button(`row-${i}`, '', 'row', g => rowBox(g, i)),
      progress(`slider-${i}`, g => bar(g, g.slider)),
      { id: `keycap-${i}`, type: 'panel', asset: 'panel.card',
        ...placement(g => [g.value[0], rowBox(g, i)[1] - 1, g.value[1], rowBox(g, i)[3] + 1]) },
      { id: `switch-${i}`, type: 'group', ...placement(g => {
        const row = rowBox(g, i), y = (row[1] + row[3]) / 2
        return [g.toggle[0], y - 12, g.toggle[1], y + 12]
      }), children: [
        { id: `switch-track-${i}`, type: 'progress', track: 'bar.track', fill: 'bar.progress', value: 1,
          rect: { anchorMin: [0, 0.25], anchorMax: [1, 0.75], offsetMin: [0, 0], offsetMax: [0, 0] } },
        ...([0, 1] as const).map(on => ({ id: `switch-${on ? 'on' : 'off'}-${i}`, type: 'icon' as const, asset: 'badge.round',
          rect: { anchorMin: [on, 0.5] as [number, number], anchorMax: [on, 0.5] as [number, number],
            offsetMin: [on ? -24 : 0, -12] as [number, number], offsetMax: [on ? 0 : 24, 12] as [number, number] } }))
      ] },
      label(`value-${i}`, '', g => [g.value[0], rowBox(g, i)[1], g.value[1], rowBox(g, i)[3]], 26, 'right')
    )
  }
  return { id: 'settings', initialFocus: 'row-0', enter: { kind: 'pop', duration: 300 },
    exit: { kind: 'fade', duration: 150 }, widgets }
}

export function main(): void {
  const path = fileURLToPath(new URL('../ui/screens.ui-doc.json', import.meta.url))
  const source = readFileSync(path, 'utf8')
  const pattern = /^    \{\n      "id": "settings",[\s\S]*?^    \}/gm
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) throw new Error('Expected exactly one settings screen in ui/screens.ui-doc.json')
  // Number pairs and innermost objects (rects, fonts, anims) stay on one line: one value per line pushed the document
  // past the repository's file-size guard.
  const json = JSON.stringify(settingsScreen(), null, 2)
    .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]')
    .replace(/\{\n[^{}]*?\n\s*\}/g, block => block.replace(/\n\s*/g, ' '))
  const replacement = json.split('\n').map(line => `    ${line}`).join('\n')
  const output = source.replace(pattern, () => replacement).trimEnd() + '\n'
  JSON.parse(output)
  // The guard refuses a tracked file over MAX_FILE_BYTES: fail before the oversized document reaches disk.
  const bytes = Buffer.byteLength(output, 'utf8')
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`ui/screens.ui-doc.json would be ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte file guard; shrink the settings screen or its formatting`)
  }
  writeFileSync(`${path}.tmp`, output)
  renameSync(`${path}.tmp`, path)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
