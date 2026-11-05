// Display adapter shared by the show and zone views. Remote poses remain display-only,
// but use the same character instances, animation and costume attachments as local poses.
import type { FarFeed } from '@royal-fiesta/game/net/farFeed'
import type { FarEntity } from '@royal-fiesta/sim/zones/farState'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { clearCharacterDetail, Phase, viewCharacter } from '@royal-fiesta/sim/match/matchSim'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import type { BodyRef, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import type { Pose } from '@royal-fiesta/sim/vec'
import type { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'

export class DomainSceneSim {
  tick = 0
  readonly setup: { playerCount: number }
  private readonly courseData: ResolvedCourse
  private readonly seatDomain: (FiestaDomain | undefined)[]
  private readonly state: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: -1,
  }
  private readonly remote = new Map<number, FarEntity & { vx: number; vy: number; vz: number }>()
  private reference: FiestaDomain | null = null

  constructor(course: ResolvedCourse, seatCount: number) {
    this.courseData = course
    this.setup = { playerCount: seatCount }
    this.seatDomain = new Array<FiestaDomain | undefined>(seatCount).fill(undefined)
  }

  refresh(domains: readonly FiestaDomain[], tick: number, feed?: FarFeed): void {
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
    const elapsed = (tick - this.tick) / 60
    const next = new Map<number, FarEntity & { vx: number; vy: number; vz: number }>()
    for (const entity of feed?.read(tick, seat => this.holdsSeat(seat)) ?? []) {
      if (![entity.x, entity.y, entity.z, entity.yaw].every(Number.isFinite)) continue
      const previous = this.remote.get(entity.seat)
      const velocity = (axis: 'x' | 'y' | 'z', old: 'vx' | 'vy' | 'vz') =>
        previous === undefined ? 0 : elapsed > 0 ? (entity[axis] - previous[axis]) / elapsed : previous[old]
      next.set(entity.seat, { ...entity, vx: velocity('x', 'vx'), vy: velocity('y', 'vy'), vz: velocity('z', 'vz') })
    }
    this.remote.clear()
    for (const [seat, entity] of next) this.remote.set(seat, entity)
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
    const remote = this.remote.get(p)
    // `out` is the scene's one view for every seat: a seat without sim state must not keep the previous seat's stroke.
    if (domain === undefined) clearCharacterDetail(out)
    if (domain === undefined && remote !== undefined) {
      out.pos.x = remote.x; out.pos.y = remote.y; out.pos.z = remote.z
      out.vel.x = remote.vx; out.vel.y = remote.vy; out.vel.z = remote.vz
      out.facing.x = Math.sin(remote.yaw); out.facing.z = Math.cos(remote.yaw)
      out.mode = remote.mode
      out.status = remote.status
      out.parked = remote.mode === CharMode.parked
      out.teleportTick = -1
      return out
    }
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
    // The same copy as MatchSim.character: the scene animates the stroke, carry and slide from these fields.
    const state = viewCharacter(domain.state(p, this.state), domain.obstacles, domain.mechanisms, out)
    out.status = domain.status(p)
    out.parked = state.mode === CharMode.parked
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

  // SceneView builds one instance per mechanism body from the item list (MatchSim has the same two calls).
  mechanismItemCount(): number {
    return this.reference?.mechanisms.spec()?.items.length ?? 0
  }

  mechanismItem(i: number): MechItem {
    const item = this.reference?.mechanisms.spec()?.items[i]
    if (item === undefined) throw new Error(`no mechanism item ${i}; pass a loaded item index`)
    return item
  }

  mechanismBodyPose(ref: BodyRef, out: Pose): boolean {
    const domain = this.reference
    return domain !== null && domain.mechanisms.bodyPose(domain.ctx, ref, out)
  }

  mechanismEvents(fromTick: number, out: MechEvent[]): number {
    const domain = this.reference
    return domain === null ? 0 : domain.mechanisms.events(fromTick, out)
  }

  signal(id: string): boolean {
    const domain = this.reference
    return domain !== null && domain.mechLogic.signal(id)
  }

  // SceneView wraps step() to observe each simulation tick; the zone session steps its own domains.
  step(_inputs: readonly PlayerInput[]): void {}
}

