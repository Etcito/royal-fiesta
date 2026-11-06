import {
  SETTINGS_PAGES, SETTINGS_ROW_SLOTS, type SettingsItem, type SettingsPage
} from '@royal-fiesta/game/screens/settingsPages'
import type { WidgetProps } from './screenMap.ts'

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
      for (const kind of ['row', 'value', 'slider', 'switch']) props[`${kind}-${i}`] = { visible: false }
      continue
    }
    props[`row-${i}`] = { text: item.label, visible: true, disabled: item.disabled !== undefined }
    props[`value-${i}`] = { text: valueText(item), visible: true }
    props[`slider-${i}`] = { visible: item.control === 'slider', value: item.fraction ?? 0 }
    props[`switch-${i}`] = { visible: item.control === 'toggle', value: item.fraction ?? 0 }
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
