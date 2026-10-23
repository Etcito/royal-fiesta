import { emptyControls, type RawControls } from '../client/inputMap.ts'
import { RefusalError, refuse } from '@royal-fiesta/sim/refusal'

export const SETTINGS_KEY = 'royal-fiesta.settings'

export const KEY_ACTIONS = ['forward', 'back', 'left', 'right', 'jump', 'dive', 'grab'] as const
export type KeyAction = typeof KEY_ACTIONS[number]
export type Quality = 'low' | 'medium' | 'high'

export interface Settings {
  keys: Record<KeyAction, string>
  volume: number
  quality: Quality
  mouseSensitivity: number
  stickSensitivity: number
  invertY: boolean
}

export interface SettingsStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_SETTINGS: Settings = {
  keys: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', dive: 'ShiftLeft', grab: 'KeyE' },
  volume: 80,
  quality: 'high',
  mouseSensitivity: 5,
  stickSensitivity: 5,
  invertY: false
}

export type SettingsRow = { kind: 'volume' } | { kind: 'quality' } | { kind: 'mouseSensitivity' | 'stickSensitivity' | 'invertY' } | { kind: 'key'; action: KeyAction } | { kind: 'reset' }

export const SETTINGS_ROWS: readonly SettingsRow[] = [
  { kind: 'volume' },
  { kind: 'quality' },
  { kind: 'mouseSensitivity' },
  { kind: 'stickSensitivity' },
  { kind: 'invertY' },
  ...KEY_ACTIONS.map(action => ({ kind: 'key' as const, action })),
  { kind: 'reset' }
]

function copy(settings: Settings): Settings {
  return { ...settings, keys: { ...settings.keys } }
}

export function parseSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse('settings', 'where#', 'expected a settings object; provide keys, volume, and quality')
  }
  const data = value as Record<string, unknown>
  if (!Object.hasOwn(data, 'keys')) refuse('settings', 'where#/keys', 'missing field; provide all key bindings')
  if (!Object.hasOwn(data, 'volume')) refuse('settings', 'where#/volume', 'missing field; set a volume from 0 to 100')
  if (!Object.hasOwn(data, 'quality')) refuse('settings', 'where#/quality', 'missing field; choose low, medium, or high')
  const rawKeys = data.keys
  if (typeof rawKeys !== 'object' || rawKeys === null || Array.isArray(rawKeys)) {
    refuse('settings', 'where#/keys', 'expected key bindings; provide a code for every action')
  }
  const keys = {} as Record<KeyAction, string>
  const seen = new Map<string, KeyAction>()
  for (const action of KEY_ACTIONS) {
    if (!Object.hasOwn(rawKeys, action)) refuse('settings', `where#/keys/${action}`, 'missing field; provide a key code')
    const code = (rawKeys as Record<string, unknown>)[action]
    if (typeof code !== 'string') refuse('settings', `where#/keys/${action}`, 'key code must be a string; choose a keyboard code')
    const other = seen.get(code)
    if (other) refuse('settings', `where#/keys/${action}`, `key code is already assigned to ${other}; pick another key`)
    seen.set(code, action)
    keys[action] = code
  }
  if (!Number.isInteger(data.volume) || (data.volume as number) < 0 || (data.volume as number) > 100) {
    refuse('settings', 'where#/volume', 'volume must be an integer from 0 to 100; choose a value in that range')
  }
  if (data.quality !== 'low' && data.quality !== 'medium' && data.quality !== 'high') {
    refuse('settings', 'where#/quality', 'unknown quality; choose low, medium, or high')
  }
  // Saves written before these fields existed use defaults for absent fields.
  const mouseSensitivity = Object.hasOwn(data, 'mouseSensitivity') ? data.mouseSensitivity : DEFAULT_SETTINGS.mouseSensitivity
  const stickSensitivity = Object.hasOwn(data, 'stickSensitivity') ? data.stickSensitivity : DEFAULT_SETTINGS.stickSensitivity
  const invertY = Object.hasOwn(data, 'invertY') ? data.invertY : DEFAULT_SETTINGS.invertY
  for (const [field, value] of [['mouseSensitivity', mouseSensitivity], ['stickSensitivity', stickSensitivity]] as const) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
      refuse('settings', `where#/${field}`, 'must be an integer from 1 to 10; choose a value in that range')
    }
  }
  if (typeof invertY !== 'boolean') refuse('settings', 'where#/invertY', 'must be a boolean; choose true or false')
  return { keys, volume: data.volume as number, quality: data.quality,
    mouseSensitivity: mouseSensitivity as number, stickSensitivity: stickSensitivity as number, invertY }
}

