import type { StageId } from './kinds.ts'

// S14 show plans: each entry is the nominal head count entering that round.
export const DEFAULT_PLAN: readonly number[] = [60, 40, 24, 12, 6, 1]
export const LONG_PLAN: readonly number[] = [60, 48, 36, 24, 12, 6, 1]

export const FINAL_MIN = 2
export const FINAL_MAX = 12
export const CUT_TARGET = 12

const DEFAULT_STAGES: readonly StageId[] = ['R1', 'R2', 'R3', 'R4', 'final']
const LONG_STAGES: readonly StageId[] = ['R1', 'R1', 'R2', 'R3', 'R4', 'final']

export function nextTarget(n: number, currentNominal: number, nextNominal: number): number {
  return Math.max(1, Math.min(n - 1, Math.ceil((n * nextNominal) / currentNominal)))
}

export interface ShowCursor {
  readonly plan: readonly number[]
  readonly step: number
  readonly alive: number
  readonly teamRounds: number
  readonly roundIndex: number
}

export interface RoundSlot {
  readonly stage: StageId | 'cut'
  readonly final: boolean
  readonly target: number
  readonly teamAllowed: boolean
  readonly playoff: boolean
}

export function newCursor(plan: readonly number[], alive: number): ShowCursor {
  return { plan, step: 0, alive, teamRounds: 0, roundIndex: 0 }
}

export function stageOf(plan: readonly number[], step: number): StageId {
  const stages = plan.length === LONG_PLAN.length ? LONG_STAGES : DEFAULT_STAGES
  return stages[Math.min(Math.max(step, 0), stages.length - 1)]
}

export function nextSlot(c: ShowCursor): RoundSlot | null {
  if (c.alive <= 1) return null
  const currentNominal = c.plan[c.step] ?? 1
  const nextNominal = c.plan[c.step + 1] ?? 1
  const target = nextTarget(c.alive, currentNominal, nextNominal)
  const wouldBeFinal = nextNominal === 1 || target < 2
  if (wouldBeFinal) {
    if (c.alive > FINAL_MAX) return { stage: 'cut', final: false, target: CUT_TARGET, teamAllowed: false, playoff: false }
    return { stage: 'final', final: true, target: 1, teamAllowed: false, playoff: false }
  }
  const teamAllowed = c.alive % 2 === 0 && target === c.alive / 2 && c.teamRounds < 1
  return { stage: stageOf(c.plan, c.step), final: false, target, teamAllowed, playoff: false }
}

export function advanceCursor(c: ShowCursor, slot: RoundSlot, qualified: number, wasTeam: boolean): ShowCursor {
  const stay = slot.playoff || slot.stage === 'cut'
  return {
    plan: c.plan,
    step: stay ? c.step : c.step + 1,
    alive: qualified,
    teamRounds: c.teamRounds + (wasTeam ? 1 : 0),
    roundIndex: c.roundIndex + 1,
  }
}
