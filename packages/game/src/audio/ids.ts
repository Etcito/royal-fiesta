// Sound ids the game plays. The S16 catalog is the single source of truth, so the game imports
// its lookups from here and never hardcodes an id.
export { SOUNDS, soundDef, stepSoundId, musicId, BED_IDS } from './catalog.ts'
export type { SoundDef, Bus, SoundGroup, SoundBedId } from './catalog.ts'

/** The continuous crowd bed (the one bed id, S16). */
export const CROWD_BED_ID = 'crowd'
