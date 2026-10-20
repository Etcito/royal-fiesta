// The online page's sound: the HAA engine opens on the first user gesture (browsers keep the
// audio context suspended until then), and GameAudio plays the match's sound events and crowd bed.
// The game's audio code only sees SoundPort; the Web Audio objects stay in packages/game/src/audio/context.ts.
import { openBrowserAudio, type BrowserSound } from '@royal-fiesta/game/audio/context'
import { sampleMatch, type MatchSample } from '@royal-fiesta/game/audio/events'
import { GameAudio } from '@royal-fiesta/game/audio/gameAudio'
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'
// Vite bundles the crowd worklet and returns its URL (dev and build alike).
import fiestaWorkletUrl from '../audio/fiestaWorklet.ts?worker&url'

export class SoundDriver {
  #opening: Promise<void> | null = null
  #sound: BrowserSound | null = null
  #game: GameAudio | null = null
  readonly #sample: MatchSample = { phase: 0, roundKind: null, final: false, players: [] }
  readonly #scratch: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }

  constructor() {
    const open = (): void => {
      this.open().catch((error: unknown) => console.warn('[sound] off:', error instanceof Error ? error.message : error))
    }
    window.addEventListener('pointerdown', open, { once: true })
    window.addEventListener('keydown', open, { once: true })
  }

  /** Opens the engine once; later calls return the same promise. */
  open(): Promise<void> {
    this.#opening ??= (async () => {
      const sound = await openBrowserAudio({
        manifestUrl: new URL('audio/manifest.json', document.baseURI).href,
        processorUrl: new URL('audio/haa-processors.js', document.baseURI).href,
        crowdProcessorUrl: fiestaWorkletUrl,
        maxListeners: 1,
      })
      this.#sound = sound
      this.#game = new GameAudio(sound.port)
    })()
    return this.#opening
  }

  /** Once per rendered frame: the match's sound events play; no match stops the bed. */
  frame(sim: MatchSim | null): void {
    if (this.#game === null) return
    if (sim === null) {
      this.#game.stop()
      return
    }
    this.#game.observe(sampleMatch(sim, this.#sample, this.#scratch))
  }

  async close(): Promise<void> {
    this.#game?.stop()
    await this.#sound?.close()
    this.#game = null
    this.#sound = null
  }
}
