import { hex8 } from '@gamesaloon/rollback'
import type { ProfileName } from '../course.ts'
import type { RoundReason } from './roundSystem.ts'

export { hex8 }

export interface RoundLogEntry {
  index: number
  kind: 'race' | 'survival'
  final: boolean
  course: string
  startTick: number
  endTick: number
  participants: number[]
  target: number
  qualified: number[]
  eliminated: number[]
  reason: RoundReason
}

export interface MatchLog {
  format: 'royal-fiesta.matchlog'
  version: 0
  seed: number
  profile: ProfileName
  playerCount: number
  humans: boolean[]
  setupHash: string
  rounds: RoundLogEntry[]
  winner: number
  podium: number[]
  finalTick: number
  finalHash: string
}

function roundOrdered(r: RoundLogEntry): RoundLogEntry {
  return {
    index: r.index,
    kind: r.kind,
    final: r.final,
    course: r.course,
    startTick: r.startTick,
    endTick: r.endTick,
    participants: r.participants.slice(),
    target: r.target,
    qualified: r.qualified.slice(),
    eliminated: r.eliminated.slice(),
    reason: r.reason,
  }
}

export function matchLogJson(log: MatchLog): string {
  const ordered: MatchLog = {
    format: log.format,
    version: log.version,
    seed: log.seed,
    profile: log.profile,
    playerCount: log.playerCount,
    humans: log.humans.slice(),
    setupHash: log.setupHash,
    rounds: log.rounds.map(roundOrdered),
    winner: log.winner,
    podium: log.podium.slice(),
    finalTick: log.finalTick,
    finalHash: log.finalHash,
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}
