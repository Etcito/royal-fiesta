import { loadRaaAnim, type RaaAnimLoaded } from '@etcito/raa-anim'

export type { AnimationGraph, AnimationGraphState, GraphStep } from '@etcito/raa-anim'
export type AnimBrick = RaaAnimLoaded

// Platform-specific wasm loading belongs to the package. Keep this visual adapter
// separate from simulation imports and let callers observe loading failures.
export async function loadAnimBrick(): Promise<AnimBrick> {
  return loadRaaAnim()
}
