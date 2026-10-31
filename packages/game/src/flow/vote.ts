// The map vote: a pure model driven by the flow actions (keyboard and gamepad
// share them through flowAction). No DOM and no clock: the caller passes dtMs.
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { Action } from '../screens/nav.ts'

export const VOTE_MS = 5000

export interface VoteCandidate {
  map: string
  name: string
  kind: RoundKind
}

export interface VoteModel {
  candidates: VoteCandidate[]
  focus: number
  chosen: number | null
  msLeft: number
}

export interface VoteStep {
  model: VoteModel
  send: number | null
  sound: string | null
}

// Whole-second boundaries crossed while msLeft stays positive, so 5000 ms
// crossed in 16 ms steps gives exactly four ticks and none at 0.
function ticksCrossed(fromMs: number, toMs: number): number {
  const from = Math.ceil(fromMs / 1000)
  const to = Math.max(1, Math.ceil(toMs / 1000))
  return Math.max(0, from - to)
}

export function voteStep(m: VoteModel, action: Action | null, dtMs: number): VoteStep {
  const n = m.candidates.length
  let focus = m.focus
  let chosen = m.chosen
  let send: number | null = null
  let sound: string | null = null

  if (m.msLeft > 0 && chosen === null && action !== null && n > 0) {
    if (action === 'confirm') {
      chosen = focus
      send = focus
      sound = 'flow.vote-confirm'
    } else if (action === 'left' || action === 'up' || action === 'right' || action === 'down') {
      const dir = action === 'left' || action === 'up' ? -1 : 1
      focus = (focus + dir + n) % n
      sound = 'ui.hover'
    }
  }

  const before = Math.max(0, m.msLeft)
  const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0
  const after = Math.max(0, before - dt)
  if (sound !== 'flow.vote-confirm' && ticksCrossed(before, after) > 0) {
    sound = 'flow.vote-tick'
  }

  return { model: { ...m, focus, chosen, msLeft: after }, send, sound }
}
