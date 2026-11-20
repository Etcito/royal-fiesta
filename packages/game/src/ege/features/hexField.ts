import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { boolParam, intParam, numParam, vec3Param } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, FeatureEmitContext } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

export const hexFieldEmitter: FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const origin = vec3Param(spec, path, 'origin')
  const layers = intParam(spec, path, 'layers', 1, 4)
  const layerSpacingM = numParam(spec, path, 'layerSpacingM', 0.05, 100)
  const rings = intParam(spec, path, 'rings', 1, 8)
  const cellsPerLayer = 3 * rings * (rings + 1) + 1
  const count = layers * cellsPerLayer
  if (count > 512) {
    refuse('feature', `${path}/rings`, 'expected at most 512 cells; reduce rings or layers')
  }
  const flatM = numParam(spec, path, 'flatM', 0.05, 100, 5.5)
  const pointM = numParam(spec, path, 'pointM', 0.05, 100, 6.4)
  const thickM = numParam(spec, path, 'thickM', 0.05, 100, 0.35)
  const warnS = numParam(spec, path, 'warnS', 0, 600)
  const decayS = numParam(spec, path, 'decayS', 0, 600)
  const scaleWithEntrants = boolParam(spec, path, 'scaleWithEntrants', false)
  const outerHalf = [pointM / 2, thickM / 2, flatM / 2]
  // The source draws a 12 m wide, 1 m thick disc scaled by (pointM / 12, thickM, flatM / 12)
  // (packages/sim/src/features/hexField.ts:76-78), so its drawn radius is pointM / 2. The engine
  // cylinder is round: use flatM / 2, the spacing of neighbouring centres, so discs tile without
  // overlapping. The visual table reads s.x as the radius, so pass it as a radius, not a scale.
  const visual = visualOf('candy.floor-disc', { x: flatM / 2, y: thickM, z: flatM / 2 })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 9, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_hex_field: {
          origin: [origin.x, origin.y, origin.z], layers, layer_spacing_m: layerSpacingM,
          rings, flat_m: flatM, point_m: pointM, thick_m: thickM, warn_s: warnS,
          decay_s: decayS, scale_with_entrants: scaleWithEntrants ? 1 : 0, placed: 0,
        },
        'ege.transform': { pos: [origin.x, origin.y, origin.z], rot: [0, 0, 0, 1] },
      },
    },
    children: Array.from({ length: count }, (_, index) => ({
      name: `feature/${spec.id}/hex/${index}`,
      body: { type: 'fixed' },
      colliders: [{ shape: 'box', half_extents: outerHalf, group: 'static' }],
      components: {
        'ege.transform': { pos: [origin.x, origin.y, origin.z], rot: [0, 0, 0, 1] },
        'ege.render': { shape: visual.shape, color: visual.color, visible: 1, params: visual.params },
        'ege.body_props': {
          lock_rotations: 0, additional_mass: 0, friction_combine: 0,
          groups_override: 0, memberships: 0, filter: 0, colliders_enabled: 1,
        },
        feature_hex_field_hex: { owner: ctx.index, index, t: [origin.x, origin.y, origin.z], state: 0, timer: 0 },
      },
    })),
  }
}
