import { RefusalError } from '@royal-fiesta/sim/refusal'

// The public-clone stub of the private MAMA module. tools/bricks.ts is Node-only, so the reason is
// repeated here instead of imported; only the SDF loading path reaches this refusal.
export const MAMA_PRESENT = false

const REASON = 'MAMA not available: MAMA is not resolved in this build (public clone); see docs/bricks.md'

export async function loadMama(): Promise<unknown> {
  throw new RefusalError('sdf', 'MAMA', REASON)
}
