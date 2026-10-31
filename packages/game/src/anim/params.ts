// Maps observed character state to the penguin graph parameters (assets/common/penguin.animgraph.json).
// Reads sim values only; never mutates them. Units stay the sim's (m/s).
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { EMOTES } from '../hub/protocol.ts'

/** Graph `mode` values, as declared by the graph's transitions. */
export const GraphMode = {
  locomotion: 0,
  air: 1,
  dive: 2,
  bellySlide: 3,
  grab: 5,
} as const

/** The character state the mapping observes (one tick). */
export interface CharObservation {
  mode: number
  carry?: number
  strokeTimer?: number
  vel: { readonly x: number; readonly y: number; readonly z: number }
  grounded: boolean
  /** Obstacle surface: normal, ice, mud or rubber. */
  surface: string
  /** S9 emote index: 0 none, 1 wave, 2 dance, 3 cheer, 4 laugh. */
  emote: number
}

/** Graph params keyed by the declared names, with the declared types. */
export interface PenguinParams {
  speed: number // float, horizontal |v| in m/s
  vy: number // float, vertical velocity in m/s
  grounded: boolean // bool
  mode: number // int
  jump: boolean // trigger: true on the tick it fires
  emote: number // int
}

/** Per-character edge-detection memory for trigger inputs. */
export interface ParamMemory { prevGrounded: boolean; prevMode: number; primed: boolean }

export function newParamMemory(): ParamMemory {
  return { prevGrounded: true, prevMode: CharMode.ground, primed: false }
}

/** Maps a CharMode to the graph's `mode` int. */
export function graphMode(mode: number): number {
  switch (mode) {
    case CharMode.air: return GraphMode.air
    case CharMode.dive: return GraphMode.dive
    case CharMode.slide: return GraphMode.bellySlide
    case CharMode.diveRecover: return GraphMode.bellySlide
    case CharMode.grabbing: return GraphMode.grab
    default: return GraphMode.locomotion // ground, stunned, frozen, parked
  }
}

/** Clamps an S9 emote to the declared range; unknown values mean none. */
export function graphEmote(emote: number): number {
  return Number.isInteger(emote) && emote > 0 && emote < EMOTES.length ? emote : 0
}

/**
 * Builds the graph params for one tick and advances `mem`. `jump` fires only on the
 * grounded -> airborne edge with upward velocity, so repeated observations never retrigger it.
 */
export function mapParams(obs: CharObservation, mem: ParamMemory, out?: PenguinParams): PenguinParams {
  const o = out ?? { speed: 0, vy: 0, grounded: true, mode: 0, jump: false, emote: 0 }
  const { x, y, z } = obs.vel
  o.speed = Math.sqrt(x * x + z * z)
  o.vy = y
  o.grounded = obs.grounded
  o.mode = graphMode(obs.mode)
  o.jump = mem.primed && mem.prevGrounded && !obs.grounded && y > 0 && obs.mode === CharMode.air
  o.emote = graphEmote(obs.emote)
  mem.prevGrounded = obs.grounded
  mem.prevMode = obs.mode
  mem.primed = true
  return o
}
