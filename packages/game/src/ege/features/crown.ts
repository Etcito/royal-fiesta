import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { numParam, vec3Param } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, RawEntity } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, visualOf } from '../featureEmitters.ts'

// no handoff: Emit carry items and their persistent records takes nothing from this card.
// no handoff: Run crown grabs and overtime resets takes nothing from this card.
export const crownEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const t = vec3Param(spec, path, 't')
  const grabRangeM = numParam(spec, path, 'grabRangeM', 0.25, 3, 1)
  if (ctx.course.checkpoints.length === 0) refuse('feature', path, 'crown needs CP1; add a checkpoint')
  const pos = [t.x, t.y, t.z]
  const rot = [0, 0, 0, 1]
  const visual = visualOf('candy.tower', { x: 0.25, y: 0.25, z: 0.25 })
  const children: RawEntity[] = []
  for (let seat = 0; seat < 8; seat++) {
    children.push({
      name: `feature/${spec.id}/seat/${seat}`,
      components: { feature_crown_seat: { owner: ctx.index, seat, prev_dist: 0 } },
    })
  }
  children.push({
    name: `feature/${spec.id}/visual/0`,
    components: {
      feature_crown_visual: { owner: ctx.index, index: 0 },
      'ege.transform': { pos, rot },
      'ege.render': { shape: visual.shape, color: visual.color, visible: 1, params: visual.params },
    },
  })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.crown, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_crown: { t: pos, grab_range_m: grabRangeM, taken: 0, next_reset_tick: 0, placed: 0 },
        'ege.transform': { pos, rot },
      },
    },
    children,
  }
}
