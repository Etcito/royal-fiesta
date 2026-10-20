// HubWorld: the local, non-rollback plaza. It runs the match character controller so the hub
// feels like the rounds; nothing here is networked or snapshotted.
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { CharacterSystem } from '@royal-fiesta/sim/character/system'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { inBox } from '@royal-fiesta/sim/course'
import type { Box, ResolvedCourse, SpawnPoint } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { ObstacleSystem } from '@royal-fiesta/sim/obstacles/system'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { FiestaWorld } from '@royal-fiesta/sim/world'
import type { SimSystem } from '@royal-fiesta/sim/world'
import { EMOTE_MS, EMOTES } from './protocol.ts'

export class HubWorld {
  readonly #world: FiestaWorld<PlayerInput>
  readonly #chars: CharacterSystem
  readonly #spawn: SpawnPoint
  readonly #killY: number
  readonly #pad: Box
  readonly #inputs: PlayerInput[] = []
  readonly #st: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
  #emote = 0
  #emoteUntil = 0

  constructor(R: RapierModule, plaza: ResolvedCourse, spawn: number) {
    if (plaza.kind !== 'hub') {
      throw new RefusalError('hub', `${plaza.id}#/kind`, `got '${plaza.kind}', the hub needs a course of kind 'hub'; pass the hub plaza course`)
    }
    if (plaza.queuePad === null) {
      throw new RefusalError('hub', `${plaza.id}#/queuePad`, 'the hub needs a queue pad; add a queuePad box to the course')
    }
    if (!Number.isInteger(spawn) || spawn < 0 || spawn >= plaza.spawns.length) {
      throw new RefusalError('hub', `${plaza.id}#/spawns/${spawn}`, `spawn must be an integer in 0..${plaza.spawns.length - 1}; pick an existing spawn`)
    }
    this.#pad = plaza.queuePad
    this.#spawn = plaza.spawns[spawn]
    this.#killY = plaza.killPlaneY
    const obstacles = new ObstacleSystem([plaza])
    this.#chars = new CharacterSystem({ playerCount: 1 })
    this.#world = new FiestaWorld<PlayerInput>(R, {
      playerCount: 1,
      systems: [obstacles as SimSystem<PlayerInput>, this.#chars],
    })
    const ctx = this.#world.ctx
    obstacles.load(ctx, 0)
    this.#chars.place(ctx, 0, this.#spawn)
  }

  get tick(): number { return this.#world.tick }

  // One fixed 60 Hz tick; the caller owns the accumulator.
  step(input: PlayerInput): void {
    this.#inputs[0] = input
    this.#world.step(this.#inputs)
    const s = this.#chars.state(this.#world.ctx, 0, this.#st)
    if (s.pos.y < this.#killY) this.#chars.place(this.#world.ctx, 0, this.#spawn)
  }

  state(out: CharState): CharState {
    return this.#chars.state(this.#world.ctx, 0, out)
  }

  onQueuePad(): boolean {
    return inBox(this.#pad, this.#chars.state(this.#world.ctx, 0, this.#st).pos)
  }

  setEmote(id: number, nowMs: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= EMOTES.length) {
      throw new RefusalError('hub', 'setEmote(id)', `got ${id}, must be an integer in 0..${EMOTES.length - 1}; pass an EMOTES index`)
    }
    this.#emote = id
    this.#emoteUntil = nowMs + EMOTE_MS
  }

  emote(nowMs: number): number {
    return nowMs < this.#emoteUntil ? this.#emote : 0
  }

  free(): void {
    this.#world.free()
  }
}
