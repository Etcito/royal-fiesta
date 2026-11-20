import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { intParam, numParam, vec3Param } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, RawEntity } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, visualOf } from '../featureEmitters.ts'

const MIN_CELLS = 4
const MAX_CELLS = 256
const SEATS = 8

export const memoryTilesEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const origin = vec3Param(spec, path, 'origin')
  const cols = intParam(spec, path, 'cols', 1, MAX_CELLS)
  const rows = intParam(spec, path, 'rows', 1, MAX_CELLS)
  const count = cols * rows
  if (count > MAX_CELLS) {
    refuse('ege-scene', `${path}/cols`,
      'memoryTiles of more than 256 cells has no engine pool in part 1; use at most 256 cells')
  }
  if (count < MIN_CELLS) {
    refuse('feature', `${path}/cols`, `expected cols * rows in ${MIN_CELLS}..${MAX_CELLS}; got ${cols} x ${rows}`)
  }
  const cellM = numParam(spec, path, 'cellM', 0.2, 100)
  const symbols = intParam(spec, path, 'symbols', 2, 6)
  const cycles = intParam(spec, path, 'cycles', 1, 20)
  const revealS = numParam(spec, path, 'revealS', 0, 600)
  const hideS = numParam(spec, path, 'hideS', 0, 600)
  const choiceS = numParam(spec, path, 'choiceS', 0, 600)
  const penaltyS = numParam(spec, path, 'penaltyS', 0, 600, 14)
  const originArray: [number, number, number] = [origin.x, origin.y, origin.z]
  const cellVisual = visualOf('candy.floor-tile', { x: 2, y: 2, z: 2 })
  const markerVisual = visualOf('candy.floor-disc', { x: 2, y: 2, z: 2 })
  const children: RawEntity[] = []
  for (let index = 0; index < count; index++) {
    children.push({
      name: `feature/${spec.id}/cell/${index}`,
      body: { type: 'fixed' },
      colliders: [{ shape: 'box', half_extents: [1, 1, 1], group: 'static' }],
      components: {
        'ege.transform': { pos: originArray, rot: [0, 0, 0, 1] },
        'ege.render': { shape: cellVisual.shape, color: cellVisual.color, visible: 1, params: cellVisual.params },
        'ege.body_props': {
          lock_rotations: 0, additional_mass: 0, friction_combine: 0,
          groups_override: 0, memberships: 0, filter: 0, colliders_enabled: 1,
        },
        'ege.box_collider': { half_extents: [1, 1, 1] },
        feature_memory_tiles_cell: {
          owner: ctx.index, index, t: originArray, half: [1, 1, 1], state: 0, timer: 0, symbol: 0,
          cycle_symbols: Array(16).fill(0), cycle_symbols_tail: Array(4).fill(0),
        },
      },
    })
  }
  for (let index = 0; index < cycles; index++) {
    children.push({
      name: `feature/${spec.id}/cycle/${index}`,
      components: { feature_memory_tiles_cycle: { owner: ctx.index, index, target: 0 } },
    })
  }
  for (let index = 0; index < SEATS; index++) {
    children.push({
      name: `feature/${spec.id}/seat/${index}`,
      components: {
        feature_memory_tiles_seat: { owner: ctx.index, seat: index, first_correct_tick: -1 },
      },
    })
  }
  for (let index = 0; index < count + 1; index++) {
    children.push({
      name: `feature/${spec.id}/marker/${index}`,
      components: {
        'ege.transform': { pos: originArray, rot: [0, 0, 0, 1] },
        'ege.render': {
          shape: markerVisual.shape, color: markerVisual.color, visible: 0, params: markerVisual.params,
        },
        feature_memory_tiles_marker: { owner: ctx.index, index },
      },
    })
  }
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.memoryTiles, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_memory_tiles: {
          origin: originArray, cols, rows, cell_m: cellM, symbols, cycles,
          reveal_s: revealS, hide_s: hideS, choice_s: choiceS, penalty_s: penaltyS,
          target: 0, cycle: -1, phase: 0, choice_start_tick: 0, finalized: 0, placed: 0,
        },
        'ege.transform': { pos: originArray, rot: [0, 0, 0, 1] },
      },
    },
    children,
  }
}
