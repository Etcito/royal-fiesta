// Every S16 `world` family, in catalog order. Family entry convention (shared with
// movement.ts): the first entries are the BAKE set, one per variant 0..variants-1, in
// order, with `seconds` equal to the patch length (live loops: 3 s). Later entries repeat
// a variant number and are CHECK-ONLY input settings; the sound check renders them, but
// the bake must never bake them.
//
// world.ts carries no falloff of its own: spatial attenuation stays the course `sounds`
// falloff (refM/maxM in the course JSON, read by emitters.ts, S13).
import type { BankEntry } from '@etcito/haa-spatial/bank'
import { SOUNDS } from '../catalog.ts'

export interface FamilyRender { id: string; entries: BankEntry[] }

const PATCH_SECONDS: Readonly<Record<string, number>> = {
  'mech.switch': 0.22,
  'mech.lever': 0.48,
  'mech.door': 0.8,
  'mech.spring': 0.68,
  'mech.hammer': 0.8,
  'mech.seesaw': 0.78,
  'mech.log': 1,
  'mech.tile-warn': 0.56,
  'mech.tile-fall': 0.85,
  'mech.boost': 0.48,
  'mech.launch': 0.65,
  'mech.door-break': 1.05,
  'obj.goal': 1.2,
  'obj.pickup': 0.55,
  'obj.bank': 0.72,
  'obj.capture': 0.95,
  'obj.steal': 0.42,
  'obj.tail': 0.28,
  'obj.crown': 1.1,
}

/** One-shots whose patch publishes the event-strength input `gain` (0..1, default 1). */
const GAIN_ONESHOTS: ReadonlySet<string> = new Set([
  'mech.door', 'mech.spring', 'mech.hammer', 'mech.seesaw', 'mech.log',
])

export const WORLD_FAMILIES: readonly FamilyRender[] = SOUNDS
  .filter(sound => sound.group === 'world')
  .map(sound => {
    const loop = sound.mode === 'loop'
    const seconds = loop ? 3 : PATCH_SECONDS[sound.id]
    const gain = GAIN_ONESHOTS.has(sound.id)
    const bakeInput: Record<string, number> | null = loop ? { rate: 0.6 } : gain ? { gain: 1 } : null
    const entries: BankEntry[] = Array.from({ length: sound.variants }, (_, variant) => ({
      variant, seconds,
      ...(bakeInput === null ? {} : { inputs: bakeInput }),
    }))
    if (loop) {
      entries.push(
        { variant: 0, seconds, inputs: { rate: 0.1 } },
        { variant: 0, seconds, inputs: { rate: 1 } },
      )
    } else if (gain) {
      entries.push({ variant: 0, seconds, inputs: { gain: 0.3 } })
    }
    return { id: sound.id, entries }
  })
