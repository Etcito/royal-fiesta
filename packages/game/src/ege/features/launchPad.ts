import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { boolParam, boxParam, numParam, vec3Param } from '@royal-fiesta/sim/features/params'
import type { FeatureEmitter, FeatureEmitContext, RawEntity } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

// no handoff: Marker kind: emitter, post script, schema and the two race test files takes nothing from this card.
export const launchPadEmitter: FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const box = boxParam(spec, path)
  const target = vec3Param(spec, path, 'target')
  const apexM = numParam(spec, path, 'apexM', 0.5, 40)
  const recoverOnly = boolParam(spec, path, 'recoverOnly', false)
  const center = [box.center.x, box.center.y, box.center.z]
  const half = [box.half.x, box.half.y, box.half.z]
  const visual = visualOf('candy.mech-spring-pad', box.half)
  const children: RawEntity[] = [{
    name: `feature/${spec.id}/visual/0`,
    components: {
      'ege.transform': { pos: center, rot: [0, 0, 0, 1] },
      'ege.render': { shape: visual.shape, color: visual.color, visible: 1, params: [box.half.x, box.half.y, 0, 0] },
    },
  }]
  for (let seat = 0; seat < 8; seat++) {
    children.push({
      name: `feature/${spec.id}/seat/${seat}`,
      components: {
        feature_launch_pad_seat: {
          owner: ctx.index, seat, inside: 0, launched: -1, flight: 0,
          last_fall: -1, prev_protected: 0, alive: 1,
        },
      },
    })
  }
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 2, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_launch_pad: {
          center, half, target: [target.x, target.y, target.z], apex_m: apexM,
          recover_only: recoverOnly ? 1 : 0, pad_stage: -1, placed: 0,
        },
        'ege.transform': { pos: center, rot: [0, 0, 0, 1] },
      },
    },
    children,
  }
}
