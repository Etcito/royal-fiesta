// The client side of GameSaloon's timed lobbies (gamesaloon docs/lobby.md): pure, no socket, no clock.
// The server runs the wait and starts the round; this tracks what to show (countdown, players, the
// join / spectate / new choice) and picks a default when the player does not answer the choice.
import { refuse } from '@royal-fiesta/sim/refusal'

/** How long the choice screen waits for an answer before taking the default. */
export const LOBBY_CHOICE_MS = 10_000
/** A server that never answers lobby_enter has no lobbies: the client falls back to the exact-size queue. */
export const LOBBY_FALLBACK_MS = 3000
/** The local (offline) hub's wait before its round starts by itself. */
export const LOCAL_LOBBY_WAIT_S = 60

export type LobbyPick = 'join' | 'spectate' | 'new'
export type LobbyPhase = 'waiting' | 'playing'

export interface LobbyOffer { id: string; phase: LobbyPhase; players: number; seats: number; startsInMs: number; actions: LobbyPick[]; names: string[] }

export type LobbyServerMsg =
  | { t: 'lobby_choice'; lobbies: { id: string; phase: LobbyPhase; players: number; seats: number; startsInMs: number; actions: string[]; names: unknown[] }[] }
  | { t: 'lobby_state'; id: string; phase: LobbyPhase; role: 'player' | 'spectator'; seat: number; players: unknown[]; seats: number; startsInMs: number; waitMs: number }
  | { t: 'lobby_watch'; id: string; session: string; seed: number; players: number; opps: unknown[]; replay: boolean }
  | { t: 'lobby_act'; id: string; a: unknown; n: number; from: number }
  | { t: 'lobby_closed'; id: string; reason: 'ended' | 'empty' }
  | { t: 'lobby_left' }
  | { t: 'lobby_error'; reason: string }

export type LobbyStage = 'entering' | 'choosing' | 'player' | 'spectator'

export interface LobbyView {
  stage: LobbyStage
  id: string | null
  phase: LobbyPhase
  names: string[]
  seats: number
  /** Local clock (ms) when the round starts; null once playing or unknown. */
  startsAt: number | null
  /** The offered lobby while choosing. */
  offer: LobbyOffer | null
  /** Local clock (ms) when the default choice is taken. */
  choiceAt: number | null
}

/** What the flow must do after a message. */
export type LobbyStep = { kind: 'none' } | { kind: 'reenter' } | { kind: 'fail'; reason: string }

function nameOf(p: unknown): string {
  const n = typeof p === 'object' && p !== null ? (p as { name?: unknown }).name : undefined
  return typeof n === 'string' && n.length > 0 ? n.slice(0, 24) : '?'
}

const PICKS: readonly string[] = ['join', 'spectate', 'new']

export class LobbyTracker {
  private v: LobbyView = LobbyTracker.empty()
  private heard = false
  private enteredAt = 0

  static empty(): LobbyView {
    return { stage: 'entering', id: null, phase: 'waiting', names: [], seats: 0, startsAt: null, offer: null, choiceAt: null }
  }

  get view(): Readonly<LobbyView> { return this.v }
  /** Any lobby message since the last enter: the server has lobbies. */
  get answered(): boolean { return this.heard }

  /** lobby_enter was sent at `now`. */
  entered(now: number): void {
    this.v = LobbyTracker.empty()
    this.enteredAt = now
  }

  /** No lobby answer for LOBBY_FALLBACK_MS since the first enter: use the legacy queue. */
  fallbackDue(now: number): boolean {
    return !this.heard && this.v.stage === 'entering' && now - this.enteredAt >= LOBBY_FALLBACK_MS
  }

