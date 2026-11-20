import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { intParam, numParam, vec3Param } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

export const annulusEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const center = vec3Param(spec, path, 'center')
  const innerM = numParam(spec, path, 'innerM', 0, 1000)
  const outerM = numParam(spec, path, 'outerM', 0, 1000)
  if (!(outerM > innerM + 0.5)) {
    refuse('feature', `${path}/outerM`,
      `expected outerM > innerM + 0.5 m (inner ${innerM} m, outer ${outerM} m); widen the ring or shrink the hole`)
  }
  const thickM = numParam(spec, path, 'thickM', 0.05, 10)
  const speedDegS = numParam(spec, path, 'speedDegS', -360, 360)
  const segments = intParam(spec, path, 'segments', 6, 48)
  const origin: [number, number, number] = [center.x, center.y, center.z]
  const visual = visualOf('candy.floor-tile', { x: 2, y: 2, z: 2 })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 11, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_annulus: {
          center: origin, inner_m: innerM, outer_m: outerM, thick_m: thickM,
          speed_deg_s: speedDegS, segments, overtime_ticks: 0, placed: 0,
        },
        'ege.transform': { pos: origin, rot: [0, 0, 0, 1] },
      },
    },
    children: Array.from({ length: segments }, (_, index) => ({
      name: `feature/${spec.id}/segment/${index}`,
      body: { type: 'kinematic_position' },
      colliders: [{ shape: 'box', half_extents: [1, 1, 1], group: 'moving' }],
      components: {
        'ege.transform': { pos: origin, rot: [0, 0, 0, 1] },
        'ege.render': { shape: visual.shape, color: visual.color, visible: 1, params: visual.params },
        'ege.body_props': {
          lock_rotations: 0, additional_mass: 0, friction_combine: 0,
          groups_override: 0, memberships: 0, filter: 0, colliders_enabled: 1,
        },
        'ege.box_collider': { half_extents: [1, 1, 1] },
        feature_annulus_segment: { owner: ctx.index, index },
      },
    })),
  }
}
