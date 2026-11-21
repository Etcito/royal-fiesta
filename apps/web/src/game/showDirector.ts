import { VOTE_MS, votePick, voteStep } from '../../../../packages/game/src/flow/vote.ts'
import type { VoteModel } from '../../../../packages/game/src/flow/vote.ts'
import { COUNTDOWN_MS, countdownAt } from '../../../../packages/game/src/flow/countdown.ts'
import { resultRows } from '../../../../packages/game/src/flow/roundResults.ts'
import { elimShow, elimShowAt, elimSkip } from '../../../../packages/game/src/flow/elimShow.ts'
import type { ElimShowModel } from '../../../../packages/game/src/flow/elimShow.ts'
import { endScreen } from '../../../../packages/game/src/flow/endScreen.ts'
import type { EndScreenModel } from '../../../../packages/game/src/flow/endScreen.ts'
import type { ZoneRoundResult } from '../../../../packages/game/src/net/zoneRounds.ts'
import type { EngineRoundResult, EngineShowRuntime } from '../../../../packages/game/src/ege/showTypes.ts'
import type { Action, GameScreen } from '../../../../packages/game/src/screens/nav.ts'

export interface ShowPortRound {
  readonly plan: { readonly index: number }
}

/** The read-only show fields the presentation reads; no simulation or world dependency. */
export interface ShowPort {
  readonly candidates: readonly string[] | null
  readonly show: { readonly rounds: readonly ZoneRoundResult[] }
  readonly done: boolean
  readonly champion: number | null
  readonly alive: readonly number[]
  vote(choice: number): void
  readonly round: ShowPortRound | null
}

function sameList(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
  return a !== null && a.length === b.length && a.every((value, i) => value === b[i])
}

function copyResult(result: EngineRoundResult): ZoneRoundResult {
  return {
    index: result.index, map: result.map, course: result.course, kind: result.kind, final: result.final,
    playoff: result.playoff, endTick: result.endTick, reason: result.reason,
    ranking: [...result.ranking], qualified: [...result.qualified], eliminated: [...result.eliminated],
    points: [...result.points], teamScores: [...result.teamScores], champion: result.champion,
  }
}

/** Handoff: Game switch share 4/8: ShowMode presents an engine show - engineShowPort(runtime, localSeat) builds the ShowPort that ShowMode passes to new ShowDirector(port, info, names, localSeat, voteMs, introMs); today it is called only by the tests. It reads runtime.snapshot() on every getter and copies the candidates, rounds and alive lists, keeping each cached reference while its content is unchanged. */
export function engineShowPort(runtime: EngineShowRuntime, localSeat: number): ShowPort {
  let candidates: readonly string[] | null = null
  let alive: readonly number[] = []
  let show: { readonly rounds: readonly ZoneRoundResult[] } = { rounds: [] }
  let round: ShowPortRound | null = null
  return {
    get candidates() {
      const snapshot = runtime.snapshot()
      if (snapshot.screen !== 'vote') return null
      if (!sameList(candidates, snapshot.candidates)) candidates = [...snapshot.candidates]
      return candidates
    },
    get show() {
      const { results } = runtime.snapshot()
      if (results.length !== show.rounds.length) show = { rounds: results.map(copyResult) }
      return show
    },
    get done() {
      return runtime.snapshot().screen === 'done'
    },
    get champion() {
      return runtime.snapshot().champion
    },
    get alive() {
      const snapshot = runtime.snapshot()
      if (!sameList(alive, snapshot.alive)) alive = [...snapshot.alive]
      return alive
    },
    vote(choice: number): void {
      const snapshot = runtime.snapshot()
      if (!Number.isInteger(choice) || choice < 0 || choice >= snapshot.candidates.length) return
      if (snapshot.screen !== 'vote' || !snapshot.seatOf.includes(localSeat)) return
      runtime.vote(localSeat, choice)
    },
    get round() {
      const snapshot = runtime.snapshot()
      if (snapshot.screen === 'vote') return null
      if (round === null || round.plan.index !== snapshot.round) round = { plan: { index: snapshot.round } }
      return round
    },
  }
}

