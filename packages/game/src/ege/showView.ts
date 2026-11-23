import type { EngineInstance } from '@etcito/game-engine/loader'
import { entityPoses } from '@etcito/game-engine/preview'
import type { PreviewPose } from '@etcito/game-engine/preview'
import { showSchemaLayout } from './showState.ts'
import { readShowViewState } from './worldRead.ts'
import type { RecordValues, WorldState } from '@etcito/game-engine/world-state'
import { CharMode, SLIDE_STROKE, strokeAnimPhase } from '@royal-fiesta/sim/character/constants'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import { SURFACES } from '@royal-fiesta/sim/course'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { clearCharacterDetail, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { BodyRef, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { Pose } from '@royal-fiesta/sim/vec'
import type { SceneReadView } from '../render/sceneReadView.ts'
import type { EnginePresentationWorld, EngineShowRuntime, EngineShowSnapshot } from './showTypes.ts'

const SEAT_COUNT = 60
const NEAR_LIMIT = 8
const SIGNAL_PREFIXES = ['switches', 'levers', 'logic'] as const
// G6 E3: the character timer value of a belly slide's airtime (packages/sim/src/character/system.ts:96).
const SLIDE_AIR_TIMER = -1

/** The engine reads this view needs; the default uses the engine's own pose and world-state APIs. */
export interface EngineViewReaders {
  poses(engine: EngineInstance, world: number, ids: readonly number[], alpha: number): readonly PreviewPose[]
  state(engine: EngineInstance, world: number): WorldState
}

export const ENGINE_VIEW_READERS: EngineViewReaders = {
  poses: (engine, world, ids, alpha) => (ids.length === 0 ? [] : entityPoses(engine, world, ids, alpha)),
  state: (engine, world) => readShowViewState(engine, world, showSchemaLayout(engine)),
}

/** One live physics world of the current presentation, with its borrowed poses and state for this refresh only. */
interface LiveWorld {
  readonly meta: EnginePresentationWorld
  readonly engine: EngineInstance
  readonly poses: Map<number, PreviewPose>
  readonly state: WorldState
}

/** A stable room seat whose live mapping is valid and not parked, with the world that owns its entity. */
interface SeatSlot {
  readonly roomSeat: number
  readonly inputSlot: number
  readonly live: LiveWorld
  readonly entity: number
}

const PHASE_OF: Readonly<Record<EngineShowSnapshot['screen'], number>> = {
  vote: Phase.intermission,
  loading: Phase.intermission,
  intro: Phase.intro,
  playing: Phase.playing,
  overtime: Phase.playing,
  results: Phase.roundEnd,
  podium: Phase.podium,
  done: Phase.done,
}

/**
 * Handoff: G7-PAGE presentation: complete the round and confirmed podium calls EngineShowView.refresh once per
 * post-tick observation, then reads character, obstacle and mechanism views and nearSeats for the drawn frame.
 * Today refresh copies runtime.presentation() and the runtime snapshot, rebuilds every live world's poses and
 * state, and selects the near seats; nothing is retained across a refresh, so replaced worlds are never read.
 */
export class EngineShowView implements SceneReadView {
  tick = 0
  readonly setup: { readonly playerCount: number } = { playerCount: SEAT_COUNT }
  private readonly runtime: EngineShowRuntime
  private readonly readers: EngineViewReaders
  private activeCourse: ResolvedCourse | null = null
  private snapshot: EngineShowSnapshot | null = null
  private lives: LiveWorld[] = []
  private readonly slots = new Map<number, SeatSlot>()
  private near: number[] = []
  private disposed = false

  constructor(runtime: EngineShowRuntime, readers: EngineViewReaders = ENGINE_VIEW_READERS) {
    this.runtime = runtime
    this.readers = readers
  }

  /**
   * Rebuilds every borrowed view from the current presentation and the given interpolation alpha. This is the
   * sole writer of the near set: it selects active human seats first (inputSlot, then roomSeat), then fills
   * up to eight with active bots in ascending roomSeat order. Other live seats are far candidates only.
   */
  refresh(alpha: number): void {
    if (this.disposed) refuse('ege-show-view', 'refresh', 'was disposed; create a new EngineShowView for this runtime')
    const presentation = this.runtime.presentation()
    this.tick = presentation.tick
    this.activeCourse = presentation.course
    this.snapshot = this.runtime.snapshot()
    this.lives = presentation.worlds.map(meta => this.readLive(meta, alpha))
    this.collectSlots()
    this.near = this.selectNear()
  }

  /** The stable room seats selected for near rendering in the last refresh, as a copy. */
  nearSeats(): ReadonlySet<number> {
    return new Set(this.near)
  }

  /** Drops every borrowed view and the near set; the view is refused until it is created again. */
  dispose(): void {
    this.disposed = true
    this.lives = []
    this.slots.clear()
    this.near = []
    this.activeCourse = null
    this.snapshot = null
  }

  phase(out: MatchViewState): MatchViewState {
    const snapshot = this.requireSnapshot('phase')
    const lastResult = snapshot.results[snapshot.results.length - 1]
    const confirmed = [...snapshot.results].reverse().find(result => result.champion !== -1)
    out.tick = this.tick
    out.phase = PHASE_OF[snapshot.screen]
    out.phaseTicksLeft = 0
    out.roundIndex = snapshot.round
    out.roundKind = this.activeCourse?.kind === 'race' || this.activeCourse?.kind === 'survival' ? this.activeCourse.kind : null
    out.final = false
    out.courseIndex = this.activeCourse === null ? -1 : 0
    out.roundTicksLeft = 0
    out.alive = snapshot.alive.length
    out.target = 0
    out.qualifiedCount = lastResult?.qualified.length ?? 0
    out.winner = snapshot.champion ?? -1
    out.podium = confirmed === undefined ? [] : confirmed.ranking.slice(0, 3)
    return out
  }

  character(p: number, out: CharacterView): CharacterView {
    this.requireSnapshot('character')
    if (!Number.isInteger(p) || p < 0 || p >= SEAT_COUNT) {
      refuse('ege-show-view', `character(${p})`, `is outside 0..${SEAT_COUNT - 1}; pass a stable room seat`)
    }
    clearCharacterDetail(out)
    const slot = this.near.includes(p) ? this.slots.get(p) : undefined
    const key = slot === undefined ? '' : String(slot.entity)
    const character = slot?.live.state.components.character?.[key]
    const pose = slot === undefined ? undefined : slot.live.poses.get(slot.entity)
    if (slot === undefined || character === undefined || pose === undefined) {
      this.parkOut(out)
      return out
    }
    const velocity = slot.live.state.components['ege.velocity']?.[key]
    const seat = slot.live.state.components.seat?.[key]
    const lin = (velocity?.lin ?? [0, 0, 0]) as number[]
    const facing = character.facing as number[]
    out.pos.x = pose.t[0]
    out.pos.y = pose.t[1]
    out.pos.z = pose.t[2]
    out.vel.x = lin[0]
    out.vel.y = lin[1]
    out.vel.z = lin[2]
    out.facing.x = facing[0]
    out.facing.z = facing[1]
    out.mode = character.mode as number
    out.status = (seat?.status as number | undefined) ?? 0
    out.teleportTick = character.teleport_tick as number
    out.parked = out.mode === CharMode.parked
    if (!out.parked) this.seatDetail(slot.live, character, out)
    return out
  }

  course(): ResolvedCourse | null {
    return this.activeCourse
  }

  obstacleCount(): number {
    return this.primary()?.meta.obstacles.length ?? 0
  }

  obstacleSpec(i: number): ObstacleSpec {
    const spec = this.primary()?.meta.obstacles[this.indexOf(i, this.obstacleCount(), 'obstacleSpec')]?.spec
    if (spec === undefined) refuse('ege-show-view', `obstacleSpec(${i})`, 'has no live obstacle; pass an index below obstacleCount()')
    return spec
  }

  obstaclePose(i: number, out: Pose): Pose {
    const live = this.primary()
    const index = this.indexOf(i, this.obstacleCount(), 'obstaclePose')
    const pose = live?.poses.get(live.meta.obstacles[index]?.entity ?? -1)
    return pose === undefined ? out : writePose(pose, out)
  }

  mechanismItemCount(): number {
    return this.activeCourse?.mechanisms?.items.length ?? 0
  }

  mechanismItem(i: number): MechItem {
    const item = this.activeCourse?.mechanisms?.items[this.indexOf(i, this.mechanismItemCount(), 'mechanismItem')]
    if (item === undefined) refuse('ege-show-view', `mechanismItem(${i})`, 'is outside the course mechanisms')
    return item
  }

  mechanismBodyPose(ref: BodyRef, out: Pose): boolean {
    const item = this.activeCourse?.mechanisms?.items[ref.item]
    const body = item?.bodies[ref.body]
    const live = this.primary()
    if (item === undefined || body === undefined || live === undefined) return false
    const entity = live.meta.bodies.get(`${item.id}/${body.id}`)
    const pose = entity === undefined ? undefined : live.poses.get(entity)
    if (pose === undefined) return false
    writePose(pose, out)
    return true
  }

  mechanismEvents(_fromTick: number, _out: MechEvent[]): number {
    return 0
  }

  signal(id: string): boolean {
    for (const live of this.lives) {
      const signals = live.state.components['ege.mech.signal']
      if (signals === undefined) continue
      for (const prefix of SIGNAL_PREFIXES) {
        const entity = live.meta.scene.index(`${prefix}/${id}`)
        if (entity < 0) continue
        const record = signals[String(entity)]
        if (record !== undefined) return record.value === 1
      }
    }
    return false
  }

  private readLive(meta: EnginePresentationWorld, alpha: number): LiveWorld {
    const engine = meta.ref.timeline.module.engine
    const ids = [
      ...meta.obstacles.map(obstacle => obstacle.entity),
      ...meta.bodies.values(),
      ...meta.seats.map(seat => seat.entity),
    ]
    const poses = new Map<number, PreviewPose>()
    const read = this.readers.poses(engine, meta.ref.world, ids, alpha)
    ids.forEach((entity, index) => poses.set(entity, read[index]))
    return { meta, engine, poses, state: this.readers.state(engine, meta.ref.world) }
  }

  // Collects each valid, active, non-parked mapping; a stable room seat owned by two entities refuses.
  private collectSlots(): void {
    this.slots.clear()
    const active = new Set(this.snapshot?.seatOf ?? [])
    for (const live of this.lives) {
      for (const seat of live.meta.seats) {
        if (!Number.isInteger(seat.roomSeat) || seat.roomSeat < 0 || seat.roomSeat >= SEAT_COUNT) {
          refuse('ege-show-view', `presentation.seats/${seat.roomSeat}`, 'is not a stable room seat 0..59')
        }
        const character = live.state.components.character?.[String(seat.entity)]
        const pose = live.poses.get(seat.entity)
        if (!active.has(seat.roomSeat) || character === undefined || pose === undefined) continue
        if (character.mode === CharMode.parked) continue
        const prior = this.slots.get(seat.roomSeat)
        if (prior !== undefined && (prior.entity !== seat.entity || prior.live !== live)) {
          refuse('ege-show-view', `presentation.seats/${seat.roomSeat}`, 'is owned by two live entities at once; resolve the duplicate mapping')
        }
        this.slots.set(seat.roomSeat, { roomSeat: seat.roomSeat, inputSlot: seat.inputSlot, live, entity: seat.entity })
      }
    }
  }

  private selectNear(): number[] {
    const all = [...this.slots.values()]
    const humans = all.filter(slot => slot.inputSlot >= 0).sort((a, b) => a.inputSlot - b.inputSlot || a.roomSeat - b.roomSeat)
    const bots = all.filter(slot => slot.inputSlot < 0).sort((a, b) => a.roomSeat - b.roomSeat)
    return [...humans, ...bots].slice(0, NEAR_LIMIT).map(slot => slot.roomSeat)
  }

  private seatDetail(live: LiveWorld, record: RecordValues, out: CharacterView): void {
    const mode = record.mode as number
    const timer = record.timer as number
    const strokeTimer = record.stroke_timer as number
    out.strokeTimer = strokeTimer
    out.strokePhase = mode === CharMode.swim ? undefined : strokeAnimPhase(SLIDE_STROKE, strokeTimer)
    out.strokeStart = SLIDE_STROKE.startFrac
    out.slideSpeed = record.slide_speed as number
    out.carry = record.carry as number
    out.slideAir = mode === CharMode.air && timer === SLIDE_AIR_TIMER
    out.surface = this.groundSurface(live, record)
  }

  // The ground is a mechanism body or course obstacle of the character's own world; its surface record names the kind.
  private groundSurface(live: LiveWorld, record: RecordValues): string {
    const item = record.ground_item as number
    const body = record.ground_body as number
    const obstacle = record.ground_obstacle as number
    let entity = -1
    if (item >= 0 && body >= 0) {
      const spec = this.activeCourse?.mechanisms?.items[item]
      const part = spec?.bodies[body]
      if (spec !== undefined && part !== undefined) entity = live.meta.bodies.get(`${spec.id}/${part.id}`) ?? -1
    } else if (obstacle >= 0) {
      entity = live.meta.obstacles[obstacle]?.entity ?? -1
    }
    if (entity < 0) return 'normal'
    const surface = live.state.components.surface?.[String(entity)]
    if (surface === undefined) return 'normal'
    return SURFACES[surface.kind as number] ?? 'normal'
  }

  private parkOut(out: CharacterView): void {
    out.pos.x = 0
    out.pos.y = 0
    out.pos.z = 0
    out.vel.x = 0
    out.vel.y = 0
    out.vel.z = 0
    out.facing.x = 0
    out.facing.z = 0
    out.mode = CharMode.parked
    out.status = 0
    out.teleportTick = 0
    out.parked = true
  }

  private primary(): LiveWorld | undefined {
    return this.lives[0]
  }

  private indexOf(index: number, count: number, operation: string): number {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      refuse('ege-show-view', `${operation}(${index})`, `is outside 0..${count - 1}; pass an index of the live course`)
    }
    return index
  }

  private requireSnapshot(operation: string): EngineShowSnapshot {
    if (this.snapshot === null) refuse('ege-show-view', operation, 'was called before refresh or after dispose; refresh the view first')
    return this.snapshot
  }
}

function writePose(pose: PreviewPose, out: Pose): Pose {
  out.t.x = pose.t[0]
  out.t.y = pose.t[1]
  out.t.z = pose.t[2]
  out.r.x = pose.r[0]
  out.r.y = pose.r[1]
  out.r.z = pose.r[2]
  out.r.w = pose.r[3]
  return out
}
