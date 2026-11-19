import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { enumParam, listParam, numOf, objOf, ticksParam, vec3Of } from '@royal-fiesta/sim/features/params'
import type { FeatureEmitter, FeatureEmitContext } from '../featureEmitters.ts'
import { featureSalt, visualOf } from '../featureEmitters.ts'

export const tileFieldEmitter: FeatureEmitter = (spec: FeatureSpec, ctx: FeatureEmitContext) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const tiles = listParam(spec, path, 'tiles', 1, 512).map((value, index) => {
    const tilePath = `${path}/tiles/${index}`
    const tile = objOf(value, tilePath)
    const t = vec3Of(tile.t, `${tilePath}/t`)
    const rawSize = vec3Of(tile.size, `${tilePath}/size`)
    const size = [rawSize.x, rawSize.y, rawSize.z].map((n, axis) =>
      numOf(n, `${tilePath}/size/${axis}`, 0.05, 100))
    return {
      t: [t.x, t.y, t.z],
      half: [size[0] / 2, size[2] / 2, size[1] / 2],
    }
  })
  ticksParam(spec, path, 'decayS', 0, 600)
  ticksParam(spec, path, 'warnS', 0, 600)
  const decayS = spec.params.decayS as number
  const warnS = spec.params.warnS as number
  const mode = enumParam(spec, path, 'mode', ['reset', 'permanent'] as const)
  if (mode === 'reset') ticksParam(spec, path, 'resetS', 0, 600)
  const resetS = mode === 'reset' ? spec.params.resetS as number : 0
  const first = tiles[0]
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: 8, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_tile_field: {
          warn_s: warnS, decay_s: decayS, mode: mode === 'reset' ? 0 : 1,
          reset_s: resetS, tile_count: tiles.length,
        },
        'ege.transform': { pos: first.t, rot: [0, 0, 0, 1] },
      },
    },
    children: tiles.map((tile, index) => {
      const [x, y, z] = tile.half
      const visual = visualOf('candy.floor-tile', { x: x * 2, y: z * 2, z: y * 2 })
      return {
        name: `feature/${spec.id}/tile/${index}`,
        body: { type: 'fixed' },
        colliders: [{ shape: 'box', half_extents: tile.half, group: 'static' }],
        components: {
          'ege.transform': { pos: tile.t, rot: [0, 0, 0, 1] },
          'ege.render': { shape: visual.shape, color: visual.color, visible: 1, params: [x, y, z, 0] },
          'ege.body_props': {
            lock_rotations: 0, additional_mass: 0, friction_combine: 0,
            groups_override: 0, memberships: 0, filter: 0, colliders_enabled: 1,
          },
          feature_tile_field_tile: {
            owner: ctx.index, index, t: tile.t, half: tile.half, state: 0, timer: 0,
          },
        },
      }
    }),
  }
}
