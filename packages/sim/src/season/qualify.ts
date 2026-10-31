import { fnv1a32 } from '@gamesaloon/rollback'
import { PlayerStatus } from '../match/roundSystem.ts'
import { RefusalError as Refusal } from '../refusal.ts'
import type { FinalRule, RoundKind } from './kinds.ts'

export interface SeatRecord {
  seat: number
  status: number
  finishTick: number
  finishSub: number
  lap: number
  stage: number
  routeMm: number
  falls: number
  score: number
  lastScoreTick: number
  holdTicks: number
  possessing: boolean
  lastAcquireTick: number
  matches: number
  crossTicks: number
  outTick: number
  outSub: number
  team: number
  openingRank: number
}

export interface RoundOutcome {
  ranking: number[]
  qualified: number[]
  eliminated: number[]
  playoff: number[] | null
  champion: number
  teamWinner: number
}

export function seedOrder(seed: number, roundIndex: number, seat: number): number {
  const bytes = new Uint8Array(12)
  const words = new DataView(bytes.buffer)
  words.setUint32(0, seed, true)
  words.setUint32(4, roundIndex, true)
  words.setUint32(8, seat, true)
  return fnv1a32(bytes)
}

function living(r: SeatRecord): boolean {
  return r.status === PlayerStatus.alive || r.status === PlayerStatus.qualified
}

function finished(r: SeatRecord): boolean {
  return r.finishTick >= 0
}

function progress(a: SeatRecord, b: SeatRecord): number {
  return b.lap - a.lap || b.stage - a.stage || a.routeMm - b.routeMm || a.falls - b.falls
}

function finishOrder(a: SeatRecord, b: SeatRecord): number {
  return Number(finished(b)) - Number(finished(a)) ||
    (finished(a) ? a.finishTick - b.finishTick || a.finishSub - b.finishSub : progress(a, b))
}

function survivalOrder(a: SeatRecord, b: SeatRecord): number {
  return Number(living(b)) - Number(living(a)) ||
    (living(a) ? 0 : b.outTick - a.outTick || b.outSub - a.outSub)
}

// null remains accepted for non-final maps, as in the season map data and resolveRound.
export function rankRound(
  kind: RoundKind, finalRule: FinalRule | null, records: readonly SeatRecord[],
  seed: number, roundIndex: number, teamScores?: readonly number[],
): number[] | Refusal {
  const seeded = (a: SeatRecord, b: SeatRecord): number =>
    seedOrder(seed, roundIndex, a.seat) - seedOrder(seed, roundIndex, b.seat) || a.seat - b.seat
  let compare: (a: SeatRecord, b: SeatRecord) => number
  switch (kind) {
    case 'race': compare = finishOrder; break
    case 'survival': compare = survivalOrder; break
    case 'collection': compare = (a, b) => b.score - a.score || a.lastScoreTick - b.lastScoreTick; break
    case 'hunt': compare = (a, b) => b.holdTicks - a.holdTicks ||
      Number(b.possessing) - Number(a.possessing) || a.lastAcquireTick - b.lastAcquireTick; break
    case 'logic': compare = (a, b) => b.matches - a.matches || a.crossTicks - b.crossTicks; break
    case 'final':
      if (finalRule === null) return new Refusal('season-rules', 'finalRule', 'a final requires crown or lastStanding')
      compare = finalRule === 'crown' ? finishOrder : survivalOrder
      break
    case 'team': {
      const teams = [...new Set(records.map(r => r.team))]
      if (teamScores === undefined || teamScores.length !== teams.length) {
        return new Refusal('season-rules', 'teamScores', 'provide one score per team, indexed by team index')
      }
      if (teams.some(t => !Number.isInteger(t) || t < 0 || t >= teamScores.length) ||
          teamScores.some(s => !Number.isFinite(s))) {
        return new Refusal('season-rules', 'teamScores', 'use contiguous team indices and finite scores')
      }
      const opening = new Map<number, number>(teams.map(t => [t, 0]))
      for (const r of records) opening.set(r.team, opening.get(r.team)! + r.openingRank)
      // The team index is the seed-order identity for a team tie.
      teams.sort((a, b) => teamScores[b] - teamScores[a] || opening.get(a)! - opening.get(b)! ||
        seedOrder(seed, roundIndex, a) - seedOrder(seed, roundIndex, b) || a - b)
      const places = new Map(teams.map((t, i) => [t, i]))
      compare = (a, b) => places.get(a.team)! - places.get(b.team)! || a.openingRank - b.openingRank
      break
    }
  }
  return [...records].sort((a, b) => compare(a, b) || seeded(a, b)).map(r => r.seat)
}

