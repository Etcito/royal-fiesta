import { EgeError, EgeStatus } from '@etcito/game-engine/abi'
import { entityPoses } from '@etcito/game-engine/preview'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import type { EngineInstance } from '@etcito/game-engine/loader'
import type { PreviewPose } from '@etcito/game-engine/preview'
import type { RecordValues, WorldState } from '@etcito/game-engine/world-state'
import type { SchemaLayout, ScriptModule } from '@etcito/game-engine/script'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { inBox } from '@royal-fiesta/sim/course'
import type { ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import { encodeInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { clearCharacterDetail, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { BodyRef, MechEvent, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import { refuse } from '@royal-fiesta/sim/refusal'
import { seatSpawn } from '@royal-fiesta/sim/zones/seatSpawn'
import type { Pose } from '@royal-fiesta/sim/vec'
import { MAX_LOBBY_BOTS } from '../hub/hubBots.ts'
import { EMOTE_MS, EMOTES } from '../hub/protocol.ts'
import type { RemoteView } from '../hub/remotes.ts'
import type { SceneReadView } from '../render/sceneReadView.ts'
import type { CourseV1 } from '../courseV1.ts'
import { engineCodeOfS1 } from './inputCodes.ts'
import type { EmittedScene } from './sceneEmitter.ts'
import { buildShowHubScene } from './showScene.ts'
import type { EngineShowConfig } from './showTypes.ts'

const AREA = 'ege-hub'

/** One live hub world's copied state and poses, refreshed after every step and respawn. */
class HubRead {
  tick = 0
  state: WorldState | null = null
  poses: readonly PreviewPose[] = []
  readonly itemBase: number
  readonly seatBase: number
  private readonly engine: EngineInstance
  private readonly layout: SchemaLayout
  private readonly scene: EmittedScene
  private readonly itemNames: string[]

  constructor(engine: EngineInstance, layout: SchemaLayout, scene: EmittedScene) {
    this.engine = engine
    this.layout = layout
    this.scene = scene
    this.itemNames = [...scene.itemBodies.keys()]
    this.itemBase = scene.obstacleEntities.length
    this.seatBase = this.itemBase + this.itemNames.length
  }

  refresh(world: number, tick: number): void {
    const state = readWorldState(this.engine, world, this.layout)
    this.tick = tick
    this.state = state
    const ids: number[] = [...this.scene.obstacleEntities]
    for (const name of this.itemNames) ids.push(this.scene.itemBodies.get(name)!)
    for (const entity of this.scene.seatEntities) ids.push(entity)
    this.poses = ids.length === 0 ? [] : entityPoses(this.engine, world, ids, 1)
  }

  seatKey(player: number): string {
    return String(this.scene.seatEntities[player])
  }

  seatPose(player: number): PreviewPose | undefined {
    return this.poses[this.seatBase + player]
  }

  record(name: string, player: number): RecordValues | undefined {
    return this.state?.components[name]?.[this.seatKey(player)]
  }
}

/** The hub's SceneReadView over the live world: hub obstacles, mechanism bodies and character poses. */
class HubReadView implements SceneReadView {
  readonly setup: { readonly playerCount: number }
  private readonly read: HubRead
  private readonly scene: EmittedScene
  private readonly courseData: ResolvedCourse
  private readonly itemOffsets = new Map<string, number>()

  constructor(read: HubRead, scene: EmittedScene, courseData: ResolvedCourse, playerCount: number) {
    this.read = read
    this.scene = scene
    this.courseData = courseData
    this.setup = { playerCount }
    const items = courseData.mechanisms?.items ?? []
    for (const item of items) {
      for (const body of item.bodies) this.itemOffsets.set(`${item.id}/${body.id}`, this.itemOffsets.size)
    }
  }

  get tick(): number {
    return this.read.tick
  }

  phase(out: MatchViewState): MatchViewState {
    out.tick = this.read.tick
    out.phase = Phase.playing
    out.courseIndex = 0
    return out
  }

  character(player: number, out: CharacterView): CharacterView {
    if (!Number.isInteger(player) || player < 0 || player >= this.setup.playerCount) {
      refuse(AREA, `character(${player})`, `is outside 0..${this.setup.playerCount - 1}; pass a hub seat`)
    }
    clearCharacterDetail(out)
    const pose = this.read.seatPose(player)
    const character = this.read.record('character', player)
    const seat = this.read.record('seat', player)
    const velocity = this.read.record('ege.velocity', player)
    if (pose === undefined || character === undefined) {
      this.park(out)
      return out
    }
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
    return out
  }

  course(): ResolvedCourse {
    return this.courseData
  }

  obstacleCount(): number {
    return this.scene.obstacleEntities.length
  }

  obstacleSpec(index: number): ObstacleSpec {
    const spec = this.courseData.obstacles[index]
    if (spec === undefined) refuse(AREA, `obstacleSpec(${index})`, 'has no hub obstacle; pass an index below obstacleCount()')
    return spec
  }

  obstaclePose(index: number, out: Pose): Pose {
    return this.writePose(index, out)
  }

  mechanismItemCount(): number {
    return this.courseData.mechanisms?.items.length ?? 0
  }

  mechanismItem(index: number): MechItem {
    const item = this.courseData.mechanisms?.items[index]
    if (item === undefined) refuse(AREA, `mechanismItem(${index})`, 'has no hub mechanism; pass an index below mechanismItemCount()')
    return item
  }

  mechanismBodyPose(ref: BodyRef, out: Pose): boolean {
    const item = this.courseData.mechanisms?.items[ref.item]
    const body = item?.bodies[ref.body]
    if (item === undefined || body === undefined) return false
    const local = this.itemOffsets.get(`${item.id}/${body.id}`)
    if (local === undefined) return false
    this.writePose(this.read.itemBase + local, out)
    return true
  }

  mechanismEvents(_fromTick: number, _out: MechEvent[]): number {
    return 0
  }

  signal(_id: string): boolean {
    return false
  }

  private park(out: CharacterView): void {
    out.pos.x = 0
    out.pos.y = 0
    out.pos.z = 0
    out.vel.x = 0
    out.vel.y = 0
    out.vel.z = 0
    out.facing.x = 0
    out.facing.z = 1
    out.mode = CharMode.parked
    out.status = 0
    out.teleportTick = 0
    out.parked = true
  }

  private writePose(index: number, out: Pose): Pose {
    const pose = this.read.poses[index]
    if (pose === undefined) refuse(AREA, `pose(${index})`, 'has no live hub entity; pass an index of this world')
    out.t.x = pose.t[0]
    out.t.y = pose.t[1]
    out.t.z = pose.t[2]
    out.r.x = pose.r[0]
    out.r.y = pose.r[1]
    out.r.z = pose.r[2]
    out.r.w = pose.r[3]
    return out
  }
}

/** The hub runtime contract this card implements. */
export interface HubRuntime {
  readonly tick: number
  readonly botCount: number
  readonly spawn: number
  readonly faults: number
  step(input: PlayerInput): void
  state(out: CharState, player?: number): CharState
  botViews(): RemoteView[]
  respawn(spawn: number): void
  onQueuePad(): boolean
  setEmote(id: number, nowMs: number): void
  emote(nowMs: number): number
  free(): void
  view(): SceneReadView
}

function validate(plaza: CourseV1, spawn: number, bots: number): ResolvedCourse {
  if (plaza.kind !== 'hub') {
    refuse(AREA, `courses/${plaza.id}.course.json#/kind`, `course '${plaza.id}' is not a hub course; pass the hub plaza`)
  }
  const sim = plaza.sim
  if (sim === null) refuse(AREA, `courses/${plaza.id}.course.json`, 'has no simulation part; pass a playable hub plaza')
  if (sim.queuePad === null) {
    refuse(AREA, `courses/${plaza.id}.course.json#/queuePad`, 'the hub plaza has no queue pad; add a queuePad box')
  }
  if (!Number.isInteger(spawn) || spawn < 0 || spawn >= sim.spawns.length) {
    refuse(AREA, `courses/${plaza.id}.course.json#/spawns/${spawn}`, `spawn must be an integer in 0..${sim.spawns.length - 1}; pick an existing spawn`)
  }
  if (!Number.isInteger(bots) || bots < 0 || bots > MAX_LOBBY_BOTS) {
    refuse(AREA, 'bots', `got ${bots}; pass an integer in 0..${MAX_LOBBY_BOTS}`)
  }
  if (1 + bots > sim.spawns.length) {
    refuse(AREA, 'bots', `${bots} lobby bots need ${1 + bots} spawns but the plaza has ${sim.spawns.length}`)
  }
  return sim
}

/** The plaza copy whose spawns start at `spawn`, so hub seat 0 takes that spawn and seat i a distinct one. */
function rotatedCourse(plaza: CourseV1, spawn: number): CourseV1 {
  const sim = plaza.sim!
  const spawns = [...sim.spawns.slice(spawn), ...sim.spawns.slice(0, spawn)]
  return { ...plaza, sim: { ...sim, spawns } }
}

interface HubDoc {
  doc: { entities: { components?: Record<string, RecordValues> }[] }
  emitted: EmittedScene
}

function hubDoc(config: EngineShowConfig, plaza: CourseV1, spawn: number, bots: number): HubDoc {
  const rotated = rotatedCourse(plaza, spawn)
  const sim = rotated.sim!
  const hubConfig: EngineShowConfig = {
    ...config,
    humans: [true, ...Array<boolean>(bots).fill(false)],
    courses: [...config.courses, rotated],
  }
  const emitted = buildShowHubScene(hubConfig, rotated, 0)
  const doc = JSON.parse(emitted.text) as HubDoc['doc']
  const seed = config.seed >>> 0
  doc.entities.push({
    components: { show_hub_state: { owner: 0, occupants: 0, humans: 0, bots: 0, tick: 0, rng_state: seed } },
  })
  for (let seat = 0; seat <= bots; seat++) {
    const point = seatSpawn(sim, seat).t
    doc.entities.push({
      components: {
        show_hub_occupant: {
          owner: 0, room_seat: seat, round_seat: seat, kind: seat === 0 ? 0 : 1, emote: 0, active: 1,
          wander_x: point.x, wander_z: point.z, wander_tick: 0,
          rng_state: ((seed ^ Math.imul(seat + 1, 0x9e3779b1)) >>> 0) || 1,
        },
      },
    })
  }
  return { doc, emitted }
}

class EngineHub implements HubRuntime {
  readonly botCount: number
  private readonly engine: EngineInstance
  private readonly module: ScriptModule
  private readonly host: ScriptHost
  private readonly config: EngineShowConfig
  private readonly plaza: CourseV1
  private readonly sim: ResolvedCourse
  private readonly scene: EmittedScene
  private readonly read: HubRead
  private readonly viewRead: HubReadView
  private world: number
  private base = 0
  private currentTick = 0
  private currentSpawn: number
  private emoteId = 0
  private emoteUntil = 0
  private freed = false

  constructor(
    engine: EngineInstance,
    module: ScriptModule,
    host: ScriptHost,
    layout: SchemaLayout,
    config: EngineShowConfig,
    plaza: CourseV1,
    sim: ResolvedCourse,
    spawn: number,
    bots: number,
    built: HubDoc,
    world: number,
  ) {
    this.engine = engine
    this.module = module
    this.host = host
    this.config = config
    this.plaza = plaza
    this.sim = sim
    this.botCount = bots
    this.scene = built.emitted
    this.currentSpawn = spawn
    this.world = world
    this.read = new HubRead(engine, layout, built.emitted)
    this.viewRead = new HubReadView(this.read, built.emitted, sim, 1 + bots)
    this.read.refresh(this.world, 0)
  }

  get tick(): number {
    return this.currentTick
  }

  get spawn(): number {
    return this.currentSpawn
  }

  get faults(): number {
    return this.module.faultCount
  }

  step(input: PlayerInput): void {
    this.assertLive()
    this.host.stepTick(this.world, [engineCodeOfS1(encodeInput(input))])
    this.sync()
  }

  state(out: CharState, player = 0): CharState {
    this.assertLive()
    this.assertPlayer(player)
    const character = this.read.record('character', player)
    const velocity = this.read.record('ege.velocity', player)
    const pose = this.read.seatPose(player)
    if (character === undefined || pose === undefined) {
      refuse(AREA, `state(${player})`, 'has no live hub character; step the hub before reading a seat')
    }
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
    out.grounded = character.grounded === 1
    out.groundObstacle = character.ground_obstacle as number
    out.knockbacks = character.knockbacks as number
    out.teleportTick = character.teleport_tick as number
    return out
  }

  botViews(): RemoteView[] {
    this.assertLive()
    const views: RemoteView[] = []
    for (let seat = 1; seat <= this.botCount; seat++) {
      const s = this.state(newState(), seat)
      views.push({
        seat, name: `Bot ${seat}`, colour: seat % 8, pos: { ...s.pos },
        yaw: Math.atan2(s.facing.x, s.facing.z), mode: s.mode, emote: 0,
        queued: false, inMatch: false, stale: false, spectator: false,
      })
    }
    return views
  }

  respawn(spawn: number): void {
    this.assertLive()
    if (!Number.isInteger(spawn)) refuse(AREA, 'respawn(spawn)', `got ${spawn}; pass an integer plaza spawn index`)
    const n = this.sim.spawns.length
    const index = ((spawn % n) + n) % n
    const built = hubDoc(this.config, this.plaza, index, this.botCount)
    const next = this.engine.createWorld(JSON.stringify(built.doc))
    this.base += this.engine.tick(this.world)
    this.engine.freeWorld(this.world)
    this.world = next
    this.currentSpawn = index
    this.currentTick = this.base
    this.read.refresh(this.world, this.currentTick)
  }

  onQueuePad(): boolean {
    this.assertLive()
    const pose = this.read.seatPose(0)
    if (pose === undefined) return false
    return inBox(this.sim.queuePad!, { x: pose.t[0], y: pose.t[1], z: pose.t[2] })
  }

  setEmote(id: number, nowMs: number): void {
    this.assertLive()
    if (!Number.isInteger(id) || id < 0 || id >= EMOTES.length) {
      refuse(AREA, 'setEmote(id)', `got ${id}; pass an integer in 0..${EMOTES.length - 1}`)
    }
    this.emoteId = id
    this.emoteUntil = nowMs + EMOTE_MS
  }

  emote(nowMs: number): number {
    this.assertLive()
    return nowMs < this.emoteUntil ? this.emoteId : 0
  }

  free(): void {
    if (this.freed) return
    this.freed = true
    try {
      this.engine.freeWorld(this.world)
    } finally {
      this.module.dispose()
    }
  }

  view(): SceneReadView {
    this.assertLive()
    return this.viewRead
  }

  private sync(): void {
    this.currentTick = this.base + this.engine.tick(this.world)
    this.read.refresh(this.world, this.currentTick)
  }

  private assertPlayer(player: number): void {
    if (!Number.isInteger(player) || player < 0 || player > this.botCount) {
      refuse(AREA, `state(${player})`, `is outside 0..${this.botCount}; seat 0 is the local human`)
    }
  }

  private assertLive(): void {
    if (this.freed) refuse(AREA, 'free', 'the hub was freed; create a new hub with createEngineHub')
  }
}

function newState(): CharState {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
}

/**
 * Handoff: 'Hub page integration: the engine-show page starts in the engine hub and runs shows through
 * EngineHubFlow' calls createEngineHub(config: EngineShowConfig, plaza: CourseV1, spawn: number, bots = 0)
 * and passes the returned HubRuntime to the EngineHubFlow constructor. Today it installs the schema when
 * none is loaded, loads the show scripts, builds the rotated show_hub world with occupant rows and returns
 * a HubRuntime whose state is the hub tick base, the current spawn index and the emote id/end. It is not
 * the show preparation: startShow remains the page's createEngineShow and its views and effects.
 */
export async function createEngineHub(
  config: EngineShowConfig,
  plaza: CourseV1,
  spawn: number,
  bots = 0,
): Promise<HubRuntime> {
  const sim = validate(plaza, spawn, bots)
  try {
    schemaLayout(config.engine)
  } catch (error) {
    if (!(error instanceof EgeError) || error.code !== EgeStatus.NO_SCHEMA) throw error
    config.engine.setSchema(config.schemaText)
  }
  let module: ScriptModule | undefined
  try {
    module = await loadScript(config.engine, config.scriptBytes, { name: 'rf-hub-scripts' })
    const layout = schemaLayout(config.engine)
    const built = hubDoc(config, plaza, spawn, bots)
    const host = new ScriptHost(module)
    let world = 0
    try {
      world = config.engine.createWorld(JSON.stringify(built.doc))
      return new EngineHub(config.engine, module, host, layout, config, plaza, sim, spawn, bots, built, world)
    } catch (error) {
      if (world !== 0) config.engine.freeWorld(world)
      throw error
    }
  } catch (error) {
    module?.dispose()
    throw error
  }
}
