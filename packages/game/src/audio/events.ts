// Sound events read from the match state. The simulation has no event bus, so the game audio
// watches the sim's observable state (character mode, walk cycle and round status) and reports
// transitions. Pure apart from reading the sim: no Web Audio, no clock, never writes sim state.
//
// One sample is one rendered frame. A transition that starts and ends inside one frame is not
// seen; at 60 fps a frame is one tick, so this only happens to a sub-tick mode change.
import { surfaceOf } from '@royal-fiesta/sim/course'
import type { ColliderSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import { CHAR, CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { Pose } from '@royal-fiesta/sim/vec'
import { newWalkState, stepWalk, walkPose, type WalkState } from '../anim/walkCycle.ts'
import { stepSoundId, WORLDS_AUDIO, musicId } from './catalog.ts'

export interface Vec3 { x: number; y: number; z: number }

/** The part of one player's state the sound rules read. */
export interface PlayerSample {
  mode: number
  status: number
  grounded: boolean
  footDown: -1 | 0 | 1
  vel: Vec3
  pos: Vec3
  /** Belly-slide speed (m/s); 0 until M4 adds the slide states. */
  slideSpeed: number
  /** Carried object count; 0 until M4 adds the carry states. */
  carry: number
  /** Obstacle surface under the feet: normal, ice, mud or rubber. */
  surface: string
}

/** The part of one match frame the sound rules read. */
export interface MatchSample {
  phase: number
  roundKind: RoundKind | null
  final: boolean
  /** The audio world of the current course: candy, ice, jungle, neon or common. */
  world: string
  players: PlayerSample[]
}

export interface SoundEvent {
  id: string
  player: number
  pos: Vec3
  /** Patch gain input for events whose level scales (steps, landings). */
  strength?: number
}

/** A live loop: one input value per frame. */
export interface LoopSample {
  id: string
  player: number
  pos: Vec3
  input: number
}

/** Crowd bed excitement while a round is on (tuning of the game, not of the pack). */
export const BED_EXCITEMENT = { race: 0.5, survival: 0.7, final: 0.9 } as const

/** Bed fade-out when a round ends (s). */
export const BED_FADE_S = 1

const STEP_FULL_SPEED = 8
const LAND_HARD_MPS = 9
const LAND_FULL_MPS = 15
const MIN_STRENGTH = 0.2
const STUN_GRAB_M = 1.2
const STUN_HIT_M = 1.5
const SWIM_STROKE_MPS = 1.5
const SURFACE_MARGIN = 0.15

const clamp = (x: number, lo: number, hi: number): number => (x <= lo ? lo : x >= hi ? hi : x)
const planarSpeed = (v: Vec3): number => Math.hypot(v.x, v.z)
const within = (a: Vec3, b: Vec3, m: number): boolean => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz <= m * m
}

function newPlayerSample(): PlayerSample {
  return {
    mode: 0, status: 0, grounded: false, footDown: 0,
    vel: { x: 0, y: 0, z: 0 }, pos: { x: 0, y: 0, z: 0 },
    slideSpeed: 0, carry: 0, surface: 'normal',
  }
}

/** A fresh, empty match sample for a screen or driver to reuse. */
export function newMatchSample(): MatchSample {
  return { phase: Phase.intro, roundKind: null, final: false, world: 'common', players: [] }
}

function stunId(s: MatchSample, p: number): string {
  const b = s.players[p]
  let grabbed = false
  let near = false
  for (let q = 0; q < s.players.length; q++) {
    if (q === p) continue
    const o = s.players[q]
    if (o.mode === CharMode.grabbing && within(b.pos, o.pos, STUN_GRAB_M)) grabbed = true
    if (within(b.pos, o.pos, STUN_HIT_M)) near = true
  }
  return grabbed ? 'move.wobble' : near ? 'move.hit' : 'move.stun'
}

/**
 * The sound events between two frames. The first frame (prev null) yields none, so joining a
 * match in progress does not play a burst of stale sounds. A player already eliminated is
 * skipped; the alive -> eliminated tick still reports flow.eliminate.
 */
export function diffSamples(prev: MatchSample | null, next: MatchSample): SoundEvent[] {
  if (prev === null) return []
  const events: SoundEvent[] = []
  const n = Math.min(prev.players.length, next.players.length)
  for (let p = 0; p < n; p++) {
    const a = prev.players[p]
    const b = next.players[p]
    if (a.status === PlayerStatus.eliminated) continue
    const add = (id: string, strength?: number): void => {
      events.push(strength === undefined
        ? { id, player: p, pos: { ...b.pos } }
        : { id, player: p, pos: { ...b.pos }, strength })
    }
    if (a.status === PlayerStatus.alive && b.status === PlayerStatus.eliminated) {
      add('flow.eliminate')
      continue
    }
    if (b.grounded && b.footDown !== 0) {
      add(stepSoundId(b.surface, next.world), clamp(planarSpeed(b.vel) / STEP_FULL_SPEED, MIN_STRENGTH, 1))
    }
    if (a.grounded && !b.grounded && b.vel.y > 0) add('move.jump')
    if (!a.grounded && b.grounded) {
      const impact = -a.vel.y
      add(impact < LAND_HARD_MPS ? 'move.land.soft' : 'move.land.hard',
        clamp(impact / LAND_FULL_MPS, MIN_STRENGTH, 1))
    }
    if (b.mode === CharMode.dive && a.mode !== CharMode.dive) add('move.dive')
    if (b.slideSpeed > 0 && b.slideSpeed - a.slideSpeed >= SWIM_STROKE_MPS) add('move.swim')
    if (b.mode === CharMode.stunned && a.mode !== CharMode.stunned) add(stunId(next, p))
    if (b.mode === CharMode.grabbing && a.mode !== CharMode.grabbing) add('move.grab')
    if (a.mode === CharMode.grabbing && b.mode !== CharMode.grabbing) add('move.release')
    if (a.carry === 0 && b.carry !== 0) add('move.carry')
  }
  return events
}

/** The loops a frame keeps running: one move.slide per sliding player, its speed as the input. */
export function loopsOf(s: MatchSample): LoopSample[] {
  const out: LoopSample[] = []
  for (let p = 0; p < s.players.length; p++) {
    const pl = s.players[p]
    if (pl.slideSpeed > 0) out.push({ id: 'move.slide', player: p, pos: { ...pl.pos }, input: pl.slideSpeed })
  }
  return out
}

/** Whether the crowd bed plays for this frame, and at what excitement. */
export function bedState(s: MatchSample): { on: boolean; excitement: number } {
  const inRound = s.roundKind !== null && (s.phase === Phase.intro || s.phase === Phase.playing)
  const excitement = s.final ? BED_EXCITEMENT.final : s.roundKind === 'survival' ? BED_EXCITEMENT.survival : BED_EXCITEMENT.race
  return { on: inRound, excitement }
}

function isWorld(world: string): boolean {
  return (WORLDS_AUDIO as readonly string[]).includes(world)
}

/**
 * The music cue for a screen. A menu screen maps to itself. A match maps its phase and round
 * kind: done -> podium, a between-round phase -> results, a final -> final, race/logic -> race,
 * survival/collection/hunt -> survival, team -> team. The world is s.world when it is an audio
 * world, else candy. Anything else, or a null sample for a match, is null (silence).
 */
export function musicCue(screen: string, s: MatchSample | null): string | null {
  const world = s !== null && isWorld(s.world) ? s.world : 'candy'
  let cue: string | null = null
  if (screen === 'lobby' || screen === 'hub' || screen === 'results' || screen === 'podium') {
    cue = screen
  } else if (screen === 'match') {
    if (s === null) return null
    if (s.phase === Phase.done) cue = 'podium'
    else if (s.phase === Phase.roundEnd || s.phase === Phase.intermission) cue = 'results'
    else if (s.final) cue = 'final'
    else if (s.roundKind === 'race' || s.roundKind === 'logic') cue = 'race'
    else if (s.roundKind === 'survival' || s.roundKind === 'collection' || s.roundKind === 'hunt') cue = 'survival'
    else if (s.roundKind === 'team') cue = 'team'
  }
  return cue === null ? null : musicId(world, cue)
}

const scratchPhase = {
  tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null as 'race' | 'survival' | null,
  final: false, courseIndex: 0, roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [] as number[],
}

const scratchPose: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }

// The walk state of each sampled player, keyed by the caller's reusable MatchSample, so
// stepWalk runs exactly once per player per frame.
const walkStates = new WeakMap<MatchSample, WalkState[]>()

/** The audio world of a course id: its prefix when that is an audio world, else common. */
function worldOf(courseId: string): string {
  const prefix = courseId.split('-')[0]
  return isWorld(prefix) ? prefix : 'common'
}

function colliderHalf(c: ColliderSpec): Vec3 {
  switch (c.shape) {
    case 'cuboid': return c.half
    case 'roundCuboid': return { x: c.half.x + c.border, y: c.half.y + c.border, z: c.half.z + c.border }
    case 'ball': return { x: c.radius, y: c.radius, z: c.radius }
    default: return { x: c.radius, y: c.halfHeight, z: c.radius }
  }
}

// Whether any collider of the obstacle (world pose p) holds the point (feet) inside its AABB.
function underFeet(colliders: readonly ColliderSpec[], p: Pose, feet: Vec3): boolean {
  const q = p.r
  const x = q.x, y = q.y, z = q.z, w = q.w
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w)
  const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w)
  const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y)
  for (const c of colliders) {
    const h = colliderHalf(c)
    const cx = p.t.x + r00 * c.t.x + r01 * c.t.y + r02 * c.t.z
    const cy = p.t.y + r10 * c.t.x + r11 * c.t.y + r12 * c.t.z
    const cz = p.t.z + r20 * c.t.x + r21 * c.t.y + r22 * c.t.z
    const hx = Math.abs(r00) * h.x + Math.abs(r01) * h.y + Math.abs(r02) * h.z
    const hy = Math.abs(r10) * h.x + Math.abs(r11) * h.y + Math.abs(r12) * h.z
    const hz = Math.abs(r20) * h.x + Math.abs(r21) * h.y + Math.abs(r22) * h.z
    if (Math.abs(feet.x - cx) <= hx + SURFACE_MARGIN &&
        Math.abs(feet.y - cy) <= hy + SURFACE_MARGIN &&
        Math.abs(feet.z - cz) <= hz + SURFACE_MARGIN) return true
  }
  return false
}