export function resolveRound(
  kind: RoundKind, finalRule: FinalRule | null, target: number,
  records: readonly SeatRecord[], teamScores: readonly number[], seed: number, roundIndex: number,
): RoundOutcome {
  const ranking = rankRound(kind, finalRule, records, seed, roundIndex, teamScores)
  // Resolution retains its RoundOutcome signature; invalid input uses the throwing convention.
  if (ranking instanceof Refusal) throw ranking
  const bySeat = new Map(records.map(r => [r.seat, r]))
  const ordered = ranking.map(seat => bySeat.get(seat)!)
  let qualified: number[] = []
  let playoff: number[] | null = null
  let champion = -1
  let teamWinner = -1

  // Only a tie crossing the quota boundary needs a replay. Seed order is for
  // presentation here, never for awarding a disputed survival or crown place.
  const takeExits = (batch: SeatRecord[], count: number): void => {
    const take = Math.min(count, batch.length)
    if (take <= 0) return
    const boundary = batch[take - 1]
    const tied = batch.filter(r => r.outTick === boundary.outTick && r.outSub === boundary.outSub)
    if (take < batch.length && batch[take].outTick === boundary.outTick && batch[take].outSub === boundary.outSub) {
      playoff = tied.map(r => r.seat)
      const disputed = new Set(playoff)
      qualified = batch.slice(0, take).filter(r => !disputed.has(r.seat)).map(r => r.seat)
    } else {
      qualified = batch.slice(0, take).map(r => r.seat)
    }
  }

  if (kind === 'team') {
    teamWinner = ordered[0]?.team ?? -1
    qualified = ordered.filter(r => r.team === teamWinner).map(r => r.seat)
  } else if (kind === 'final' && finalRule === 'crown') {
    const first = ordered.find(finished)
    if (first) {
      const tied = ordered.filter(r => r.finishTick === first.finishTick && r.finishSub === first.finishSub)
      if (tied.length > 1) playoff = tied.map(r => r.seat)
      else qualified = [first.seat]
    } else if (ordered.length) {
      // No grab even after overtime: all finalists get another CP1 attempt.
      playoff = ranking.slice()
    }
  } else if (kind === 'survival' || (kind === 'final' && finalRule === 'lastStanding')) {
    const alive = ordered.filter(living)
    if (kind === 'final') {
      if (alive.length === 1) qualified = [alive[0].seat]
      else if (alive.length > 1) playoff = alive.map(r => r.seat)
      else takeExits(ordered, 1)
    } else if (alive.length) {
      // Both underfilled batches and overfilled overtime retain all survivors.
      qualified = alive.map(r => r.seat)
    } else if (ordered.length) {
      // Only the last simultaneous batch can fill places; earlier exits stay out.
      takeExits(ordered.filter(r => r.outTick === ordered[0].outTick), target)
    }
  } else {
    qualified = ranking.slice(0, Math.max(0, target))
  }
  if (kind === 'final' && qualified.length === 1 && playoff === null) champion = qualified[0]
  const retained = new Set([...qualified, ...(playoff ?? [])])
  const eliminated = ranking.filter(seat => !retained.has(seat))
  return { ranking, qualified, eliminated, playoff, champion, teamWinner }
}
