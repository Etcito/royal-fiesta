// The client page's sound. The first user gesture opens the audio engine (browsers keep the audio
// context suspended until then). The manifest is read relative to the page. A failure is logged once
// and the game carries on silently. This module is pure logic: the engine opener, the fetch and the
// console are passed in, so the wiring is testable headless (apps/web/test/clientSound.test.ts).
import type { BrowserSound } from '@royal-fiesta/game/audio/context'
import { newMatchSample, sampleMatch, type MatchSample } from '@royal-fiesta/game/audio/events'
import { GameAudio } from '@royal-fiesta/game/audio/gameAudio'
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'

export interface SoundDeps {
  /** The manifest as an absolute URL (audio/manifest.json relative to the page). */
  manifestUrl: string
  /** Opens the engine on the given absolute manifest URL. Called synchronously inside the gesture. */
  open(manifestUrl: string): Promise<BrowserSound>
  /** Reads the manifest. Called synchronously inside the gesture; rejects when the file is missing. */
  fetchJson(url: string): Promise<unknown>
  warn(message: string): void
}

/** The debug hook the page exposes as window.__rfAudio (read from Chrome with JavaScript). */
export interface RfAudioDebug {
  /** The engine's audio context state, or 'none' before the first gesture or after a failure. */
  readonly state: string
  /** True once the manifest has been read and parsed. */
  readonly loaded: boolean
  /** Number of sound families listed by the manifest. */
  readonly familiesLoaded: number
}

type Phase = 'idle' | 'opening' | 'on' | 'off'

// Gestures that open the engine: a pointer press covers mouse and touch, a key press covers the keyboard.
const GESTURES = ['pointerdown', 'keydown'] as const

export class ClientSound {
  readonly #deps: SoundDeps
  #phase: Phase = 'idle'
  #opening: Promise<void> | null = null
  #sound: BrowserSound | null = null
  #game: GameAudio | null = null
  #loaded = false
  #families = 0
  readonly #sample: MatchSample = newMatchSample()
  readonly #scratch: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }

  constructor(deps: SoundDeps) {
    this.#deps = deps
  }

  /** Listens for the first gesture on target. Opening is idempotent: later gestures do nothing. */
  arm(target: EventTarget): void {
    const stop = new AbortController()
    const onGesture = (): void => {
      stop.abort()
      void this.open()
    }
    for (const type of GESTURES) target.addEventListener(type, onGesture, { signal: stop.signal })
  }

  /** Opens the engine once; later calls return the same promise. Never rejects. */
  open(): Promise<void> {
    this.#opening ??= this.#start()
    return this.#opening
  }

  async #start(): Promise<void> {
    this.#phase = 'opening'
    // Both calls start inside the gesture; neither is awaited before the other begins.
    const [m, e] = await Promise.allSettled([
      this.#deps.fetchJson(this.#deps.manifestUrl),
      this.#deps.open(this.#deps.manifestUrl),
    ])
    const engine: BrowserSound | null = e.status === 'fulfilled' ? e.value : null
    try {
      if (m.status === 'rejected') throw m.reason
      if (e.status === 'rejected') throw e.reason
      const families = familiesOf(m.value)
      this.#loaded = true
      this.#families = families
      this.#sound = e.value
      this.#game = new GameAudio(e.value.port)
      this.#phase = 'on'
    } catch (error) {
      // A half-loaded engine is closed, so nothing plays and no context is left running.
      if (engine !== null) await closeQuietly(engine)
      this.#phase = 'off'
      this.#deps.warn(`sound is off: ${messageOf(error)}`)
    }
  }

  /** Once per rendered frame: the match's sound events play; no match (or no engine) stops the bed. */
  frame(sim: MatchSim | null): void {
    if (this.#game === null) return
    if (sim === null) {
      this.#game.stop()
      return
    }
    this.#game.observe(sampleMatch(sim, this.#sample, this.#scratch))
  }

  get state(): string {
    return this.#sound?.audio.ctx.state ?? 'none'
  }

  get loaded(): boolean {
    return this.#loaded
  }

  get familiesLoaded(): number {
    return this.#families
  }

  /** Sets window.__rfAudio = { state, loaded, familiesLoaded } as live getters. */
  expose(target: object): void {
    const self = this
    const debug: RfAudioDebug = {
      get state() { return self.state },
      get loaded() { return self.loaded },
      get familiesLoaded() { return self.familiesLoaded },
    }
    Object.defineProperty(target, '__rfAudio', { value: debug, configurable: true })
  }

  /** The current phase, for tests. */
  get phase(): Phase {
    return this.#phase
  }
}

// The manifest's family list: a bake without it cannot play, so it counts as a failed load.
function familiesOf(json: unknown): number {
  const families = (json as { families?: unknown } | null)?.families
  if (!Array.isArray(families)) throw new Error('audio manifest has no families list')
  return families.length
}

async function closeQuietly(sound: BrowserSound): Promise<void> {
  try {
    await sound.close()
  } catch {
    // Closing a half-open engine is best effort.
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
