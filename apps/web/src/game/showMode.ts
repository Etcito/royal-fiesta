import { DPR_CAP, pixelViewports, splitLayout } from '@royal-fiesta/game/client/splitLayout'
import { renderScale } from '../perf/renderScale.ts'
import { perfEnabled, perfLine, timed } from '../perf/framePerf.ts'
import type { ShadingMode } from '../sdf/sdfPort.ts'
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
import { decodeInput, encodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
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
import { ShowDirector, engineShowPort } from './showDirector.ts'
import type { ShowFrame, ShowPort } from './showDirector.ts'
import type { EngineRoundResult, EngineShowObservation, EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import { EngineShowView } from '@royal-fiesta/game/ege/showView'
import { EngineShowEffects } from '@royal-fiesta/game/ege/showEffects'
import type { SceneReadView } from '@royal-fiesta/game/render/sceneReadView'
import { EngineSeatPresenter, engineEffectSinks, farPenguinBridge, seatTierLine } from '../engineShow/presentation.ts'
import type { CharacterView } from '@royal-fiesta/sim/match/matchSim'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { loadShowContent } from './showContent.ts'
import type { ShowContent } from './showContent.ts'
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
  /** The room seat this page plays (online: its lobby seat); 0 offline. */
  localSeat?: number
  /** Seat names (online: the lobby's players, then bots); offline names when absent. */
  name?: (seat: number) => string
}

/**
 * Owns the show's round canvas: per-round content, port, scene and warm-up draw, and the director's screens. Offline
 * (create) it also owns and steps the simulation; online (online) the network flow owns and steps the match.
 */
export class ShowMode {
  private full: ZoneFullMatch | null = null
  private director: ShowDirector | null = null
  private current: ShowFrame | null = null
  private scene: ZoneNetScene | null = null
  private index = -1
  private disposed = false
  private error: string | null = null
  private readonly canvas: HTMLCanvasElement
  /** The backing size the show draws at (the lobby canvas cap, times ?scale). */
  private readonly drawSize: { width: number; height: number }
  /** The canvas size the current scene's port was created at. */
  private sceneBacking = { width: 1, height: 1 }
  private sceneSeats = 1
  private readonly stages: { canvas: HTMLCanvasElement; display: string }[]
  private readonly memories: ReturnType<typeof newModeBotMemory>[]
  private sampleTick = 0
  private readonly options: ShowModeOptions
  private sounds: string[] = []
  private background: boolean
  private look: WornLook | null
  // Online: PlayFlow steps the match and disposes it; this show only presents it.
  private driven = false
  // Engine show (ShowMode.engine): the runtime, its read view, effects, far figures and the scene it presents on.
  private engineRuntime: EngineShowRuntime | null = null
  private port: ShowPort | null = null
  private readView: EngineShowView | null = null
  private effects: EngineShowEffects | null = null
  private presenter: EngineSeatPresenter | null = null
  private bridge: ReturnType<typeof farPenguinBridge> | null = null
  private farModel: 'penguin' | 'oldbean' = 'penguin'
  private tierLine = ''
  private unsubscribe: (() => void) | null = null
  private engineKey = ''
  /**
   * Receipt -> confirmed result. Only the grant sink of engineEffectSinks (presentation.ts:45, its grant(receipt, result)
   * parameters typed string and EngineRoundResult) writes it, once per confirmed result receipt; ShowMode reads nothing
   * else from it, and the economy reward stays with ShowAdapter's rewardOffline over results().
   */
  private readonly grants = new Map<string, EngineRoundResult>()

  private constructor(options: ShowModeOptions) {
    this.options = options
    this.background = options.background === true
    this.look = options.look ?? null
    this.memories = []
    this.stages = Array.from(options.views.querySelectorAll('canvas'), canvas => ({ canvas, display: canvas.style.display }))
    this.canvas = options.views.ownerDocument.createElement('canvas')
    this.drawSize = ShowMode.fullSize(options.views)
    // A show prepared behind the start screen never draws until Play adopts it: its canvas (and the raa targets sized from
    // it) stays 1x1 until then, instead of a full-size swapchain, depth, MSAA and G-buffers nobody sees.
    this.canvas.width = this.background ? 1 : this.drawSize.width
    this.canvas.height = this.background ? 1 : this.drawSize.height
    this.canvas.dataset.show = 'true'
    // Not in the DOM yet: the app puts it on the page (the one canvas) once the engine has configured it.
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

  /** The online show: the same rounds, screens and loading on a match the network flow steps (OnlineMatch.full). */
  static online(options: ShowModeOptions, full: ZoneFullMatch, content: ShowContent): ShowMode {
    const mode = new ShowMode(options)
    mode.driven = true
    try {
      mode.full = full
      mode.director = new ShowDirector(full, content.info, seat => mode.name(seat), mode.localSeat,
        options.voteMs ?? DEFAULT_VOTE_MS, PROFILES.sprint.introTicks * 1000 / 60)
      mode.current = mode.director.step(null, 0)
    } catch (error) {
      mode.fail(error)
    }
    return mode
  }

  /**
   * Handoff: Game switch share 7/8: offline engine start, hub, show, podium and return in the shell - ShowMode.engine(options,
   * runtime, content, { driven: false }) is what the shell calls with an offline EngineShowRuntime; today it builds the
   * ShowDirector on engineShowPort(runtime, localSeat), subscribes one runtime.onPresentation listener, and frame() advances
   * runtime.frame itself. ShowMode owns the runtime and disposes it. Attached by wrapping the return value in ShowAdapter.
   * Handoff: Game switch share 8/8: online engine show in the shell through PlayFlow - ShowMode.engine(options, runtime,
   * content, { driven: true }) is called by PlayFlow.show with the runtime it steps; today ShowMode only presents it and
   * never frames or disposes that runtime. The runtime stays owned by PlayFlow.
   */
  static engine(options: ShowModeOptions, runtime: EngineShowRuntime, content: ShowContent, mode: { driven: boolean }): ShowMode {
    const show = new ShowMode(options)
    show.driven = mode.driven
    show.engineRuntime = runtime
    try {
      show.port = engineShowPort(runtime, show.localSeat)
      show.director = new ShowDirector(show.port, content.info, seat => show.name(seat), show.localSeat,
        options.voteMs ?? DEFAULT_VOTE_MS, PROFILES.sprint.introTicks * 1000 / 60)
      show.readView = new EngineShowView(runtime)
      show.readView.refresh(1)
      show.presenter = new EngineSeatPresenter()
      show.effects = new EngineShowEffects(runtime, engineEffectSinks(() => ({ play: cue => { show.sounds.push(cue) } }), show.grants))
      show.unsubscribe = runtime.onPresentation(observation => timed('observe: ShowMode.observeEngine (all)', () => show.observeEngine(observation)))
      show.current = show.director.step(null, 0)
    } catch (error) {
      show.fail(error)
    }
    return show
  }

  /** The EngineShowView while a physics world is presented, else null (legacy create/online always null). */
  view(): SceneReadView | null {
    const runtime = this.engineRuntime
    if (runtime === null || this.readView === null) return null
    return runtime.presentation().worlds.some(world => ['seat', 'field', 'hub'].includes(world.ref.kind)) ? this.readView : null
  }

  private get localSeat(): number { return this.options.localSeat ?? 0 }

  /**
   * Prepares the show behind the start screen: its content is loaded and its director is on its first round. A first
   * round on a course nobody votes for also loads now (its port, scene and warm-up draw); the director holds its
   * countdown until it is ready, as for any round. A first round put to the vote (12 seats open on three candidates)
   * loads after the vote, on a port of its own: pipelines compiled ahead on another port do not carry over (measured
   * 2026-11-04: pipelines already compiled for the three candidates on their own ports took a median 4.3 s on the round's
   * port, fresh ones 3.9 s). False when the show failed.
   */
  preload(): boolean {
    if (this.disposed || this.error !== null || this.full === null) return false
    if (this.activeRound() !== null) this.loadRound()
    return true
  }

  /** True while this show was sized for `views` as it is now (a preloaded show is discarded when the page resized). */
  fits(views: HTMLElement): boolean {
    const full = ShowMode.fullSize(views)
    return this.drawSize.width === full.width && this.drawSize.height === full.height
  }

  private static fullSize(views: HTMLElement): { width: number; height: number } {
    const dpr = Math.min(views.ownerDocument.defaultView?.devicePixelRatio ?? 1, DPR_CAP) * renderScale
    return { width: Math.max(1, Math.round(views.clientWidth * dpr)), height: Math.max(1, Math.round(views.clientHeight * dpr)) }
  }

  /** Gives the canvas, and the port created while it was 1x1, the size the show draws at. Idempotent. */
  private grow(): void {
    if (this.background || this.disposed) return
    const { width, height } = this.drawSize
    if (this.scene === null) {
      this.canvas.width = width
      this.canvas.height = height
      return
    }
    if (this.sceneBacking.width === width && this.sceneBacking.height === height) return
    const port = this.scene.port as { resize?: (w: number, h: number, dpr: number, viewports: ReturnType<typeof pixelViewports>) => void }
    if (typeof port.resize !== 'function') return
    port.resize(width, height, 1, pixelViewports(splitLayout(this.sceneSeats, false), width, height, 1))
    this.sceneBacking = { width, height }
  }

  /** Play takes the show prepared behind the start screen: the worn look of that moment, the rest warmed at once. */
  adopt(look: WornLook | null): this {
    this.look = look
    this.background = false
    this.grow()
    return this
  }

  /**
   * The port and course of the round on screen (RoundGate, the app's countdown guard); null while the round loads: the
   * director shows its load hold as the countdown screen, the countdown itself starts once the world is ready.
   */
  roundStage(): RoundStage | null {
    const round = this.activeRound()
    if (this.scene === null || round === null || round.plan.index !== this.index || this.current?.loading !== false) return null
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
  private name(seat: number): string {
    if (this.options.name) return this.options.name(seat)
    return seat === 0 ? this.options.localName : seat < this.humanCount ? `P${seat + 1}` : `Bot ${seat}`
  }
  get camera() { return this.scene?.camera ?? null }
  get lookCanvas(): HTMLCanvasElement { return this.canvas }
  get failure(): string | null { return this.error }
  get finished(): boolean { return this.current?.finished ?? false }
  get models(): ShowFrame | null { return this.current }
  results(): ZoneRoundResult[] { return this.port !== null ? [...this.port.show.rounds] : this.full?.show.rounds ?? [] }
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
    if (this.engineRuntime !== null) { this.frameEngine(dtS, action, human); return }
    if (this.disposed || this.error !== null || this.full === null || this.director === null) return
    const dt = Number.isFinite(dtS) ? Math.max(0, dtS) : 0
    try {
      this.current = this.director.step(action, dt * 1000)
      this.sounds.push(...this.current.sounds)
      this.loadRound()
      if (!this.current.hold && !this.finished) {
        if (!this.driven) this.full.frame(dt, (round, out) => this.sample(round, out, human))
        // Start loading on the vote result, before the next animation frame.
        if (this.activeRound() !== null && this.activeRound()!.plan.index !== this.index) {
          this.current = this.director.step(null, 0)
          this.sounds.push(...this.current.sounds)
          this.loadRound()
        }
      }
      const visible = ['countdown', 'round', 'spectate'].includes(this.screen())
      const round = this.activeRound()
      if (visible && this.scene !== null && round !== null && round.plan.index === this.index) {
        this.scene.update(round.match, 1, dt)
        this.scene.render()
      }
    } catch (error) {
      this.fail(error)
    }
  }

  /** Offline (not driven) the script owns timing: runtime.frame runs every frame, whatever the director holds. */
  private frameEngine(dtS: number, action: Action | null, human: PlayerInput | readonly PlayerInput[]): void {
    const runtime = this.engineRuntime
    if (this.disposed || this.error !== null || this.director === null || runtime === null) return
    const dt = Number.isFinite(dtS) ? Math.max(0, dtS) : 0
    try {
      if (!this.driven) timed('EngineShowRuntime.frame', () => runtime.frame(dt, roomSeat => this.engineCode(roomSeat, human)))
      this.current = timed('ShowDirector.step', () => this.director!.step(action, dt * 1000))
      this.sounds.push(...this.current.sounds)
      timed('observe: flush (once per frame)', () => this.flushObservation())
      timed('ShowMode.loadEngine', () => this.loadEngine(runtime))
      timed('EngineShowEffects.pump', () => this.effects?.pump())
      const visible = ['countdown', 'round', 'spectate'].includes(this.screen())
      this.tierLine = ''
      if (visible && this.scene !== null && this.readView !== null && this.presenter !== null) {
        const presenter = this.presenter, view = this.readView, scene = this.scene
        timed('EngineSeatPresenter.refill', () => presenter.refill(runtime.presentation(), runtime.snapshot(), view.nearSeats()))
        const submission = presenter.submission()
        timed('RenderBridge.sync', () => this.bridge?.sync(submission.view, view.tick))
        if (perfEnabled) {
          const mode = (scene.port as { shadingMode?: ShadingMode }).shadingMode ?? 'scene'
          this.tierLine = seatTierLine(submission, mode, this.farModel)
        }
        timed('ZoneNetScene.present', () => scene.present(view, 1, dt))
        timed('ZoneNetScene.render', () => scene.render())
      }
    } catch (error) {
      this.fail(error)
    }
  }

  /** The S1 code of a human room seat (the local human in slot 0); every other seat is neutral. */
  private engineCode(roomSeat: number, human: PlayerInput | readonly PlayerInput[]): number {
    if (roomSeat >= this.humanCount) return NEUTRAL_CODE
    const input = Array.isArray(human) ? human[roomSeat] : roomSeat === 0 ? human : undefined
    return input === undefined ? NEUTRAL_CODE : encodeInput(input)
  }

  /** Post-tick: refresh the read view, observe the scene once for this tick, feed the far figures. Before-release only invalidates. */
  // The presented seats are read once per frame, from the last tick's observation: the far view keeps only the latest
  // snapshot of each domain and the scene is drawn once per frame, so decoding every seat on each of up to 8 catch-up
  // ticks was most of EngineShowRuntime.frame (measured: ~10 ms per tick with 60 seats). The events lane (EngineShowEffects)
  // still sees every tick. A release drops the pending observation (its worlds are going away) and applies at once.
  private pendingObservation: EngineShowObservation | null = null

  private observeEngine(observation: EngineShowObservation): void {
    if (this.disposed || this.readView === null || this.presenter === null) return
    if (observation.kind === 'before-release') {
      this.pendingObservation = null
      this.presenter.observe(observation, new Set())
      return
    }
    this.pendingObservation = observation
  }

  private flushObservation(): void {
    const observation = this.pendingObservation
    this.pendingObservation = null
    const view = this.readView
    if (observation === null || this.disposed || view === null || this.presenter === null) return
    const presenter = this.presenter
    timed('observe: EngineShowView.refresh', () => view.refresh(1))
    timed('observe: ZoneNetScene.observe', () => this.scene?.observe(view))
    timed('observe: EngineSeatPresenter.observe', () => presenter.observe(observation, view.nearSeats()))
  }

  /** A new round or course: the scene is rebuilt on the presented course; the director's worldReady follows its load. */
  private loadEngine(runtime: EngineShowRuntime): void {
    const presentation = runtime.presentation()
    const course = presentation.course
    if (course === null) return
    const key = `${presentation.round}:${course.id}`
    if (key === this.engineKey) return
    this.engineKey = key
    this.bridge?.dispose()
    this.bridge = null
    this.scene?.dispose()
    this.scene = null
    void this.prepareEngine(key, presentation.round, course)
  }

  /** Same zone scene and course gate as the legacy prepare(); a rejection fails the show and never falls back. */
  private async prepareEngine(key: string, round: number, course: ResolvedCourse): Promise<void> {
    const runtime = this.engineRuntime
    if (runtime === null) return
    const live = (): boolean => !this.disposed && this.error === null && this.engineKey === key
    try {
      const content = await checkAwait(`round ${round}: content ${course.id}`, () => zoneContent('sprint', course.id))
      const seats = runtime.snapshot().seatOf
      const local = Math.max(0, seats.indexOf(this.localSeat))
      this.sceneSeats = 1
      const backing = { width: this.canvas.width, height: this.canvas.height }
      const prepared = await checkAwait(`round ${round}: render port`, () => prepareZoneNetScene({
        canvas: this.canvas, crowdCull: seats.length > 8, followSeats: [local], orbit: this.options.orbit, course,
        createPort: content.createPort, assets: content.assets, bean: content.bean, character: content.character,
        skinned: content.skinned, dressing: content.dressing,
      }))
      if (!live()) { prepared.dispose(); return }
      const scene = prepared.attach(seats.length, local)
      this.scene = scene
      this.sceneBacking = backing
      this.grow()
      this.farModel = content.farModel
      const bridge = this.bridge = farPenguinBridge(scene.port, content.bean, this.farModel === 'penguin'
        ? { asset: content.character, skinned: content.skinned } : undefined)
      if (perfEnabled) perfLine('seats', () => this.tierLine)
      if (this.readView !== null) scene.present(this.readView, 1, 0)
      await checkAwait(`round ${round}: scene paint and animation`, () => Promise.all([scene.ready(), bridge.ready]))
      await prepareCourse(scene.port, course.id, { cancelled: () => !live() })
      if (live()) this.director?.worldReady(round)
    } catch (error) {
      if (live()) this.fail(error)
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
      this.sceneSeats = Math.max(1, Math.min(4, this.humanCount))
      const backing = { width: this.canvas.width, height: this.canvas.height }
      const prepared = await checkAwait(`round ${index}: render port`, () => prepareZoneNetScene({
        canvas: this.canvas, crowdCull: round.seatOf.length > 8,
        followSeats: Array.from({ length: this.humanCount }, (_, k) => {
          const local = round.seatOf.indexOf(this.localSeat + k)
          return local >= 0 ? local : (round.localSeats[0] ?? 0)
        }), orbit: this.options.orbit, course: round.plan.course, createPort: content.createPort,
        assets: content.assets, bean: content.bean,
        look: round.seatOf.includes(this.localSeat) ? () => this.look : undefined,
        character: content.character, skinned: content.skinned, dressing: content.dressing,
      }))
      if (this.disposed || this.error !== null || this.index !== index) { prepared.dispose(); return }
      const local = round.seatOf.indexOf(this.localSeat)
      const scene = prepared.attach(round.seatOf.length, local >= 0 ? local : (round.localSeats[0] ?? 0))
      this.scene = scene
      this.sceneBacking = backing
      this.grow()
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
    const seat = round.seatOf.indexOf(this.localSeat)
    if (seat < 0) return null
    const domain = round.match.domains.find(domain => domain.seats.includes(seat))
    return domain === undefined ? null : { round, seat, domain }
  }

  /**
   * Engine: the legacy HudState shape built from the snapshot. The snapshot carries no phase timers, course index, target
   * or final flag, so those fields are zero or false; qualifiedCount counts the latest confirmed result's qualified seats.
   */
  private engineHud(): { view: MatchViewState; names: string[]; seat: number } | null {
    const runtime = this.engineRuntime
    if (runtime === null) return null
    const snapshot = runtime.snapshot()
    const seat = snapshot.seatOf.indexOf(this.localSeat)
    if (seat < 0) return null
    const latest = snapshot.results[snapshot.results.length - 1]
    const view: MatchViewState = {
      tick: snapshot.tick, phase: ['playing', 'overtime'].includes(snapshot.screen) ? Phase.playing : Phase.intro,
      phaseTicksLeft: 0, roundIndex: snapshot.round, roundKind: null, final: false, courseIndex: 0, roundTicksLeft: 0,
      alive: snapshot.alive.length, qualifiedCount: latest?.qualified.length ?? 0, target: 0,
      winner: snapshot.champion ?? -1, podium: [],
    }
    return { view, names: snapshot.seatOf.map(roomSeat => this.name(roomSeat)), seat }
  }

  hud() {
    if (this.engineRuntime !== null) return this.engineHud()
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
      seat, name: this.name(this.localSeat), status: domain.status(seat), tick: domain.tick,
      round: round.plan.index, kind: round.plan.kind, final: round.plan.final,
      target: round.plan.target, entrants: round.seatOf.length,
      result: round.match.currentLedger?.result ?? null,
    }
  }

  listener(): ListenerPose | null {
    if (this.engineRuntime !== null) {
      const seat = this.engineRuntime.snapshot().seatOf.indexOf(this.localSeat)
      const view = this.view()
      if (seat < 0 || view === null) return null
      const out: CharacterView = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 }, mode: 0, status: 0, parked: true, teleportTick: 0 }
      const character = view.character(seat, out)
      return { x: character.pos.x, y: character.pos.y, z: character.pos.z, fx: character.facing.x, fz: character.facing.z }
    }
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
    if (!this.driven) this.full?.dispose()
    this.full = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.effects?.dispose()
    this.effects = null
    this.readView?.dispose()
    this.readView = null
    this.presenter?.clear()
    this.presenter = null
    this.bridge?.dispose()
    this.bridge = null
    this.tierLine = ''
    if (!this.driven) this.engineRuntime?.dispose()
    this.engineRuntime = null
    this.scene?.dispose()
    this.scene = null
    this.canvas.remove()
    for (const stage of this.stages) stage.canvas.style.display = stage.display
  }
}
