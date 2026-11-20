import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { numParam, objOf, vec3Of } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, RawEntity } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, visualOf } from '../featureEmitters.ts'

// Source: packages/sim/src/features/risingKill.ts constructor and draw. The emitter copies the
// parameters and clock.t; the kill height, tier clock and visual sizes are computed by the scripts.
export const risingKillEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const startY = numParam(spec, path, 'startY', -Infinity, Infinity)
  const endY = numParam(spec, path, 'endY', -Infinity, Infinity)
  if (!(endY > startY)) {
    refuse('feature', `${path}/endY`, `expected endY > startY (${startY}); raise endY above the start height`)
  }
  const startS = numParam(spec, path, 'startS', 0, Infinity)
  const riseMps = numParam(spec, path, 'riseMps', 0.01, 5)
  const clock = objOf(spec.params.clock, `${path}/clock`)
  const center = vec3Of(clock.t, `${path}/clock/t`)
  const halfM = numParam(spec, path, 'halfM', 0.1, Infinity, 30)
  const origin = [center.x, center.y, center.z]
  const plane = visualOf('candy.floor-tile', { x: halfM, y: 1, z: halfM })
  const ring = visualOf('candy.floor-disc', { x: 1, y: 0.1, z: 1 })
  const children: RawEntity[] = [
    {
      name: `feature/${spec.id}/visual/0`,
      components: {
        'ege.transform': { pos: [center.x, startY, center.z], rot: [0, 0, 0, 1] },
        'ege.render': { shape: plane.shape, color: plane.color, visible: 1, params: plane.params },
        feature_rising_kill_visual: { owner: ctx.index, index: 0 },
      },
    },
    {
      name: `feature/${spec.id}/visual/1`,
      components: {
        'ege.transform': { pos: origin, rot: [0, 0, 0, 1] },
        'ege.render': { shape: ring.shape, color: ring.color, visible: 1, params: ring.params },
        feature_rising_kill_visual: { owner: ctx.index, index: 1 },
      },
    },
  ]
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.risingKill, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_rising_kill: {
          start_y: startY, end_y: endY, start_s: startS, rise_mps: riseMps, clock: origin, half_m: halfM,
          overtime_ticks: 0, kill_y: startY, left_s: 0, fraction: 1, rising: 0, placed: 0,
        },
        'ege.transform': { pos: origin, rot: [0, 0, 0, 1] },
      },
    },
    children,
  }
}