export function loadSettings(store: SettingsStore): { settings: Settings; error: string | null } {
  const saved = store.getItem(SETTINGS_KEY)
  if (saved === null) return { settings: copy(DEFAULT_SETTINGS), error: null }
  try {
    return { settings: parseSettings(JSON.parse(saved)), error: null }
  } catch (error) {
    const message = error instanceof RefusalError
      ? error.message
      : `[settings] where#: invalid JSON; replace the saved settings`
    return { settings: copy(DEFAULT_SETTINGS), error: message }
  }
}

export function saveSettings(store: SettingsStore, settings: Settings): void {
  store.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function adjust(settings: Settings, row: SettingsRow, dir: number): Settings {
  if (row.kind === 'reset') return copy(DEFAULT_SETTINGS)
  const next = copy(settings)
  if (row.kind === 'volume') next.volume = Math.max(0, Math.min(100, next.volume + Math.sign(dir) * 10))
  if (row.kind === 'mouseSensitivity' || row.kind === 'stickSensitivity') {
    next[row.kind] = Math.max(1, Math.min(10, next[row.kind] + Math.sign(dir)))
  }
  if (row.kind === 'invertY') next.invertY = !next.invertY
  if (row.kind === 'quality') {
    const qualities: readonly Quality[] = ['low', 'medium', 'high']
    const index = qualities.indexOf(next.quality)
    next.quality = qualities[(index + (dir < 0 ? 2 : 1)) % qualities.length]
  }
  return next
}

export function rebind(settings: Settings, action: KeyAction, code: string): Settings {
  if (code === 'Escape' || code === 'Enter' || /^Digit[1-4]$/.test(code)) {
    refuse('settings', `where#/keys/${action}`, `${code} is reserved for menus and emotes; pick another key`)
  }
  const other = KEY_ACTIONS.find(candidate => candidate !== action && settings.keys[candidate] === code)
  if (other) refuse('settings', `where#/keys/${action}`, `${code} is already assigned to ${other}; pick another key`)
  const next = copy(settings)
  next.keys[action] = code
  return next
}

export function renderScale(quality: Quality): number {
  return quality === 'low' ? 0.5 : quality === 'medium' ? 0.75 : 1
}

export function controlsFromKeys(held: ReadonlySet<string>, settings: Settings): RawControls {
  const controls = emptyControls()
  const alternate = (code: string, action: KeyAction): boolean =>
    held.has(code) && !KEY_ACTIONS.some(other => other !== action && settings.keys[other] === code)
  controls.forward = held.has(settings.keys.forward) || held.has('ArrowUp') || alternate('KeyZ', 'forward')
  controls.back = held.has(settings.keys.back) || held.has('ArrowDown')
  controls.left = held.has(settings.keys.left) || held.has('ArrowLeft') || alternate('KeyQ', 'left')
  controls.right = held.has(settings.keys.right) || held.has('ArrowRight')
  controls.jump = held.has(settings.keys.jump)
  controls.dive = held.has(settings.keys.dive)
  controls.grab = held.has(settings.keys.grab)
  return controls
}

export function describeRow(row: SettingsRow, settings: Settings): string {
  if (row.kind === 'volume') return `Volume ${settings.volume}%`
  if (row.kind === 'quality') return `Quality ${settings.quality}`
  if (row.kind === 'mouseSensitivity') return `Mouse sensitivity ${settings.mouseSensitivity}`
  if (row.kind === 'stickSensitivity') return `Stick sensitivity ${settings.stickSensitivity}`
  if (row.kind === 'invertY') return `Invert Y ${settings.invertY ? 'on' : 'off'}`
  if (row.kind === 'key') return `${row.action[0].toUpperCase()}${row.action.slice(1)}: ${settings.keys[row.action]}`
  return 'Reset to defaults'
}
