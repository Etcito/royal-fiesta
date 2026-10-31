import type { LevelSpec, SpawnPoint } from '../course.ts'
import { refuse } from '../refusal.ts'
import { seedOrder } from './qualify.ts'
import { respawnSlot } from './respawn.ts'

export function splitTeams(seats: readonly number[], seed: number, roundIndex: number): Uint8Array {
  if (seats.length === 0 || seats.length % 2 !== 0) {
    refuse('teams', 'seats', 'provide a nonzero even number of seats')
  }
  const order = seats.map((seat, index) => ({ seat, index, order: seedOrder(seed, roundIndex, seat) }))
  order.sort((a, b) => a.order - b.order || a.seat - b.seat)
  const teams = new Uint8Array(seats.length)
  for (let i = seats.length / 2; i < order.length; i++) teams[order[i].index] = 1
  return teams
}

export function teamTie(
  scores: readonly number[], overtimeLeader: number, openingRankSums: readonly number[],
  seed: number, roundIndex: number,
): number {
  const teams = scores.map((_, team) => team)
  teams.sort((a, b) => scores[b] - scores[a] ||
    Number(b === overtimeLeader) - Number(a === overtimeLeader) ||
    openingRankSums[a] - openingRankSums[b] ||
    seedOrder(seed, roundIndex, a) - seedOrder(seed, roundIndex, b) || a - b)
  return teams[0]
}

export function homeSpawn(level: LevelSpec, team: number, k: number, out: SpawnPoint): SpawnPoint {
  const home = level.homes.find(candidate => candidate.team === team)
  if (!home) refuse('teams', 'homes', `add a home for team ${team}`)
  if (home.respawn.length === 0) refuse('teams', 'homes', `add a respawn point for team ${team}`)
  const n = home.respawn.length
  return respawnSlot(home.respawn[k % n], Math.floor(k / n), level.respawn, out)
}
