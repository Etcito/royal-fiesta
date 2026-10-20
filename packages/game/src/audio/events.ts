// Sound events read from the match state. The simulation has no event bus, so the game audio
// watches the sim's observable state (character mode and round status) and reports transitions.
// Pure apart from reading the sim: no Web Audio, no clock, never writes sim state.
//
// One sample is one rendered frame. A transition that starts and ends inside one frame is not
// seen; at 60 fps a frame is one tick, so this only happens to a sub-tick mode change.
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import type { FiestaSoundId } from './ids.ts'
import { FIESTA_SOUNDS } from './ids.ts'

export interface Vec3 { x: number; y: number; z: number }

/** The part of one player's state the sound rules read. */
export interface PlayerSample {
  mode: number
  status: number
  vy: number
  pos: Vec3
}

/** The part of one match frame the sound rules read. */
export interface MatchSample {
  phase: number
  roundKind: 'race' | 'survival' | null
  final: boolean
  players: PlayerSample[]
}

export interface SoundEvent {
  id: FiestaSoundId
  player: number
  pos: Vec3
}

/** Crowd bed excitement while a round is on (tuning of the game, not of the pack). */
export const BED_EXCITEMENT = { race: 0.5, survival: 0.7, final: 0.9 } as const

/** Bed fade-out when a round ends (s). */
export const BED_FADE_S = 1

/**
 * The sound events between two frames. The first frame (prev null) yields none, so joining a
 * match in progress does not play a burst of stale sounds.
 *
 * - jump: grounded -> air with an upward velocity (a fall off a ledge is not a jump);
 * - dive, grab, wobble: entering dive, grabbing or stunned (a bump from another character or an
 *   obstacle; the sim has no separate wobble state);
 * - eliminate: alive -> eliminated.
 */
export function diffSamples(prev: MatchSample | null, next: MatchSample): SoundEvent[] {
  if (prev === null) return []
  const events: SoundEvent[] = []
  const n = Math.min(prev.players.length, next.players.length)
  for (let p = 0; p < n; p++) {
    const a = prev.players[p]
    const b = next.players[p]
    const add = (id: FiestaSoundId): void => { events.push({ id, player: p, pos: { ...b.pos } }) }
    if (a.mode === CharMode.ground && b.mode === CharMode.air && b.vy > 0) add(FIESTA_SOUNDS.jump)
    if (b.mode === CharMode.dive && a.mode !== CharMode.dive) add(FIESTA_SOUNDS.dive)
    if (b.mode === CharMode.grabbing && a.mode !== CharMode.grabbing) add(FIESTA_SOUNDS.grab)
    if (b.mode === CharMode.stunned && a.mode !== CharMode.stunned) add(FIESTA_SOUNDS.wobble)
    if (a.status === PlayerStatus.alive && b.status === PlayerStatus.eliminated) add(FIESTA_SOUNDS.eliminate)
  }
  return events
}

/** Whether the crowd bed plays for this frame, and at what excitement. */
export function bedState(s: MatchSample): { on: boolean; excitement: number } {
  const inRound = s.roundKind !== null && (s.phase === Phase.intro || s.phase === Phase.playing)
  const excitement = s.final ? BED_EXCITEMENT.final : s.roundKind === 'survival' ? BED_EXCITEMENT.survival : BED_EXCITEMENT.race
  return { on: inRound, excitement }
}

const scratchPhase = {
  tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null as 'race' | 'survival' | null,
  final: false, courseIndex: 0, roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [] as number[],
}

/** Copies a sample into out (reusing its arrays) and returns out. */
export function copySample(from: MatchSample, out: MatchSample | null): MatchSample {
  const to: MatchSample = out ?? { phase: 0, roundKind: null, final: false, players: [] }
  to.phase = from.phase
  to.roundKind = from.roundKind
  to.final = from.final
  to.players.length = from.players.length
  for (let p = 0; p < from.players.length; p++) {
    const a = from.players[p]
    const slot = to.players[p] ?? (to.players[p] = { mode: 0, status: 0, vy: 0, pos: { x: 0, y: 0, z: 0 } })
    slot.mode = a.mode
    slot.status = a.status
    slot.vy = a.vy
    slot.pos.x = a.pos.x
    slot.pos.y = a.pos.y
    slot.pos.z = a.pos.z
  }
  return to
}

/** Reads a MatchSample from the sim. Scratch objects are reused, so call it once per frame. */
export function sampleMatch(sim: MatchSim, out: MatchSample, scratch: CharacterView): MatchSample {
  const state = sim.phase(scratchPhase)
  out.phase = state.phase
  out.roundKind = state.roundKind
  out.final = state.final
  const count = sim.setup.playerCount
  while (out.players.length < count) out.players.push({ mode: 0, status: 0, vy: 0, pos: { x: 0, y: 0, z: 0 } })
  out.players.length = count
  for (let p = 0; p < count; p++) {
    sim.character(p, scratch)
    const s = out.players[p]
    s.mode = scratch.mode
    s.status = scratch.status
    s.vy = scratch.vel.y
    s.pos.x = scratch.pos.x
    s.pos.y = scratch.pos.y
    s.pos.z = scratch.pos.z
  }
  return out
}
