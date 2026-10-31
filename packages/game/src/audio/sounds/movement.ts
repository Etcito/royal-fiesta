// Family entry convention: the first entries are the BAKE set, one per variant
// 0..variants-1, in order. Their seconds equal the patch length (live loops: 3 s).
// Later entries repeat a variant number and are CHECK-ONLY input settings; the
// sound check renders them, but the bake must never bake them.
import type { BankEntry } from '@etcito/haa-spatial/bank'
import { SOUNDS } from '../catalog.ts'

export interface FamilyRender { id: string; entries: BankEntry[] }

const PATCH_SECONDS: Readonly<Record<string, number>> = {
  'move.step.candy': 0.22,
  'move.step.ice': 0.24,
  'move.step.jungle': 0.28,
  'move.step.neon': 0.18,
  'move.step.stone': 0.16,
  'move.step.mud': 0.3,
  'move.jump': 0.3,
  'move.land.soft': 0.25,
  'move.land.hard': 0.35,
  'move.dive': 0.5,
  'move.swim': 0.4,
  'move.hit': 0.3,
  'move.stun': 0.6,
  'move.wobble': 0.6,
  'move.grab': 0.25,
  'move.release': 0.2,
  'move.carry': 0.3,
}

export const MOVEMENT_FAMILIES: readonly FamilyRender[] = SOUNDS
  .filter(sound => sound.group === 'movement')
  .map(sound => {
    const seconds = sound.mode === 'loop' ? 3 : PATCH_SECONDS[sound.id]
    const step = sound.id.startsWith('move.step.')
    const slide = sound.id === 'move.slide'
    const entries: BankEntry[] = Array.from({ length: sound.variants }, (_, variant) => ({
      variant, seconds,
      ...(step ? { inputs: { speed: 5 } } : slide ? { inputs: { speed: 6 } } : {}),
    }))
    if (step) {
      entries.push(
        { variant: 0, seconds, inputs: { speed: 1 } },
        { variant: 0, seconds, inputs: { speed: 8 } },
      )
    } else if (slide) {
      entries.push({ variant: 0, seconds, ramps: { speed: [0, 12] } })
    }
    return { id: sound.id, entries }
  })
