import { loadEngine } from '@etcito/game-engine'
import type { EngineInstance } from '@etcito/game-engine/loader'
import { schemaLayout } from '@etcito/game-engine/script'
import { showSchemaLayout } from '@royal-fiesta/game/ege/showState'
import { cameraBasis } from '@royal-fiesta/game/client/cameraBasis'
import { controlsToInput } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import type { CourseV1, ResolvedGameAsset } from '@royal-fiesta/game/courseV1'
import { RF_EGE_SCRIPTS_URL } from '@royal-fiesta/game/ege/files'
import { EngineShowEffects } from '@royal-fiesta/game/ege/showEffects'
import { engineOnlineStats } from '@royal-fiesta/game/ege/onlineState'
import { createEngineShow } from '@royal-fiesta/game/ege/showRuntime'
import type { EngineShowConfig, EngineShowRuntime, EngineShowSnapshot } from '@royal-fiesta/game/ege/showTypes'
import type { EngineModuleIdentity } from '../../../../tools/egeScripts.ts'
import { EngineShowView } from '@royal-fiesta/game/ege/showView'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { CameraPose, RenderTarget } from '@royal-fiesta/game/render/port'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { decodeInput, encodeInput, NEUTRAL_CODE, neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { refuse } from '@royal-fiesta/sim/refusal'
import schemaJson from '../../../../ege.schema.json' with { type: 'json' }
import { browserGameAssets, loadV1Courses } from '../content/v1Data.ts'
import type { ResizablePort } from '../sdf/sdfPort.ts'
import { openBrowserAudio } from '@royal-fiesta/game/audio/context'
import type { BrowserSound } from '@royal-fiesta/game/audio/context'
import { deviceOfCanvas, pendingPipelines } from '../render/asyncPipelines.ts'
import { podiumLayoutOf } from '@royal-fiesta/game/courseV1'
import type { EngineRoundResult } from '@royal-fiesta/game/ege/showTypes'
import { PodiumStage } from '@royal-fiesta/game/render/podiumStage'
import type { PodiumLayout } from '@royal-fiesta/game/content'
import { audioManifestUrl } from '../play/sound.ts'
import { createEngineShowReady } from './ready.ts'
import { EngineScreenTracker, EngineSeatPresenter, engineEffectSinks, farPenguinBridge, podiumPlayers } from './presentation.ts'
import type { EngineScreenModel, EngineSeatSubmission } from './presentation.ts'
import { engineShowTestMode } from './testMode.ts'
import { checkAwait } from '../game/checkProgress.ts'
import { createShowPacer, isBotCheckTick, PODIUM_PLAN, registerScenario, showSeatPoses, ShowFactsCollector } from './ops.ts'
import type { ShowPacer } from './ops.ts'
import type { CaptureResult } from '../../../../tools/engineCaptureJob.ts'
import type { EngineShowObservation, EngineShowPresentation } from '@royal-fiesta/game/ege/showTypes'
import { readWorldState } from '@etcito/game-engine/world-state'
import { createEngineHub } from '@royal-fiesta/game/ege/hub'
import type { HubRuntime } from '@royal-fiesta/game/ege/hub'
import { EngineHubFlow } from '@royal-fiesta/game/ege/hubFlow'
import type { EngineHubFlowState } from '@royal-fiesta/game/ege/hubFlow'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { decodeHubAct } from '@royal-fiesta/game/hub/protocol'
import { RemoteBuffer } from '@royal-fiesta/game/hub/remotes'
import type { RemoteView } from '@royal-fiesta/game/hub/remotes'
import { HubView } from '../play/hubView.ts'

const AREA = 'engine-show'
const WIDTH = 1920
const HEIGHT = 1080
const SEATS = 60
const MAX_HUMANS = 8
const LOCAL_SEAT = 0
const PUBLICATION_URL = 'ege/rf-publication.json'
const STEP_CAP_S = 0.25
const STICK_DEADZONE = 0.15
const PODIUM_COURSE = 'podium'
const HUB_PLAZA = 'hub-plaza'
const HUB_SPAWN = 0
const HUB_LOBBY_BOTS = 4

/** The dedicated page's startup options; the bootstrap defaults to local mode, sixty seats and one human. */
export interface EngineShowPageOptions {
  mode: 'local' | 'online'
  testMode: boolean
  seed: number
  humans: number
  /** Nominal head counts passed through EngineShowConfig.plan; absent keeps the runtime's default show plan. */
  plan?: readonly number[]
  onRuntime?: (runtime: EngineShowRuntime) => void
}

/** Copied presentation state; counts are numbers, round and tick are the authoritative runtime indices. */
export interface EnginePageState {
  screen: string
  ready: boolean
  error: string | null
  backend: 'engine'
  seats: number
  humans: number
  bots: number
  round: number
  tick: number
  moduleKey: string
  faults: number
  completedRounds: number
  desyncs: number
}

/** The page handle: the readiness boundary, copied state and an idempotent dispose. */
export interface EngineShowPage {
  ready: Promise<void>
  state(): EnginePageState
  dispose(): void
  /** The last drawn frame's screen model and submitted near/far room seats; null before the first frame. */
  presentation(): EnginePagePresentation | null
}

/** Copied presentation of the last drawn frame: the screen/HUD model and the seats each renderer received. */
export interface EnginePagePresentation {
  model: EngineScreenModel
  near: readonly number[]
  far: readonly number[]
  grants: number
}

// The Vite build resolves the engine wasm to an emitted asset; the bootstrap installs its URL here so this
// module stays importable outside Vite (Node checks and the downstream page test).
let engineWasmUrl: string | undefined

export function setEngineShowWasmUrl(url: string): void {
  engineWasmUrl = url
}

type ZoneContent = Awaited<ReturnType<typeof import('../zone/zoneContent.ts').zoneContent>>

/** The authored courses, assets, zones and season a show is prepared from; the page and the game shell share it. */
export interface AuthoredShow {
  courses: CourseV1[]
  plaza: CourseV1
  assets: Map<string, ResolvedGameAsset>
  zones: ReadonlyMap<string, ZonesFile>
  season: readonly SchedMap[]
  zoneContent: ZoneContent
  podium: PodiumLayout
}

/** The loaded engine, its published identity and scripts; the schema is already loaded and key-checked. */
export interface PublishedEngine {
  engine: EngineInstance
  identity: EngineModuleIdentity
  scriptBytes: ArrayBuffer
}

/** Optional human count and plan for one show; every other field comes from the page's current configuration. */
export interface EngineShowConfigOverrides {
  plan?: readonly number[]
  humans?: number
}

/** The views and effects bound to one show the flow has attached; the runtime itself belongs to EngineHubFlow. */
interface LiveShow {
  readonly runtime: EngineShowRuntime
  readonly read: EngineShowView
  readonly scene: SceneView
  readonly effects: EngineShowEffects
  readonly port: ResizablePort
  readonly presenter: EngineSeatPresenter
  readonly bridge: ReturnType<typeof farPenguinBridge>
  readonly stage: PodiumStage
  readonly tracker: EngineScreenTracker
  podiumKey: string
  unsubscribe: (() => void) | null
  captureUnsubscribe: (() => void) | null
}

/** A presence act from the relay for one remote hub occupant; the payload is decoded by decodeHubAct. */
export interface EngineHubPresenceAct { seat: number; payload: unknown; recvMs: number }

/**
 * The page-private stepping, sampling and capture handles scenarios use. One host serves the page's lifetime: it
 * drives the engine hub and every show that EngineHubFlow starts on it.
 */
export interface EngineShowHostApi {
  readonly collector: ShowFactsCollector
  pauseLoop(): void
  step(ticks: number, decide: (index: number) => number): void
  vote(candidate: number): void
  draw(): void
  pump(): { droppedRecords: number; repeatedSoundDeliveries: number; repeatedGrantDeliveries: number }
  snapshot(): EngineShowSnapshot
  screen(): string
  /** The authoritative position of the last observed tick, for progress and failure text. */
  where(): string
  localMode(): number
  /**
   * While on, ticks are simulated and their confirmed effects drained, but the read view, SceneView animation
   * and far submission are not refreshed: those ticks are never presented. Turning it off refreshes the read
   * view and observes the current tick, so the next drawn frame shows the authoritative state.
   */
  fastForward(on: boolean): void
  /** Sets the plan of the next show, starts it through EngineHubFlow and resolves with this same host in 'show'. */
  remount(plan: readonly number[]): Promise<EngineShowHostApi>
  /**
   * Handoff: 'Engine online share 5/5: online capture scenarios and inventory' calls
   * EngineShowHostApi.remountWith(start, overrides) and EngineShowHostApi.showConfig(overrides) through
   * engineShowHost(page). Today remountWith prepares the next show with `start(showConfig(overrides))` once and
   * attaches it through the same path as remount; showConfig applies the overrides to the page's current config.
   */
  remountWith(
    start: (config: EngineShowConfig) => Promise<EngineShowRuntime>,
    overrides?: EngineShowConfigOverrides,
  ): Promise<EngineShowHostApi>
  /** The page's current show configuration with the optional humans and plan overrides applied. */
  showConfig(overrides?: EngineShowConfigOverrides): EngineShowConfig
  /**
   * Waits for the animation load and the GPU pipelines the drawn show requested, then redraws still frames and
   * waits for the GPU, so near/far penguins, the course and the podium are really on the canvas before capture.
   */
  settle(): Promise<void>
  stopWatching(): void
  capture(): Promise<Uint8Array>
  flow(): EngineHubFlow
  /** The engine hub of this page; null after dispose. */
  hub(): HubRuntime | null
  /** Decodes one S9 hub act into the remote presence buffer; a malformed act is dropped, counted and returns false. */
  pushPresence(act: EngineHubPresenceAct): boolean
  /** The remote hub occupants sampled at nowMs, the same list the hub draw uses. */
  presence(nowMs: number): RemoteView[]
  /** A copy of the stable signals emitted so far, in order. */
  signals(): readonly string[]
}

/** Which watch bookkeeping a show observes: the local seat's samples and the scripted bots' poses. */
interface WatchState {
  ownSeat: boolean
  bots: boolean
  fast: boolean
  pending: { code: number; sampled: boolean; before: readonly [number, number, number] | null } | null
  poses: Map<number, readonly [number, number, number]>
}

let activeCapture: EngineShowHostApi | null = null
let activePage: EngineShowPage | null = null

/**
 * Handoff: G7-PAGE presentation: complete the round and confirmed podium and G7-PAGE capture registration:
 * register offline scenarios and inventory call `mountEngineShow(root, options)` in this file. Today it
 * prepares the local show from the product loaders, creates the runtime, the EngineShowView read view,
 * SceneView, EngineShowEffects and the SDF port, subscribes the read view to the runtime's post-tick
 * observations and returns the EngineShowPage handle `{ ready, state, dispose }`. The optional onRuntime
 * callback receives the prepared runtime, and the configured human seats keep their stable room-seat
 * identities. EngineShowPage.state reads the copied snapshot and EngineShowPage.dispose unsubscribes,
 * disposes the effects, views and port, then releases the runtime. The far snapshot attachment remains with
 * the presentation share; this mount adds no second snapshot encoder or membership policy.
 */
export async function mountEngineShow(root: HTMLElement, options: EngineShowPageOptions): Promise<EngineShowPage> {
  validateOptions(options)
  const { canvas, status, hud } = mountInterface(root)
  const grants = new Map<string, EngineRoundResult>()
  let sound: BrowserSound | null = null
  let opening = false
  let drawn: { model: EngineScreenModel; submission: EngineSeatSubmission } | null = null
  // Browsers open audio only after a gesture; the audio pack then plays confirmed cues through the effects sinks.
  const openAudio = (): void => {
    if (opening || typeof AudioContext === 'undefined') return
    opening = true
    void openBrowserAudio({ manifestUrl: audioManifestUrl(document.baseURI), maxListeners: 1 })
      .then(opened => {
        if (disposed) void opened.close()
        else sound = opened
      })
      .catch(() => { opening = false })
  }
  // Enter starts the next show from the hub; the hub itself never starts a show, and an online show starts only
  // through EngineShowHostApi.remountWith because its transport is not the page's.
  const startOnEnter = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && options.mode === 'local' && flow?.state() === 'hub') void flow.start()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', openAudio)
    window.addEventListener('keydown', openAudio)
    window.addEventListener('keydown', startOnEnter)
  }
  const internal = {
    ready: false,
    error: null as string | null,
    screen: 'loading',
    snapshot: null as EngineShowSnapshot | null,
    moduleKey: '',
  }
  let live: LiveShow | null = null
  const showIds = new WeakMap<EngineShowRuntime, number>()
  let showSerial = 0
  let disposed = false
  let paused = false
  let frameId = 0
  let lastFrame = 0
  let authoredSeason: AuthoredShow['season'] = []
  let authoredRef: AuthoredShow | null = null
  let port: ResizablePort | null = null
  let hub: HubRuntime | null = null
  let hubView: HubView | null = null
  let flow: EngineHubFlow | null = null
  let pendingRuntime: EngineShowRuntime | null = null
  let nextPlan: readonly number[] | undefined
  let nextStart: ((config: EngineShowConfig) => Promise<EngineShowRuntime>) | undefined
  let nextOverrides: EngineShowConfigOverrides | undefined
  let showConfigOf: ((overrides?: EngineShowConfigOverrides) => EngineShowConfig) | null = null
  let showHumans = options.humans
  let lastDesyncs = 0
  let phaseSeen: EngineHubFlowState = 'loading'
  let hubPresented = false
  let roundSignalled = false
  let podiumSignalled = false
  let droppedPresence = 0
  let lastStats = { droppedRecords: 0, repeatedSoundDeliveries: 0, repeatedGrantDeliveries: 0 }
  const signalList: string[] = []
  const remotes = new RemoteBuffer()
  const hubState: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
  const collector = new ShowFactsCollector({ seats: SEATS, humans: options.humans, bots: SEATS - options.humans })
  const input = trackInput()
  const player = neutralInput()
  const localInput = neutralInput()
  const watch: WatchState = { ownSeat: true, bots: true, fast: false, pending: null, poses: new Map() }
  const sample = (roomSeat: number): number => {
    if (roomSeat !== LOCAL_SEAT) return NEUTRAL_CODE
    input.poll()
    return controlsCode(input.controls, live?.scene.camera ?? hubView?.camera ?? null, player)
  }
  const paint = (): void => {
    status.dataset.state = internal.error !== null ? 'error' : internal.ready ? 'ready' : 'loading'
    status.textContent = internal.error ?? (internal.ready ? 'ready' : 'loading')
  }
  const noteCapture = (observation: EngineShowObservation): void => {
    if (observation.kind !== 'post-tick') return
    const pending = watch.pending
    const local = pending !== null && pending.sampled && watch.ownSeat
    const bots = watch.bots && isBotCheckTick(observation.tick)
    const poses = local || bots ? showSeatPoses(observation.presentation, SEATS) : watch.poses
    if (local && pending !== null) {
      collector.sample({
        code: pending.code, stored: storedControl(observation.presentation), before: pending.before,
        after: poses.get(LOCAL_SEAT) ?? null, mode: -1,
      })
      watch.pending = null
    }
    if (bots) {
      collector.observeBots(poses)
      if (collector.botCount() > 0) watch.bots = false
    }
    if (local || bots) watch.poses = poses
    collector.progress({ snapshot: observation.snapshot, course: observation.presentation.course?.id ?? null, tick: observation.presentation.tick })
    collector.scriptFaults(observation.snapshot.faults)
  }
  /** Draws the attached show: the scene, the seats it submits, the podium and the HUD. */
  function drawFrame(dtS: number): void {
    const current = live
    if (current === null || port === null) return
    const snapshot = current.runtime.snapshot()
    const presentation = current.runtime.presentation()
    current.scene.update(current.read, null, 1, dtS)
    current.presenter.refill(presentation, snapshot, current.read.nearSeats())
    const submission = current.presenter.submission()
    const model = current.tracker.update(snapshot, presentation, authoredSeason, LOCAL_SEAT)
    if (model.podium !== null) {
      current.bridge.sync(submission.view.count === 0 ? submission.view : { count: 0, stride: submission.view.stride, bytes: new Uint8Array(8) })
      const key = model.podium.join(',')
      if (key !== current.podiumKey) current.stage.show(podiumPlayers(model.podium))
      current.podiumKey = key
      current.stage.update(dtS)
    } else {
      if (current.podiumKey !== '') current.stage.hide()
      current.podiumKey = ''
      current.bridge.sync(submission.view)
    }
    current.effects.pump()
    port.render()
    hud.textContent = model.hud.join('\n')
    drawn = { model, submission: model.podium === null ? submission : { ...submission, far: new Set() } }
    internal.snapshot = snapshot
    if (snapshot.screen === 'playing' && !roundSignalled) {
      roundSignalled = true
      signalList.push('round-ready')
    }
    if (snapshot.screen === 'podium' && !podiumSignalled) {
      podiumSignalled = true
      signalList.push('podium-ready')
    }
  }
  /** Draws the engine hub with the existing hub presentation: local and lobby occupants, remote emotes and presence. */
  function drawHub(dtS: number): void {
    if (hub === null || hubView === null || port === null) return
    const now = performance.now()
    hubView.update(hub.state(hubState, 0), 0, [...hub.botViews(), ...remotes.sample(now)], hub.tick, dtS, hub.emote(now))
    port.render()
    drawn = null
    hud.textContent = 'engine hub'
    if (!hubPresented) {
      hubPresented = true
      signalList.push('page-ready', 'hub-ready')
    }
  }
  /** One presented frame: the attached show when there is one, otherwise the hub. */
  function renderCurrent(dtS: number): void {
    if (live !== null) drawFrame(dtS)
    else drawHub(dtS)
  }
  function loop(now: number): void {
    if (disposed || paused) return
    const dtS = Math.min((now - lastFrame) / 1000, STEP_CAP_S)
    lastFrame = now
    try {
      tick(dtS, decodeInput(sample(LOCAL_SEAT), localInput))
      renderCurrent(dtS)
    } catch (error) {
      show('error', error instanceof Error ? error.message : String(error))
      return
    }
    frameId = requestAnimationFrame(loop)
  }
  function startLoop(): void {
    if (paused || typeof requestAnimationFrame !== 'function') return
    lastFrame = performance.now()
    frameId = requestAnimationFrame(loop)
  }
  function show(state: 'loading' | 'ready' | 'error', message?: string): void {
    if (disposed) return
    if (state === 'error') {
      internal.ready = false
      internal.error = message ?? 'Engine show preparation failed'
    } else {
      internal.ready = state === 'ready'
      internal.error = null
      if (state === 'loading') internal.screen = 'loading'
    }
    paint()
    if (state === 'ready') startLoop()
  }
  /** Builds everything bound to one started show on the shared port; the runtime stays owned by EngineHubFlow. */
  function attachShow(runtime: EngineShowRuntime): void {
    const authored = authoredRef
    const shared = port
    if (authored === null || shared === null) throw new Error('[engine-show] the show was started before the page was prepared')
    let read: EngineShowView | null = null
    let scene: SceneView | null = null
    let effects: EngineShowEffects | null = null
    let bridge: ReturnType<typeof farPenguinBridge> | null = null
    let stage: PodiumStage | null = null
    try {
      options.onRuntime?.(runtime)
      read = new EngineShowView(runtime)
      read.refresh(1)
      const currentRead = read
      effects = new EngineShowEffects(runtime, engineEffectSinks(() => sound?.port ?? null, grants))
      scene = new SceneView({
        port: shared,
        viewport: 0,
        localPlayer: LOCAL_SEAT,
        assets: authored.zoneContent.assets,
        bean: authored.zoneContent.bean,
        character: authored.zoneContent.character,
        skinned: authored.zoneContent.skinned,
        dressing: authored.zoneContent.dressing,
        crowdAspect: () => WIDTH / HEIGHT,
      })
      const currentScene = scene
      bridge = farPenguinBridge(shared, authored.zoneContent.bean)
      stage = new PodiumStage({
        port: shared,
        viewport: 0,
        bean: authored.zoneContent.character,
        block: authored.zoneContent.assets('wall-block'),
        layout: authored.podium,
      })
      const presenter = new EngineSeatPresenter()
      const current: LiveShow = {
        runtime, read: currentRead, scene: currentScene, effects, port: shared, presenter, bridge, stage,
        tracker: new EngineScreenTracker(), podiumKey: '', unsubscribe: null, captureUnsubscribe: null,
      }
      current.unsubscribe = runtime.onPresentation(observation => {
        if (observation.kind !== 'post-tick') {
          presenter.observe(observation, new Set())
          return
        }
        internal.snapshot = observation.snapshot
        internal.screen = observation.snapshot.screen
        if (watch.fast) return
        currentRead.refresh(1)
        currentScene.observeTick(currentRead)
        presenter.observe(observation, currentRead.nearSeats())
      })
      current.captureUnsubscribe = runtime.onPresentation(noteCapture)
      internal.snapshot = runtime.snapshot()
      internal.screen = internal.snapshot.screen
      showIds.set(runtime, ++showSerial)
      live = current
      hubView?.setVisible(false)
    } catch (error) {
      stage?.dispose()
      bridge?.dispose()
      scene?.dispose()
      read?.dispose()
      effects?.dispose()
      throw error
    }
  }
  /** Releases what attachShow built; the show runtime is freed by EngineHubFlow, and the shared port stays with the page. */
  function detachShow(): void {
    const current = live
    if (current === null) return
    live = null
    drawn = null
    current.unsubscribe?.()
    current.captureUnsubscribe?.()
    current.effects.dispose()
    current.presenter.clear()
    current.bridge.dispose()
    current.stage.dispose()
    current.scene.dispose()
    current.read.dispose()
    hubView?.setVisible(true)
  }
  /** Follows the flow after each tick: attaches the show it entered, detaches the show it left, announces the return. */
  function syncShow(): void {
    const phase = flow?.state() ?? 'loading'
    if (phase === 'show' && live === null && pendingRuntime !== null) {
      const runtime = pendingRuntime
      pendingRuntime = null
      attachShow(runtime)
    }
    if (phase !== 'show') detachShow()
    if (phaseSeen === 'show' && (phase === 'returning' || phase === 'hub')) signalList.push('hub-returned')
    phaseSeen = phase
  }
  /** One fixed tick of the flow in every state, followed by the page's attachment sync. */
  function tick(dtS: number, playerInput: PlayerInput): void {
    flow?.frame(dtS, playerInput)
    syncShow()
  }
  const screenNow = (): string => {
    const phase = flow?.state() ?? 'loading'
    if (phase === 'hub' || phase === 'returning') return 'hub'
    if (phase === 'show') return live === null ? 'loading' : (internal.snapshot?.screen ?? internal.screen)
    return phase
  }
  const prepare = async (): Promise<void> => {
    const [published, authored] = await Promise.all([loadEnginePublication(), loadEngineAuthoredShow()])
    if (disposed) return
    const { engine, identity, scriptBytes } = published
    internal.moduleKey = identity.moduleKey
    authoredSeason = authored.season
    authoredRef = authored
    const config = (plan: readonly number[] | undefined, overrides?: EngineShowConfigOverrides): EngineShowConfig =>
      applyConfigOverrides({
        engine,
        schemaText: JSON.stringify(schemaJson),
        scriptBytes,
        identity,
        seed: options.seed,
        courses: authored.courses,
        assets: authored.assets,
        zones: authored.zones,
        season: authored.season,
        humans: humanFlags(options.humans),
        ...(plan === undefined ? {} : { plan }),
        testMode: engineShowTestMode(options.testMode).enabled,
      }, overrides)
    showConfigOf = overrides => config(options.plan, overrides)
    const sim = authored.plaza.sim
    if (sim === null) refuse(AREA, `courses/${HUB_PLAZA}.course.json`, 'has no simulation part; pass a playable hub plaza')
    const shared = await createPort(canvas, authored.zoneContent)
    if (disposed) {
      shared.dispose()
      return
    }
    port = shared
    let hubRuntime: HubRuntime
    try {
      hubRuntime = await createEngineHub(config(undefined), authored.plaza, HUB_SPAWN, HUB_LOBBY_BOTS)
    } catch (error) {
      shared.dispose()
      throw error
    }
    if (disposed) {
      hubRuntime.free()
      shared.dispose()
      return
    }
    hub = hubRuntime
    hubView = new HubView(shared, 0, authored.zoneContent.assets, authored.zoneContent.bean, sim, {
      character: authored.zoneContent.character,
      skinned: authored.zoneContent.skinned,
      dressing: authored.zoneContent.dressing,
    })
    // The flow owns each show it starts; the page keeps the latest one only until it attaches the views.
    const startShow = (used: EngineShowConfig, start: () => Promise<EngineShowRuntime>): Promise<EngineShowRuntime> => {
      showHumans = used.humans.filter(human => human).length
      return start().then(runtime => {
        pendingRuntime = runtime
        return runtime
      })
    }
    flow = new EngineHubFlow(hubRuntime, () => {
      const starter = nextStart
      const overrides = nextOverrides
      nextStart = undefined
      nextOverrides = undefined
      if (starter !== undefined) {
        const used = config(options.plan, overrides)
        return startShow(used, () => starter(used))
      }
      const plan = nextPlan ?? options.plan
      nextPlan = undefined
      const used = config(plan)
      return startShow(used, () => createEngineShow(used))
    })
    drawHub(0)
    activeCapture = host
  }
  /** Starts one prepared show through EngineHubFlow and attaches it; a failed start reports the flow's own error. */
  const startFlow = async (): Promise<void> => {
    const current = flow
    if (current === null) throw new Error('[engine-show] the engine hub is not prepared; await page.ready before starting a show')
    await current.start()
    if (current.state() === 'failed') throw new Error(current.error() ?? '[engine-show] the show failed to start')
    syncShow()
    if (live === null) throw new Error('[engine-show] the started show is not attached')
  }
  const host: EngineShowHostApi = {
    collector,
    pauseLoop() {
      paused = true
      if (frameId !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId)
      frameId = 0
    },
    step(ticks, decide) {
      for (let i = 0; i < ticks; i++) {
        const before = watch.ownSeat ? watch.poses.get(LOCAL_SEAT) ?? null : null
        const code = decide(i)
        watch.pending = watch.ownSeat ? { code, sampled: true, before } : null
        tick(1 / 60, decodeInput(code, localInput))
      }
    },
    vote(candidate) {
      const current = live
      if (current === null) return
      const snapshot = current.runtime.snapshot()
      if (snapshot.screen !== 'vote' || snapshot.candidates.length === 0) return
      // An eliminated local seat is off the roster and has no vote; bots vote through the script.
      if (!snapshot.seatOf.includes(LOCAL_SEAT)) return
      try {
        current.runtime.vote(LOCAL_SEAT, Math.min(candidate, snapshot.candidates.length - 1))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message} [vote context: show instance #${showIds.get(current.runtime) ?? '?'}, hubFlow state '${flow?.state() ?? 'none'}', `
          + `roster seatOf [${snapshot.seatOf.join(',')}], screen '${snapshot.screen}', round ${snapshot.round}, tick ${snapshot.tick}]`, { cause: error })
      }
    },
    draw() {
      renderCurrent(1 / 60)
      const current = live
      if (current === null) return
      const submission = current.presenter.submission()
      collector.audit(submission.near, submission.far)
    },
    pump() {
      const current = live
      if (current !== null) {
        current.effects.pump()
        current.effects.pump()
        lastStats = { ...current.effects.deliveryStats() }
      }
      return lastStats
    },
    snapshot() {
      const snapshot = live?.runtime.snapshot() ?? internal.snapshot
      if (snapshot === null) throw new Error('[engine-show] no show has been presented yet; start a show before reading it')
      return snapshot
    },
    screen() { return screenNow() },
    where() {
      const snapshot = internal.snapshot
      return `round ${snapshot?.round ?? 0} screen '${snapshot?.screen ?? internal.screen}' tick ${snapshot?.tick ?? 0}`
        + ` with ${snapshot?.results.length ?? 0} confirmed rounds`
    },
    localMode() {
      const current = live
      return current === null ? -1 : localModeOf(current.runtime.presentation())
    },
    fastForward(on) {
      if (watch.fast === on) return
      watch.fast = on
      const current = live
      if (on || current === null) return
      current.read.refresh(1)
      current.scene.observeTick(current.read)
    },
    async remount(plan) {
      if (options.mode === 'online') refuse(AREA, 'remount', 'online shows start only through remountWith; pass the online starter')
      nextPlan = plan
      await startFlow()
      return host
    },
    async remountWith(start, overrides) {
      if (typeof start !== 'function') refuse(AREA, 'remountWith.start', 'must be a function preparing the show from its config')
      if (flow === null) throw new Error('[engine-show] the engine hub is not prepared; await page.ready before starting a show')
      nextStart = start
      nextOverrides = overrides
      await startFlow()
      return host
    },
    showConfig(overrides) {
      if (showConfigOf === null) throw new Error('[engine-show] the engine hub is not prepared; await page.ready before reading the show config')
      return showConfigOf(overrides)
    },
    async settle() {
      const current = live
      if (current !== null) await current.scene.animationReady()
      const deadline = performance.now() + 20000
      while (pendingPipelines() > 0) {
        if (performance.now() >= deadline) throw new Error(`[engine-show] pipeline readiness timed out; ${pendingPipelines()} pipelines still pending`)
        await new Promise<void>(resolve => { setTimeout(resolve, 10) })
      }
      for (let i = 0; i < 8; i++) renderCurrent(0)
      // The far figures are part of the frame: every submitted far seat must hold a live bridge instance.
      if (live !== null) {
        const submitted = drawn?.submission.far.size ?? 0
        if (live.bridge.instances !== submitted) {
          throw new Error(`[engine-show] far penguins not drawn: ${live.bridge.instances} bridge instances for ${submitted} submitted far seats`)
        }
      }
      const device = deviceOfCanvas(canvas) as { queue: { onSubmittedWorkDone(): Promise<unknown> } } | undefined
      if (device !== undefined) await device.queue.onSubmittedWorkDone()
    },
    stopWatching() { watch.ownSeat = false },
    async capture() {
      if (port === null) throw new Error('[engine-show] the page has no render port; await page.ready before capturing')
      const png = await port.capture()
      if (png === null) throw new Error('[engine-show] port.capture returned no image; draw a frame before capturing')
      const owner = root.ownerDocument
      const shot = owner.createElement('canvas')
      shot.width = WIDTH
      shot.height = HEIGHT
      const bitmap = await createImageBitmap(new Blob([png as BlobPart]))
      const context = shot.getContext('2d')
      if (context === null) throw new Error('[engine-show] a 2d canvas is needed to compose the capture HUD')
      context.drawImage(bitmap, 0, 0, WIDTH, HEIGHT)
      bitmap.close()
      const lines = drawn?.model.hud ?? []
      context.font = '28px monospace'
      context.fillStyle = 'rgba(0,0,0,0.6)'
      context.fillRect(24, 24, 760, 44 + lines.length * 34)
      context.fillStyle = '#ffffff'
      lines.forEach((line, i) => context.fillText(line, 44, 58 + i * 34))
      const blob = await new Promise<Blob | null>(resolve => shot.toBlob(resolve, 'image/png'))
      if (blob === null) throw new Error('[engine-show] toBlob returned no PNG for the capture')
      return new Uint8Array(await blob.arrayBuffer())
    },
    flow() {
      if (flow === null) throw new Error('[engine-show] the engine hub is not prepared; await page.ready first')
      return flow
    },
    hub() { return disposed ? null : hub },
    pushPresence(act) {
      const decoded = decodeHubAct(act.payload)
      if (decoded === null) {
        droppedPresence++
        return false
      }
      remotes.push(act.seat, decoded, act.recvMs)
      return true
    },
    presence(nowMs) { return remotes.sample(nowMs) },
    signals() { return [...signalList] },
  }
  const dispose = (): void => {
    if (disposed) return
    host.pauseLoop()
    disposed = true
    detachShow()
    flow?.dispose()
    hubView?.dispose()
    port?.dispose()
    if (activeCapture === host) activeCapture = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', openAudio)
      window.removeEventListener('keydown', openAudio)
      window.removeEventListener('keydown', startOnEnter)
    }
    input.detach()
    void sound?.close()
    sound = null
    hud.remove()
    canvas.remove()
    status.remove()
  }
  const { ready } = createEngineShowReady(prepare, show)
  paint()
  const handle: EngineShowPage = {
    ready,
    state(): EnginePageState {
      const snapshot = internal.snapshot
      const phase = flow?.state() ?? 'loading'
      const failed = phase === 'failed'
      const attached = live
      const stats = attached === null ? null : engineOnlineStats(attached.runtime)
      if (attached !== null) lastDesyncs = stats?.desyncs ?? 0
      const humans = attached === null ? options.humans : showHumans
      return {
        screen: screenNow(),
        ready: internal.ready && (phase === 'hub' || phase === 'show' || phase === 'returning'),
        error: failed ? (flow?.error() ?? null) : internal.error,
        backend: 'engine',
        seats: SEATS,
        humans,
        bots: SEATS - humans,
        round: snapshot?.round ?? 0,
        tick: snapshot?.tick ?? 0,
        moduleKey: live?.runtime.identity.moduleKey ?? internal.moduleKey,
        faults: snapshot?.faults ?? 0,
        completedRounds: snapshot?.results.length ?? 0,
        desyncs: lastDesyncs,
      }
    },
    dispose,
    presentation(): EnginePagePresentation | null {
      if (drawn === null) return null
      return {
        model: { ...drawn.model, hud: [...drawn.model.hud] },
        near: [...drawn.submission.near].sort((a, b) => a - b),
        far: [...drawn.submission.far].sort((a, b) => a - b),
        grants: grants.size,
      }
    },
  }
  activePage = handle
  return handle
}

