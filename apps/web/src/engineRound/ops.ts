export function registerEngineRoundOps(run: (input: unknown) => Promise<unknown>): void {
  (window as unknown as { nmcGpu: unknown }).nmcGpu = { ops: { engineRound: run }, ready: true }
}
