import type { Bus } from '../audio/catalog.ts'
import {
  AUDIO_ROWS, CONTROLS_ROWS, GAMEPLAY_ROWS, describeRow,
  type KeyAction, type Settings, type SettingsRow
} from './settings.ts'

export const SETTINGS_PAGES = ['audio', 'graphics', 'controls', 'gameplay'] as const
export type SettingsPage = typeof SETTINGS_PAGES[number]

export const PAGE_TITLES: Record<SettingsPage, string> = {
  audio: 'Audio',
  graphics: 'Graphics',
  controls: 'Controls',
  gameplay: 'Gameplay & Accessibility'
}

export const TAB_LABELS: Record<SettingsPage, string> = {
  audio: 'Audio',
  graphics: 'Graphics',
  controls: 'Controls',
  gameplay: 'Gameplay'
}

export const PAGE_ROWS: Record<'audio' | 'controls' | 'gameplay', readonly SettingsRow[]> = {
  audio: AUDIO_ROWS,
  controls: CONTROLS_ROWS,
  gameplay: GAMEPLAY_ROWS
}

// Row widgets per page in ui/screens.ui-doc.json.
export const SETTINGS_ROW_SLOTS = 14

export interface SettingsItem {
  label: string
  value: string
  control: 'slider' | 'toggle' | 'choice' | 'capture' | 'action'
  fraction?: number
  index?: number
  count?: number
  disabled?: string
  help: string
  nextLoad?: boolean
}

export interface RowContext {
  rebinding: KeyAction | null
  reducedMotion: boolean
}

const BUS_LABELS: Record<Bus, string> = {
  music: 'Music volume',
  sfx: 'SFX volume',
  ui: 'UI volume',
  ambience: 'Ambience volume',
  crowd: 'Crowd volume'
}

const ARROWS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
}

export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (code === 'ShiftLeft') return 'Left Shift'
  if (code === 'ShiftRight') return 'Right Shift'
  if (code === 'ControlLeft') return 'Left Ctrl'
  if (code === 'Space') return 'Space'
  return ARROWS[code] ?? code
}

function capitalised(action: KeyAction): string {
  return `${action[0].toUpperCase()}${action.slice(1)}`
}

export function rowItem(row: SettingsRow, settings: Settings, ctx: RowContext): SettingsItem {
  if (row.kind === 'volume') {
    return {
      label: 'Master volume', value: `${settings.volume}%`, control: 'slider',
      fraction: settings.volume / 100, help: 'Sets the overall game volume.'
    }
  }
  if (row.kind === 'bus') {
    return {
      label: BUS_LABELS[row.bus], value: `${Math.round(settings.buses[row.bus] * 100)}%`, control: 'slider',
      fraction: settings.buses[row.bus], help: `Sets how loud the ${row.bus} sounds are.`
    }
  }
  if (row.kind === 'mouseSensitivity') {
    return {
      label: 'Mouse sensitivity', value: String(settings.mouseSensitivity), control: 'slider',
      fraction: (settings.mouseSensitivity - 1) / 9, help: 'Sets how far the mouse turns the camera.'
    }
  }
  if (row.kind === 'stickSensitivity') {
    return {
      label: 'Stick sensitivity', value: String(settings.stickSensitivity), control: 'slider',
      fraction: (settings.stickSensitivity - 1) / 9, help: 'Sets how far the stick turns the camera.'
    }
  }
  if (row.kind === 'invertY') {
    return {
      label: 'Invert Y', value: settings.invertY ? 'On' : 'Off', control: 'toggle',
      fraction: settings.invertY ? 1 : 0, help: 'Flips the vertical direction of the camera.'
    }
  }
  if (row.kind === 'key') {
    const rebinding = ctx.rebinding === row.action
    return {
      label: capitalised(row.action), value: rebinding ? 'Press a key...' : keyName(settings.keys[row.action]),
      control: 'capture', help: 'Press Enter, then press the new key.'
    }
  }
  if (row.kind === 'remap') {
    return {
      label: 'Controller buttons', value: 'Open', control: 'action',
      help: 'Opens the controller button remapping page.'
    }
  }
  if (row.kind === 'reducedMotion') {
    return {
      label: 'Reduced motion', value: ctx.reducedMotion ? 'On (system)' : 'Off (system)', control: 'toggle',
      fraction: ctx.reducedMotion ? 1 : 0, disabled: 'follows your device reduce-motion setting',
      help: 'Follows your device reduce-motion setting.'
    }
  }
  if (row.kind === 'reset') {
    return {
      label: describeRow(row, settings), value: '', control: 'action',
      help: row.scope === 'audio'
        ? 'Restores the default volume and bus levels.'
        : row.scope === 'controls'
          ? 'Restores the default keys and camera settings.'
          : 'Restores every setting to its default.'
    }
  }
  throw new Error(`unhandled settings row ${row.kind}`)
}

export function pageItems(
  page: 'audio' | 'controls' | 'gameplay', settings: Settings, ctx: RowContext
): SettingsItem[] {
  return PAGE_ROWS[page].map(row => rowItem(row, settings, ctx))
}