/** The show's stored local control code, read from the world that holds the local seat; null when none is stored. */
function storedControl(presentation: EngineShowPresentation): number | null {
  for (const world of presentation.worlds) {
    const seat = world.seats.find(item => item.roomSeat === LOCAL_SEAT)
    if (seat === undefined) continue
    const engine = world.ref.timeline.module.engine
    const state = readWorldState(engine, world.ref.world, showSchemaLayout(engine))
    const row = state.components.show_control?.[String(seat.entity)]
    if (row !== undefined && typeof row.code === 'number') return row.code
  }
  return null
}

/** The local character's mode from the world that holds the local seat; -1 when absent. */
function localModeOf(presentation: EngineShowPresentation): number {
  for (const world of presentation.worlds) {
    const seat = world.seats.find(item => item.roomSeat === LOCAL_SEAT)
    if (seat === undefined) continue
    const engine = world.ref.timeline.module.engine
    const state = readWorldState(engine, world.ref.world, showSchemaLayout(engine))
    const row = state.components.character?.[String(seat.entity)]
    if (row !== undefined && typeof row.mode === 'number') return row.mode
  }
  return -1
}

function validateOptions(options: EngineShowPageOptions): void {
  if (options === null || typeof options !== 'object') refuse(AREA, 'options', 'is missing; pass mount options')
  if (options.mode !== 'local' && options.mode !== 'online') {
    refuse(AREA, 'options.mode', `'${String(options.mode)}' is not local or online; choose one`)
  }
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
    refuse(AREA, 'options.seed', 'must be an integer in 0..4294967295; pass a whole seed')
  }
  if (!Number.isInteger(options.humans) || options.humans < 0 || options.humans > MAX_HUMANS) {
    refuse(AREA, 'options.humans', `must be an integer in 0..${MAX_HUMANS}; a show configures at most eight humans`)
  }
  if (typeof options.testMode !== 'boolean') refuse(AREA, 'options.testMode', 'must be a boolean; pass true for minimum presentation waits')
  if (options.plan !== undefined && (!Array.isArray(options.plan) || options.plan.length === 0
    || options.plan.some(count => !Number.isInteger(count) || count < 1))) {
    refuse(AREA, 'options.plan', 'must be a non-empty list of positive head counts; omit it for the default show plan')
  }
  if (options.onRuntime !== undefined && typeof options.onRuntime !== 'function') {
    refuse(AREA, 'options.onRuntime', 'must be a function receiving the prepared runtime')
  }
}

