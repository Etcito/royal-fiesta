import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { numParam, vec3Param } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter, RawEntity } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, tintColor, visualOf } from '../featureEmitters.ts'

// Source: packages/sim/src/features/tails.ts (tailSetFeature). The root carries the authored count,
// spawn pile and immunity seconds, and starts assigned 0 with an empty free pool; the tail_set script
// runs the half-count arithmetic and the first-round assignment from the feature RNG salt. Each of the
// eight seats is a bodyless child with an empty feature_tail_set_seat record and an initially hidden
// floor-disc visual (the source draw), so no holder is ever chosen in TypeScript. Child names are
// feature/<spec.id>/seat/<i> with the zero-based decimal seat index, e.g. feature/tails-demo/seat/0.
// These are entity names, not filesystem paths.
const SEATS = 8
const DISC_ASSET = 'candy.floor-disc'
const DISC_FULL_SIZE = { x: 0.5, y: 0.12, z: 0.5 }
const DISC_TINT = 4
const ORIGIN_ROT: [number, number, number, number] = [0, 0, 0, 1]

// no handoff: Emit carry items and their persistent records takes nothing from this card.
// no handoff: Run tail assignment, steals and possession takes nothing callable from this card; it reads
// the feature_tail_set and feature_tail_set_seat records this card declares.
export const tailSetEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const count = tailCount(spec, path)
  const spawn = vec3Param(spec, path, 'spawn')
  const immunityS = numParam(spec, path, 'immunityS', 0, 30)
  const spawnArray: [number, number, number] = [spawn.x, spawn.y, spawn.z]
  const disc = visualOf(DISC_ASSET, DISC_FULL_SIZE)
  const children: RawEntity[] = []
  for (let seat = 0; seat < SEATS; seat++) {
    children.push({
      name: `feature/${spec.id}/seat/${seat}`,
      components: {
        feature_tail_set_seat: { owner: ctx.index, seat, has_tail: 0, immune_until: 0, prev_grab: 0 },
        'ege.transform': { pos: spawnArray, rot: ORIGIN_ROT },
        'ege.render': {
          shape: disc.shape, color: tintColor(DISC_TINT, disc.color), visible: 0, params: disc.params,
        },
      },
    })
  }
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.tailSet, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_tail_set: { count, spawn: spawnArray, immunity_s: immunityS, assigned: 0, free_tails: 0 },
        'ege.transform': { pos: spawnArray, rot: ORIGIN_ROT },
      },
    },
    children,
  }
}

// m7-tail-records: -1 stands for the authored 'half'; otherwise only an integer 1..30.
function tailCount(spec: FeatureSpec, path: string): number {
  const value = spec.params.count
  if (value === 'half') return -1
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 30) return value
  return refuse('feature', `${path}/count`,
    "expected count as 'half' or an integer 1..30; write 'half' or a whole number in that range")
}
