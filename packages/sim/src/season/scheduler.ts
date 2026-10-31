import type { Rng } from '@gamesaloon/rollback'
import { refuse } from '../refusal.ts'
import type { FinalRule, RoundKind, StageId } from './kinds.ts'
import type { RoundSlot } from './plan.ts'
import { seedOrder } from './qualify.ts'

export const NO_BACK_TO_BACK: readonly [string, string][] = [['H', 'I'], ['D', 'G']]

export interface SchedMap {
  id: string
  course: number
  kind: RoundKind
  finalRule: FinalRule | null
  stages: readonly StageId[]
  team: boolean
  cut: boolean
}

export interface ShowSchedule {
  finalMap: string | null
  used: string[]
  lastKind: RoundKind | null
  previous: string | null
  rngState: number
}

export function newSchedule(maps: readonly SchedMap[], rng: Rng): ShowSchedule {
  const finals = maps.filter(map => map.finalRule !== null && map.stages.includes('final'))
  const finalMap = finals.length === 0 ? null : finals[rng.int(0, finals.length - 1)].id
  return { finalMap, used: [], lastKind: null, previous: null, rngState: rng.state }
}

export function candidates(
  maps: readonly SchedMap[], slot: RoundSlot, s: ShowSchedule, rng: Rng, k = 3,
): string[] {
  // Cut is a slot stage, not a StageId: E/P retain their ordinary stages.
  const pool = maps.filter(map =>
    (slot.stage === 'cut' ? map.cut : map.stages.includes(slot.stage)) &&
    (slot.final ? map.id === s.finalMap : map.id !== s.finalMap) &&
    (!map.team || slot.teamAllowed) &&
    !NO_BACK_TO_BACK.some(([before, after]) => before === s.previous && after === map.id),
  )
  const unused = pool.filter(map => !s.used.includes(map.id))
  let eligible = unused.filter(map => map.kind !== s.lastKind)
  if (eligible.length === 0) eligible = unused
  if (eligible.length === 0) eligible = pool
  if (eligible.length === 0) {
    refuse('scheduler', slot.stage, `no eligible map for stage ${slot.stage}; build or load a map of that stage`)
  }

  // Fisher-Yates shuffles a fresh pool, leaving the caller's roster untouched.
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[eligible[i], eligible[j]] = [eligible[j], eligible[i]]
  }
  s.rngState = rng.state
  const count = slot.final || slot.stage === 'cut' || slot.playoff ? 1 : k
  return eligible.slice(0, count).map(map => map.id)
}

export function resolveVote(
  cands: readonly string[], votes: readonly number[], seed: number, roundIndex: number,
): string {
  if (cands.length === 0) refuse('scheduler', 'vote', 'provide at least one candidate before resolving a vote')
  const counts = new Array<number>(cands.length).fill(0)
  for (const choice of votes) {
    if (Number.isInteger(choice) && choice >= 0 && choice < cands.length) counts[choice]++
  }
  let winner = 0
  for (let i = 1; i < cands.length; i++) {
    if (counts[i] > counts[winner] ||
        (counts[i] === counts[winner] && seedOrder(seed, roundIndex, i) < seedOrder(seed, roundIndex, winner))) {
      winner = i
    }
  }
  return cands[winner]
}

export function commitMap(s: ShowSchedule, map: SchedMap): ShowSchedule {
  return { ...s, used: [...s.used, map.id], lastKind: map.kind, previous: map.id }
}
