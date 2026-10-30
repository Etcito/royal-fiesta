/// <reference types="vite/client" />
// The online page's sound: the HAA engine opens on the first user gesture (browsers keep the
// audio context suspended until then), GameAudio plays the match's sound events and crowd bed,
// and the course's spatial sounds run on haa 0.2.0 through CourseAudio (play/courseAudio.ts).
// The game's audio code only sees SoundPort; the Web Audio objects stay in
// packages/game/src/audio/context.ts.
import { openBrowserAudio, type BrowserSound } from '@royal-fiesta/game/audio/context'
import { CourseEmitters, type EmitterCommand, type ListenerPose } from '@royal-fiesta/game/audio/emitters'
import { sampleMatch, type MatchSample } from '@royal-fiesta/game/audio/events'
import { GameAudio, type CourseAudio } from '@royal-fiesta/game/audio/gameAudio'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { browserAudioPatches } from '../content/v1Data.ts'
import { createCourseAudio } from './courseAudio.ts'
// Vite bundles the crowd worklet and returns its URL (dev and build alike).
import fiestaWorkletUrl from '../audio/fiestaWorklet.ts?worker&url'
// haa 0.2.0's player bundle and compiled engine. The legacy 0.1.1 worklet the engine bakes next to
// the manifest registers haa-bed/haa-sampler/haa-mix; 0.2.0 registers haa-player (PLAYER_PROCESSOR),
// so both modules can live on the one context opened by openBrowserAudio.
import haaWorkletUrl from '@etcito/haa-spatial/worklet?url'
import haaWasmUrl from '@etcito/haa-spatial/wasm?url'

export class SoundDriver {
  #opening: Promise<void> | null = null
  #sound: BrowserSound | null = null
  #game: GameAudio | null = null
  #courseAudio: CourseAudio | null = null
  #emitters: CourseEmitters | null = null
  #course: ResolvedCourse | null = null
  readonly #commands: EmitterCommand[] = []
  readonly #listener: ListenerPose = { x: 0, y: 0, z: 0, fx: 0, fz: 1 }
  readonly #sample: MatchSample = { phase: 0, roundKind: null, final: false, players: [] }
  readonly #scratch: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }

  constructor() {
    const open = (): void => {
      this.open().catch((error: unknown) => console.warn('[sound] off:', messageOf(error)))
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
      try {
        const [module, patches] = await Promise.all([compileWasm(), browserAudioPatches()])
        this.setCourseAudio(createCourseAudio(sound.ctx, patches, module, haaWorkletUrl, sound.output))
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

  /** Once per rendered frame: the match's sound events play; no match stops the bed. */
  frame(sim: MatchSim | null, listener?: ListenerPose): void {
    if (this.#game === null) return
    if (sim === null) {
      this.#game.stop()
      this.#course = null
      this.#emitters = null
      return
    }
    this.#game.observe(sampleMatch(sim, this.#sample, this.#scratch))
    const course = sim.course()
    if (course !== this.#course) {
      this.#course = course
      this.#emitters = course === null ? null : new CourseEmitters(course)
      this.#emitters?.reset()
    }
    if (this.#courseAudio === null || this.#emitters === null) return
    const n = this.#emitters.frame(sim, sim.tick, this.#commands)
    this.#courseAudio.apply(this.#commands, n)
    this.#courseAudio.setListener(listener ?? this.#listenerOf(sim))
  }

  /** Frees the course audio and stops the game's sounds; the engine stays open until close(). */
  dispose(): void {
    this.setCourseAudio(null)
    this.#game?.stop()
  }

  async close(): Promise<void> {
    this.dispose()
    await this.#sound?.close()
    this.#game = null
    this.#sound = null
  }

  // Player 0 is the local listener by default: its position and horizontal facing.
  #listenerOf(sim: MatchSim): ListenerPose {
    const c = sim.character(0, this.#scratch)
    const l = this.#listener
    l.x = c.pos.x
    l.y = c.pos.y
    l.z = c.pos.z
    l.fx = c.facing.x
    l.fz = c.facing.z
    return l
  }
}

async function compileWasm(): Promise<WebAssembly.Module> {
  const response = await fetch(haaWasmUrl)
  if (!response.ok) throw new Error(`HTTP ${response.status} for the haa wasm`)
  return WebAssembly.compile(await response.arrayBuffer())
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
