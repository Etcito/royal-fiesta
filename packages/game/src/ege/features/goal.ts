import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { boxParam } from '@royal-fiesta/sim/features/params'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { FeatureEmitter } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, tintColor, visualOf } from '../featureEmitters.ts'

// Source: packages/sim/src/features/football.ts:243-273 (class Goal). goal.team is the DEFENDING team.
// The goal has no body and no schedule entry: its preStep and postStep are empty. The ball post
// system reads these records to score (scripts/ege/features/ball.as.ts).
// The draw is candy.wall-block at full size 2 * half, tint 2 for team 0 and 3 for team 1 (E4 tint table).
// Child name feature/<spec.id>/visual/0 follows the contract tree of m7-goal-records. These are entity
// names, not filesystem paths.
const GOAL_ASSET = 'candy.wall-block'
const TEAM_TINT: readonly number[] = [2, 3]
const ORIGIN_ROT: [number, number, number, number] = [0, 0, 0, 1]

export const goalEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const team = goalTeam(spec, path)
  const box = boxParam(spec, path)
  const center: [number, number, number] = [box.center.x, box.center.y, box.center.z]
  const half: [number, number, number] = [box.half.x, box.half.y, box.half.z]
  const visual = visualOf(GOAL_ASSET, { x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2 })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.goal, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_goal: { team, center, half },
        'ege.transform': { pos: center, rot: ORIGIN_ROT },
      },
    },
    children: [{
      name: `feature/${spec.id}/visual/0`,
      components: {
        'ege.transform': { pos: center, rot: ORIGIN_ROT },
        'ege.render': {
          shape: visual.shape,
          color: tintColor(TEAM_TINT[team], visual.color),
          visible: 1,
          params: visual.params,
        },
      },
    }],
  }
}

function goalTeam(spec: FeatureSpec, path: string): number {
  const value = spec.params.team
  if (value === 0 || value === 1) return value
  return refuse('feature', `${path}/team`, 'expected team 0 or 1, the defending team; write 0 or 1')
}
