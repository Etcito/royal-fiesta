// S14 points per round: every qualified entrant scores by its final rank, the rest score nothing.
export function roundPoints(rank: number, entrants: number, qualified: boolean): number {
  return qualified ? entrants - rank + 1 : 0
}
