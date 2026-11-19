import type { WorldState } from '@etcito/game-engine/world-state'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { clearCharacterDetail, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { BodyRef, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { Pose } from '@royal-fiesta/sim/vec'
import type { CourseV1 } from '../courseV1.ts'
import type { CameraPose } from '../render/port.ts'
import type { RoundObservation } from './observe.ts'
import type { EngineRound } from './round.ts'
import type { EmittedScene } from './sceneEmitter.ts'

const POSE_STRIDE = 23
const SIGNAL_PREFIXES = ['switches', 'levers', 'logic'] as const

/**
 * Handoff: Engine round page: load, scene view, render bridge, composite and live mode draws this through SceneView
 * and uses focusCamera for its `focus` view. One observation and one pose call serve each drawn frame.
 */
export class EngineSceneSim {
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
    const c = this.observation!.seats[p]
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

  step(_inputs: readonly PlayerInput[]): void {}

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
