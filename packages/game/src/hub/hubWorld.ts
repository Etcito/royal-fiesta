import { HubBot, MAX_LOBBY_BOTS } from './hubBots.ts'
import type { RemoteView } from './remotes.ts'
// HubWorld: the local, non-rollback plaza, optionally with physical bot characters. It runs the match character controller so the hub
// feels like the rounds; nothing here is networked or snapshotted.
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { CharacterSystem } from '@royal-fiesta/sim/character/system'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { inBox } from '@royal-fiesta/sim/course'
import type { Box, ResolvedCourse, SpawnPoint } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { MechLogicSystem } from '@royal-fiesta/sim/mechanisms/logicSystem'
import { MechanismSystem } from '@royal-fiesta/sim/mechanisms/system'
import { ObstacleSystem } from '@royal-fiesta/sim/obstacles/system'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { FiestaWorld } from '@royal-fiesta/sim/world'
import type { SimSystem } from '@royal-fiesta/sim/world'
import { EMOTE_MS, EMOTES } from './protocol.ts'

export class HubWorld {
  readonly #world: FiestaWorld<PlayerInput>
  readonly #chars: CharacterSystem
  #spawn: SpawnPoint
  readonly #spawns: readonly SpawnPoint[]
  readonly #killY: number
  readonly #pad: Box
  readonly #inputs: PlayerInput[] = []
  readonly #st: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
  readonly #bots: HubBot[] = []
  readonly #human: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
  #emote = 0
  #emoteUntil = 0

  constructor(R: RapierModule, plaza: ResolvedCourse, spawn: number, bots = 0, seed = 1) {
    if (plaza.kind !== 'hub') {
      throw new RefusalError('hub', `${plaza.id}#/kind`, `got '${plaza.kind}', the hub needs a course of kind 'hub'; pass the hub plaza course`)
    }
    if (plaza.queuePad === null) {
      throw new RefusalError('hub', `${plaza.id}#/queuePad`, 'the hub needs a queue pad; add a queuePad box to the course')
    }
    if (!Number.isInteger(spawn) || spawn < 0 || spawn >= plaza.spawns.length) {
      throw new RefusalError('hub', `${plaza.id}#/spawns/${spawn}`, `spawn must be an integer in 0..${plaza.spawns.length - 1}; pick an existing spawn`)
    }
    if (!Number.isInteger(bots) || bots < 0 || bots > MAX_LOBBY_BOTS) throw new RefusalError('hub', 'bots', 'pass an integer in 0..8')
    for (let i = 0; i < bots; i++) this.#bots.push(new HubBot(plaza, plaza.spawns[spawn], i, seed))
    this.#pad = plaza.queuePad
    this.#spawn = plaza.spawns[spawn]
    this.#spawns = plaza.spawns
    this.#killY = plaza.killPlaneY
    const obstacles = new ObstacleSystem([plaza])
    const mechLogic = new MechLogicSystem([plaza])
    const mechanisms = new MechanismSystem([plaza])
    this.#chars = new CharacterSystem({ playerCount: 1 + bots })
    this.#world = new FiestaWorld<PlayerInput>(R, {
      playerCount: 1 + bots, maxPlayers: 1 + MAX_LOBBY_BOTS,
      systems: [obstacles as SimSystem<PlayerInput>, mechLogic, mechanisms, this.#chars],
    })
    const ctx = this.#world.ctx
    obstacles.load(ctx, 0)
    mechanisms.load(ctx, 0)
    mechLogic.load(ctx, 0)
    this.#chars.place(ctx, 0, this.#spawn)
    this.#bots.forEach((bot, i) => this.#chars.place(ctx, i + 1, bot.spawn))
  }

  get tick(): number { return this.#world.tick }

  // One fixed 60 Hz tick; the caller owns the accumulator.
  step(input: PlayerInput): void {
    this.#inputs[0] = input
    const human = this.state(this.#human)
    for (let i = 0; i < this.#bots.length; i++) this.#inputs[i + 1] = this.#bots[i].sample(this.state(this.#st, i + 1), human, this.tick)
    this.#world.step(this.#inputs)
    const s = this.#chars.state(this.#world.ctx, 0, this.#st)
    if (s.pos.y < this.#killY) this.#chars.place(this.#world.ctx, 0, this.#spawn)
    for (let i = 0; i < this.#bots.length; i++) {
      if (this.state(this.#st, i + 1).pos.y < this.#killY) this.#chars.place(this.#world.ctx, i + 1, this.#bots[i].spawn)
    }
  }

  state(out: CharState, player = 0): CharState {
    return this.#chars.state(this.#world.ctx, player, out)
  }

  get botCount(): number { return this.#bots.length }

  /** These poses are actual characters in this physics world, not network/display-only remotes. */
  botViews(): RemoteView[] {
    return this.#bots.map((_bot, i) => {
      const s = this.state(this.#st, i + 1)
      return { seat: i + 1, name: `Bot ${i + 1}`, colour: (i + 1) % 8, pos: { ...s.pos },
        yaw: Math.atan2(s.facing.x, s.facing.z), mode: s.mode, emote: 0,
        queued: false, inMatch: false, stale: false, spectator: false }
    })
  }

  /** Puts the bean on a plaza spawn (any integer, wrapped onto the plaza's spawns): its place in a shared hub. Falls back there too. */
  respawn(spawn: number): void {
    const n = this.#spawns.length
    this.#spawn = this.#spawns[((spawn % n) + n) % n]
    this.#chars.place(this.#world.ctx, 0, this.#spawn)
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
