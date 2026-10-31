// The end screen model: the podium of the final ranking, its crowns and the golden ticket recipient.
// The ticket is only named here; M8/M9 grant it (offline through the economy stub, online by the host).
import type { ShowState, ZoneRoundResult } from '../net/zoneRounds.ts'

export interface EndScreenModel {
  winner: number
  podium: { seat: number; crown: 'gold' | 'silver' | 'bronze' }[]
  goldenTicketTo: number
  showWinnerMs: 4000
}

const CROWNS = ['gold', 'silver', 'bronze'] as const
const SHOW_WINNER_MS = 4000

// The last result flagged final; without one, the last result of the show.
function finalOf(show: ShowState): ZoneRoundResult | null {
  for (let i = show.rounds.length - 1; i >= 0; i--) {
    if (show.rounds[i].final) return show.rounds[i]
  }
  return show.rounds[show.rounds.length - 1] ?? null
}

export function endScreen(show: ShowState): EndScreenModel {
  const final = finalOf(show)
  const seats: number[] = []
  const seen = new Set<number>()
  const add = (seat: number): void => {
    if (seats.length >= 3 || seen.has(seat)) return
    seen.add(seat)
    seats.push(seat)
  }
  if (final !== null) for (const seat of final.ranking) add(seat)
  // A final with fewer than three entrants fills from earlier rankings, latest round first.
  if (seats.length < 3 && final !== null) {
    const at = show.rounds.indexOf(final)
    for (let i = (at < 0 ? show.rounds.length : at) - 1; i >= 0 && seats.length < 3; i--) {
      for (const seat of show.rounds[i].ranking) {
        if (seats.length >= 3) break
        add(seat)
      }
    }
  }
  const podium = seats.map((seat, index) => ({ seat, crown: CROWNS[index] }))
  const winner = final !== null && final.champion >= 0 ? final.champion : podium[0]?.seat ?? -1
  return { winner, podium, goldenTicketTo: winner, showWinnerMs: SHOW_WINNER_MS }
}
