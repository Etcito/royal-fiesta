import { loadRaaAnim, type RaaAnimApi } from '@etcito/raa-anim'

// Platform-specific wasm loading belongs to the package. Keep this visual adapter
// separate from simulation imports and let callers observe loading failures.
export function loadAnimBrick(): Promise<RaaAnimApi> {
  return loadRaaAnim()
}
