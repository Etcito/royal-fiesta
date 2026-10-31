// Pose-layer registration (1.13). Layers are view-side pose corrections applied after the graph
// step, one instance per character; they never read frame time.
import type { CharObservation } from './params.ts'
import { ACTION_LAYER } from './actionPoses.ts'
import { WALK_LAYER } from './walkCycle.ts'

export interface PoseLayer {
  readonly name: string
  create(boneNames: readonly string[]): PoseLayerInstance
}

export interface PoseLayerInstance {
  /** Called once per observed sim tick, in layer order. */
  observe(obs: CharObservation): void
  /** `local` is the S17 local TRS array (10 floats per bone: t xyz, r xyzw, s xyz). */
  apply(local: Float32Array, obs: CharObservation): void
  reset(): void
}

export const POSE_LAYERS: readonly PoseLayer[] = [WALK_LAYER, ACTION_LAYER]
