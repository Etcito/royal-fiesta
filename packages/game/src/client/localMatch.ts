import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'

const STEP_S = 1 / 60

export interface LocalMatchOptions {
  R: RapierModule; seats: number; seed: number; profile: ProfileName; courses: readonly ResolvedCourse[]
}

// One shared simulation for all local seats; no snapshots or rollback session.
export class LocalMatch {
  readonly sim: MatchSim
  private readonly seats: number
  private readonly inputs: PlayerInput[] = Array.from({ length: 8 }, () => neutralInput())
  private acc = 0
  private disposed = false

  constructor(o: LocalMatchOptions) {
    if (!Number.isInteger(o.seats) || o.seats < 1 || o.seats > 4) {
      refuse('client', 'localMatch', `${o.seats} is outside 1..4; pass the number of local seats (1..4)`)
    }
    this.seats = o.seats
    this.sim = new MatchSim(o.R, {
      seed: o.seed, playerCount: 8, humans: Array.from({ length: 8 }, (_, p) => p < o.seats),
      profile: o.profile, courses: o.courses,
    })
  }

  get done(): boolean {
    return this.sim.done
  }

  frame(dtS: number, sample: (seat: number, out: PlayerInput) => void): number {
    this.acc = Math.min(this.acc + dtS, 8 * STEP_S)
    while (this.acc >= STEP_S && !this.sim.done) {
      for (let seat = 0; seat < this.seats; seat++) sample(seat, this.inputs[seat])
      this.sim.step(this.inputs)
      this.acc -= STEP_S
    }
    return this.done ? 1 : this.acc / STEP_S
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sim.free()
  }
}
