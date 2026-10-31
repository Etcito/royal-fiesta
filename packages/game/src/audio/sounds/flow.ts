// Family entry convention: the first entries are the BAKE set, one per variant
// 0..variants-1, in order. Their seconds equal the patch length. Flow patches
// publish no inputs, so no later entry repeats a variant number: there are no
// check-only settings here.
import type { BankEntry } from '@etcito/haa-spatial/bank'
import { SOUNDS } from '../catalog.ts'
import type { FamilyRender } from './movement.ts'

const PATCH_SECONDS: Readonly<Record<string, number>> = {
  'ui.click': 0.12,
  'ui.hover': 0.06,
  'ui.back': 0.22,
  'ui.error': 0.28,
  'ui.buy': 0.32,
  'ui.ticket': 0.27,
  'ui.inbox': 0.3,
  'flow.vote-tick': 0.09,
  'flow.vote-confirm': 0.25,
  'flow.count-tick': 0.16,
  'flow.count-go': 0.8,
  'flow.round-start': 1.2,
  'flow.qualify': 1,
  'flow.eliminate': 1.2,
  'flow.elim-drop': 0.4,
  'flow.win': 2.5,
  'flow.crown-gold': 2,
  'flow.crown-silver': 1.75,
  'flow.crown-bronze': 1.5,
}

export const FLOW_FAMILIES: readonly FamilyRender[] = SOUNDS
  .filter(sound => sound.group === 'flow')
  .map(sound => {
    const entries: BankEntry[] = Array.from({ length: sound.variants }, (_, variant) => ({
      variant, seconds: PATCH_SECONDS[sound.id],
    }))
    return { id: sound.id, entries }
  })
