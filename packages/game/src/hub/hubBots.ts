// View-independent offline lobby pilots. Steering uses the same seeded brain as round bots.
import { Rng } from '@gamesaloon/rollback'
import { newMemory, rollSkill, survivalBrain } from '@royal-fiesta/sim/bots/brain'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse, SpawnPoint } from '@royal-fiesta/sim/course'
import { decodeInput, neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'

export const DEFAULT_LOBBY_BOTS = 1
export const MAX_LOBBY_BOTS = 8

export class HubBot {
  private readonly rng: Rng
  private readonly memory = newMemory()
  private readonly skill: ReturnType<typeof rollSkill>
  private readonly course: ResolvedCourse
  private readonly target = { x: 0, y: 0, z: 0 }
  private readonly wander = { x: 0, z: 0 }
  readonly input: PlayerInput = neutralInput()
  readonly spawn: SpawnPoint

  constructor(plaza: ResolvedCourse, home: SpawnPoint, index: number, seed: number) {
    this.rng = new Rng(seed).fork(0x687562 + index)
    this.skill = rollSkill(this.rng)
    // Close enough to try grabbing without first crossing the plaza; leave space between bodies.
    const a = index * Math.PI / 4
    this.spawn = { t: { x: home.t.x + 2.2 * Math.sin(a), y: home.t.y, z: home.t.z + 2.2 * Math.cos(a) }, facing: { x: 0, z: -1 } }
    this.course = { ...plaza, path: [{ p: this.target, jump: false, dive: false }] }
  }

  sample(state: CharState, human: CharState, tick: number): PlayerInput {
    if (tick % 120 === 0) {
      const a = this.rng.range(0, Math.PI * 2), radius = this.rng.range(1, 4)
      this.wander.x = this.spawn.t.x + Math.sin(a) * radius
      this.wander.z = this.spawn.t.z + Math.cos(a) * radius
    }
    const dx = state.pos.x - human.pos.x, dz = state.pos.z - human.pos.z
    const distance = Math.hypot(dx, dz)
    if (distance < 1.8 && distance > 0.01) {
      this.target.x = state.pos.x + dx / distance * 2
      this.target.z = state.pos.z + dz / distance * 2
    } else if (distance > 8) {
      this.target.x = human.pos.x
      this.target.z = human.pos.z
    } else {
      this.target.x = this.wander.x
      this.target.z = this.wander.z
    }
    this.target.y = state.pos.y
    decodeInput(survivalBrain({ course: this.course, ...state, obstacleAhead: false, hazardNear: false }, this.skill, this.memory, this.rng), this.input)
    // A human can overtake the wanderer and catch it with the normal grab cone.
    this.input.moveX *= 0.5
    this.input.moveZ *= 0.5
    return this.input
  }
}