  apply(m: LobbyServerMsg, now: number): LobbyStep {
    this.heard = true
    const v = this.v
    switch (m.t) {
      case 'lobby_choice': {
        // Offer a lobby that can still be joined before one whose round is on.
        const first = m.lobbies.find((l) => l.actions.includes('join')) ?? m.lobbies[0]
        if (!first) return { kind: 'reenter' }
        const offer: LobbyOffer = {
          id: first.id, phase: first.phase, players: first.players, seats: first.seats, startsInMs: first.startsInMs,
          actions: [...first.actions.filter((a) => PICKS.includes(a)) as LobbyPick[], 'new'], names: first.names.map(nameOf),
        }
        this.v = {
          stage: 'choosing', id: first.id, phase: first.phase, names: offer.names, seats: first.seats,
          startsAt: first.phase === 'waiting' ? now + first.startsInMs : null, offer, choiceAt: now + LOBBY_CHOICE_MS,
        }
        return { kind: 'none' }
      }
      case 'lobby_state':
        this.v = {
          stage: m.role, id: m.id, phase: m.phase, names: m.players.map(nameOf), seats: m.seats,
          startsAt: m.phase === 'waiting' ? now + m.startsInMs : null, offer: null, choiceAt: null,
        }
        return { kind: 'none' }
      case 'lobby_watch':
        if (m.id === v.id) this.v = { ...v, phase: 'playing', startsAt: null, names: m.opps.map(nameOf) }
        return { kind: 'none' }
      case 'lobby_act':
      case 'lobby_left':
        return { kind: 'none' }
      case 'lobby_closed':
        // The watched lobby ended (its round is over, or it emptied): look again.
        if (m.id !== v.id) return { kind: 'none' }
        this.entered(now)
        return { kind: 'reenter' }
      case 'lobby_error':
        // A race lost (the lobby started or closed meanwhile) or a pick the server forgot: look again.
        if (m.reason === 'lobby_closed' || m.reason === 'unknown_lobby' || m.reason === 'not_entered') {
          this.entered(now)
          return { kind: 'reenter' }
        }
        return { kind: 'fail', reason: m.reason }
    }
  }

  /** Whole seconds left before the round starts, or null. */
  secondsLeft(now: number): number | null {
    const at = this.v.startsAt
    return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000))
  }

  /** The default answer: join a waiting lobby with a free seat, else a new lobby. */
  defaultPick(): LobbyPick {
    return this.v.offer?.actions.includes('join') ? 'join' : 'new'
  }

  /** The choice timed out: the flow sends defaultPick(). */
  choiceDue(now: number): boolean {
    return this.v.stage === 'choosing' && this.v.choiceAt !== null && now >= this.v.choiceAt
  }

  /** Validates a pick against the offer; returns the lobby id to send (null for new). */
  pick(p: LobbyPick): string | null {
    const offer = this.v.offer
    if (this.v.stage !== 'choosing' || offer === null) refuse('hub', 'lobby.pick', 'no lobby choice is open; pick only on the choice screen')
    if (!offer.actions.includes(p)) refuse('hub', `lobby.pick/${p}`, `the offered lobby allows ${offer.actions.join(', ')}`)
    // Answered: no default any more; the server's lobby_state moves the stage on.
    this.v = { ...this.v, choiceAt: null }
    return p === 'new' ? null : offer.id
  }
}

/** The local hub's countdown: runs on unpaused frame time, never resets on a new seat. */
export class LocalCountdown {
  private readonly waitS: number
  private elapsed = 0

  constructor(waitS = LOCAL_LOBBY_WAIT_S) {
    if (!(waitS > 0)) refuse('hub', 'LocalCountdown.waitS', `${waitS} must be > 0 seconds`)
    this.waitS = waitS
  }

  /** Advances by dt seconds; true once the wait is over. */
  step(dtS: number): boolean {
    if (dtS > 0) this.elapsed += dtS
    return this.done
  }

  get done(): boolean { return this.elapsed >= this.waitS }
  get secondsLeft(): number { return Math.max(0, Math.ceil(this.waitS - this.elapsed)) }
  reset(): void { this.elapsed = 0 }
}

/** Hub overlay lines for a lobby view. */
export function lobbyLines(t: LobbyTracker, now: number): string[] {
  const v = t.view
  const left = t.secondsLeft(now)
  const who = v.names.length ? v.names.join(', ') : ''
  switch (v.stage) {
    case 'entering': return ['Joining a lobby...']
    case 'choosing': {
      const o = v.offer!
      const auto = Math.max(0, Math.ceil(((v.choiceAt ?? now) - now) / 1000))
      return o.phase === 'waiting'
        ? [`A lobby is open: ${o.players}/${o.seats} players, round in ${left ?? 0} s`, who, `Joining it in ${auto} s`]
        : [`A round is being played: ${who}`, `New lobby in ${auto} s`]
    }
    case 'player':
      return [`Lobby ${v.names.length}/${v.seats} - round starts in ${left ?? 0} s`, who, 'Bots fill the empty places']
    case 'spectator':
      return v.phase === 'waiting'
        ? [`Spectating a lobby: ${v.names.length}/${v.seats} - round in ${left ?? 0} s`, who]
        : [`Spectating a round: ${who}`, 'You play in the next lobby when it ends']
  }
}
