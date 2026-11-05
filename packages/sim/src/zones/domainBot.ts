import { Rng } from '@gamesaloon/rollback'
import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { newMemory, raceBrain, rollSkill, survivalBrain } from '../bots/brain.ts'
import type { CharState } from '../character/system.ts'
import type { ResolvedCourse } from '../course.ts'
import { NEUTRAL_CODE } from '../input.ts'

/** A seat's existing brain, including reaction delay. Travels with the seat on rollback and handoff. */
export class DomainBot {
  private readonly rng: Rng
  private readonly skill: ReturnType<typeof rollSkill>
  private readonly memory = newMemory()
  private readonly ring: Int32Array
  private head = 0

  constructor(seed: number, seat: number) {
    this.rng = new Rng(seed).fork(0xb0700000 + seat)
    this.skill = rollSkill(this.rng)
    this.ring = new Int32Array(this.skill.reactionTicks).fill(NEUTRAL_CODE)
  }

  sample(course: ResolvedCourse, state: CharState): number {
    const input = { course, ...state, obstacleAhead: false, hazardNear: false }
    const code = course.kind === 'survival'
      ? survivalBrain(input, this.skill, this.memory, this.rng)
      : raceBrain(input, this.skill, this.memory, this.rng)
    if (this.ring.length === 0) return code
    const delayed = this.ring[this.head]
    this.ring[this.head] = code
    this.head = (this.head + 1) % this.ring.length
    return delayed
  }

  snapshot(w: SnapWriter): void {
    const m = this.memory
    w.u32(this.rng.state)
    w.i32(m.pathIndex); w.i32(m.stuckTicks)
    w.f64(m.lastX); w.f64(m.lastZ); w.f64(m.wobble)
    w.i32(m.ticks); w.i32(m.waitTicks)
    w.u8(this.head)
    for (const code of this.ring) w.u32(code)
  }

  restore(r: SnapReader): void {
    const m = this.memory
    this.rng.state = r.u32()
    m.pathIndex = r.i32(); m.stuckTicks = r.i32()
    m.lastX = r.f64(); m.lastZ = r.f64(); m.wobble = r.f64()
    m.ticks = r.i32(); m.waitTicks = r.i32()
    this.head = r.u8()
    for (let i = 0; i < this.ring.length; i++) this.ring[i] = r.u32()
  }
}
