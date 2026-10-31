// Sound ids the game plays. The S16 catalog is the single source of truth, so the game imports
// its lookups from here and never hardcodes an id.
export { SOUNDS, soundDef, stepSoundId, musicId, BED_IDS } from './catalog.ts'
export type { SoundDef, Bus, SoundGroup, SoundBedId } from './catalog.ts'

/** The continuous crowd bed (the one bed id, S16). */
export const CROWD_BED_ID = 'crowd'

// legacy: removed by the cleanup card
// The v0.1 pack ids. context.ts, fiestaWorklet.ts and the old tools still import them; the M2
// redesign replaces those call sites with the catalog and the baked manifest.
export const FIESTA_SOUNDS = {
  jump: 'fiesta.jump',
  dive: 'fiesta.dive',
  grab: 'fiesta.grab',
  eliminate: 'fiesta.eliminate',
  wobble: 'fiesta.wobble',
} as const

export type FiestaSoundId = typeof FIESTA_SOUNDS[keyof typeof FIESTA_SOUNDS]

/** legacy: removed by the cleanup card */
export const FIESTA_MIX_ID = 'fiesta'

/** legacy: removed by the cleanup card */
export const CROWD_PROCESSOR = 'fiesta-crowd'
