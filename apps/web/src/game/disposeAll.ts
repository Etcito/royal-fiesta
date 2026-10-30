// Cleanup that never hides the real failure. A wasm-bindgen engine whose call was cut short by a JS exception
// (a WebGPU validation error thrown through a Rust frame) stays mutably borrowed, so its next call, even
// engine.dispose(), throws "recursive use of an object detected which would lead to unsafe aliasing in rust".
// A finally block that disposed the ports and let that second error escape replaced the first one, which
// is the only one that names the cause. Every step runs; when the body already failed their errors are logged
// (console.error is recorded by the GPU page prelude) and the body error propagates; otherwise the first one is thrown.
export function disposeAll(steps: readonly (() => void)[], bodyFailed: boolean): void {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      step()
    } catch (e) {
      errors.push(e)
      console.error(`cleanup step failed${bodyFailed ? ' after the op failed' : ''}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (errors.length > 0 && !bodyFailed) throw errors[0]
}
