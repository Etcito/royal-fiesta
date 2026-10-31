// Family entry convention: the first entry of each variant is the BAKE set.
// Later entries repeating that variant are CHECK-ONLY settings, never baked.
import type { Arrangement, Instrument } from '@etcito/haa-spatial/arranger'
import type { BankEntry } from '@etcito/haa-spatial/bank'
import { refuse } from '@royal-fiesta/sim/refusal'
import { SOUNDS } from '../catalog.ts'
import type { FamilyRender } from './movement.ts'

export const MUSIC_CUE_IDS: readonly string[] = SOUNDS
  .filter(sound => sound.group === 'music' && sound.id.startsWith('music.'))
  .map(sound => sound.id)

/** Load arrangement and instrument text through the caller's reader only. */
export function loadArrangement(
  id: string,
  readText: (path: string) => string,
): { arrangement: Arrangement; instruments: Instrument[] } {
  if (!MUSIC_CUE_IDS.includes(id)) {
    refuse('audio', 'loadArrangement', `not a music cue id '${id}'`)
  }
  const path = `audio/${id}.arr.json`
  const arrangement = JSON.parse(readText(path)) as Arrangement
  if (arrangement?.id !== id) {
    refuse('audio', path, `arrangement id must equal '${id}'`)
  }
  const instruments: Instrument[] = arrangement.instruments.map(instrument => ({
    ...instrument,
    patch: readText(instrument.patch),
  }))
  return { arrangement, instruments }
}

export const BED_FAMILIES: readonly FamilyRender[] = SOUNDS
  .filter(sound => sound.group === 'music' && (sound.bus === 'ambience' || sound.bus === 'crowd'))
  .map(sound => {
    const entries: BankEntry[] = sound.id === 'crowd'
      ? [0.5, 0.1, 0.95].map(excitement => ({
        variant: 0, seconds: 4, inputs: { excitement },
      }))
      : [{ variant: 0, seconds: 4 }]
    return { id: sound.id, entries }
  })
