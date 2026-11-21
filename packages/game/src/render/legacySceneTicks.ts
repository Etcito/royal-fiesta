// Legacy stepped-simulation observation, kept out of SceneView's read path.
// A MatchSim steps several times before one frame; the presentation wants every tick, so the first
// SceneView attached to a sim wraps its step once and shares the observer set through a WeakMap.
// Only a typed MatchSim is accepted here: an arbitrary SceneReadView (EngineSceneSim, SeatSceneSim,
// a display adapter) may carry its own step method and must never get it wrapped.
import type { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import type { SceneReadView } from './sceneReadView.ts'

export type StepObserver = (view: SceneReadView) => void

const stepObservers = new WeakMap<MatchSim, Set<StepObserver>>()

/** Observes every step of `sim` from now on; returns the detach function. Repeated attaches share one wrap. */
export function attachLegacySceneTicks(sim: MatchSim, observe: StepObserver): () => void {
  let observers = stepObservers.get(sim)
  if (observers === undefined) {
    const set = new Set<StepObserver>()
    const step = sim.step.bind(sim)
    sim.step = inputs => {
      step(inputs)
      for (const o of set) o(sim)
    }
    stepObservers.set(sim, set)
    observers = set
  }
  observers.add(observe)
  return () => { observers.delete(observe) }
}
