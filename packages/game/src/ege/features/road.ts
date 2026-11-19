import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { roadMesh, validateRoad } from '@royal-fiesta/sim/road'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, FeatureEmitContext } from '../featureEmitters.ts'
import { featureSalt } from '../featureEmitters.ts'

/** No handoff: Marker kind: emitter, post script, schema and the two race test files takes nothing from this card. */
export const roadEmitter: FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  let road
  try {
    road = validateRoad(spec.params)
    roadMesh(road)
  } catch (error) {
    refuse('feature', path, String(error))
  }
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 21, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_road: { width: road.width, surface: road.surface === 'ice' ? 1 : 0 },
        'ege.transform': { pos: road.path[0].p, rot: [0, 0, 0, 1] },
      },
    },
    children: [],
  }
}
