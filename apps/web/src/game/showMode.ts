import type { WornLook } from '@royal-fiesta/game/render/wornLook'
import type { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { checkAwait } from './checkProgress.ts'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ListenerPose } from '@royal-fiesta/game/audio/emitters'
import { newModeBotMemory, modeBotInput } from '@royal-fiesta/game/net/modeBots'
import { createOfflineFullMatch } from '@royal-fiesta/game/net/offlineFullMatch'
import type { ZoneFullMatch, ZoneFullRound } from '@royal-fiesta/game/net/zoneFullMatch'
import type { ZoneRoundResult } from '@royal-fiesta/game/net/zoneRounds'
import type { Action, GameScreen } from '@royal-fiesta/game/screens/nav'
import { decodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { refuse } from '@royal-fiesta/sim/refusal'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import { roundTicks } from '@royal-fiesta/sim/match/rules'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { zoneContent } from '../zone/zoneContent.ts'
import { prepareZoneNetScene } from '../zone/zoneNetScene.ts'
import type { ZoneNetScene } from '../zone/zoneNetScene.ts'
import { ShowDirector } from './showDirector.ts'
import type { ShowFrame } from './showDirector.ts'
import { loadShowContent } from './showContent.ts'
import { prepareCourse } from '../render/pipelineGate.ts'
import type { RoundStage } from '../render/pipelineGate.ts'

const DEFAULT_VOTE_MS = 5000
const DEFAULT_INTERMISSION_MS = 12000

export interface ShowModeOptions {
  look?: WornLook | null
  R: RapierModule
  /** The same camera that receives the App look inputs. */
  orbit?: OrbitCamera
  views: HTMLElement
  openingCourse?: string
  seats: number
  humans?: number
  fixedSeats?: boolean
  seed: number
  localName: string
  /** The vote window of every round; the match defaults it to 5000 ms. */
  voteMs?: number
  /** The wait between rounds; the match defaults it to 1500 ms, the show to 12000 ms. */
  intermissionMs?: number
  /**
   * Prepared behind the start screen (App preloads the first round with preload()): the round's warm-up draw then
   * goes one asset at a time, each once the page compiles nothing, until adopt().
   */
  background?: boolean
}

/** Owns the authoritative offline simulation and round canvas; the app owns the stage. */
export class ShowMode {
  private full: ZoneFullMatch | null = null
  private director: ShowDirector | null = null
  private current: ShowFrame | null = null
  private scene: ZoneNetScene | null = null
  private index = -1
  private disposed = false
  private error: string | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly stages: { canvas: HTMLCanvasElement; display: string }[]
  private readonly memories: ReturnType<typeof newModeBotMemory>[]
  private sampleTick = 0
  private readonly options: ShowModeOptions
  private sounds: string[] = []
  private background: boolean
  private look: WornLook | null

  private constructor(options: ShowModeOptions) {
    this.options = options
    this.background = options.background === true
    this.look = options.look ?? null
    this.memories = []
    this.stages = Array.from(options.views.querySelectorAll('canvas'), canvas => ({ canvas, display: canvas.style.display }))
    this.canvas = options.views.ownerDocument.createElement('canvas')
    const dpr = options.views.ownerDocument.defaultView?.devicePixelRatio ?? 1
    this.canvas.width = Math.max(1, Math.round(options.views.clientWidth * dpr))
    this.canvas.height = Math.max(1, Math.round(options.views.clientHeight * dpr))
    this.canvas.dataset.show = 'true'
    this.canvas.style.display = 'none'
    options.views.appendChild(this.canvas)
  }

  static async create(options: ShowModeOptions): Promise<ShowMode> {
    const mode = new ShowMode(options)
    try {
      if (!Number.isInteger(options.seats) || options.seats < 2 || options.seats > 60) {
        refuse('game-web', 'showMode.seats', 'supply an integer from 2 to 60')
      }
      const content = await checkAwait('show course and zone content', () => loadShowContent('sprint'))
      const seats = Array.from({ length: options.seats }, (_, seat) => seat)
      mode.memories.push(...seats.map(() => newModeBotMemory()))
      mode.full = createOfflineFullMatch(options.R, {
        seats: options.seats, seed: options.seed, openingCourse: options.openingCourse,
        courses: content.courses, zones: content.zones, season: content.season, profile: 'sprint',
        voteMs: options.voteMs ?? DEFAULT_VOTE_MS,
        intermissionMs: options.intermissionMs ?? DEFAULT_INTERMISSION_MS,
      })
      mode.director = new ShowDirector(mode.full, content.info, seat => mode.name(seat), 0, options.voteMs ?? DEFAULT_VOTE_MS,
        PROFILES.sprint.introTicks * 1000 / 60)
      mode.current = mode.director.step(null, 0)
    } catch (error) {
      mode.fail(error)
    }
    return mode
  }

  /**
   * Loads the first round now (its port, scene and warm-up draw) when the match opens on a course nobody votes for;
   * false when it opens on a vote. The director holds that round's countdown until it is ready, as for any round.
   */
  preload(): boolean {
    if (this.disposed || this.error !== null || this.activeRound() === null) return false
    this.loadRound()
    return true
  }

  /** True while this show was sized for `views` as it is now (a preloaded show is discarded when the page resized). */
  fits(views: HTMLElement): boolean {
    const dpr = views.ownerDocument.defaultView?.devicePixelRatio ?? 1
    return this.canvas.width === Math.max(1, Math.round(views.clientWidth * dpr))
      && this.canvas.height === Math.max(1, Math.round(views.clientHeight * dpr))
  }

  /** Play takes the show prepared behind the start screen: the worn look of that moment, the rest warmed at once. */
  adopt(look: WornLook | null): this {
    this.look = look
    this.background = false
    return this
  }

  /** The port and course of the round on screen (RoundGate, the app's countdown guard). */
  roundStage(): RoundStage | null {
    const round = this.activeRound()
    if (this.scene === null || round === null || round.plan.index !== this.index) return null
    return { port: this.scene.port, course: round.plan.course.id }
  }

  get humanCount(): number { return this.options.humans ?? 1 }
  get fixedSeats(): boolean { return this.options.fixedSeats === true }
  facing(seat: number) {
    if (seat === 0 && this.options.orbit) return this.options.orbit.ground()
    const camera = this.scene?.cameras?.[seat]
    if (!camera) return { x: 0, z: 1 }
    const x = camera.target[0] - camera.eye[0], z = camera.target[2] - camera.eye[2]
    const length = Math.hypot(x, z)
    return length > 0 ? { x: x / length, z: z / length } : { x: 0, z: 1 }
  }
  inspectHumans() {
    const round = this.activeRound()
    return {
      cameras: this.scene?.cameras?.map(camera => camera === null ? null : { ...camera, eye: [...camera.eye], target: [...camera.target] }) ?? [],
      characters: Array.from({ length: this.humanCount }, (_, k) => {
        const seat = round?.seatOf.indexOf(k) ?? -1
        const state = round?.match.domains.find(domain => domain.seats.includes(seat))?.state(seat)
        return state === undefined ? null : { pos: { ...state.pos }, vel: { ...state.vel }, mode: state.mode }
      }),
    }
  }
  private name(seat: number): string { return seat === 0 ? this.options.localName : seat < this.humanCount ? `P${seat + 1}` : `Bot ${seat}` }
  get camera() { return this.scene?.camera ?? null }
  get lookCanvas(): HTMLCanvasElement { return this.canvas }
  get failure(): string | null { return this.error }
  get finished(): boolean { return this.current?.finished ?? false }
  get models(): ShowFrame | null { return this.current }
  results(): ZoneRoundResult[] { return this.full?.show.rounds ?? [] }
  screen(): GameScreen { return this.current?.screen ?? 'vote' }
  cues(): string[] { const sounds = this.sounds; this.sounds = []; return sounds }

  /** A pointer click on vote card `index`; the director applies votePick and the cue is drained with the frame's. */
  pick(index: number): void {
    if (this.disposed || this.error !== null || this.director === null) return
    this.sounds.push(...this.director.pick(index))
  }

  /** A pointer hover over vote card `index`: focus only, with the ui.hover cue when it moves. */
  hover(index: number): void {
    if (this.disposed || this.error !== null || this.director === null) return
    this.sounds.push(...this.director.hover(index))
  }

  frame(dtS: number, action: Action | null, human: PlayerInput | readonly PlayerInput[]): void {
    if (this.disposed || this.error !== null || this.full === null || this.director === null) return
    const dt = Number.isFinite(dtS) ? Math.max(0, dtS) : 0
    try {
      this.current = this.director.step(action, dt * 1000)
      this.sounds.push(...this.current.sounds)
      this.loadRound()
      if (!this.current.hold && !this.finished) {
        this.full.frame(dt, (round, out) => this.sample(round, out, human))
        // Start loading on the vote result, before the next animation frame.
        if (this.activeRound() !== null && this.activeRound()!.plan.index !== this.index) {
          this.current = this.director.step(null, 0)
          this.sounds.push(...this.current.sounds)
          this.loadRound()
        }
      }
      const visible = ['countdown', 'round', 'spectate'].includes(this.screen())
      this.canvas.style.display = visible ? '' : 'none'
      for (const stage of this.stages) stage.canvas.style.display = visible ? 'none' : stage.display
      const round = this.activeRound()
      if (visible && this.scene !== null && round !== null && round.plan.index === this.index) {
        this.scene.update(round.match, 1, dt)
        this.scene.render()
      }
    } catch (error) {
      this.fail(error)
    }
  }

  private sample(round: ZoneFullRound, out: PlayerInput[], human: PlayerInput | readonly PlayerInput[]): void {
    for (let i = 0; i < round.localSeats.length; i++) {
      const seat = round.localSeats[i]
      const roomSeat = round.seatOf[seat]
      if (roomSeat < this.humanCount) {
        const input = Array.isArray(human) ? human[roomSeat] : roomSeat === 0 ? human : null
        if (input) Object.assign(out[i], input)
        else decodeInput(NEUTRAL_CODE, out[i])
        continue
      }
      const domain = round.match.domains.find(domain => domain.seats.includes(seat))
      if (domain === undefined) decodeInput(NEUTRAL_CODE, out[i])
      else modeBotInput(domain, this.memories[roomSeat], seat, this.sampleTick, out[i])
    }
    this.sampleTick++
  }

  private activeRound(): ZoneFullRound | null {
    return this.full?.round ?? null
  }

  private loadRound(): void {
    const round = this.activeRound()
    if (round == null || round.plan.index === this.index) return
    this.index = round.plan.index
    this.scene?.dispose()
    this.scene = null
    this.sampleTick = 0
    for (let i = 0; i < this.memories.length; i++) this.memories[i] = newModeBotMemory()
    void this.prepare(round)
  }

  private async prepare(round: ZoneFullRound): Promise<void> {
    const index = round.plan.index
    try {
      const content = await checkAwait(`round ${index}: content ${round.plan.course.id}`, () => zoneContent('sprint', round.plan.course.id))
      const prepared = await checkAwait(`round ${index}: render port`, () => prepareZoneNetScene({
        canvas: this.canvas, crowdCull: round.seatOf.length > 8,
        followSeats: Array.from({ length: this.humanCount }, (_, k) => {
          const local = round.seatOf.indexOf(k)
          return local >= 0 ? local : (round.localSeats[0] ?? 0)
        }), orbit: this.options.orbit, course: round.plan.course, createPort: content.createPort,
        assets: content.assets, bean: content.bean,
        look: round.seatOf.includes(0) ? () => this.look : undefined,
        character: content.character, skinned: content.skinned, dressing: content.dressing,
      }))
      if (this.disposed || this.error !== null || this.index !== index) { prepared.dispose(); return }
      const local = round.seatOf.indexOf(0)
      const scene = prepared.attach(round.seatOf.length, local >= 0 ? local : (round.localSeats[0] ?? 0))
      this.scene = scene
      // Mount the near scene before waiting for its animation assets.
      scene.update(round.match, 1, 0)
      await checkAwait(`round ${index}: scene paint and animation`, () => scene.ready())
      // The shared gate: the warm-up draw of the course while the vote or loading screen is up. Its parts still
      // compiling draw in vertex colour, so the countdown does not wait for them.
      const live = (): boolean => !this.disposed && this.error === null && this.index === index
      const background = this.background
      await prepareCourse(scene.port, round.plan.course.id, { oneAtATime: background, cancelled: () => !live() || !this.background })
      if (background && !this.background && live()) await prepareCourse(scene.port, round.plan.course.id)
      if (live()) this.director?.worldReady(index)
    } catch (error) {
      if (!this.disposed && this.index === index) this.fail(error)
    }
  }

  /** Round seats are compacted after each cut; never query domain seat 0 blindly. */
  private humanDomain() {
    const round = this.activeRound()
    if (round == null) return null
    const seat = round.seatOf.indexOf(0)
    if (seat < 0) return null
    const domain = round.match.domains.find(domain => domain.seats.includes(seat))
    return domain === undefined ? null : { round, seat, domain }
  }

  hud() {
    const local = this.humanDomain()
    if (local === null) return null
    const { round, seat, domain } = local
    const duration = roundTicks(round.plan.course, PROFILES.sprint)
    const intro = PROFILES.sprint.introTicks
    let alive = 0
    let qualified = 0
    const ledger = round.match.currentLedger
    for (let other = 0; other < round.seatOf.length; other++) {
      const owner = round.match.domains.find(candidate => candidate.seats.includes(other))
      const status = ledger?.status(other) ?? owner?.status(other) ?? PlayerStatus.alive
      if (status === PlayerStatus.alive) alive++
      if (status === PlayerStatus.qualified) qualified++
    }
    const view: MatchViewState = {
      tick: domain.tick, phase: domain.tick < intro ? Phase.intro : Phase.playing,
      phaseTicksLeft: Math.max(0, intro - domain.tick), roundIndex: round.plan.index,
      roundKind: round.plan.kind === 'race' || round.plan.kind === 'survival' ? round.plan.kind : null,
      final: round.plan.final, courseIndex: round.plan.courseIndex,
      roundTicksLeft: Math.max(0, duration - Math.max(0, domain.tick - intro)),
      alive, qualifiedCount: qualified, target: round.plan.target, winner: -1, podium: [],
    }
    return {
      view, names: round.seatOf.map(roomSeat => this.name(roomSeat)), roundTicks: duration,
      seat, name: this.name(0), status: domain.status(seat), tick: domain.tick,
      round: round.plan.index, kind: round.plan.kind, final: round.plan.final,
      target: round.plan.target, entrants: round.seatOf.length,
      result: round.match.currentLedger?.result ?? null,
    }
  }

  listener(): ListenerPose | null {
    const local = this.humanDomain()
    if (local === null) return null
    const state = local.domain.state(local.seat)
    return { x: state.pos.x, y: state.pos.y, z: state.pos.z, fx: state.facing.x, fz: state.facing.z }
  }

  private fail(error: unknown): void {
    // The error screen only shows the message; the stack goes to the log with it.
    console.error('[show] failed:', error instanceof Error ? (error.stack ?? error.message) : String(error))
    this.error = error instanceof Error ? error.message : String(error)
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.full?.dispose()
    this.full = null
    this.scene?.dispose()
    this.scene = null
    this.canvas.remove()
    for (const stage of this.stages) stage.canvas.style.display = stage.display
  }
}
