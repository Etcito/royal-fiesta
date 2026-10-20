// The game's sound controller: plays the Royal Fiesta sounds from match state and keeps the crowd
// bed on while a round runs. It talks to HAA through the small SoundPort below, so the same code
// drives the browser engine (context.ts) and the offline engine in the headless tests.
import { CROWD_BED_ID } from './ids.ts'
import { bedState, copySample, diffSamples, BED_FADE_S, type MatchSample, type SoundEvent, type Vec3 } from './events.ts'

export interface BedPort {
  setParam(name: string, value: number): void
  stop(fadeSec?: number): void
}

/** The subset of HAA's AudioControls the game uses. */
export interface SoundPort {
  play(id: string, o?: { pos?: Vec3 }): unknown
  startBed(id: string): BedPort | null
}

export class GameAudio {
  readonly #port: SoundPort
  #prev: MatchSample | null = null
  #bed: BedPort | null = null

  constructor(port: SoundPort) {
    this.#port = port
  }

  /** Plays the events of this frame and updates the bed. Returns the events it played. */
  observe(sample: MatchSample): SoundEvent[] {
    const events = diffSamples(this.#prev, sample)
    for (const e of events) this.#port.play(e.id, { pos: e.pos })
    const bed = bedState(sample)
    if (bed.on) {
      if (this.#bed === null) this.#bed = this.#port.startBed(CROWD_BED_ID)
      this.#bed?.setParam('excitement', bed.excitement)
    } else if (this.#bed !== null) {
      this.#bed.stop(BED_FADE_S)
      this.#bed = null
    }
    this.#prev = copySample(sample, this.#prev)
    return events
  }

  /** Stops the bed and forgets the last frame (leaving the match, or a new one). */
  stop(): void {
    this.#bed?.stop(BED_FADE_S)
    this.#bed = null
    this.#prev = null
  }
}
