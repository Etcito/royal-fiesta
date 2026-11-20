import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, FeatureEmitContext } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

export const markerEmitter: FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const t = markerPosition(spec, path)
  const radiusM = markerRadius(spec, path)
  const visual = visualOf('candy.floor-disc', { x: radiusM, y: 0.1, z: radiusM })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 0, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_marker: { t: [t.x, t.y, t.z], radius_m: radiusM, touches: 0, last_touch_tick: -1 },
        'ege.transform': { pos: [t.x, t.y, t.z], rot: [0, 0, 0, 1] },
        'ege.render': { shape: visual.shape, color: visual.color, visible: 1, params: visual.params },
      },
    },
    children: [],
  }
}

function markerPosition(spec: FeatureSpec, path: string) {
  const value = spec.params.t
  if (!Array.isArray(value) || value.length !== 3) {
    refuse('feature', `${path}/t`, 'expected t as [x,y,z] in metres; write a three-number position')
  }
  const x = value[0]
  const y = value[1]
  const z = value[2]
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' ||
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    refuse('feature', `${path}/t`, 'expected finite t numbers; replace NaN or Infinity with metre coordinates')
  }
  return { x, y, z }
}

function markerRadius(spec: FeatureSpec, path: string): number {
  const value = spec.params.radiusM ?? 1
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 10) {
    refuse('feature', `${path}/radiusM`, 'expected radiusM in 0.1..10 m; omit it for 1 or write a number in that range')
  }
  return value
}
