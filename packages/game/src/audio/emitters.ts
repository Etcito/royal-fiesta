// Course sound emitters: turns a course's sounds (S13) into per-frame commands for the view's
// spatial audio. Pure view code: it reads the sim through MechanismView, never writes sim state,
// and has no Web Audio or Node API.
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import {
  MECH_EVENT_RING,
  isMechanismView,
} from '@royal-fiesta/sim/mechanismSpec'
import type {
  BodyRef,
  MechEvent,
  MechEventKind,
  MechanismView,
  SoundSpec,
} from '@royal-fiesta/sim/mechanismSpec'
import type { Pose, Vec3 } from '@royal-fiesta/sim/vec'

/** The listener in the world: position and horizontal facing, as HAA's spatial scene takes it. */
export interface ListenerPose {
  x: number
  y: number
  z: number
  fx: number
  fz: number
}

/** What the view does with a command. Loop follows the sound's `loop`; gain/ref/max are its falloff. */
export type EmitterCommandKind = 'start' | 'stop' | 'move' | 'trigger'

export interface EmitterCommand {
  kind: EmitterCommandKind
  /** The sound's id (stable per course). */
  id: string
  /** The HAA patch id the player plays. */
  patch: string
  gain: number
  /** Event strength for a patch's declared gain input; absent for non-event commands. */
  strength?: number
  ref: number
  max: number
  loop: boolean
  x: number
  y: number
  z: number
}

const SWITCH_OR_LEVER: ReadonlySet<MechEventKind> = new Set([
  'switchOn', 'switchOff', 'leverOn', 'leverOff',
])

/**
 * The course's sound emitters. One instance per course: `frame` reads the sim's mechanism view
 * and fills the command list, returning how many commands it wrote.
 *
 * - a sound with neither event nor signal starts once (at its point, or at body 0 of its item);
 * - a sound with a signal starts when the signal turns on and stops when it turns off;
 * - a sound with an event triggers once per matching mechanism event, at the event position.
 *
 * Events are deduplicated by tick + kind + source because rollback can report them again; keys
 * older than the 64-tick event ring are dropped. `reset` forgets the loops and event history.
 */
export class CourseEmitters {
  readonly #sounds: readonly SoundSpec[]
  readonly #signals: readonly string[]
  readonly #started: boolean[]
  readonly #signalOn: boolean[]
  readonly #seen = new Map<string, number>()
  readonly #events: MechEvent[] = []
  readonly #fresh: MechEvent[] = []
  readonly #pose: Pose = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } }
  readonly #ref: BodyRef = { item: -1, body: 0 }
  #lastTick = -1

  constructor(course: ResolvedCourse) {
    this.#sounds = course.sounds ?? []
    this.#signals = course.mechanisms?.signals ?? []
    this.#started = new Array(this.#sounds.length).fill(false)
    this.#signalOn = new Array(this.#sounds.length).fill(false)
  }

  /** Fills `out` with this frame's commands and returns the count. */
  frame(sim: unknown, tick: number, out: EmitterCommand[]): number {
    const view = isMechanismView(sim) ? sim : null
    const fromTick = this.#lastTick < 0 ? tick : this.#lastTick + 1
    this.#collectEvents(view, fromTick, tick)

    let n = 0
    for (let i = 0; i < this.#sounds.length; i++) {
      const s = this.#sounds[i]
      if (s.event !== null) {
        n = this.#eventCommands(view, s, out, n)
      } else if (s.signal >= 0) {
        n = this.#signalCommands(view, i, s, out, n)
      } else {
        n = this.#fixedCommands(view, i, s, out, n)
      }
    }

    this.#lastTick = tick
    out.length = n
    return n
  }

  /** Forgets every loop, signal edge and seen event: the next frame starts the loops again. */
  reset(): void {
    this.#started.fill(false)
    this.#signalOn.fill(false)
    this.#seen.clear()
    this.#events.length = 0
    this.#fresh.length = 0
    this.#lastTick = -1
  }

  #fixedCommands(view: MechanismView | null, i: number, s: SoundSpec, out: EmitterCommand[], n: number): number {
    if (!this.#started[i]) {
      this.#started[i] = true
      return this.#write(out, n, 'start', s, view, s.t)
    }
    // An item loop follows body 0 of its item each frame.
    if (s.item >= 0) return this.#write(out, n, 'move', s, view, s.t)
    return n
  }

  #signalCommands(view: MechanismView | null, i: number, s: SoundSpec, out: EmitterCommand[], n: number): number {
    if (view === null) return n
    const id = this.#signals[s.signal]
    const on = id === undefined ? false : view.signal(id)
    if (on === this.#signalOn[i]) return n
    this.#signalOn[i] = on
    this.#started[i] = on
    return this.#write(out, n, on ? 'start' : 'stop', s, view, s.t)
  }

  #eventCommands(view: MechanismView | null, s: SoundSpec, out: EmitterCommand[], n: number): number {
    if (view === null) return n
    for (const ev of this.#fresh) {
      if (ev.kind !== s.event) continue
      if (s.signal >= 0 && SWITCH_OR_LEVER.has(ev.kind) && ev.source !== s.signal) continue
      if (s.item >= 0 && ev.kind === 'impact' && ev.source !== s.item) continue
      return this.#write(out, n, 'trigger', s, null, ev)
    }
    return n
  }

  #collectEvents(view: MechanismView | null, fromTick: number, tick: number): void {
    this.#fresh.length = 0
    if (view === null) return
    const count = view.mechanismEvents(fromTick, this.#events)
    for (let i = 0; i < count; i++) {
      const ev = this.#events[i]
      const key = `${ev.tick}:${ev.kind}:${ev.source}`
      if (this.#seen.has(key)) continue
      this.#seen.set(key, ev.tick)
      this.#fresh.push(ev)
    }
    const cutoff = tick - MECH_EVENT_RING
    if (cutoff > 0) {
      for (const [key, at] of this.#seen) {
        if (at < cutoff) this.#seen.delete(key)
      }
    }
  }

  #write(
    out: EmitterCommand[], n: number, kind: EmitterCommandKind, s: SoundSpec,
    view: MechanismView | null, at: Vec3 | MechEvent,
  ): number {
    const p = this.#positionOf(view, s, at)
    let c = out[n]
    if (c === undefined) {
      c = { kind, id: '', patch: '', gain: 1, ref: 2, max: 60, loop: false, x: 0, y: 0, z: 0 }
      out[n] = c
    }
    c.kind = kind
    c.id = s.id
    c.patch = s.patch
    c.gain = s.gain
    c.strength = 'strength' in at ? at.strength : undefined
    c.ref = s.ref
    c.max = s.max
    c.loop = s.loop
    c.x = p.x
    c.y = p.y
    c.z = p.z
    return n + 1
  }

  /** The event position for a trigger; otherwise body 0 of the item, falling back to the sound's point. */
  #positionOf(view: MechanismView | null, s: SoundSpec, at: Vec3 | MechEvent): Vec3 {
    if ('kind' in at) return at
    if (s.item >= 0 && view !== null) {
      this.#ref.item = s.item
      this.#ref.body = 0
      if (view.mechanismBodyPose(this.#ref, this.#pose)) return this.#pose.t
    }
    return at
  }
}
