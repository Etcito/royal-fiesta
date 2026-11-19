import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { boxParam, enumParam, numParam } from '@royal-fiesta/sim/features/params'
import type { FeatureEmitter, FeatureEmitContext } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

const ELIGIBILITY = ['all', 'trailingTeam'] as const

// Handoff: Engine-round m5 inventory rows and ege-m5 commands uses
// `boostLaneEmitter` through FEATURE_EMITTERS to create each lane root and visual.
export const boostLaneEmitter: FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const box = boxParam(spec, path)
  const yawDeg = numParam(spec, path, 'yawDeg', -180, 180)
  const boost = numParam(spec, path, 'boost', 0, 10)
  const durationS = numParam(spec, path, 'durationS', 0.1, 30)
  const rechargeS = numParam(spec, path, 'rechargeS', 0, 60)
  const eligibility = enumParam(spec, path, 'eligibility', ELIGIBILITY)
  const visual = visualOf('candy.conveyor-belt', {
    x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2,
  })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 1, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_boost_lane: {
          center: [box.center.x, box.center.y, box.center.z],
          half: [box.half.x, box.half.y, box.half.z],
          yaw_deg: yawDeg, boost, duration_s: durationS, recharge_s: rechargeS,
          eligibility: eligibility === 'all' ? 0 : 1, placed: 0,
          boost_until: Array(8).fill(0), ready_at: Array(8).fill(0),
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
