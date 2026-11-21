// G7.4: the read-only presentation boundary between a simulation host and SceneView.
// A read view exposes ticks, seats, the course, obstacles and mechanisms; stepping is not part of it.
// SceneView reads through this interface and never writes simulation state. Engine hosts observe ticks
// explicitly with SceneView.observeTick after each presented tick; only a real MatchSim receives the
// legacy step wrapper (legacySceneTicks.ts), never an arbitrary read view that happens to have step().
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import type { BodyRef, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import type { Pose } from '@royal-fiesta/sim/vec'

/**
 * Handoff: G7 round compatibility (engine-round adapter and page): EngineSceneSim already supplies
 * these reads, so it implements SceneReadView and the page calls SceneView.observeTick once after each
 * presented tick instead of casting to MatchSim. SceneView.update and observeTick take this interface;
 * legacySceneTicks.ts attachLegacySceneTicks remains the only MatchSim step wrapper. SeatSceneSim and
 * DomainSceneSim already supply these reads and stay read only.
 *
 * What SceneView needs from a simulation to present it. Implementations:
 * - answer a seat outside 0 .. setup.playerCount - 1 by refusing (a missing seat is never an index);
 * - park a seat without state explicitly and clear its optional detail (strokeTimer, strokePhase,
 *   strokeStart, slideSpeed, carry, surface, slideAir);
 * - return false from mechanismBodyPose without changing `out` when the body is absent.
 */
export interface SceneReadView {
  readonly tick: number
  readonly setup: { readonly playerCount: number }
  phase(out: MatchViewState): MatchViewState
  character(player: number, out: CharacterView): CharacterView
  course(): ResolvedCourse | null
  obstacleCount(): number
  obstacleSpec(index: number): ObstacleSpec
  obstaclePose(index: number, out: Pose): Pose
  mechanismItemCount(): number
  mechanismItem(index: number): MechItem
  mechanismBodyPose(ref: BodyRef, out: Pose): boolean
  mechanismEvents(fromTick: number, out: MechEvent[]): number
  signal(id: string): boolean
}
