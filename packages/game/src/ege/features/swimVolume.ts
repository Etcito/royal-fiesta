import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { boxParam, numParam } from '@royal-fiesta/sim/features/params'
import { CHAR } from '@royal-fiesta/sim/character/constants'
import type { FeatureEmitter, FeatureEmitContext } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

export const swimVolumeEmitter: FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const box = boxParam(spec, path)
  const drag = numParam(spec, path, 'drag', 0, 20, CHAR.swim.drag)
  const buoyancy = numParam(spec, path, 'buoyancy', 0, 60, 22)
  const visual = visualOf('candy.slime-pool', {
    x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2,
  })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 6, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_swim_volume: {
          center: [box.center.x, box.center.y, box.center.z],
          half: [box.half.x, box.half.y, box.half.z],
          drag, buoyancy, inside: Array(8).fill(0),
        },
        'ege.transform': { pos: [box.center.x, box.center.y, box.center.z], rot: [0, 0, 0, 1] },
      },
    },
    children: [{
      name: `feature/${spec.id}/visual/0`,
      components: {
        'ege.transform': { pos: [box.center.x, box.center.y, box.center.z], rot: [0, 0, 0, 1] },
        'ege.render': { shape: visual.shape, color: visual.color, visible: 1, params: visual.params },
      },
    }],
  }
}
