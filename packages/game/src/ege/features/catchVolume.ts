import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { levelOf } from '@royal-fiesta/sim/course'
import { boxParam, intParam } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, FeatureEmitContext } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

export const catchVolumeEmitter: FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const box = boxParam(spec, path)
  const respawnStage = intParam(spec, path, 'respawnStage', 0, 1_000_000)
  const stages = levelOf(ctx.course).route.stages
  const checkpoint = stages.findIndex((stage) => stage === respawnStage)
  if (checkpoint < 0) {
    refuse('feature', `${path}/respawnStage`, `no checkpoint at route stage ${respawnStage}; add a checkpoint of that stage`)
  }
  const visual = visualOf('candy.floor-disc', { x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2 })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 3, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_catch_volume: {
          center: [box.center.x, box.center.y, box.center.z],
          half: [box.half.x, box.half.y, box.half.z],
          respawn_stage: respawnStage, checkpoint, inside: Array(8).fill(0),
        },
        'ege.transform': { pos: [box.center.x, box.center.y, box.center.z], rot: [0, 0, 0, 1] },
      },
    },
    children: [{
      name: `feature/${spec.id}/visual/0`,
      components: {
        'ege.transform': { pos: [box.center.x, box.center.y, box.center.z], rot: [0, 0, 0, 1] },
        'ege.render': { shape: visual.shape, color: visual.color, visible: 0, params: [box.half.x, box.half.y, 0, 0] },
      },
    }],
  }
}
