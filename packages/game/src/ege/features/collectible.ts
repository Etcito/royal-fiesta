import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { intParam, listParam, numParam, vec3Of } from '@royal-fiesta/sim/features/params'
import type { FeatureEmitter, RawEntity } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, visualOf } from '../featureEmitters.ts'

// Source: packages/sim/src/features/collectibles.ts (collectibleFeature). Each authored spot becomes a
// bodyless visual child at its position. The pickup radius, score and regeneration are not emitted here:
// the collectible script reads these records. The M7 yard brief asks for small spheres, so the visual is
// engine sphere shape 2 with radius half the source draw size (0.6 m, collectibles.ts draw). Its colour is
// the base colour of the source draw asset candy.floor-disc (featureEmitters.ts visual table).
// Regeneration changes the visibility of these same spot children, set by the collectible script.
// Child names are feature/<spec.id>/spot/<i> with the zero-based decimal spot index, e.g.
// feature/collectible-demo/spot/0. These are entity names, not filesystem paths.
const SPOT_ASSET = 'candy.floor-disc'
const SPOT_FULL_SIZE_M = 0.6
const SPOT_RADIUS_M = SPOT_FULL_SIZE_M / 2
const ENGINE_SPHERE = 2
const ORIGIN: [number, number, number] = [0, 0, 0]
const ORIGIN_ROT: [number, number, number, number] = [0, 0, 0, 1]

// no handoff: Emit carry items and their persistent records takes nothing from this card.
// no handoff: Run collectible pickup, scoring and regeneration takes nothing from this card.
export const collectibleEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const spots = listParam(spec, path, 'spots', 1, 64).map((point, index) =>
    vec3Of(point, `${path}/spots/${index}`))
  const value = intParam(spec, path, 'value', 1, 100)
  const regenS = numParam(spec, path, 'regenS', 0.1, 600)
  const color = visualOf(SPOT_ASSET, { x: SPOT_FULL_SIZE_M, y: SPOT_FULL_SIZE_M, z: SPOT_FULL_SIZE_M }).color
  const children: RawEntity[] = spots.map((spot, index) => {
    const t: [number, number, number] = [spot.x, spot.y, spot.z]
    return {
      name: `feature/${spec.id}/spot/${index}`,
      components: {
        feature_collectible_spot: { owner: ctx.index, index, t, ready_tick: 0 },
        'ege.transform': { pos: t, rot: ORIGIN_ROT },
        'ege.render': { shape: ENGINE_SPHERE, color, visible: 1, params: [SPOT_RADIUS_M, 0, 0, 0] },
      },
    }
  })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.collectible, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_collectible: { value, regen_s: regenS },
        'ege.transform': { pos: ORIGIN, rot: ORIGIN_ROT },
      },
    },
    children,
  }
}
