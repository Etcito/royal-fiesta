// AudioWorklet module of the crowd bed. Vite bundles it (`?worker&url` in play/sound.ts), and the
// page loads it with audioWorklet.addModule. The bed is the pack's CrowdModel (CROWD_BED.create),
// rendered 128 frames per quantum; setParam messages {index, value} write the bed's parameter vector.
import { CROWD_PROCESSOR } from '@royal-fiesta/game/audio/ids'
import { CROWD_BED } from '@royal-fiesta/game/audio/pack/crowd'

declare const sampleRate: number
// The AudioWorklet global scope types (not in lib.dom).
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const QUANTUM = 128

class CrowdProcessor extends AudioWorkletProcessor {
  readonly #params = Float32Array.from(CROWD_BED.defaults)
  readonly #voice = CROWD_BED.create(sampleRate, 1)
  readonly #left = new Float32Array(QUANTUM)
  readonly #right = new Float32Array(QUANTUM)

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<{ index: number; value: number }>) => {
      const { index, value } = event.data
      if (Number.isInteger(index) && index >= 0 && index < this.#params.length && Number.isFinite(value)) {
        this.#params[index] = value
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const n = Math.min(QUANTUM, out[0]?.length ?? 0)
    this.#voice.process(this.#params, 0, this.#left, this.#right, n)
    out[0]?.set(this.#left.subarray(0, n))
    out[1]?.set(this.#right.subarray(0, n))
    return true
  }
}

registerProcessor(CROWD_PROCESSOR, CrowdProcessor)
