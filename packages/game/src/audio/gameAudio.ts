import { soundDef, WORLDS_AUDIO } from './catalog.ts'
import { CROWD_BED_ID } from './ids.ts'
import { bedState, copySample, diffSamples, loopsOf, musicCue, BED_FADE_S, type MatchSample, type SoundEvent, type Vec3 } from './events.ts'
import type { EmitterCommand, ListenerPose } from './emitters.ts'

/**
 * The view's course audio: it applies the commands of the course's sound emitters to the spatial
 * scene. Implemented in apps/web (haa 0.2.0); this package only names the shape, so no haa import.
 */
export interface CourseAudio {
  apply(cmds: readonly EmitterCommand[], n: number): void
  setListener(l: ListenerPose): void
  dispose(): void
}

export interface LoopPort {
  set(name: string, value: number): void
  move(pos: Vec3): void
  stop(fadeS?: number): void
}

/** Audio engine boundary for events, spatial loops and screen cues. */
export interface SoundPort {
  play(id: string, o?: { pos?: Vec3; strength?: number }): unknown
  startLoop(id: string, o?: { pos?: Vec3 }): LoopPort | null
  setListeners(ls: readonly ListenerPose[]): void
}

export class GameAudio {
  readonly #port: SoundPort
  #prev: MatchSample | null = null
  readonly #loops = new Map<string, LoopPort>()
  #musicId: string | null = null
  #music: LoopPort | null = null
  #ambienceId: string | null = null
  #ambience: LoopPort | null = null
  #bed: LoopPort | null = null

  constructor(port: SoundPort) {
    this.#port = port
  }

  /** Plays frame events and updates movement loops, screen music, ambience and crowd. */
  observe(sample: MatchSample, screen = 'match'): SoundEvent[] {
    const events = diffSamples(this.#prev, sample)
    for (const e of events) this.#port.play(e.id, { pos: e.pos, strength: e.strength })

    const active = new Set<string>()
    for (const frame of loopsOf(sample)) {
      const key = `${frame.id}:${frame.player}`
      active.add(key)
      let loop = this.#loops.get(key)
      if (!loop) {
        loop = this.#port.startLoop(frame.id, { pos: frame.pos }) ?? undefined
        if (loop) this.#loops.set(key, loop)
      }
      const input = soundDef(frame.id).input
      if (input !== null) loop?.set(input, frame.input)
      loop?.move(frame.pos)
    }
    for (const [key, loop] of this.#loops) {
      if (!active.has(key)) {
        loop.stop(0.15)
        this.#loops.delete(key)
      }
    }

    const cue = musicCue(screen, sample)
    if (cue !== this.#musicId) {
      this.#music?.stop(1)
      this.#music = null
      this.#musicId = cue
      if (cue !== null) {
        if (soundDef(cue).mode === 'loop') this.#music = this.#port.startLoop(cue)
        else this.#port.play(cue)
      }
    }

    const ambience = (screen === 'hub' || screen === 'match') && WORLDS_AUDIO.some(world => world === sample.world)
      ? `amb.${sample.world}` : null
    if (ambience !== this.#ambienceId) {
      this.#ambience?.stop(1)
      this.#ambience = ambience === null ? null : this.#port.startLoop(ambience)
      this.#ambienceId = ambience
    }

    const bed = bedState(sample)
    if (bed.on) {
      if (this.#bed === null) this.#bed = this.#port.startLoop(CROWD_BED_ID)
      this.#bed?.set('excitement', bed.excitement)
    } else if (this.#bed !== null) {
      this.#bed.stop(BED_FADE_S)
      this.#bed = null
    }
    this.#prev = copySample(sample, this.#prev)
    return events
  }

  setListeners(ls: readonly ListenerPose[]): void {
    this.#port.setListeners(ls)
  }

  /** Stops all loops and forgets frame and cue state so the controller can be reused. */
  stop(): void {
    for (const loop of this.#loops.values()) loop.stop(0.15)
    this.#loops.clear()
    this.#music?.stop(1)
    this.#music = null
    this.#musicId = null
    this.#ambience?.stop(1)
    this.#ambience = null
    this.#ambienceId = null
    this.#bed?.stop(BED_FADE_S)
    this.#bed = null
    this.#prev = null
  }
}
