import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { boxParam } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, tintColor, visualOf } from '../featureEmitters.ts'

// Source: packages/sim/src/features/bank.ts (bankFeature). A bank has no body and no preStep: its
// postStep is run by scripts/ege/features/bank.as.ts, which creates feature_bank_inside records as
// qualifying debris bodies enter and removes them when they leave. This emitter creates only the
// bodyless root and its wall-block visual, so no inside records exist at world construction.
// The draw is candy.wall-block at full size 2 * half; tint 0 (neutral, base colour) for team null,
// 2 for team 0 and 3 for team 1 (E4 tint table). Child name feature/<spec.id>/visual/0 follows the
// m7-bank-records tree. These are entity names, not filesystem paths.
const BANK_ASSET = 'candy.wall-block'
const TEAM_TINT: readonly number[] = [2, 3]
const ORIGIN_ROT: [number, number, number, number] = [0, 0, 0, 1]

// no handoff: Emit carry items and their persistent records takes nothing callable from this card; our
// modules share ege-features-objective and ege.schema.json only as additive declarations.
// no handoff: Run bank deposits and withdrawals takes nothing from this card; it reads the feature_bank
// and feature_bank_inside records this card declares.
export const bankEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const team = bankTeam(spec, path)
  const box = boxParam(spec, path)
  const center: [number, number, number] = [box.center.x, box.center.y, box.center.z]
  const half: [number, number, number] = [box.half.x, box.half.y, box.half.z]
  const visual = visualOf(BANK_ASSET, { x: half[0] * 2, y: half[1] * 2, z: half[2] * 2 })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.bank, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_bank: { center, half, team },
        'ege.transform': { pos: center, rot: ORIGIN_ROT },
      },
    },
    children: [{
      name: `feature/${spec.id}/visual/0`,
      components: {
        'ege.transform': { pos: center, rot: ORIGIN_ROT },
        'ege.render': {
          shape: visual.shape,
          color: tintColor(team < 0 ? 0 : TEAM_TINT[team], visual.color),
          visible: 1,
          params: visual.params,
        },
      },
    }],
  }
}

// m7-bank-records: team null maps to -1; otherwise only 0 or 1. Anything else is refused at the
// authored feature pointer if it can be resolved from the params key alone.
function bankTeam(spec: FeatureSpec, path: string): number {
  const value = spec.params.team
  if (value === null) return -1
  if (value === 0 || value === 1) return value
  return refuse('feature', `${path}/team`, 'expected team 0, 1 or null; write a team index or null')
}
