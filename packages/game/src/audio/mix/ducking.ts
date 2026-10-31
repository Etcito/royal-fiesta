import type { Bus } from '../catalog.ts'

/** One ducking rule: a trigger predicate, the bus it ducks, and its envelope. */
export interface DuckRule {
  trigger: (id: string) => boolean
  bus: Bus
  depthDb: number
  attackS: number
  releaseS: number
}

const MENU_MUSIC = /^music\.[a-z]+\.(lobby|results|podium)$/

/** S16 ducking: flow stings and count-go duck music; menu music ducks ambience. */
export const DUCK_RULES: readonly DuckRule[] = [
  { trigger: (id) => id.startsWith('flow.'), bus: 'music', depthDb: 10, attackS: 0.05, releaseS: 0.6 },
  { trigger: (id) => MENU_MUSIC.test(id), bus: 'ambience', depthDb: 8, attackS: 0.3, releaseS: 1.0 },
]

interface Envelope {
  startS: number
  fromDb: number
  depthDb: number
  attackS: number
  releaseS: number
}

function envelopeDb(e: Envelope, atS: number): number {
  const dt = atS - e.startS
  if (dt < 0) return 0
  if (dt === 0) return e.fromDb
  if (dt < e.attackS) return e.fromDb + (e.depthDb - e.fromDb) * (dt / e.attackS)
  const released = dt - e.attackS
  if (released >= e.releaseS) return 0
  return e.depthDb * (1 - released / e.releaseS)
}

/**
 * Ducking state per bus. Each trigger starts an attack/release envelope; overlapping
 * triggers take the deepest value, and a re-trigger starts from the current depth so
 * frequent callers hold the duck instead of letting it drain.
 */
export class DuckState {
  private readonly voices = new Map<Bus, Envelope[]>()

  trigger(id: string, atS: number): void {
    for (const rule of DUCK_RULES) {
      if (!rule.trigger(id)) continue
      const current = this.depthDb(rule.bus, atS)
      const voices = (this.voices.get(rule.bus) ?? []).filter((voice) => envelopeDb(voice, atS) > 0)
      voices.push({
        startS: atS,
        fromDb: current,
        depthDb: rule.depthDb,
        attackS: rule.attackS,
        releaseS: rule.releaseS,
      })
      this.voices.set(rule.bus, voices)
    }
  }

  /** The negative duck amount in dB, or 0 when idle. */
  gainDb(bus: Bus, atS: number): number {
    const depth = this.depthDb(bus, atS)
    return depth > 0 ? -depth : 0
  }

  private depthDb(bus: Bus, atS: number): number {
    const voices = this.voices.get(bus)
    if (voices === undefined) return 0
    let depth = 0
    for (const voice of voices) depth = Math.max(depth, envelopeDb(voice, atS))
    return depth
  }
}
