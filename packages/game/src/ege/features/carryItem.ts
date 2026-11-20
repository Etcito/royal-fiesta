import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { boxParam, listParam, numParam, objOf, stringParam, vec3Of } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, RawEntity } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt } from '../featureEmitters.ts'

// Source: packages/sim/src/features/carry.ts constructor and draw. Spawns become debris ball
// bodies at their authored positions; homes and seats are data records. The carry pre script
// sets each body's additional mass from the source density-one sphere mass before first physics.
// Child names are feature/<spec.id>/item/<i>, feature/<spec.id>/home/<i> and
// feature/<spec.id>/seat/<i>: <i> is the zero-based decimal pool index with no file extension, e.g.
// feature/carry-demo/item/0. These are entity names, not filesystem paths.
const ITEM_RADIUS = 0.35
const ITEM_DENSITY = 0
const SEATS = 8
const ORIGIN: [number, number, number] = [0, 0, 0]

const SPHERE = 'sphere'

type Triple = [number, number, number]

const triple = (v: { x: number; y: number; z: number }): Triple => [v.x, v.y, v.z]

// no handoff: Run carry pickup, holding, drop and reset takes nothing callable from this card; it reads the
// feature_carry_item records emitted here.
// no handoff: Emit defending goals and their visual boxes takes nothing from this card.
export const carryItemEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  stringParam(spec, path, 'asset', /^[a-z0-9.-]{1,64}$/)
  const resetS = numParam(spec, path, 'resetS', 0, Number.MAX_SAFE_INTEGER / 60)
  const spawns = listParam(spec, path, 'spawns', 1, 16).map(
    (value, index): Triple => triple(vec3Of(value, `${path}/spawns/${index}`)),
  )
  const homes = listParam(spec, path, 'homes', 0, 4).map((value, index) => {
    const ptr = `${path}/homes/${index}`
    const params = objOf(value, ptr)
    const box = boxParam({ ...spec, params }, ptr)
    const team = params.team
    if (team !== null && team !== 0 && team !== 1) {
      refuse('feature', `${ptr}/team`, 'expected team 0, 1 or null; write a team index or null')
    }
    return { center: triple(box.center), half: triple(box.half), team: team === null ? -1 : team }
  })
  const children: RawEntity[] = []
  for (let index = 0; index < spawns.length; index++) {
    const spawn = spawns[index]
    children.push({
      name: `feature/${spec.id}/item/${index}`,
      body: { type: 'dynamic' },
      colliders: [{ shape: SPHERE, radius: ITEM_RADIUS, density: ITEM_DENSITY, group: 'debris' }],
      components: {
        'ege.transform': { pos: spawn, rot: [0, 0, 0, 1] },
        'ege.body_props': {
          lock_rotations: 0, additional_mass: 0, friction_combine: 0,
          groups_override: 0, memberships: 0, filter: 0, colliders_enabled: 1,
        },
        feature_carry_item_item: {
          owner: ctx.index, index, spawn, holder: -1, last_touch_tick: 0, last_hand: spawn,
        },
      },
    })
  }
  for (let index = 0; index < homes.length; index++) {
    const home = homes[index]
    children.push({
      name: `feature/${spec.id}/home/${index}`,
      components: {
        feature_carry_item_home: {
          owner: ctx.index, index, center: home.center, half: home.half, team: home.team,
        },
      },
    })
  }
  for (let index = 0; index < SEATS; index++) {
    children.push({
      name: `feature/${spec.id}/seat/${index}`,
      components: {
        feature_carry_item_seat: { owner: ctx.index, seat: index, prev_grab: 0 },
      },
    })
  }
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.carryItem, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_carry_item: { reset_s: resetS, placed: 0 },
        'ege.transform': { pos: ORIGIN, rot: [0, 0, 0, 1] },
      },
    },
    children,
  }
}
