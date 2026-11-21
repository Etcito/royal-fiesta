import { createReadyGate } from '../engineRound/ready.ts'

/**
 * Handoff: G7-PAGE: mount the locally controlled simple scene takes the page readiness gate over. Its mount calls
 * createEngineShowReady with the complete asynchronous preparation (script admission, content and mesh preparation,
 * course readiness) and the loading, error and ready UI callback, and uses the returned ready promise as the page
 * readiness boundary. Today it reuses createReadyGate (apps/web/src/engineRound/ready.ts:11 createReadyGate; that
 * Handoff comment covers the shared loading, ready and error sequence) and adds two things: a synchronous throw from
 * the preparation takes the same failed path as a rejection, and the error text names the cause and the repair.
 * The gate passes no runtime handle or external-effect receipt; ready is the only readiness signal. Test mode is
 * presentation-only: engineShowTestMode (apps/web/src/engineShow/testMode.ts) supplies the flag and skipped
 * decorative transitions, and never a gameplay cap, plan or simulated tick. Flows await the named loading, ready and
 * error states instead of fixed sleeps, and a missing expected state is a failure.
 */
export function createEngineShowReady(
  load: () => Promise<void>,
  show: (state: 'loading' | 'ready' | 'error', message?: string) => void,
): { ready: Promise<void> } {
  return createReadyGate(() => startPreparation(load), (state, message) => {
    if (state === 'error') show('error', failureText(message))
    else show(state)
  })
}

// A synchronous throw from the preparation takes the same failed path as a rejection.
function startPreparation(load: () => Promise<void>): Promise<void> {
  try {
    return load()
  } catch (error) {
    return Promise.reject(error)
  }
}

// The page shows the cause and the repair, never a bare error text.
function failureText(detail: string | undefined): string {
  const cause = detail !== undefined && detail.trim() !== '' ? detail.trim() : 'no error message was given'
  return `Engine show could not be prepared: ${cause}. Fix this cause, then reload the page.`
}