// The surface an obstacle under the player's feet carries; ice and mud override the world.
function surfaceUnder(sim: MatchSim, pos: Vec3): string {
  const count = sim.obstacleCount()
  const feetY = pos.y - (CHAR.halfHeight + CHAR.radius)
  const feet: Vec3 = { x: pos.x, y: feetY, z: pos.z }
  for (let i = 0; i < count; i++) {
    const spec = sim.obstacleSpec(i)
    const surface = surfaceOf(spec)
    if (surface !== 'ice' && surface !== 'mud') continue
    sim.obstaclePose(i, scratchPose)
    if (underFeet(spec.colliders, scratchPose, feet)) return surface
  }
  return 'normal'
}

/** Copies a sample into out (reusing its arrays) and returns out. */
export function copySample(from: MatchSample, out: MatchSample | null): MatchSample {
  const to: MatchSample = out ?? newMatchSample()
  to.phase = from.phase
  to.roundKind = from.roundKind
  to.final = from.final
  to.world = from.world
  to.players.length = from.players.length
  for (let p = 0; p < from.players.length; p++) {
    const a = from.players[p]
    const slot = to.players[p] ?? (to.players[p] = newPlayerSample())
    slot.mode = a.mode
    slot.status = a.status
    slot.grounded = a.grounded
    slot.footDown = a.footDown
    slot.vel.x = a.vel.x
    slot.vel.y = a.vel.y
    slot.vel.z = a.vel.z
    slot.pos.x = a.pos.x
    slot.pos.y = a.pos.y
    slot.pos.z = a.pos.z
    slot.slideSpeed = a.slideSpeed
    slot.carry = a.carry
    slot.surface = a.surface
  }
  return to
}

/** Reads a MatchSample from the sim. Scratch objects are reused, so call it once per frame. */
export function sampleMatch(sim: MatchSim, out: MatchSample, scratch: CharacterView): MatchSample {
  const state = sim.phase(scratchPhase)
  out.phase = state.phase
  out.roundKind = state.roundKind
  out.final = state.final
  const course: ResolvedCourse | null = sim.course()
  out.world = course === null ? 'common' : worldOf(course.id)
  const count = sim.setup.playerCount
  while (out.players.length < count) out.players.push(newPlayerSample())
  out.players.length = count
  let walks = walkStates.get(out)
  if (walks === undefined) {
    walks = []
    walkStates.set(out, walks)
  }
  for (let p = 0; p < count; p++) {
    sim.character(p, scratch)
    const s = out.players[p]
    s.mode = scratch.mode
    s.status = scratch.status
    s.grounded = scratch.mode === CharMode.ground
    s.vel.x = scratch.vel.x
    s.vel.y = scratch.vel.y
    s.vel.z = scratch.vel.z
    s.pos.x = scratch.pos.x
    s.pos.y = scratch.pos.y
    s.pos.z = scratch.pos.z
    const walk = walks[p] ?? (walks[p] = newWalkState())
    stepWalk(walk, scratch.vel, s.grounded)
    s.footDown = walkPose(walk).footDown
    s.slideSpeed = 0
    s.carry = 0
    s.surface = course === null ? 'normal' : surfaceUnder(sim, scratch.pos)
  }
  return out
}
