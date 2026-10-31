import type { Bus } from '../catalog.ts'

/** Primary bus trims in dB (S16): music -8, sfx 0, ui -4, ambience -14, crowd -12. */
export const BUS_GAIN_DB: Readonly<Record<Bus, number>> = {
  music: -8,
  sfx: 0,
  ui: -4,
  ambience: -14,
  crowd: -12,
}

/** Master limiter ceiling in dBFS (S16). */
export const LIMITER_CEILING_DB = -1

/** Convert a dB value to a linear gain multiplier. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}
