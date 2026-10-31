import type { Bus } from '../catalog.ts'

/** Per-bus volume settings, each in 0..1. */
export interface BusVolumes {
  music: number
  sfx: number
  ui: number
  ambience: number
  crowd: number
}

/** LocalStorage key of the persisted audio settings (the contract key). */
export const AUDIO_SETTINGS_KEY = 'royal-fiesta.audio'

const DEFAULT_VOLUME = 0.8

export const DEFAULT_BUS_VOLUMES: BusVolumes = {
  music: DEFAULT_VOLUME,
  sfx: DEFAULT_VOLUME,
  ui: DEFAULT_VOLUME,
  ambience: DEFAULT_VOLUME,
  crowd: DEFAULT_VOLUME,
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Parse persisted bus volumes: finite numbers clamp to 0..1, everything else keeps the default. */
export function parseBusVolumes(v: unknown): BusVolumes {
  const parsed: BusVolumes = { ...DEFAULT_BUS_VOLUMES }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return parsed
  const record = v as Record<string, unknown>
  for (const bus of Object.keys(parsed) as Bus[]) {
    const value = record[bus]
    if (typeof value === 'number' && Number.isFinite(value)) parsed[bus] = clamp01(value)
  }
  return parsed
}
