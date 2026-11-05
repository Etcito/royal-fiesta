import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { RELAY_MAX_PLAYERS } from './relayProtocol.ts'
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

export const NET_PLAYERS = 60
/** Classic full-world diagnostics retain MatchSim's eight-seat limit. */
export const CLASSIC_NET_PLAYERS = 8

export function classicNetSetup(seed: number, humanPeers: number, profile: ProfileName, courses: readonly ResolvedCourse[]): MatchSetup {
  if (!Number.isInteger(humanPeers) || humanPeers < 1 || humanPeers > CLASSIC_NET_PLAYERS) {
    refuse('net', 'netSetup.humanPeers', `${humanPeers} is outside 1..8; pass the number of human peers (1..8)`)
  }
  const humans: boolean[] = []
  for (let i = 0; i < CLASSIC_NET_PLAYERS; i++) humans.push(i < humanPeers)
  return { seed, playerCount: CLASSIC_NET_PLAYERS, humans, profile, courses }
}

/** Online lobby seats: the relay counts only humans; domain simulations hold the bot fill. */
export function netSetup(seed: number, humanPeers: number, profile: ProfileName, courses: readonly ResolvedCourse[]): MatchSetup {
  if (!Number.isInteger(humanPeers) || humanPeers < 1 || humanPeers > RELAY_MAX_PLAYERS) {
    refuse('net', 'netSetup.humanPeers', `supply 1..${RELAY_MAX_PLAYERS} relay humans`)
  }
  return { seed, playerCount: NET_PLAYERS, humans: Array.from({ length: NET_PLAYERS }, (_, seat) => seat < humanPeers), profile, courses }
}
