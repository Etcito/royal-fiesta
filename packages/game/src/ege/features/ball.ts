import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { numParam, vec3Param } from '@royal-fiesta/sim/features/params'
import { G } from '@royal-fiesta/sim/groups'
import type { FeatureEmitter } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt } from '../featureEmitters.ts'

// no handoff: Emit carry items and their persistent records takes nothing from this card.
// no handoff: Run pushed balls, goals and resets takes nothing from this card.
export const ballEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const point = vec3Param(spec, path, 'spawn')
  const spawn = [point.x, point.y, point.z]
  const radius = numParam(spec, path, 'radius', 0.3, 3)
  const mass = numParam(spec, path, 'mass', 0.1, 500)
  const resetS = numParam(spec, path, 'resetS', 1, 120)
  return {
    root: {
      name: `feature/${spec.id}`,
      body: { type: 'dynamic', ccd: true },
      colliders: [{ shape: 'sphere', radius, density: 0, group: 'moving' }],
      components: {
        feature: { kind: FEATURE_KIND_RANK.ball, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_ball: { spawn, radius, mass, reset_s: resetS, pending: -1, anchor_tick: 0, anchor: spawn, placed: 0 },
        'ege.transform': { pos: spawn, rot: [0, 0, 0, 1] },
        'ege.render': { shape: 0 },
        'ege.body_props': {
          lock_rotations: 0, additional_mass: mass, friction_combine: 0,
          groups_override: 1, memberships: G.MOVING, filter: G.STATIC | G.MOVING | G.CHAR | G.DEBRIS,
          colliders_enabled: 1,
        },
      },
    },
    children: [],
  }
}
