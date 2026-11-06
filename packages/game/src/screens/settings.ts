import { emptyControls, type RawControls } from '../client/inputMap.ts'
import { RefusalError, refuse } from '@royal-fiesta/sim/refusal'
import { BUSES, type Bus } from '../audio/catalog.ts'
import { AUDIO_SETTINGS_KEY, DEFAULT_BUS_VOLUMES, parseBusVolumes, type BusVolumes } from '../audio/mix/volumes.ts'

export const SETTINGS_KEY = 'royal-fiesta.settings'

export const KEY_ACTIONS = ['forward', 'back', 'left', 'right', 'jump', 'dive', 'grab'] as const
export type KeyAction = typeof KEY_ACTIONS[number]

export interface Settings {
  keys: Record<KeyAction, string>
  volume: number
  buses: BusVolumes
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
  buses: { ...DEFAULT_BUS_VOLUMES },
  mouseSensitivity: 5,
  stickSensitivity: 5,
  invertY: false
}

export type ResetScope = 'audio' | 'controls' | 'all'

export type SettingsRow =
  | { kind: 'volume' }
  | { kind: 'bus'; bus: Bus }
  | { kind: 'mouseSensitivity' | 'stickSensitivity' | 'invertY' }
  | { kind: 'key'; action: KeyAction }
  | { kind: 'remap' }
  | { kind: 'reducedMotion' }
  | { kind: 'reset'; scope: ResetScope }

// The page row lists: audio, controls and gameplay. settingsPages builds PAGE_ROWS from these same lists.
export const AUDIO_ROWS: readonly SettingsRow[] = [
  { kind: 'volume' },
  ...BUSES.map(bus => ({ kind: 'bus' as const, bus })),
  { kind: 'reset', scope: 'audio' }
]

export const CONTROLS_ROWS: readonly SettingsRow[] = [
  ...KEY_ACTIONS.map(action => ({ kind: 'key' as const, action })),
  { kind: 'remap' },
  { kind: 'mouseSensitivity' },
  { kind: 'stickSensitivity' },
  { kind: 'invertY' },
  { kind: 'reset', scope: 'controls' }
]

export const GAMEPLAY_ROWS: readonly SettingsRow[] = [
  { kind: 'reducedMotion' },
  { kind: 'reset', scope: 'all' }
]

export const SETTINGS_ROWS: readonly SettingsRow[] = [
  ...AUDIO_ROWS, ...CONTROLS_ROWS, ...GAMEPLAY_ROWS
]

function copy(settings: Settings): Settings {
  return { ...settings, keys: { ...settings.keys }, buses: { ...settings.buses } }
}

export function parseSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse('settings', 'where#', 'expected a settings object; provide keys and volume')
  }
  const data = value as Record<string, unknown>
  if (!Object.hasOwn(data, 'keys')) refuse('settings', 'where#/keys', 'missing field; provide all key bindings')
  if (!Object.hasOwn(data, 'volume')) refuse('settings', 'where#/volume', 'missing field; set a volume from 0 to 100')
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
  // Saves written before these fields existed use defaults for absent fields; an old save's `quality` is ignored.
  const mouseSensitivity = Object.hasOwn(data, 'mouseSensitivity') ? data.mouseSensitivity : DEFAULT_SETTINGS.mouseSensitivity
  const stickSensitivity = Object.hasOwn(data, 'stickSensitivity') ? data.stickSensitivity : DEFAULT_SETTINGS.stickSensitivity
  const invertY = Object.hasOwn(data, 'invertY') ? data.invertY : DEFAULT_SETTINGS.invertY
  for (const [field, value] of [['mouseSensitivity', mouseSensitivity], ['stickSensitivity', stickSensitivity]] as const) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
      refuse('settings', `where#/${field}`, 'must be an integer from 1 to 10; choose a value in that range')
    }
  }
  if (typeof invertY !== 'boolean') refuse('settings', 'where#/invertY', 'must be a boolean; choose true or false')
  return { keys, volume: data.volume as number,
    buses: Object.hasOwn(data, 'buses') ? parseBusVolumes(data.buses) : { ...DEFAULT_BUS_VOLUMES },
    mouseSensitivity: mouseSensitivity as number, stickSensitivity: stickSensitivity as number, invertY }
}

