import { EgeError, EgeStatus } from '@etcito/game-engine/abi'
import { entityPoses } from '@etcito/game-engine/preview'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { decodeEvents, readWorldState } from '@etcito/game-engine/world-state'
import type { EngineInstance } from '@etcito/game-engine/loader'
import type { PreviewPose } from '@etcito/game-engine/preview'
import type { SchemaLayout, ScriptModule } from '@etcito/game-engine/script'
import type { WorldState } from '@etcito/game-engine/world-state'
import { NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { DomainBot } from '@royal-fiesta/sim/zones/domainBot'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import { refuse } from '@royal-fiesta/sim/refusal'
import { engineCodeOfS1 } from './inputCodes.ts'
import { charStateOf, observeRound } from './observe.ts'
import type { RoundObservation } from './observe.ts'
import type { EmittedScene } from './sceneEmitter.ts'
import type { CourseV1 } from '../courseV1.ts'

export interface RoundSetup {
  profile: ProfileName
  seed: number
  humans: readonly boolean[]
}

export async function createEngineRound(
  engine: EngineInstance,
  schemaText: string,
  scriptBytes: BufferSource,
  scene: EmittedScene,
  course: CourseV1,
  setup: RoundSetup,
): Promise<EngineRound> {
  if (setup.humans.length !== 8) {
    refuse('ege-round', 'setup.humans', `has ${setup.humans.length} seats; pass 8 booleans, false for a bot seat`)
  }
  if (!course.sim) refuse('ege-round', 'course.sim', 'has no simulation data; pass a race or survival course')
  try {
    schemaLayout(engine)
  } catch (error) {
    if (!(error instanceof EgeError) || error.code !== EgeStatus.NO_SCHEMA) throw error
    engine.setSchema(schemaText)
  }
  const module = await loadScript(engine, scriptBytes, { name: 'rf-scripts' })
  const world = engine.createWorld(scene.text)
  const host = new ScriptHost(module)
  const layout = schemaLayout(engine)
  return new EngineRound(engine, world, module, host, layout, scene, course.sim, setup)
}

export class EngineRound {
  readonly engine: EngineInstance
  readonly world: number
  readonly module: ScriptModule
  readonly host: ScriptHost
  readonly layout: SchemaLayout
  readonly scene: EmittedScene
  private board: WorldState
  private current: RoundObservation
  private readonly bots: (DomainBot | null)[]
  private readonly events: Record<string, number>
  private readonly course: ResolvedCourse | null
  private disposed = false

  constructor(
    engine: EngineInstance,
    world: number,
    module: ScriptModule,
    host: ScriptHost,
    layout: SchemaLayout,
    scene: EmittedScene,
    course: ResolvedCourse | null,
    setup: RoundSetup,
  ) {
    this.engine = engine
    this.world = world
    this.module = module
    this.host = host
    this.layout = layout
    this.scene = scene
    this.course = course
    this.bots = setup.humans.map((human, seat) => human ? null : new DomainBot(setup.seed, seat))
    this.events = Object.fromEntries(layout.events.map(({ name }) => [name, 0]))
    this.board = readWorldState(engine, world, layout)
    this.current = observeRound(this.board, scene, module.faultCount, this.events)
  }

  get tick(): number {
    return this.engine.tick(this.world)
  }

  step(human: (seat: number) => number): void {
    const codes = new Array<number>(8)
    const routes = new Map<string, ResolvedCourse>()
    for (let seat = 0; seat < 8; seat++) {
      const bot = this.bots[seat]
      const code = bot === null
        ? human(seat)
        : this.course && (this.current.phase === 'playing' || this.current.phase === 'overtime') && this.current.seats[seat].status === PlayerStatus.alive
          ? bot.sample(this.botCourse(this.course, seat, routes), charStateOf(this.current.seats[seat]))
          : NEUTRAL_CODE
      codes[seat] = engineCodeOfS1(code)
    }
    const before = this.tick
    this.host.stepTick(this.world, codes)
    const after = this.tick
    const records = this.engine.events(this.world, before, after).records
    for (const event of decodeEvents(records, this.layout)) {
      this.events[event.kind] = (this.events[event.kind] ?? 0) + 1
    }
    this.board = readWorldState(this.engine, this.world, this.layout)
    this.current = observeRound(this.board, this.scene, this.module.faultCount, this.events)
  }

  // Like hexField.botTarget, the survival brain seeks solid cells on the
  // current deck. The authored route also contains nodes on vanished tiles.
  private botCourse(course: ResolvedCourse, seat: number, routes: Map<string, ResolvedCourse>): ResolvedCourse {
    const cells = this.board.components.feature_hex_field_hex
    if (course.kind !== 'survival' || !cells) return course
    const character = this.board.components.character[this.scene.seatEntities[seat]]
    const support = cells[Number(character.ground_entity)]
    if (!character.grounded || !support) return course
    const y = (support.t as number[])[1]
    const key = `${support.owner}/${y}`
    const cached = routes.get(key)
    if (cached) return cached
    const path = []
    for (const cell of Object.values(cells)) {
      const [x, height, z] = cell.t as number[]
      if (cell.owner === support.owner && height === y && cell.state === 0) {
        path.push({ p: { x, y, z }, jump: false, dive: false })
      }
    }
    const route = path.length ? { ...course, path } : course
    routes.set(key, route)
    return route
  }

  observe(): RoundObservation {
    return this.current
  }

  worldState(): WorldState {
    return readWorldState(this.engine, this.world, this.layout)
  }

  poses(ids: readonly number[]): Float32Array {
    const poses = entityPoses(this.engine, this.world, ids, 1)
    const packed = new Float32Array(poses.length * 23)
    poses.forEach((pose: PreviewPose, index) => {
      const offset = index * 23
      packed.set(pose.t, offset)
      packed.set(pose.r, offset + 3)
      packed.set(pose.matrix, offset + 7)
    })
    return packed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.engine.freeWorld(this.world)
    } finally {
      this.module.dispose()
    }
  }
}