/**
 * The base show configuration with the optional human count and plan replaced; an invalid count or plan refuses
 * with a visible path so a capture or the game shell cannot silently start a different show.
 */
export function applyConfigOverrides(base: EngineShowConfig, overrides?: EngineShowConfigOverrides): EngineShowConfig {
  if (overrides === undefined) return { ...base }
  const next = { ...base }
  if (overrides.humans !== undefined) {
    if (!Number.isInteger(overrides.humans) || overrides.humans < 1 || overrides.humans > MAX_HUMANS) {
      refuse(AREA, 'overrides.humans', `must be an integer in 1..${MAX_HUMANS}; configured ${String(overrides.humans)} humans`)
    }
    next.humans = humanFlags(overrides.humans)
  }
  if (overrides.plan !== undefined) {
    if (!Array.isArray(overrides.plan) || overrides.plan.length === 0 || overrides.plan.some(count => !Number.isInteger(count) || count < 1)) {
      refuse(AREA, 'overrides.plan', 'must be a non-empty list of positive head counts; omit it for the current plan')
    }
    next.plan = overrides.plan
  }
  return next
}

function humanFlags(count: number): boolean[] {
  return Array.from({ length: SEATS }, (_, roomSeat) => roomSeat < count)
}

function mountInterface(root: HTMLElement): { canvas: HTMLCanvasElement; status: HTMLElement; hud: HTMLElement } {
  const owner = root.ownerDocument ?? (typeof document === 'undefined' ? null : document)
  if (owner === null) refuse(AREA, 'root', 'has no document; mount the page inside a browser document')
  const canvas = owner.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  canvas.id = 'view'
  const status = owner.createElement('div')
  status.id = 'status'
  status.textContent = 'loading'
  const hud = owner.createElement('pre')
  hud.id = 'hud'
  root.append(canvas, status, hud)
  return { canvas, status, hud }
}