export function loadSettings(store: SettingsStore): { settings: Settings; error: string | null } {
  const saved = store.getItem(SETTINGS_KEY)
  try {
    const settings = saved === null ? copy(DEFAULT_SETTINGS) : parseSettings(JSON.parse(saved))
    const audio = store.getItem(AUDIO_SETTINGS_KEY)
    if (audio !== null) settings.buses = parseBusVolumes(JSON.parse(audio))
    return { settings, error: null }
  } catch (error) {
    const message = error instanceof RefusalError
      ? error.message
      : `[settings] where#: invalid JSON; replace the saved settings`
    return { settings: copy(DEFAULT_SETTINGS), error: message }
  }
}

export function saveSettings(store: SettingsStore, settings: Settings): void {
  store.setItem(SETTINGS_KEY, JSON.stringify(settings))
  store.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings.buses))
}

export function adjust(settings: Settings, row: SettingsRow, dir: number): Settings {
  if (row.kind === 'reset') {
    if (row.scope === 'all') return copy(DEFAULT_SETTINGS)
    const next = copy(settings)
    if (row.scope === 'audio') {
      next.volume = DEFAULT_SETTINGS.volume
      next.buses = { ...DEFAULT_SETTINGS.buses }
    } else {
      next.keys = { ...DEFAULT_SETTINGS.keys }
      next.mouseSensitivity = DEFAULT_SETTINGS.mouseSensitivity
      next.stickSensitivity = DEFAULT_SETTINGS.stickSensitivity
      next.invertY = DEFAULT_SETTINGS.invertY
    }
    return next
  }
  const next = copy(settings)
  if (row.kind === 'volume') next.volume = Math.max(0, Math.min(100, next.volume + Math.sign(dir) * 10))
  if (row.kind === 'bus') {
    next.buses[row.bus] = Math.round(Math.max(0, Math.min(1, next.buses[row.bus] + Math.sign(dir) * 0.1)) * 10) / 10
  }
  if (row.kind === 'mouseSensitivity' || row.kind === 'stickSensitivity') {
    next[row.kind] = Math.max(1, Math.min(10, next[row.kind] + Math.sign(dir)))
  }
  if (row.kind === 'invertY') next.invertY = !next.invertY
  return next
}

// Enter or click on a row: adjust up, wrapping a slider to its minimum past its maximum.
export function cycle(settings: Settings, row: SettingsRow): Settings {
  if (row.kind === 'volume' && settings.volume >= 100) return { ...copy(settings), volume: 0 }
  if (row.kind === 'bus' && settings.buses[row.bus] >= 1) {
    const next = copy(settings)
    next.buses[row.bus] = 0
    return next
  }
  if ((row.kind === 'mouseSensitivity' || row.kind === 'stickSensitivity') && settings[row.kind] >= 10) {
    const next = copy(settings)
    next[row.kind] = 1
    return next
  }
  return adjust(settings, row, 1)
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
  switch (row.kind) {
    case 'volume': return `Volume ${settings.volume}%`
    case 'bus': {
      const labels: Record<Bus, string> = { music: 'Music', sfx: 'SFX', ui: 'UI', ambience: 'Ambience', crowd: 'Crowd' }
      return `${labels[row.bus]} volume ${Math.round(settings.buses[row.bus] * 100)}%`
    }
    case 'mouseSensitivity': return `Mouse sensitivity ${settings.mouseSensitivity}`
    case 'stickSensitivity': return `Stick sensitivity ${settings.stickSensitivity}`
    case 'invertY': return `Invert Y ${settings.invertY ? 'on' : 'off'}`
    case 'key': return `${row.action[0].toUpperCase()}${row.action.slice(1)}: ${settings.keys[row.action]}`
    case 'remap': return 'Controller buttons...'
    case 'reducedMotion': return 'Reduced motion'
    case 'reset':
      if (row.scope === 'audio') return 'Reset audio to defaults'
      if (row.scope === 'controls') return 'Reset controls to defaults'
      return 'Reset all settings to defaults'
  }
}
