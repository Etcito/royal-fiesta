import { roadMesh, validateRoad } from '../road.ts'
import { refuse } from '../refusal.ts'
import type { FeatureFactory } from './feature.ts'
export const roadFeature: FeatureFactory = (spec, path) => {
  try { roadMesh(validateRoad(spec.params)) } catch (error) { refuse('feature', path, String(error)) }
  // Fixed collider belongs to ObstacleSystem so the character's ordinary Surface path applies.
  return { id: spec.id, kind: 'road', init() {}, preStep() {}, postStep() {}, snapshot() {}, restore() {}, draw() {} }
}
