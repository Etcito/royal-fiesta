import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { numParam, vec3Param } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

export const rollingLogEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const from = vec3Param(spec, path, 'from')
  const to = vec3Param(spec, path, 'to')
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (!(distance > 1e-6)) {
    refuse('feature', `${path}/to`, 'expected to to differ from from; move the log ends apart')
  }
  if (!(Math.sqrt(dx * dx + dz * dz) > 1e-9)) {
    refuse('feature', `${path}/to`, 'expected a horizontal travel direction; keep from and to at the same height')
  }
  const radius = numParam(spec, path, 'radius', 0.2, 3)
  const length = numParam(spec, path, 'length', 0.5, 30)
  const speed = numParam(spec, path, 'speed', 0.5, 20)
  const periodS = numParam(spec, path, 'periodS', 0.5, 120)
  const phaseS = numParam(spec, path, 'phaseS', 0, Infinity, 0)
  if (periodS * speed < 2 * distance) {
    refuse('feature', `${path}/periodS`, `periodS ${periodS} s at ${speed} m/s is shorter than the ${2 * distance} m round trip; raise periodS or speed`)
  }
  const visual = visualOf('candy.spinner-bar', { x: radius * 2, y: length, z: radius * 2 })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 4, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_rolling_log: {
          from: [from.x, from.y, from.z], to: [to.x, to.y, to.z], radius, length, speed,
          period_s: periodS, phase_s: phaseS,
        },
        'ege.transform': { pos: [from.x, from.y, from.z], rot: [0, 0, 0, 1] },
        'ege.render': { shape: visual.shape, color: visual.color, visible: 1, params: [radius, length / 2, 0, 0] },
      },
      body: { type: 'kinematic_position' },
      colliders: [{ shape: 'cylinder', radius, half_height: length / 2, group: 'moving' }],
    },
    children: [],
  }
}
