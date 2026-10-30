import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import type { Pose } from '@royal-fiesta/sim/vec'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'

// SceneView reads a MatchSim-shaped view. Seats outside the local domains are parked,
// which hides them in SceneView and leaves them to FarRenderer.
export class SeatSceneSim {
  tick = 0
  readonly setup: { playerCount: number }
  private readonly courseData: ResolvedCourse
  private readonly seatDomain: (FiestaDomain | undefined)[]
  private readonly state: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: -1,
  }
  private reference: FiestaDomain | null = null

  constructor(course: ResolvedCourse, seatCount: number) {
    this.courseData = course
    this.setup = { playerCount: seatCount }
    this.seatDomain = new Array<FiestaDomain | undefined>(seatCount).fill(undefined)
  }

  refresh(domains: readonly FiestaDomain[], tick: number): void {
    this.seatDomain.fill(undefined)
    this.reference = null
    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i]
      if (this.reference === null) this.reference = domain
      const seats = domain.seats
      for (let s = 0; s < seats.length; s++) {
        const seat = seats[s]
        if (seat >= 0 && seat < this.seatDomain.length) this.seatDomain[seat] = domain
      }
    }
    this.tick = tick
  }

  holdsSeat(seat: number): boolean {
    return seat >= 0 && seat < this.seatDomain.length && this.seatDomain[seat] !== undefined
  }

  phase(out: MatchViewState): MatchViewState {
    out.tick = this.tick
    out.phase = Phase.playing
    out.courseIndex = 0
    return out
  }

  course(): ResolvedCourse {
    return this.courseData
  }

  character(p: number, out: CharacterView): CharacterView {
    const domain = this.seatDomain[p]
    if (domain === undefined) {
      out.pos.x = 0; out.pos.y = 0; out.pos.z = 0
      out.vel.x = 0; out.vel.y = 0; out.vel.z = 0
      out.facing.x = 0; out.facing.z = 1
      out.mode = CharMode.parked
      out.status = 0
      out.parked = true
      out.teleportTick = -1
      return out
    }
    const state = domain.state(p, this.state)
    out.pos.x = state.pos.x; out.pos.y = state.pos.y; out.pos.z = state.pos.z
    out.vel.x = state.vel.x; out.vel.y = state.vel.y; out.vel.z = state.vel.z
    out.facing.x = state.facing.x; out.facing.z = state.facing.z
    out.mode = state.mode
    out.status = domain.status(p)
    out.parked = state.mode === CharMode.parked
    out.teleportTick = state.teleportTick
    return out
  }

  obstacleCount(): number {
    return this.courseData.obstacles.length
  }

  obstacleSpec(i: number): ObstacleSpec {
    return this.courseData.obstacles[i]
  }

  obstaclePose(i: number, out: Pose): Pose {
    const domain = this.reference
    if (domain === null) return motionPose(this.courseData.obstacles[i], 0, 0, out)
    return domain.obstacles.pose(i, domain.tick, out)
  }

  // SceneView wraps step() to observe each simulation tick; the zone session steps its own domains.
  step(_inputs: readonly PlayerInput[]): void {}
}
