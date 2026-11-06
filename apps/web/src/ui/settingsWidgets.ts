import {
  SETTINGS_PAGES, SETTINGS_ROW_SLOTS, type SettingsItem, type SettingsPage
} from '@royal-fiesta/game/screens/settingsPages'
import type { WidgetProps } from './screenMap.ts'
import { layoutLine, placeInBox, type DrawCommand, type UiRenderer } from '@etcito/uaa'

export interface SettingsDraw {
  labels: { widget: string; glyphs: number; size: number }[]
  widgets: string[]
}

let drawn: SettingsDraw = { labels: [], widgets: [] }
export function settingsDraw(): SettingsDraw { return drawn }

// Capsule art scales by height; its text slot consequently collapsed on compact rows.
// Submit Settings labels independently of the capsule mapping and its state-specific slot styling.
export function withSettingsWidgets(renderer: UiRenderer): UiRenderer {
  return {
    kind: renderer.kind,
    resize: viewport => renderer.resize(viewport),
    destroy: () => renderer.destroy(),
    render(list) {
      if (!list.commands.some(c => SETTINGS_PAGES.some(p => c.widget === `card-${p}`))) {
        drawn = { labels: [], widgets: [] }
        renderer.render(list)
        return
      }
      const { width, height } = list.viewport
      const scale = width >= height ? Math.min(width / 1280, height / 720) : Math.min(width / 720, height / 1280)
      const commands: DrawCommand[] = list.commands.flatMap(c => {
        if (c.kind !== 'asset' || !/^(row-\d+|tab-(audio|graphics|controls|gameplay)|back|act-credits)$/.test(c.widget)) return [c]
        return [{ ...c, slots: [] }, ...c.slots.map(s => ({
          kind: 'text' as const, widget: c.widget,
          placed: placeInBox(layoutLine(s.placed.run.font, s.text, 28 * scale),
            { ...c.rect, x: c.rect.x + 8 * scale, w: c.rect.w - 16 * scale }, 'center'),
          fill: { kind: 'solid' as const, color: c.state === 'disabled' ? '#786e65' : '#432a18', opacity: 1 },
          outline: null, shadow: null, opacity: c.opacity, transform: c.transform, clip: c.clip,
        }))]
      })
      // Centre the key text on its physical cap instead of right-aligning it like numeric values.
      const caps = new Set(commands.filter(c => c.widget.startsWith('keycap-')).map(c => c.widget.replace('keycap-', 'value-')))
      for (const c of commands) {
        if (c.kind !== 'text' || !caps.has(c.widget)) continue
        const cap = commands.find(a => a.widget === c.widget.replace('value-', 'keycap-'))
        if (cap?.kind === 'asset') c.placed = placeInBox(c.placed.run, cap.rect, 'center')
      }
      drawn = {
        widgets: commands.filter(c => c.opacity > 0).map(c => c.widget),
        labels: commands.filter(c => c.kind === 'text' && c.opacity > 0).map(c => {
          if (c.kind !== 'text') throw new Error('expected text command')
          return { widget: c.widget, glyphs: c.placed.run.glyphs.filter(g => g.glyph.contours.length > 0).length,
            size: c.placed.run.sizePx * c.placed.scale }
        })
      }
      renderer.render({ ...list, commands })
    },
  }
}

function valueText(item: SettingsItem): string {
  const value = item.control === 'choice'
    ? `< ${item.value} >  ${item.index! + 1}/${item.count}`
    : item.control === 'capture' ? `[ ${item.value} ]` : item.value
  return value + (item.nextLoad ? ' (next load)' : '')
}

export function settingsWidgetProps(
  page: SettingsPage, items: readonly SettingsItem[], focused: string | null, backTo: 'start' | 'pause'
): Record<string, WidgetProps> {
  const props: Record<string, WidgetProps> = {}
  for (const p of SETTINGS_PAGES) {
    props[`card-${p}`] = { visible: p === page }
    props[`tab-mark-${p}`] = { visible: p === page, value: 1 }
  }
  for (let i = 0; i < SETTINGS_ROW_SLOTS; i++) {
    const item = items[i]
    if (item === undefined) {
      for (const kind of ['row', 'value', 'slider', 'switch', 'keycap']) props[`${kind}-${i}`] = { visible: false }
      continue
    }
    props[`row-${i}`] = { text: item.label.replace(/ to defaults$/, ''), visible: true, disabled: item.disabled !== undefined }
    props[`value-${i}`] = { text: valueText(item), visible: true }
    props[`slider-${i}`] = { visible: item.control === 'slider', value: item.fraction ?? 0 }
    props[`switch-${i}`] = { visible: item.control === 'toggle', value: item.fraction ?? 0 }
    props[`switch-on-${i}`] = { visible: item.fraction === 1 }
    props[`switch-off-${i}`] = { visible: item.fraction !== 1 }
    props[`keycap-${i}`] = { visible: item.control === 'capture' }
  }

  let help = ''
  const row = focused?.match(/^row-(\d+)$/)
  const item = row && Number(row[1]) < SETTINGS_ROW_SLOTS ? items[Number(row[1])] : undefined
  if (item !== undefined) {
    help = item.disabled ? `${item.label}: ${item.disabled}`
      : item.help + (item.nextLoad ? ' Applies when the next scene loads.' : '')
  } else if (focused?.startsWith('tab-')) {
    help = 'Left/Right: switch page'
  } else if (focused === 'back') {
    help = backTo === 'start' ? 'Back to the start screen' : 'Back to the pause menu'
  } else if (focused === 'act-credits') {
    help = 'Who made Royal Fiesta'
  }
  props.help = { text: help }
  return props
}
