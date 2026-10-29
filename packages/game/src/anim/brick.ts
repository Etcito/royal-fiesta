import { loadRaaAnim, type RaaAnimLoaded } from '@etcito/raa-anim'
// raa-anim 0.5.0's loadRaaAnim() facade leaves out the S19 graph and its package exports do not reach it
// (raa docs/api/anim-graph.md); the generated module it initialises exports loadGraph, so the loader adds it.
import { loadGraph } from '../../../../node_modules/@etcito/raa-anim/pkg/raa_anim_js.js'
import type { AnimationGraph } from '../../../../node_modules/@etcito/raa-anim/types/graph.js'

export type { AnimationGraph, AnimationGraphState, GraphStep } from '../../../../node_modules/@etcito/raa-anim/types/graph.js'
export type AnimBrick = RaaAnimLoaded & {
  loadGraph(json: string, rig: ReturnType<RaaAnimLoaded['loadRig']>, clips: ReturnType<RaaAnimLoaded['loadClip']>[]): AnimationGraph
}

// Platform-specific wasm loading belongs to the package. Keep this visual adapter
// separate from simulation imports and let callers observe loading failures.
export async function loadAnimBrick(): Promise<AnimBrick> {
  const api = await loadRaaAnim()
  return Object.freeze({ ...api, loadGraph: loadGraph as unknown as AnimBrick['loadGraph'] })
}
