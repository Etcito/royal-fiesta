import { VOTE_MS, voteStep } from '../../../../packages/game/src/flow/vote.ts'
import type { VoteModel } from '../../../../packages/game/src/flow/vote.ts'
import { COUNTDOWN_MS, countdownAt } from '../../../../packages/game/src/flow/countdown.ts'
import { resultRows } from '../../../../packages/game/src/flow/roundResults.ts'
import { elimShow, elimShowAt, elimSkip } from '../../../../packages/game/src/flow/elimShow.ts'
import type { ElimShowModel } from '../../../../packages/game/src/flow/elimShow.ts'
import { endScreen } from '../../../../packages/game/src/flow/endScreen.ts'
import type { EndScreenModel } from '../../../../packages/game/src/flow/endScreen.ts'
import type { ZoneFullMatch } from '../../../../packages/game/src/net/zoneFullMatch.ts'
import type { Action, GameScreen } from '../../../../packages/game/src/screens/nav.ts'

/** Only the full-match fields the presentation reads; no simulation or world dependency. */
export interface ShowPort extends Pick<ZoneFullMatch, 'candidates' | 'show' | 'done' | 'champion' | 'alive' | 'vote'> {
  readonly round: { readonly plan: { readonly index: number } } | null
}

type Phase = 'vote' | 'load' | 'countdown' | 'round' | 'results' | 'elimShow' | 'podium' | 'end'
export interface ShowFrame {
  screen: GameScreen
  vote: VoteModel | null
  countdown: ReturnType<typeof countdownAt> | null
  results: ReturnType<typeof resultRows> | null
  elimShow: ElimShowModel | null
  endScreen: EndScreenModel | null
  sounds: string[]
  hold: boolean
  finished: boolean
}

/** Call step(action, dtMs) before advancing the match, and respect its hold.
 * Newly observed phases start at zero; dt belongs to the previously displayed phase.
 * worldReady must name the currently loading plan, so stale async loads cannot release it.
 */
export class ShowDirector {
  private readonly port: ShowPort
  private readonly info: (map: string) => Pick<VoteModel['candidates'][number], 'name' | 'kind'>
  private readonly names: (seat: number) => string
  private readonly localSeat: number
  private phase: Phase = 'vote'
  private ms = 0
  private index: number | null = null
  private seenResults = 0
  private offered: readonly string[] | null = null
  private voteModel: VoteModel | null = null
  private rows: ReturnType<typeof resultRows> | null = null
  private elimination: ElimShowModel | null = null
  private endModel: EndScreenModel | null = null
  private label: ReturnType<typeof countdownAt>['label'] = null
  private finished = false

  constructor(port: ShowPort, info: ShowDirector['info'], names: (seat: number) => string, localSeat: number) {
    this.port = port
    this.info = info
    this.names = names
    this.localSeat = localSeat
  }

  worldReady(roundIndex: number): void {
    if (this.phase === 'load' && this.index === roundIndex) this.enter('countdown')
  }

  private enter(phase: Phase): void {
    this.phase = phase
    this.ms = 0
    this.label = null
  }

  private afterRound(): void {
    if (this.port.done) {
      this.endModel = endScreen(this.port.show)
      if (this.port.champion !== null && this.port.champion >= 0) {
        this.endModel = { ...this.endModel, winner: this.port.champion, goldenTicketTo: this.port.champion }
      }
      this.enter('podium')
    } else {
      this.voteModel = null
      this.enter('vote')
    }
  }

  step(action: Action | null, dtMs: number): ShowFrame {
    const sounds: string[] = []
    let dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0
    const presenting = ['results', 'elimShow', 'podium', 'end'].includes(this.phase)
    if (!presenting) {
      const rounds = this.port.show.rounds
      if (rounds.length > this.seenResults) {
        const last = rounds[rounds.length - 1]
        this.seenResults = rounds.length
        this.rows = resultRows(last, this.names, rounds.slice(0, -1))
        this.elimination = last.eliminated.length ? elimShow(last.ranking, last) : null
        this.enter('results')
        if (last.qualified.includes(this.localSeat)) sounds.push('flow.qualify')
        else if (last.eliminated.includes(this.localSeat)) sounds.push('flow.eliminate')
        dt = 0
      } else if (this.port.done) {
        this.afterRound()
        dt = 0
      } else if (this.port.round !== null && this.port.round.plan.index !== this.index) {
        this.index = this.port.round.plan.index
        this.offered = null
        this.voteModel = null
        this.enter('load')
        dt = 0
      } else if (this.phase === 'vote' && this.port.candidates !== null && this.port.candidates !== this.offered) {
        this.offered = this.port.candidates
        this.voteModel = { candidates: this.offered.map(map => ({ map, ...this.info(map) })),
          focus: 0, chosen: null, msLeft: VOTE_MS }
        this.ms = 0
        dt = 0
      }
    }
    this.ms += dt
    if (this.phase === 'vote' && this.voteModel !== null) {
      const next = voteStep(this.voteModel, action, dt)
      this.voteModel = next.model
      if (next.send !== null) this.port.vote(next.send)
      if (next.sound !== null) sounds.push(next.sound)
    } else if (this.phase === 'countdown' && this.ms >= COUNTDOWN_MS) {
      this.enter('round')
      sounds.push('flow.round-start')
    } else if (this.phase === 'results' && (this.ms >= 4000 || (action === 'confirm' && this.ms >= 1500))) {
      if (this.elimination !== null) this.enter('elimShow')
      else this.afterRound()
    } else if (this.phase === 'elimShow' && this.elimination !== null) {
      if (action === 'confirm') this.elimination = elimSkip(this.elimination, this.ms)
      const frame = elimShowAt(this.elimination, this.ms)
      for (const _seat of frame.drops) sounds.push('flow.elim-drop')
      if (frame.done) this.afterRound()
    } else if (this.phase === 'podium' && this.ms >= 2500) {
      this.enter('end')
      sounds.push('flow.win')
    } else if (this.phase === 'end' && this.endModel !== null) {
      if (this.ms >= this.endModel.showWinnerMs && (action === 'confirm' || this.ms >= this.endModel.showWinnerMs + 2000)) {
        this.finished = true
      }
    }
    const countdown = this.phase === 'countdown' ? countdownAt(this.ms) : null
    if (countdown !== null && countdown.label !== this.label) {
      this.label = countdown.label
      if (countdown.sound !== null) sounds.push(countdown.sound)
    }
    const screen: GameScreen = this.phase === 'load' || this.phase === 'countdown' ? 'countdown'
      : this.phase === 'results' ? 'result' : this.phase === 'end' ? 'endScreen'
      : this.phase === 'round' ? (this.port.alive.includes(this.localSeat) ? 'round' : 'spectate') : this.phase
    return {
      screen, vote: this.phase === 'vote' ? this.voteModel : null, countdown,
      results: this.phase === 'results' ? this.rows : null,
      elimShow: this.phase === 'elimShow' ? this.elimination : null,
      endScreen: this.phase === 'end' || this.phase === 'podium' ? this.endModel : null,
      sounds, hold: ['load', 'results', 'elimShow', 'podium', 'end'].includes(this.phase), finished: this.finished,
    }
  }
}
