import { SETTINGS_PAGES, SETTINGS_ROW_SLOTS, settingsPanelFraction } from '@royal-fiesta/game/screens/settingsPages'
import type { Rect } from '@royal-fiesta/game/screens/menuModel'
import type { SettingsDraw } from '../../ui/settingsWidgets.ts'
import type { WidgetProps } from '../../ui/screenMap.ts'

export interface SettingsLayoutSample {
  width: number
  height: number
  panel: Rect | null
  player: Rect | null
  labels: { id: string; text: string; rect: Rect | null }[]
  rows: number
  bindings: number[]
  toggles: number[]
  draw: SettingsDraw
}

export function settingsLayoutFailures(s: SettingsLayoutSample): string[] {
  const failures: string[] = []
  const inside = (r: Rect): boolean => [r.x, r.y, r.w, r.h].every(Number.isFinite)
    && r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= s.width && r.y + r.h <= s.height
  if (!s.panel || !inside(s.panel)) failures.push('panel must be inside the viewport')
  if (!s.player || !inside(s.player)) failures.push('drawn player bounds must be inside the viewport')
  if (s.panel && s.player) {
    const a = s.panel, b = s.player
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) failures.push('panel covers the player')
  }
  if (s.panel && s.panel.w * s.panel.h > settingsPanelFraction(s.rows, s.height > s.width) * s.width * s.height + 1) {
    failures.push(`panel exceeds the area for ${s.rows} rows`)
  }
  const expected = [...SETTINGS_PAGES.map(p => `tab-${p}`), ...Array.from({ length: s.rows }, (_, i) => `row-${i}`)]
  const scale = s.width >= s.height ? Math.min(s.width / 1280, s.height / 720) : Math.min(s.width / 720, s.height / 1280)
  for (const id of expected) {
    const label = s.labels.find(l => l.id === id)
    const drawn = s.draw.labels.find(l => l.widget === id)
    if (!label?.text.trim() || !label.rect || !inside(label.rect) || !drawn || drawn.glyphs === 0) failures.push(`${id} has no drawn label`)
    else if (drawn.size < 26 * scale) failures.push(`${id} label is too small to read`)
  }
  for (const i of s.bindings) {
    if (!s.draw.widgets.includes(`keycap-${i}`) || !s.draw.labels.some(l => l.widget === `value-${i}` && l.glyphs > 0)) {
      failures.push(`binding ${i} must draw the key-cap widget and its label`)
    }
  }
  for (const i of s.toggles) {
    if (!s.draw.widgets.includes(`switch-track-${i}`)
      || !s.draw.widgets.some(id => id === `switch-on-${i}` || id === `switch-off-${i}`)) failures.push(`toggle ${i} must draw a switch track and thumb`)
  }
  return failures
}

/** Leading row slots the screen shows; settingsWidgetProps hides the slots past the page's items. */
export function visibleRows(props: Record<string, WidgetProps>): number {
  let rows = 0
  while (rows < SETTINGS_ROW_SLOTS && props[`row-${rows}`]?.visible === true) rows++
  return rows
}