// S1 is world space: controlsToInput rotates the stick through the camera basis before encodeInput (ARCHITECTURE S1).
function controlsCode(controls: RawControls, camera: CameraPose | null, player: PlayerInput): number {
  const facing = camera === null ? { x: 0, z: 1 } : cameraBasis(camera.eye, camera.target).forward
  return encodeInput(controlsToInput(controls, facing, player))
}

type Action = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'dive' | 'grab'

function trackInput(): { controls: RawControls; poll: () => void; detach: () => void } {
  const controls: RawControls = {
    forward: false, back: false, left: false, right: false, jump: false, dive: false, grab: false, stickX: 0, stickY: 0,
  }
  const held = new Set<Action>()
  const actions: Readonly<Record<string, Action>> = {
    KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
    Space: 'jump', ShiftLeft: 'dive', ShiftRight: 'dive', KeyE: 'grab',
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    const action = actions[event.code]
    if (action === undefined) return
    held.add(action)
    event.preventDefault()
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    const action = actions[event.code]
    if (action !== undefined) held.delete(action)
  }
  const onBlur = (): void => { held.clear() }
  const onPad = (): void => {
    controls.forward = held.has('forward')
    controls.back = held.has('back')
    controls.left = held.has('left')
    controls.right = held.has('right')
    controls.jump = held.has('jump')
    controls.dive = held.has('dive')
    controls.grab = held.has('grab')
    controls.stickX = 0
    controls.stickY = 0
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return
    const pad = [...navigator.getGamepads()].find(item => item !== null)
    if (pad === undefined) return
    const x = Number.isFinite(pad.axes[0]) ? pad.axes[0] : 0
    const y = Number.isFinite(pad.axes[1]) ? pad.axes[1] : 0
    controls.stickX = Math.abs(x) > STICK_DEADZONE ? x : 0
    controls.stickY = Math.abs(y) > STICK_DEADZONE ? -y : 0
    controls.jump ||= pad.buttons[0]?.pressed === true
    controls.dive ||= pad.buttons[1]?.pressed === true
    controls.grab ||= pad.buttons[2]?.pressed === true
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
  }
  return {
    controls,
    poll: onPad,
    detach(): void {
      if (typeof window === 'undefined') return
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
}

/**
 * Loads the engine, its published identity and scripts, then loads the schema and checks the published key so the
 * page and the game shell share one loader; a mismatch refuses and names the rebuild.
 */
export async function loadEnginePublication(): Promise<PublishedEngine> {
  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
  const [engine, publication, script] = await Promise.all([
    loadEngine(engineWasmUrl === undefined ? undefined : { wasmUrl: engineWasmUrl }),
    fetch(new URL(PUBLICATION_URL, base), { cache: 'no-cache' }),
    fetch(new URL(RF_EGE_SCRIPTS_URL, base), { cache: 'no-cache' }),
  ])
  if (!publication.ok) {
    refuse(AREA, PUBLICATION_URL, `answered ${publication.status}; build the page so the scripts plugin publishes its identity`)
  }
  if (!script.ok) {
    refuse(AREA, RF_EGE_SCRIPTS_URL, `answered ${script.status}; build the page with the compiled show scripts`)
  }
  const published = await publication.json() as { schemaKey?: unknown; moduleKey?: unknown }
  if (!Number.isSafeInteger(published.schemaKey) || typeof published.moduleKey !== 'string' || published.moduleKey === '') {
    refuse(AREA, PUBLICATION_URL, 'has no engine schema key and module key; recompile the show scripts')
  }
  const identity: EngineModuleIdentity = {
    backend: 'engine',
    schemaKey: published.schemaKey as number,
    moduleKey: published.moduleKey,
  }
  const scriptBytes = await script.arrayBuffer()
  engine.setSchema(JSON.stringify(schemaJson))
  const loadedKey = schemaLayout(engine).key
  if (loadedKey !== identity.schemaKey) {
    refuse(AREA, 'publication.schemaKey', `published ${identity.schemaKey} but the loaded schema is ${loadedKey}; rebuild the show scripts`)
  }
  return { engine, identity, scriptBytes }
}

/** Loads the authored show content the page and the game shell start shows from. */
export async function loadEngineAuthoredShow(): Promise<AuthoredShow> {
  const [{ loadShowContent }, { zoneContent }] = await Promise.all([
    import('../game/showContent.ts'),
    import('../zone/zoneContent.ts'),
  ])
  const [show, zone] = await Promise.all([loadShowContent('sprint'), zoneContent('sprint')])
  const loaded = await loadV1Courses(() => {}, undefined, [...show.courses.map(course => course.id), PODIUM_COURSE, HUB_PLAZA])
  const byId = new Map(loaded.courses.map(course => [course.id, course]))
  const plaza = byId.get(HUB_PLAZA)
  if (plaza === undefined) refuse(AREA, `courses/${HUB_PLAZA}.course.json`, 'is missing from the product course loader; add the hub plaza')
  const courses: CourseV1[] = []
  for (const course of show.courses) {
    const found = byId.get(course.id)
    if (found === undefined) refuse(AREA, `courses/${course.id}.course.json`, 'is missing from the product course loader')
    courses.push(found)
  }
  const podium = byId.get(PODIUM_COURSE)
  if (podium === undefined) refuse(AREA, `courses/${PODIUM_COURSE}.course.json`, 'is missing; add the authored podium course')
  const resolver = browserGameAssets()
  const ids = [...new Set([...courses, plaza].flatMap(course => course.assetIds))]
  const resolved = await Promise.all(ids.map(async id => [id, await resolver.resolve(id)] as const))
  return {
    courses,
    plaza,
    assets: new Map(resolved),
    zones: show.zones,
    season: show.season,
    zoneContent: zone,
    podium: podiumLayoutOf(podium, id => zone.assets(id)),
  }
}

function createPort(canvas: HTMLCanvasElement, zone: ZoneContent): Promise<ResizablePort> {
  const target: RenderTarget = {
    canvas,
    width: WIDTH,
    height: HEIGHT,
    viewports: [{ x: 0, y: 0, width: WIDTH, height: HEIGHT }],
  }
  return zone.createPort(target)
}

/**
 * Handoff: 'Hub capture scenarios and command registration' calls `engineShowHost(page: EngineShowPage): EngineShowHostApi`
 * from this file. Today mountEngineShow records the one host of the mounted page and marks it active once the hub is
 * prepared and presented. The host drives EngineHubFlow.frame through `step`, starts shows through its `remount(plan)`,
 * reads the hub through `hub()` and `presence(nowMs)`, and lists the stable signals in `signals()`. The function throws
 * when `page` is not that mounted, prepared page; a scenario module reaches the hub and the flow only through it.
 */
export function engineShowHost(page: EngineShowPage): EngineShowHostApi {
  if (activeCapture === null || page !== activePage) {
    throw new Error('[engine-show] no engine show page is mounted; await page.ready before a scenario')
  }
  return activeCapture
}

const SETTLE_TICKS = 20000
const PODIUM_TICK_LIMIT = 250000

function showCode(partial: Partial<PlayerInput>): number {
  return encodeInput({ ...neutralInput(), ...partial })
}

function voteOrNeutral(host: EngineShowHostApi): number {
  if (host.screen() === 'vote') host.vote(0)
  return NEUTRAL_CODE
}

/** One fixed tick, then the pacer's slice boundary: the page answers between slices and the tick order is unchanged. */
async function stepOnce(host: EngineShowHostApi, pacer: ShowPacer, decide: () => number): Promise<void> {
  host.step(1, decide)
  await pacer.tick(() => host.where())
}

/** Starts one show from the hub through EngineHubFlow; a failed start is reported with the flow's own error. */
async function startShow(host: EngineShowHostApi): Promise<void> {
  host.pauseLoop()
  await host.flow().start()
  const flow = host.flow()
  if (flow.state() !== 'show') throw new Error(`[engine-show] the show did not start: ${flow.error() ?? flow.state()}`)
}

/** Steps until a real playable round is presented; a missing transition is a failure, never a sleep. */
async function advanceToPlaying(host: EngineShowHostApi, pacer: ShowPacer): Promise<void> {
  for (let i = 0; i < SETTLE_TICKS; i++) {
    const screen = host.screen()
    if (screen === 'playing' || screen === 'overtime') return
    await stepOnce(host, pacer, () => voteOrNeutral(host))
  }
  throw new Error(`[engine-show] the show never reached a playable round (${host.where()}); check preparation and transition signals`)
}

/** Exercises every control under its normal preconditions before the captured upright state. */
async function exerciseLocal(host: EngineShowHostApi, pacer: ShowPacer): Promise<void> {
  const collector = host.collector
  for (let i = 0; i < 120 && !collector.observed('neutral'); i++) await stepOnce(host, pacer, () => NEUTRAL_CODE)
  for (let i = 0; i < 180 && !collector.observed('positive'); i++) await stepOnce(host, pacer, () => showCode({ moveX: 1, moveZ: 1 }))
  for (let i = 0; i < 180 && !collector.observed('negative'); i++) await stepOnce(host, pacer, () => showCode({ moveX: -1, moveZ: -1 }))
  await stepOnce(host, pacer, () => showCode({ jump: true }))
  await stepOnce(host, pacer, () => showCode({ dive: true }))
  await stepOnce(host, pacer, () => showCode({ grab: true }))
  for (let i = 0; i < 20; i++) await stepOnce(host, pacer, () => NEUTRAL_CODE)
  host.stopWatching()
}

function base64Of(bytes: Uint8Array): string {
  let value = ''
  for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(value)
}

/** Draws a frame, deliberately repeats the public pump, waits for the GPU and composes the PNG with its HUD. */
async function shootFrame(host: EngineShowHostApi): Promise<Uint8Array> {
  host.draw()
  host.collector.effects(host.pump())
  await host.settle()
  return host.capture()
}

/** The PNG shot now, or the one a scenario already shot at its own moment, with the facts collected so far. */
async function captureScenario(scenario: string, host: EngineShowHostApi, shot?: Uint8Array): Promise<CaptureResult> {
  const png = shot ?? await shootFrame(host)
  if (shot !== undefined) host.collector.effects(host.pump())
  return { facts: host.collector.facts(), capture: { name: `${scenario}.png`, width: WIDTH, height: HEIGHT, mime: 'image/png', base64: base64Of(png) } }
}

async function runSimpleScenario(page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const host = engineShowHost(page)
  const pacer = createShowPacer(String(args.scenario))
  await startShow(host)
  await advanceToPlaying(host, pacer)
  await exerciseLocal(host, pacer)
  // CharMode.ground is 0: settle the exercised character back to its upright captured state.
  for (let i = 0; i < 240 && host.localMode() !== 0; i++) await stepOnce(host, pacer, () => NEUTRAL_CODE)
  return captureScenario(String(args.scenario), host)
}

/** Real ticks of the playing round before the frame is shot: the seats are still together around the start grid. */
const ROUND_SHOT_TICKS = 30

/**
 * The frame is shot at the start of the real playing round, with the local seat driven by real input: the other
 * fifty-nine seats are still around the start grid inside the unchanged follow camera (eight near seats, the rest
 * far). Shot later, the bots have already raced out of view. The local controls are then exercised for the facts.
 */
async function runRoundScenario(page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const host = engineShowHost(page)
  const pacer = createShowPacer(String(args.scenario))
  await startShow(host)
  await advanceToPlaying(host, pacer)
  for (let i = 0; i < ROUND_SHOT_TICKS; i++) await stepOnce(host, pacer, () => showCode({ moveX: 1, moveZ: 1 }))
  const shot = await shootFrame(host)
  await exerciseLocal(host, pacer)
  return captureScenario(String(args.scenario), host, shot)
}

/**
 * The confirmed podium of a real completed show: the hub remounts the show with the row's plan (PODIUM_PLAN when
 * the row names none), the first round is presented and exercised with real input, and the ticks are simulated
 * until the script-confirmed podium. The podium frame is shot while the show is still attached.
 */
async function runPodiumScenario(page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const host = engineShowHost(page)
  const pacer = createShowPacer(String(args.scenario))
  host.pauseLoop()
  const plan = Array.isArray(args.plan) ? args.plan as readonly number[] : PODIUM_PLAN
  await checkAwait(`remount the show with plan ${plan.join(',')}`, () => host.remount(plan))
  let exercised = false
  for (let i = 0; i < PODIUM_TICK_LIMIT; i++) {
    const screen = host.screen()
    if (screen === 'done') break
    if (!exercised && screen === 'playing') {
      await exerciseLocal(host, pacer)
      exercised = true
      host.fastForward(true)
      continue
    }
    await stepOnce(host, pacer, () => voteOrNeutral(host))
  }
  host.fastForward(false)
  const snapshot = host.snapshot()
  if (snapshot.screen !== 'done' || snapshot.champion === null) {
    throw new Error(`[engine-show] the show stopped at ${host.where()} after ${PODIUM_TICK_LIMIT} ticks without a confirmed champion`)
  }
  return captureScenario(String(args.scenario), host)
}

registerScenario('simple-engine-character', runSimpleScenario)
registerScenario('sixty-seat-engine-round', runRoundScenario)
registerScenario('engine-show-winner-podium', runPodiumScenario)
