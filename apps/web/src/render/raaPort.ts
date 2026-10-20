import type { RenderPort } from '@royal-fiesta/game/render/port'
import { refuse } from '@royal-fiesta/sim/refusal'
import { raaStatus } from './raaStatus.ts'

// RAA API v0 has no documented web entry yet, so there are no RAA calls here.
export async function createRaaPort(): Promise<RenderPort> {
  const status = await raaStatus()
  if (!status.available) refuse('render', 'raa', status.reason)
  return refuse('render', 'raa', 'RAA API v0 marker present but the port is not implemented; see docs/brick-gaps.md')
}
