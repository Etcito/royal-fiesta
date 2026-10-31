// The only module of the game that touches the Web Audio API. tools/test/audio-boundary.test.ts
// fails if AudioContext or `new Audio(` appears anywhere else in the sources.
import { createAudio, type HaaAudio } from '@etcito/haa'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { LoopPort, SoundPort } from './gameAudio'
import { CROWD_BED_ID, CROWD_PROCESSOR, FIESTA_MIX_ID } from './ids'
import { CROWD_PARAMS } from './pack/crowdModel'
import { registerRoyalFiesta, ROYAL_FIESTA_FAMILIES } from './pack/index'
import type { Vec3 } from './events'

export interface BrowserAudioOptions {
  /** HAA's bake manifest (audio/manifest.json, written by `npm run audio:bake`), as an absolute URL. */
  manifestUrl: string
  /** HAA's prebuilt worklet bundle (@etcito/haa/worklet, baked next to the manifest). */
  processorUrl: string
  /** The crowd bed worklet module (apps/web/src/audio/fiestaWorklet.ts, bundled), as a URL. */
  crowdProcessorUrl: string
  /** Listener count of the spatial model: 1 for the local player's view. */
  maxListeners?: 1 | 2 | 3 | 4
}

/** The sound of one browser page: the HAA engine plus the game's SoundPort over it. */
export interface BrowserSound {
  readonly audio: HaaAudio
  /** The one context the page's sound lives on (the engine, the crowd bed and the course audio share it). */
  readonly ctx: BaseAudioContext
  /** Where other sound graphs attach: the context destination. */
  readonly output: AudioNode
  readonly port: SoundPort
  close(): Promise<void>
}

// HAA's 'ambience' bus sits at -1 dB in the fiesta mix (mix.ts). The crowd bed skips HAA's bus chain
// (its compressor and ducks), so it takes that level as a plain gain.
const CROWD_GAIN = 10 ** (-1 / 20)
const CROWD_FADE_MARGIN_MS = 50

/**
 * The crowd bed: an AudioWorklet node running the pack's CrowdModel. HAA's prebuilt worklet does not
 * know the game's bed, so the bed is a worklet of its own, connected straight to the output.
 */
class CrowdBed {
  readonly #ctx: BaseAudioContext
  readonly #node: AudioWorkletNode
  readonly #gain: GainNode

  constructor(ctx: BaseAudioContext) {
    this.#ctx = ctx
    this.#node = new AudioWorkletNode(ctx, CROWD_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    this.#gain = ctx.createGain()
    this.#gain.gain.value = CROWD_GAIN
    // The bed is raw (its peaks reach about 3 before HAA's bus compressor), so a limiter stands in for that compressor.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.003
    limiter.release.value = 0.1
    this.#node.connect(this.#gain).connect(limiter).connect(ctx.destination)
  }

  setParam(name: string, value: number): void {
    const index = CROWD_PARAMS.indexOf(name as (typeof CROWD_PARAMS)[number])
    if (index < 0) refuse('audio', 'crowd', `unknown crowd bed parameter ${name}; the bed has ${CROWD_PARAMS.join(', ')}`)
    this.#node.port.postMessage({ index, value })
  }

  stop(fadeSec = 0): void {
    const now = this.#ctx.currentTime
    const g = this.#gain.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0, now + Math.max(0, fadeSec))
    setTimeout(() => {
      this.#node.disconnect()
      this.#gain.disconnect()
    }, Math.max(0, fadeSec) * 1000 + CROWD_FADE_MARGIN_MS)
  }
}

/**
 * Creates the HAA engine on a fresh AudioContext with the Royal Fiesta pack and mix, and the crowd
 * worklet. Call it from a user gesture: browsers start an AudioContext suspended otherwise.
 */
export async function openBrowserAudio(o: BrowserAudioOptions): Promise<BrowserSound> {
  registerRoyalFiesta()
  const ctx = new AudioContext()
  const audio = await createAudio(ctx, {
    manifestUrl: o.manifestUrl,
    processorUrl: o.processorUrl,
    mix: FIESTA_MIX_ID,
    maxListeners: o.maxListeners ?? 1,
    families: ROYAL_FIESTA_FAMILIES.map((family) => family.id),
  })
  await audio.ready()
  await ctx.audioWorklet.addModule(o.crowdProcessorUrl)
  await ctx.resume()
  const port: SoundPort = {
    play: (id: string, options?: { pos?: Vec3; strength?: number }) => audio.play(id, options),
    startLoop: (id: string): LoopPort | null => {
      const bed = id === CROWD_BED_ID ? new CrowdBed(ctx) : audio.startBed(id)
      return bed === null ? null : {
        set: (name, value) => bed.setParam(name, value),
        move: () => {},
        stop: fadeS => bed.stop(fadeS),
      }
    },
    setListeners: () => {},
  }
  return { audio, ctx, output: ctx.destination, port, close: () => audio.close() }
}
