import { refuse } from '@royal-fiesta/sim/refusal'

// Presentation-only test mode: the flag is handed to the runtime's config.testMode (its minimum presentation waits)
// and skips decorative transitions on the page. It takes no gameplay input and changes no cap, plan or simulated tick.
export function engineShowTestMode(enabled: boolean): Readonly<{ enabled: boolean; skipDecorativeTransitions: boolean }> {
  if (typeof enabled !== 'boolean') refuse('engine-show', 'testMode', 'must be a boolean; pass true for minimum presentation waits')
  return Object.freeze({ enabled, skipDecorativeTransitions: enabled })
}
