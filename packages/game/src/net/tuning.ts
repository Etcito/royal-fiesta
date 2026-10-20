import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'

export const FIESTA_TUNING = Object.freeze({
  tickRate: 60,
  maxSubsteps: 8,
  maxPrediction: 16,
  snapshotRing: 40,
  minDelay: 2,
  maxDelay: 2,
  delayHiddenTicks: 6,
  lostAfterMs: 3000,
  dropWaitMs: 1500,
} as const)

export const NET_PLAYERS = 8

export function netSetup(seed: number, humanPeers: number, profile: ProfileName, courses: readonly ResolvedCourse[]): MatchSetup {
  if (!Number.isInteger(humanPeers) || humanPeers < 1 || humanPeers > NET_PLAYERS) {
    refuse('net', 'netSetup.humanPeers', `${humanPeers} is outside 1..8; pass the number of human peers (1..8)`)
  }
  const humans: boolean[] = []
  for (let i = 0; i < NET_PLAYERS; i++) humans.push(i < humanPeers)
  return { seed, playerCount: NET_PLAYERS, humans, profile, courses }
}
