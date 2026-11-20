import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { enumParam, listParam, numParam, objOf, vec3Param } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, RawEntity } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, visualOf } from '../featureEmitters.ts'

const PATTERNS = ['laser', 'block', 'bars'] as const

export const sweepEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const center = vec3Param(spec, path, 'center')
  const length = numParam(spec, path, 'lengthM', 0.01, 1000)
  const telegraph = numParam(spec, path, 'telegraphS', 0, 3600)
  enumParam(spec, path, 'pattern', PATTERNS)
  numParam(spec, path, 'heightM', 0.001, 1000)
  numParam(spec, path, 'gapM', 0, 1000)
  let previousS = -1
  let previousTicks = -1
  const phases = listParam(spec, path, 'phases', 1, 16).map((value, index) => {
    const ptr = `${path}/phases/${index}`
    const overrides = objOf(value, ptr)
    const phaseSpec = { ...spec, params: { ...spec.params, ...overrides } }
    const atS = numParam({ ...spec, params: overrides }, ptr, 'atS', 0, 86400)
    const atTicks = atS === 0 ? 0 : Math.max(1, Math.round(atS * 60))
    if ((index === 0 && atS !== 0) || atS <= previousS || atTicks <= previousTicks) {
      refuse('feature', `${ptr}/atS`, 'expected phases starting at 0 s and strictly increasing at 60 Hz; separate phase times by at least one tick')
    }
    previousS = atS
    previousTicks = atTicks
    const pattern = enumParam(phaseSpec, ptr, 'pattern', PATTERNS)
    const height = numParam(phaseSpec, ptr, 'heightM', 0.001, 1000)
    const gap = numParam(phaseSpec, ptr, 'gapM', 0, 1000)
    if (pattern !== 'block' && height > 0.775) {
      refuse('feature', `${ptr}/heightM`, 'expected low bar top <= 0.775 m; lower heightM to keep a jump window')
    }
    if (pattern === 'bars' && height + gap < 2.275) {
      refuse('feature', `${ptr}/gapM`, 'expected heightM + gapM >= 2.275 m; raise gapM to keep the high bar clear')
    }
    if (pattern === 'block' && (gap < 1.5 || gap >= length)) {
      refuse('feature', `${ptr}/gapM`, 'expected a walk-through gap >= 1.5 m and smaller than lengthM; widen the wall or adjust gapM')
    }
    const speedDegS = numParam(phaseSpec, ptr, 'speedDegS', -3600, 3600, pattern === 'block' ? 0 : undefined)
    const speedMps = numParam(phaseSpec, ptr, 'speedMps', 0, 100, pattern === 'block' ? undefined : 0)
    return { at_s: atS, pattern: PATTERNS.indexOf(pattern), height_m: height, gap_m: gap, speed_deg_s: speedDegS, speed_mps: speedMps }
  })
  const partCount = phases.some(phase => phase.pattern !== 0) ? 2 : 1
  const origin = [center.x, center.y, center.z]
  const visual = visualOf('candy.sweeper-bar', { x: 2, y: 2, z: 2 })
  const children: RawEntity[] = phases.map((phase, index) => ({
    name: `feature/${spec.id}/phase/${index}`,
    components: { feature_sweep_phase: { owner: ctx.index, index, ...phase } },
  }))
  for (let index = 0; index < partCount; index++) {
    children.push({
      name: `feature/${spec.id}/part/${index}`,
      body: { type: 'kinematic_position' },
      colliders: [{ shape: 'box', half_extents: [1, 1, 1], group: 'moving' }],
      components: {
        'ege.transform': { pos: origin, rot: [0, 0, 0, 1] },
        'ege.render': { ...visual, visible: 1 },
        'ege.body_props': {
          lock_rotations: 0, additional_mass: 0, friction_combine: 0,
          groups_override: 0, memberships: 0, filter: 0, colliders_enabled: 1,
        },
        'ege.box_collider': { half_extents: [1, 1, 1] },
        feature_sweep_part: { owner: ctx.index, index, half: [1, 1, 1] },
      },
    })
  }
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.sweep, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_sweep: {
          center: origin, length_m: length, telegraph_s: telegraph, phase_count: phases.length,
          part_count: partCount, overtime_ticks: 0, active: 0, effective: 0, live: 0,
          just_live: 0, cos: 1, sin: 0, slide: 0, placed: 0,
        },
        'ege.transform': { pos: origin, rot: [0, 0, 0, 1] },
      },
    },
    children,
  }
}