type Phase = 'vote' | 'load' | 'countdown' | 'round' | 'elimShow' | 'podium' | 'end'
export interface ShowFrame {
  screen: GameScreen
  /** Only a selected round awaiting its scene may cover the UI with loading. */
  loading: boolean
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
 * The countdown holds the match until its last introMs: the match's own frozen intro then plays under GO,
 * so the round cannot run (or end) under 3-2-1 and the screen lives its full COUNTDOWN_MS.
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
  private readonly voteMs: number
  private readonly introMs: number
  private readyRound: number | null = null
  private finished = false

  constructor(port: ShowPort, info: ShowDirector['info'], names: (seat: number) => string, localSeat: number, voteMs = VOTE_MS, introMs = 0) {
    this.voteMs = voteMs
    this.introMs = Math.min(COUNTDOWN_MS, Math.max(0, introMs))
    this.port = port
    this.info = info
    this.names = names
    this.localSeat = localSeat
  }

  worldReady(roundIndex: number): void {
    // The next world may finish preparing during the elimination presentation.
    // Retain that readiness until its load phase, while rejecting stale async completions.
    if (this.port.round?.plan.index === roundIndex) this.readyRound = roundIndex
  }

  /** A pointer pick on a vote card: the same single send and cue as a confirm on that card. */
  pick(index: number): string[] {
    if (this.phase !== 'vote' || this.voteModel === null) return []
    const next = votePick(this.voteModel, index)
    this.voteModel = next.model
    if (next.send !== null) this.port.vote(next.send)
    return next.sound === null ? [] : [next.sound]
  }

  /** Pointer hover focuses a candidate (ui.hover); it never votes and never cancels. */
  hover(index: number): string[] {
    if (this.phase !== 'vote' || this.voteModel === null) return []
    const m = this.voteModel
    if (m.chosen !== null || m.msLeft <= 0) return []
    if (!Number.isInteger(index) || index < 0 || index >= m.candidates.length || index === m.focus) return []
    this.voteModel = { ...m, focus: index }
    return ['ui.hover']
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
    if (this.phase === 'load' && this.readyRound === this.index) {
      this.readyRound = null
      this.enter('countdown')
      dt = 0
    }
    const presenting = ['elimShow', 'podium', 'end'].includes(this.phase)
    if (!presenting) {
      const rounds = this.port.show.rounds
      if (rounds.length > this.seenResults) {
        const last = rounds[rounds.length - 1]
        this.seenResults = rounds.length
        this.rows = resultRows(last, this.names, rounds.slice(0, -1))
        this.elimination = last.eliminated.length ? elimShow(last.ranking, last) : null
        if (this.elimination !== null) this.enter('elimShow')
        else this.afterRound()
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
        if (this.readyRound === this.index) {
          this.readyRound = null
          this.enter('countdown')
        }
        dt = 0
      } else if (this.phase === 'vote' && this.port.candidates !== null && this.port.candidates !== this.offered) {
        this.offered = this.port.candidates
        this.voteModel = { candidates: this.offered.map(map => ({ map, ...this.info(map) })),
          focus: 0, chosen: null, msLeft: this.voteMs }
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
      : this.phase === 'end' ? 'endScreen'
      : this.phase === 'round' ? (this.port.alive.includes(this.localSeat) ? 'round' : 'spectate') : this.phase
    return {
      screen, loading: this.phase === 'load', vote: this.phase === 'vote' ? this.voteModel : null, countdown,
      results: this.rows,
      elimShow: this.phase === 'elimShow' ? this.elimination : null,
      endScreen: this.phase === 'end' || this.phase === 'podium' ? this.endModel : null,
      sounds, finished: this.finished,
      hold: ['load', 'elimShow', 'podium', 'end'].includes(this.phase)
        || (this.phase === 'countdown' && this.ms < COUNTDOWN_MS - this.introMs),
    }
  }
}
