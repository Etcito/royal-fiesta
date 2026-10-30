// One RAA engine creation at a time per page. Two Engine.create calls in flight in the one wasm-bindgen
// module (zoneLobbyPair mounts two lobbies concurrently) left the second engine's future unresolved after a
// wasm-bindgen "closure invoked recursively or after being dropped" error: that lobby never finished its scene.
import { loadRaa } from '@etcito/raa'
import type { Engine, EngineOptions } from '@etcito/raa'

// Runs each work after the previous one settled; a failed work still releases the next.
export function oneAtATime(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return work => {
    const result = last.then(work)
    last = result.catch(() => {})
    return result
  }
}

const creation = oneAtATime()

export function createRaaEngine(canvas: HTMLCanvasElement, options: EngineOptions): Promise<Engine> {
  return creation(async () => (await loadRaa()).createEngine(canvas, options))
}
