// HUD values for the uaa 'hud' screen (no DOM). hudLines is the shared text: ops.ts draws the same lines onto captures (the canvas capture has no DOM).
import { PALETTE, PALETTE_NAMES } from '@royal-fiesta/game/render/palette'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { MatchViewState } from '@royal-fiesta/sim/match/matchSim'

const PLACES = ['1st', '2nd', '3rd']

function clock(ticks: number): string {
  const s = Math.ceil(Math.max(0, ticks) / 60)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function kindLabel(state: MatchViewState): string {
  if (state.phase === Phase.podium || state.phase === Phase.done) return 'Podium'
  if (state.final) return 'Final'
  if (state.roundKind === 'race') return 'Race'
  if (state.roundKind === 'survival') return 'Survival'
  return 'Get ready'
}

function nameOf(names: string[], p: number): string {
  return names[p] ?? `Bean ${p + 1}`
}

function colourOf(p: number): string {
  const c = PALETTE[((p % PALETTE.length) + PALETTE.length) % PALETTE.length]
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`
}

function onPodium(state: MatchViewState): boolean {
  return state.phase === Phase.podium || state.phase === Phase.done
}

// Lines, in order: round kind, timer, qualified, podium places (podium phases only), local player.
export function hudLines(state: MatchViewState, names: string[], local: number): string[] {
  const lines: string[] = []
  const round = state.roundIndex >= 0 ? ` - Round ${state.roundIndex + 1}` : ''
  lines.push(onPodium(state) ? kindLabel(state) : `${kindLabel(state)}${round}`)
  if (state.phase === Phase.intro) lines.push(`Starts in ${clock(state.phaseTicksLeft)}`)
  else if (state.phase === Phase.playing) lines.push(`Time ${clock(state.roundTicksLeft)}`)
  else if (!onPodium(state)) lines.push('Time 0:00')
  if (!onPodium(state)) lines.push(`Qualified ${state.qualifiedCount} / ${state.target}`)
  else {
    for (let i = 0; i < state.podium.length && i < PLACES.length; i++) lines.push(`${PLACES[i]} ${nameOf(names, state.podium[i])}`)
  }
  const colour = PALETTE_NAMES[((local % PALETTE_NAMES.length) + PALETTE_NAMES.length) % PALETTE_NAMES.length]
  lines.push(`You: ${nameOf(names, local)} (${colour})`)
  return lines
}

// What the uaa HUD shows (screenMap's hud-* widgets). timeFraction is the round time left, 0..1; timer/qualified/alive are
// null on the podium, where those widgets are hidden.
export interface HudValues {
  kind: string
  timeLeft: string | null
  timeFraction: number | null
  qualified: string | null
  alive: string | null
  you: string
  youColour: string
  podium: { place: string; name: string; colour: string }[]
}

// roundTicks is the round's full length (0 when unknown gives a fraction of 0).
export function hudValues(state: MatchViewState, names: string[], local: number, roundTicks = 0): HudValues {
  const lines = hudLines(state, names, local)
  const podiumOn = onPodium(state)
  const podium = podiumOn ? state.podium.slice(0, PLACES.length).map((p, i) => ({ place: PLACES[i], name: nameOf(names, p), colour: colourOf(p) })) : []
  return {
    kind: lines[0],
    timeLeft: podiumOn ? null : lines[1],
    timeFraction: podiumOn ? null : roundTicks > 0 ? Math.min(1, Math.max(0, state.roundTicksLeft / roundTicks)) : 0,
    qualified: podiumOn ? null : lines[2],
    alive: podiumOn ? null : `Alive ${state.alive}`,
    you: lines[lines.length - 1],
    youColour: colourOf(local),
    podium,
  }
}

export interface HudReport {
  values?(v: HudValues): void
  banner?(text: string): void
}

// The HUD handle the clients drive: it reports values to the uaa host and touches no DOM. The first argument is the
// former DOM root, ignored; it stays only so the main.ts callers compile until they are rewired onto the uaa host.
export function mountHud(_root: unknown, report: HudReport = {}): { update(state: MatchViewState, names: string[], local: number, roundTicks?: number): void; banner(text: string): void } {
  return {
    update(state, names, local, roundTicks = 0) {
      report.values?.(hudValues(state, names, local, roundTicks))
    },
    banner(text) {
      report.banner?.(text)
    },
  }
}
