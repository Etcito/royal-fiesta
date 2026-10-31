import type { ZoneRoundResult } from '../net/zoneRounds.ts'

export interface ResultRow {
  seat: number
  name: string
  rank: number
  points: number
  total: number
  qualified: boolean
}

function pointsOf(r: ZoneRoundResult, seat: number): number {
  const index = r.ranking.indexOf(seat)
  return index < 0 ? 0 : r.points[index] ?? 0
}

export function resultRows(
  r: ZoneRoundResult,
  names: (seat: number) => string,
  earlier: readonly ZoneRoundResult[] = [],
): ResultRow[] {
  const qualified = new Set(r.qualified)
  return r.ranking.map((seat, index) => {
    const points = r.points[index] ?? 0
    let total = points
    for (const previous of earlier) total += pointsOf(previous, seat)
    return {
      seat,
      name: names(seat),
      rank: r.kind === 'team' && qualified.has(seat) ? 1 : index + 1,
      points,
      total,
      qualified: qualified.has(seat),
    }
  })
}
