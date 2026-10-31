// Shared play/game sound driver: opens on a gesture and routes cues and course sounds through the mix.
import { openBrowserAudio, setMixFactory, type BrowserSound } from '@royal-fiesta/game/audio/context'
import { CourseEmitters, type EmitterCommand, type ListenerPose } from '@royal-fiesta/game/audio/emitters'
import { newMatchSample, sampleMatch, type MatchSample } from '@royal-fiesta/game/audio/events'
import { GameAudio, type CourseAudio } from '@royal-fiesta/game/audio/gameAudio'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { browserAudioPatches } from '../content/v1Data.ts'
import { createCourseAudio } from './courseAudio.ts'
import { AUDIO_SETTINGS_KEY, parseBusVolumes } from '@royal-fiesta/game/audio/mix/volumes'
import type { SettingsStore } from '@royal-fiesta/game/screens/settings'
import { createMixGraph } from '../audio/mixGraph.ts'

setMixFactory(createMixGraph)

export interface SoundDeps {
  target: EventTarget
  baseUrl: string
  store: SettingsStore
  open: typeof openBrowserAudio
  compileWasm: (url: string) => Promise<WebAssembly.Module>
  patches: typeof browserAudioPatches
}

export class SoundDriver {
  readonly #deps: SoundDeps
  readonly #gestures = new AbortController()
  #lastVolumes: string | null | undefined
  #warnedVolumes = false
  readonly #menuSample = newMatchSample()
  #opening: Promise<void> | null = null
  #sound: BrowserSound | null = null
  #game: GameAudio | null = null
  #courseAudio: CourseAudio | null = null
  #emitters: CourseEmitters | null = null
  #course: ResolvedCourse | null = null
  readonly #commands: EmitterCommand[] = []
  readonly #listener: ListenerPose = { x: 0, y: 0, z: 0, fx: 0, fz: 1 }
  readonly #sample: MatchSample = newMatchSample()
  readonly #scratch: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }

  constructor(deps: Partial<SoundDeps> = {}) {
    this.#deps = {
      target: deps.target ?? window,
      baseUrl: deps.baseUrl ?? document.baseURI,
      store: deps.store ?? localStorage,
      open: deps.open ?? openBrowserAudio,
      compileWasm: deps.compileWasm ?? compileWasm,
      patches: deps.patches ?? browserAudioPatches,
    }
    const open = (): void => {
      this.open().catch((error: unknown) => console.warn('[sound] off:', messageOf(error)))
    }
    for (const type of ['pointerdown', 'keydown']) {
      this.#deps.target.addEventListener(type, open, { signal: this.#gestures.signal })
    }
  }

  /** Opens the engine once; later calls return the same promise. */
  open(): Promise<void> {
    this.#gestures.abort()
    this.#opening ??= (async () => {
      const processorUrl = new URL('audio/haa-processors.js', this.#deps.baseUrl).href
      const sound = await this.#deps.open({
        manifestUrl: new URL('audio/manifest.json', this.#deps.baseUrl).href,
        processorUrl,
        maxListeners: 4,
      })
      this.#sound = sound
      this.#game = new GameAudio(sound.port)
      try {
        const [module, patches] = await Promise.all([
          this.#deps.compileWasm(new URL('audio/haa.wasm', this.#deps.baseUrl).href),
          this.#deps.patches(),
        ])
        this.setCourseAudio(createCourseAudio(sound.ctx, patches, module, processorUrl, sound.mix.input('sfx')))
      } catch (error) {
        // The match sounds still play; the course's spatial sounds stay off.
        console.warn('[sound] course audio off:', messageOf(error))
        this.setCourseAudio(null)
      }
    })()
    return this.#opening
  }

  /** Swaps the course audio; the next frame restarts the course's loops on it. */
  setCourseAudio(audio: CourseAudio | null): void {
    if (this.#courseAudio === audio) return
    this.#courseAudio?.dispose()
    this.#courseAudio = audio
    this.#course = null
    this.#emitters = null
  }

  /** Once per rendered frame: update volumes, local listeners and the current screen's sounds. */
  frame(sim: MatchSim | null, listener?: ListenerPose | readonly ListenerPose[]): void {
    this.#updateVolumes()
    if (this.#game === null) return
    const listeners = this.#listenersOf(sim, listener)
    this.#game.setListeners(listeners)
    this.#courseAudio?.setListeners(listeners)
    if (sim === null) {
      this.#game.observe(this.#menuSample, 'lobby')
      this.#course = null
      this.#emitters = null
      return
    }
    this.#game.observe(sampleMatch(sim, this.#sample, this.#scratch), 'match')
    const course = sim.course()
    if (course !== this.#course) {
      this.#course = course
      this.#emitters = course === null ? null : new CourseEmitters(course)
      this.#emitters?.reset()
    }
    if (this.#courseAudio === null || this.#emitters === null) return
    const n = this.#emitters.frame(sim, sim.tick, this.#commands)
    this.#courseAudio.apply(this.#commands, n)
  }

  /** Frees the course audio and stops the game's sounds; the engine stays open until close(). */
  dispose(): void {
    this.setCourseAudio(null)
    this.#game?.stop()
  }

  async close(): Promise<void> {
    this.#gestures.abort()
    await this.#opening?.catch(() => {})
    this.dispose()
    await this.#sound?.close()
    this.#game = null
    this.#sound = null
  }

  #updateVolumes(): void {
    if (this.#sound === null) return
    try {
      const raw = this.#deps.store.getItem(AUDIO_SETTINGS_KEY)
      if (raw === this.#lastVolumes) return
      this.#lastVolumes = raw
      this.#sound.mix.setVolumes(parseBusVolumes(raw === null ? null : JSON.parse(raw)))
    } catch (error) {
      this.#sound.mix.setVolumes(parseBusVolumes(null))
      if (!this.#warnedVolumes) {
        this.#warnedVolumes = true
        console.warn('[sound] volume settings ignored:', messageOf(error))
      }
    }
  }

  // Both ports accept emitter poses; context/courseAudio own the mix-pose conversion.
  #listenersOf(sim: MatchSim | null, listener?: ListenerPose | readonly ListenerPose[]): readonly ListenerPose[] {
    const supplied = listener === undefined ? [] : Array.isArray(listener)
      ? listener as readonly ListenerPose[] : [listener as ListenerPose]
    if (supplied.length > 0) return supplied.slice(0, 4)
    if (sim === null) return [this.#listener]
    // Player 0 is the local listener by default: position and horizontal facing.
    const c = sim.character(0, this.#scratch)
    const l = this.#listener
    l.x = c.pos.x
    l.y = c.pos.y
    l.z = c.pos.z
    l.fx = c.facing.x
    l.fz = c.facing.z
    return [l]
  }
}

async function compileWasm(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for the haa wasm`)
  return WebAssembly.compile(await response.arrayBuffer())
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
