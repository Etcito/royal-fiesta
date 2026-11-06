// Regenerate only Settings; preserve the authored bytes of every other screen.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RectSpec, Screen, Widget } from '@etcito/uaa'

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
    card: [-320, -620, 320, 402],
    title: [-158, -578, 158, -522],
    back: [-274, -574, -164, -522],
    credits: [164, -574, 274, -522],
    tabs: [-274, -510, -143, -458], tabGap: 8, markY: -452,
    status: [-274, -440, 274, -408],
    help: [-274, -402, 274, -372],
    hint: [-310, 540, 310, 612],
    row: [-274, -362, -8, -316], pitch: 52, bottomPad: 42,
    slider: [16, 132], toggle: [40, 110], value: [144, 280]
  },
  landscape: {
    card: [-500, -350, 500, 350],
    title: [-290, -316, 290, -280],
    back: [-444, -314, -304, -280],
    credits: [304, -314, 444, -280],
    tabs: [-444, -274, -231, -240], tabGap: 12, markY: -236,
    status: [-444, -230, 444, -204],
    help: [-444, -204, 444, -184],
    hint: [-600, 332, 600, 358],
    row: [-444, -183, -10, -151], pitch: 36, bottomPad: 33,
    slider: [20, 230], toggle: [90, 160], value: [246, 450]
  }
}
const pages = [
  { id: 'audio', label: 'Audio', rows: 7 },
  { id: 'graphics', label: 'Graphics', rows: 14 },
  { id: 'controls', label: 'Controls', rows: 12 },
  { id: 'gameplay', label: 'Gameplay', rows: 2 }
]

function rect([x0, y0, x1, y1]: Box): RectSpec {
  return { anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5], offsetMin: [x0, y0], offsetMax: [x1, y1] }
}

function placement(box: (g: Geometry) => Box) {
  return { rect: rect(box(geometry.portrait)), landscape: rect(box(geometry.landscape)) }
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
  widgets.push(
    label('title', 'Settings', g => g.title, 28),
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
  for (let i = 0; i < 14; i++) {
    const bar = (g: Geometry, x: [number, number]): Box => {
      const row = rowBox(g, i), y = (row[1] + row[3]) / 2
      return [x[0], y - 6, x[1], y + 6]
    }
    widgets.push(
      button(`row-${i}`, '', 'row', g => rowBox(g, i)),
      progress(`slider-${i}`, g => bar(g, g.slider)),
      progress(`switch-${i}`, g => bar(g, g.toggle)),
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
  const replacement = JSON.stringify(settingsScreen(), null, 2).split('\n').map(line => `    ${line}`).join('\n')
  const output = source.replace(pattern, () => replacement).trimEnd() + '\n'
  JSON.parse(output)
  writeFileSync(`${path}.tmp`, output)
  renameSync(`${path}.tmp`, path)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
