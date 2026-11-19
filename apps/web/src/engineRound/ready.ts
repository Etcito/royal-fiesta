function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Handoff: Engine round page: load, scene view, render bridge, composite and live mode calls
 * createReadyGate around its page load and shows loading, ready or error from its callback today.
 * Shows loading at once, ready when every load resolves, and error (with the message) on the
 * first rejection. The returned promise rejects with that same error and never reports ready.
 */
export function createReadyGate(load: () => Promise<void>, show: (state: 'loading' | 'ready' | 'error', message?: string) => void): { ready: Promise<void> } {
  show('loading')
  const ready = load().then(
    () => { show('ready') },
    (error: unknown) => {
      show('error', messageOf(error))
      throw error
    },
  )
  return { ready }
}
