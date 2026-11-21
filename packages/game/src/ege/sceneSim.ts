import type { RecordValues, WorldState } from '@etcito/game-engine/world-state'
import { CharMode, SLIDE_STROKE, strokeAnimPhase } from '@royal-fiesta/sim/character/constants'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import { SURFACES } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { clearCharacterDetail, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { BodyRef, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { Pose } from '@royal-fiesta/sim/vec'
import type { CourseV1 } from '../courseV1.ts'
import type { CameraPose } from '../render/port.ts'
import type { SceneReadView } from '../render/sceneReadView.ts'
import type { RoundObservation } from './observe.ts'
import type { EngineRound } from './round.ts'
import type { EmittedScene } from './sceneEmitter.ts'

const POSE_STRIDE = 23
const SIGNAL_PREFIXES = ['switches', 'levers', 'logic'] as const
// G6 E3: the character timer value of a belly slide's airtime (packages/sim/src/character/system.ts:96).
const SLIDE_AIR_TIMER = -1

/**
 * Handoff: Engine round page: load, scene view, render bridge, composite and live mode draws this through SceneView
 * and uses focusCamera for its `focus` view. One observation and one pose call serve each drawn frame.
 * G7.4: the page presents this read-only adapter through SceneReadView and calls observeTick once per executed
 * round tick; step() stays a compatibility no-op for older callers and is outside the read interface.
 */
export class EngineSceneSim implements SceneReadView {
  tick = 0
  readonly setup: { playerCount: 8 } = { playerCount: 8 }
  private readonly courseData: ResolvedCourse
  private readonly scene: EmittedScene
  private readonly itemBase: number
  private readonly itemNames: string[]
  private readonly itemOffsets = new Map<string, number>()
  private readonly seatBase: number
  private poses: Float32Array = new Float32Array(0)
  private observation: RoundObservation | null = null
  private round: EngineRound | null = null
  private state: WorldState | null = null

  constructor(course: CourseV1, scene: EmittedScene) {
    const sim = course.sim
    if (sim === null) {
      refuse('ege-view', `courses/${course.id}.course.json`, 'has no simulation part; pass a race or survival course')
    }
    this.courseData = sim
    this.scene = scene
    this.itemBase = scene.obstacleEntities.length
    this.itemNames = [...scene.itemBodies.keys()]
    for (let i = 0; i < this.itemNames.length; i++) this.itemOffsets.set(this.itemNames[i], i)
    this.seatBase = this.itemBase + this.itemNames.length
  }

  refresh(round: EngineRound): void {
    const obs = round.observe()
    this.tick = obs.tick
    this.observation = obs
    this.round = round
    this.state = null
    const ids: number[] = []
    for (const entity of this.scene.obstacleEntities) ids.push(entity)
    for (const name of this.itemNames) ids.push(this.scene.itemBodies.get(name)!)
    for (const entity of this.scene.seatEntities) ids.push(entity)
    this.poses = round.poses(ids)
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
    if (this.observation === null) {
      refuse('ege-view', 'refresh', 'was never called; refresh the adapter with an engine round before reading a seat')
    }
    if (!Number.isInteger(p) || p < 0 || p >= this.setup.playerCount) {
      refuse('ege-view', `character(${p})`, `is outside 0..${this.setup.playerCount - 1}; pass a seat of this round`)
    }
    const c = this.observation.seats[p]
    // `out` is the scene's one view for every seat: a parked or missing seat keeps no earlier seat's detail.
    clearCharacterDetail(out)
    const base = (this.seatBase + p) * POSE_STRIDE
    out.pos.x = this.poses[base]
    out.pos.y = this.poses[base + 1]
    out.pos.z = this.poses[base + 2]
    out.vel.x = c.vel.x
    out.vel.y = c.vel.y
    out.vel.z = c.vel.z
    out.facing.x = c.facing.x
    out.facing.z = c.facing.z
    out.mode = c.mode
    out.status = c.status
    out.teleportTick = c.teleportTick
    out.parked = c.mode === CharMode.parked
    if (!out.parked) this.seatDetail(c.entity, out)
    return out
  }

  obstacleCount(): number {
    return this.courseData.obstacles.length
  }

  obstacleSpec(i: number): ObstacleSpec {
    return this.courseData.obstacles[i]
  }

  obstaclePose(i: number, out: Pose): Pose {
    return this.writePose(i, out)
  }

  mechanismItemCount(): number {
    return this.courseData.mechanisms?.items.length ?? 0
  }

  mechanismItem(i: number): MechItem {
    const item = this.courseData.mechanisms?.items[i]
    if (item === undefined) throw new Error(`no mechanism item ${i}; pass a loaded item index`)
    return item
  }

  mechanismBodyPose(ref: BodyRef, out: Pose): boolean {
    const item = this.courseData.mechanisms?.items[ref.item]
    const body = item?.bodies[ref.body]
    if (item === undefined || body === undefined) return false
    const local = this.itemOffsets.get(`${item.id}/${body.id}`)
    if (local === undefined) return false
    this.writePose(this.itemBase + local, out)
    return true
  }

  mechanismEvents(_fromTick: number, _out: MechEvent[]): number {
    return 0
  }

  signal(id: string): boolean {
    const round = this.round
    if (round === null) return false
    const state = this.state ?? (this.state = round.worldState())
    const signals = state.components['ege.mech.signal']
    if (signals === undefined) return false
    for (const prefix of SIGNAL_PREFIXES) {
      const entity = this.scene.index(`${prefix}/${id}`)
      if (entity < 0) continue
      const record = signals[String(entity)]
      if (record === undefined) continue
      return record.value === 1
    }
    return false
  }

  // Compatibility only: the page steps its EngineRound (and observes each tick) instead of this read adapter.
  step(_inputs: readonly PlayerInput[]): void {}

  /**
   * G7.4: RoundObservation omits the animation detail (stroke, slide, carry, surface), so it is read from the
   * engine's own character/surface records once per tick and copied the way MatchSim.character copies it.
   * A seat without a character record keeps no detail; a parked seat never reaches here.
   */
  private seatDetail(entity: number, out: CharacterView): void {
    const round = this.round
    if (round === null) return
    const state = this.state ?? (this.state = round.worldState())
    const record = state.components.character?.[String(entity)]
    if (record === undefined) return
    const mode = record.mode as number
    const timer = record.timer as number
    const strokeTimer = record.stroke_timer as number
    out.strokeTimer = strokeTimer
    out.strokePhase = mode === CharMode.swim ? undefined : strokeAnimPhase(SLIDE_STROKE, strokeTimer)
    out.strokeStart = SLIDE_STROKE.startFrac
    out.slideSpeed = record.slide_speed as number
    out.carry = record.carry as number
    out.slideAir = mode === CharMode.air && timer === SLIDE_AIR_TIMER
    out.surface = this.groundSurface(state, record)
  }

  // The character's ground is a mechanism body or course obstacle; its `surface` record names the surface kind.
  private groundSurface(state: WorldState, record: RecordValues): string {
    const item = record.ground_item as number
    const body = record.ground_body as number
    const obstacle = record.ground_obstacle as number
    let entity = -1
    if (item >= 0 && body >= 0) {
      const spec = this.courseData.mechanisms?.items[item]
      const part = spec?.bodies[body]
      if (spec !== undefined && part !== undefined) entity = this.scene.itemBodies.get(`${spec.id}/${part.id}`) ?? -1
    } else if (obstacle >= 0) {
      entity = this.scene.obstacleEntities[obstacle] ?? -1
    }
    if (entity < 0) return 'normal'
    const surface = state.components.surface?.[String(entity)]
    if (surface === undefined) return 'normal'
    return SURFACES[surface.kind as number] ?? 'normal'
  }

  private writePose(offset: number, out: Pose): Pose {
    const base = offset * POSE_STRIDE
    out.t.x = this.poses[base]
    out.t.y = this.poses[base + 1]
    out.t.z = this.poses[base + 2]
    out.r.x = this.poses[base + 3]
    out.r.y = this.poses[base + 4]
    out.r.z = this.poses[base + 5]
    out.r.w = this.poses[base + 6]
    return out
  }
}

// E7: the focus view of a feature, looking along +Z from behind and above its centre.
export function focusCamera(center: { x: number; y: number; z: number }): CameraPose {
  return {
    eye: [center.x, center.y + 9, center.z - 14],
    target: [center.x, center.y + 1, center.z],
    fovYDeg: 60,
    near: 0.1,
    far: 500,
  }
}
