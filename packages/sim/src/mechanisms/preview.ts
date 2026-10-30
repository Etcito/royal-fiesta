// The world sdfm runs to preview a course's mechanisms: one player slot, no characters.
// mech-logic's `withLogic` (M2) adds MechLogicSystem; until then no signal is ever on.
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '../course.ts'
import { neutralInput } from '../input.ts'
import type { PlayerInput } from '../input.ts'
import type { BodyRef, MechEvent, MechanismView } from '../mechanismSpec.ts'
import { ObstacleSystem } from '../obstacles/system.ts'
import type { Pose } from '../vec.ts'
import { FiestaWorld } from '../world.ts'
import { MechanismSystem } from './system.ts'

export interface MechanismWorld extends MechanismView {
  readonly world: FiestaWorld<unknown>
  readonly tick: number
  step(): void
  reset(): void
  free(): void
}

export function createMechanismWorld(R: RapierModule, course: ResolvedCourse): MechanismWorld {
  const obstacles = new ObstacleSystem([course])
  const mechanisms = new MechanismSystem([course])
  // S5 relative order: obstacles before mechanisms. FiestaWorld steps at FIXED_DT.
  const world = new FiestaWorld<unknown>(R, { playerCount: 1, systems: [obstacles, mechanisms] })
  obstacles.load(world.ctx, 0)
  mechanisms.load(world.ctx, 0)
  const start = world.takeSnapshotBytes()
  const inputs: readonly PlayerInput[] = [neutralInput()]
  return {
    world,
    get tick() { return world.tick },
    step(): void { world.step(inputs) },
    reset(): void { world.restoreSnapshotBytes(start) },
    free(): void { world.free() },
    mechanismEvents(fromTick: number, out: MechEvent[]): number {
      return mechanisms.events(fromTick, out)
    },
    mechanismBodyPose(ref: BodyRef, out: Pose): boolean {
      return mechanisms.bodyPose(world.ctx, ref, out)
    },
    signal(_id: string): boolean {
      return false
    },
  }
}
