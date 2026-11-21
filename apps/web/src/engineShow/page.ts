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
import { createEngineShow } from '@royal-fiesta/game/ege/showRuntime'
import type { EngineShowRuntime, EngineShowSnapshot } from '@royal-fiesta/game/ege/showTypes'
import type { EngineModuleIdentity } from '../../../../tools/egeScripts.ts'
import { EngineShowView } from '@royal-fiesta/game/ege/showView'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { CameraPose, RenderTarget } from '@royal-fiesta/game/render/port'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { encodeInput, NEUTRAL_CODE, neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { refuse } from '@royal-fiesta/sim/refusal'
import schemaJson from '../../../../ege.schema.json' with { type: 'json' }
import { browserGameAssets, loadV1Courses } from '../content/v1Data.ts'
import type { ResizablePort } from '../sdf/sdfPort.ts'
import { openBrowserAudio } from '@royal-fiesta/game/audio/context'
import type { BrowserSound } from '@royal-fiesta/game/audio/context'
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
import { createShowPacer, PODIUM_PLAN, registerScenario, ShowFactsCollector } from './ops.ts'
import type { ShowPacer } from './ops.ts'
import type { CaptureResult } from '../../../../tools/engineCaptureJob.ts'
import type { EngineShowObservation, EngineShowPresentation } from '@royal-fiesta/game/ege/showTypes'
import { readWorldState } from '@etcito/game-engine/world-state'

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

interface AuthoredShow {
  courses: CourseV1[]
  assets: Map<string, ResolvedGameAsset>
  zones: ReadonlyMap<string, ZonesFile>
  season: readonly SchedMap[]
  zoneContent: ZoneContent
  podium: PodiumLayout
}

interface PublishedEngine {
  engine: EngineInstance
  identity: EngineModuleIdentity
  scriptBytes: ArrayBuffer
}

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
  frame: number
}

/** The page-private stepping, sampling and capture handles default scenarios close over. */
interface ShowCaptureHost {
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
  /** Replaces the prepared show by a fresh one with this plan on the same loaded content and port. */
  remount(plan: readonly number[]): Promise<ShowCaptureHost>
  stopWatching(): void
  capture(): Promise<Uint8Array>
}

let activeCapture: ShowCaptureHost | null = null

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
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', openAudio)
    window.addEventListener('keydown', openAudio)
  }
  const internal = {
    ready: false,
    error: null as string | null,
    screen: 'loading',
    snapshot: null as EngineShowSnapshot | null,
    moduleKey: '',
  }
  let live: LiveShow | null = null
  let disposed = false
  let paused = false
  const collector = new ShowFactsCollector({ seats: SEATS, humans: options.humans, bots: SEATS - options.humans })
  let capture: ShowCaptureHost | null = null
  const input = trackInput()
  const player = neutralInput()
  const sample = (roomSeat: number): number => {
    if (roomSeat !== LOCAL_SEAT) return NEUTRAL_CODE
    input.poll()
    return controlsCode(input.controls, live?.scene.camera ?? null, player)
  }
  const paint = (): void => {
    status.dataset.state = internal.error !== null ? 'error' : internal.ready ? 'ready' : 'loading'
    status.textContent = internal.error ?? (internal.ready ? 'ready' : 'loading')
  }
  let lastFrame = 0
  function drawFrame(dtS: number): void {
    if (live === null) return
    const snapshot = live.runtime.snapshot()
    const presentation = live.runtime.presentation()
    live.scene.update(live.read, null, 1, dtS)
    live.presenter.refill(presentation, snapshot, live.read.nearSeats())
    const submission = live.presenter.submission()
    const model = live.tracker.update(snapshot, presentation, authoredSeason, LOCAL_SEAT)
    if (model.podium !== null) {
      live.bridge.sync(submission.view.count === 0 ? submission.view : { count: 0, stride: submission.view.stride, bytes: new Uint8Array(8) })
      const key = model.podium.join(',')
      if (key !== live.podiumKey) live.stage.show(podiumPlayers(model.podium))
      live.podiumKey = key
      live.stage.update(dtS)
    } else {
      if (live.podiumKey !== '') live.stage.hide()
      live.podiumKey = ''
      live.bridge.sync(submission.view)
    }
    live.effects.pump()
    live.port.render()
    hud.textContent = model.hud.join('\n')
    drawn = { model, submission: model.podium === null ? submission : { ...submission, far: new Set() } }
    internal.snapshot = snapshot
  }
  function loop(now: number): void {
    if (disposed || paused || live === null) return
    const dtS = Math.min((now - lastFrame) / 1000, STEP_CAP_S)
    lastFrame = now
    try {
      live.runtime.frame(dtS, sample)
      drawFrame(dtS)
    } catch (error) {
      show('error', error instanceof Error ? error.message : String(error))
      return
    }
    live.frame = requestAnimationFrame(loop)
  }
  function startLoop(): void {
    if (paused || live === null || typeof requestAnimationFrame !== 'function') return
    lastFrame = performance.now()
    live.frame = requestAnimationFrame(loop)
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
  let authoredSeason: AuthoredShow['season'] = []
  const prepare = async (): Promise<void> => {
    if (options.mode === 'online') {
      refuse(AREA, 'options.mode', 'online attachment is not available on this page yet; choose local mode')
    }
    const [published, authored] = await Promise.all([loadPublication(), loadAuthoredShow()])
    if (disposed) return
    const { engine, identity, scriptBytes } = published
    engine.setSchema(JSON.stringify(schemaJson))
    const loadedKey = schemaLayout(engine).key
    if (loadedKey !== identity.schemaKey) {
      refuse(AREA, 'publication.schemaKey', `published ${identity.schemaKey} but the loaded schema is ${loadedKey}; rebuild the show scripts`)
    }
    internal.moduleKey = identity.moduleKey
    authoredSeason = authored.season
    const createRuntime = (plan: readonly number[] | undefined): Promise<EngineShowRuntime> => createEngineShow({
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
    })
    const runtime = await createRuntime(options.plan)
    if (disposed) {
      runtime.dispose()
      return
    }
    const port = await createPort(canvas, authored.zoneContent).catch((error: unknown) => {
      runtime.dispose()
      throw error
    })
    if (disposed) {
      port.dispose()
      runtime.dispose()
      throw new Error('the engine show was disposed while it was preparing')
    }
    attach(runtime, port, authored, createRuntime)
  }
  /** Builds everything bound to one runtime on the prepared port; a remount runs it again for the new runtime. */
  function attach(
    runtime: EngineShowRuntime, port: ResizablePort, authored: AuthoredShow,
    createRuntime: (plan: readonly number[] | undefined) => Promise<EngineShowRuntime>,
  ): void {
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
        port,
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
      bridge = farPenguinBridge(port, authored.zoneContent.bean)
      stage = new PodiumStage({
        port,
        viewport: 0,
        bean: authored.zoneContent.character,
        block: authored.zoneContent.assets('wall-block'),
        layout: authored.podium,
      })
      const presenter = new EngineSeatPresenter()
      let watchLocal = true
      let botWatch = true
      let fast = false
      let pending: { code: number; sampled: boolean; before: readonly [number, number, number] | null } | null = null
      let lastPoses = new Map<number, readonly [number, number, number]>()
      const posesOf = (presentation: EngineShowPresentation): Map<number, readonly [number, number, number]> => {
        const poses = new Map<number, readonly [number, number, number]>()
        for (const world of presentation.worlds) {
          let bytes: Uint8Array
          try { bytes = world.farSnapshot() } catch { continue }
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          const count = view.getUint16(0, true)
          for (let i = 0; i < count; i++) {
            const at = 2 + i * 60
            const zone = view.getUint32(at, true)
            if (zone < 1 || zone > SEATS) continue
            poses.set(zone - 1, [view.getFloat64(at + 4, true), view.getFloat64(at + 12, true), view.getFloat64(at + 20, true)])
          }
        }
        return poses
      }
      const storedControl = (presentation: EngineShowPresentation): number | null => {
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
      const noteCapture = (observation: EngineShowObservation): void => {
        if (observation.kind !== 'post-tick') return
        const local = pending !== null && pending.sampled && watchLocal
        const bots = botWatch && observation.tick % 30 === 0
        const poses = local || bots ? posesOf(observation.presentation) : lastPoses
        if (local && pending !== null) {
          collector.sample({
            code: pending.code, stored: storedControl(observation.presentation), before: pending.before,
            after: poses.get(LOCAL_SEAT) ?? null, mode: -1,
          })
          pending = null
        }
        if (bots) {
          for (const [seat, pos] of poses) {
            if (seat < options.humans) continue
            const prior = lastPoses.get(seat)
            if (prior !== undefined && Math.hypot(pos[0] - prior[0], pos[2] - prior[2]) > 0.1) collector.botMoved(seat)
          }
          if (collector.botCount() > 0) botWatch = false
        }
        if (local || bots) lastPoses = poses
        collector.progress({ snapshot: observation.snapshot, course: observation.presentation.course?.id ?? null, tick: observation.presentation.tick })
        collector.scriptFaults(observation.snapshot.faults)
      }
      const current: LiveShow = {
        runtime, read: currentRead, scene: currentScene, effects, port, presenter, bridge, stage,
        tracker: new EngineScreenTracker(), podiumKey: '', unsubscribe: null, captureUnsubscribe: null, frame: 0,
      }
      current.unsubscribe = runtime.onPresentation(observation => {
        if (observation.kind !== 'post-tick') {
          presenter.observe(observation, new Set())
          return
        }
        internal.snapshot = observation.snapshot
        internal.screen = observation.snapshot.screen
        if (fast) return
        currentRead.refresh(1)
        currentScene.observeTick(currentRead)
        presenter.observe(observation, currentRead.nearSeats())
      })
      current.captureUnsubscribe = runtime.onPresentation(noteCapture)
      internal.snapshot = runtime.snapshot()
      internal.screen = internal.snapshot.screen
      live = current
      capture = {
        collector,
        pauseLoop() {
          paused = true
          if (current.frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(current.frame)
          current.frame = 0
        },
        step(ticks, decide) {
          for (let i = 0; i < ticks; i++) {
            if ((internal.snapshot?.screen ?? internal.screen) === 'done') return
            const before = watchLocal ? lastPoses.get(LOCAL_SEAT) ?? null : null
            pending = watchLocal ? { code: NEUTRAL_CODE, sampled: false, before } : null
            current.runtime.frame(1 / 60, seat => {
              if (seat !== LOCAL_SEAT) return NEUTRAL_CODE
              const code = decide(i)
              if (watchLocal) pending = { code, sampled: true, before }
              return code
            })
          }
        },
        vote(candidate) {
          const snapshot = current.runtime.snapshot()
          if (snapshot.screen !== 'vote' || snapshot.candidates.length === 0) return
          current.runtime.vote(LOCAL_SEAT, Math.min(candidate, snapshot.candidates.length - 1))
        },
        draw() {
          drawFrame(1 / 60)
          const submission = current.presenter.submission()
          collector.audit(submission.near, submission.far)
        },
        pump() {
          current.effects.pump()
          current.effects.pump()
          return current.effects.deliveryStats()
        },
        snapshot() { return current.runtime.snapshot() },
        screen() { return internal.snapshot?.screen ?? internal.screen },
        where() {
          const snapshot = internal.snapshot
          return `round ${snapshot?.round ?? 0} screen '${snapshot?.screen ?? internal.screen}' tick ${snapshot?.tick ?? 0}`
            + ` with ${snapshot?.results.length ?? 0} confirmed rounds`
        },
        localMode() {
          const presentation = current.runtime.presentation()
          for (const world of presentation.worlds) {
            const seat = world.seats.find(item => item.roomSeat === LOCAL_SEAT)
            if (seat === undefined) continue
            const engine = world.ref.timeline.module.engine
            const state = readWorldState(engine, world.ref.world, showSchemaLayout(engine))
            const row = state.components.character?.[String(seat.entity)]
            if (row !== undefined && typeof row.mode === 'number') return row.mode
          }
          return -1
        },
        fastForward(on) {
          if (fast === on) return
          fast = on
          if (on) return
          currentRead.refresh(1)
          currentScene.observeTick(currentRead)
        },
        async remount(plan) {
          if (live !== current) throw new Error('[engine-show] this capture host was replaced; use the host returned by remount')
          this.pauseLoop()
          detach(current)
          live = null
          capture = null
          activeCapture = null
          drawn = null
          grants.clear()
          let next: EngineShowRuntime
          try {
            next = await createRuntime(plan)
          } catch (error) {
            port.dispose()
            throw error
          }
          if (disposed) {
            next.dispose()
            port.dispose()
            throw new Error('[engine-show] the engine show was disposed while it was remounting')
          }
          attach(next, port, authored, createRuntime)
          if (activeCapture === null) throw new Error('[engine-show] the remounted show has no capture host')
          return activeCapture
        },
        stopWatching() { watchLocal = false },
        async capture() {
          const png = await current.port.capture()
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
      }
      activeCapture = capture
    } catch (error) {
      stage?.dispose()
      bridge?.dispose()
      port.dispose()
      scene?.dispose()
      read?.dispose()
      effects?.dispose()
      runtime.dispose()
      throw error
    }
  }
  /** Releases everything attach built for one runtime; the shared port stays with its owner. */
  function detach(current: LiveShow): void {
    if (current.frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(current.frame)
    current.frame = 0
    current.unsubscribe?.()
    current.captureUnsubscribe?.()
    current.effects.dispose()
    current.presenter.clear()
    current.bridge.dispose()
    current.stage.dispose()
    current.scene.dispose()
    current.read.dispose()
    current.runtime.dispose()
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const current = live
    live = null
    if (current !== null) {
      if (activeCapture === capture) activeCapture = null
      detach(current)
      current.port.dispose()
    }
    input.detach()
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', openAudio)
      window.removeEventListener('keydown', openAudio)
    }
    void sound?.close()
    sound = null
    hud.remove()
    canvas.remove()
    status.remove()
  }
  const { ready } = createEngineShowReady(prepare, show)
  paint()
  return {
    ready,
    state(): EnginePageState {
      const snapshot = internal.snapshot
      return {
        screen: snapshot?.screen ?? internal.screen,
        ready: internal.ready,
        error: internal.error,
        backend: 'engine',
        seats: SEATS,
        humans: options.humans,
        bots: SEATS - options.humans,
        round: snapshot?.round ?? 0,
        tick: snapshot?.tick ?? 0,
        moduleKey: live?.runtime.identity.moduleKey ?? internal.moduleKey,
        faults: snapshot?.faults ?? 0,
        completedRounds: snapshot?.results.length ?? 0,
        desyncs: 0,
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

async function loadPublication(): Promise<PublishedEngine> {
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
  return { engine, identity, scriptBytes: await script.arrayBuffer() }
}

async function loadAuthoredShow(): Promise<AuthoredShow> {
  const [{ loadShowContent }, { zoneContent }] = await Promise.all([
    import('../game/showContent.ts'),
    import('../zone/zoneContent.ts'),
  ])
  const [show, zone] = await Promise.all([loadShowContent('sprint'), zoneContent('sprint')])
  const loaded = await loadV1Courses(() => {}, undefined, [...show.courses.map(course => course.id), PODIUM_COURSE])
  const byId = new Map(loaded.courses.map(course => [course.id, course]))
  const courses: CourseV1[] = []
  for (const course of show.courses) {
    const found = byId.get(course.id)
    if (found === undefined) refuse(AREA, `courses/${course.id}.course.json`, 'is missing from the product course loader')
    courses.push(found)
  }
  const podium = byId.get(PODIUM_COURSE)
  if (podium === undefined) refuse(AREA, `courses/${PODIUM_COURSE}.course.json`, 'is missing; add the authored podium course')
  const resolver = browserGameAssets()
  const ids = [...new Set(courses.flatMap(course => course.assetIds))]
  const resolved = await Promise.all(ids.map(async id => [id, await resolver.resolve(id)] as const))
  return {
    courses,
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

const SETTLE_TICKS = 20000
const PODIUM_TICK_LIMIT = 250000

function requireCaptureHost(): ShowCaptureHost {
  if (activeCapture === null) throw new Error('[engine-show] the capture host is not prepared; await page.ready before a scenario')
  return activeCapture
}

function showCode(partial: Partial<PlayerInput>): number {
  return encodeInput({ ...neutralInput(), ...partial })
}

function voteOrNeutral(host: ShowCaptureHost): number {
  if (host.screen() === 'vote') host.vote(0)
  return NEUTRAL_CODE
}

/** One fixed tick, then the pacer's slice boundary: the page answers between slices and the tick order is unchanged. */
async function stepOnce(host: ShowCaptureHost, pacer: ShowPacer, decide: () => number): Promise<void> {
  host.step(1, decide)
  await pacer.tick(() => host.where())
}

/** Steps until a real playable round is presented; a missing transition is a failure, never a sleep. */
async function advanceToPlaying(host: ShowCaptureHost, pacer: ShowPacer): Promise<void> {
  for (let i = 0; i < SETTLE_TICKS; i++) {
    const screen = host.screen()
    if (screen === 'playing' || screen === 'overtime') return
    await stepOnce(host, pacer, () => voteOrNeutral(host))
  }
  throw new Error(`[engine-show] the show never reached a playable round (${host.where()}); check preparation and transition signals`)
}

/** Exercises every control under its normal preconditions before the captured upright state. */
async function exerciseLocal(host: ShowCaptureHost, pacer: ShowPacer): Promise<void> {
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

/** Draws the captured frame, deliberately repeats the public pump, then composes the PNG. */
async function captureScenario(scenario: string, host: ShowCaptureHost): Promise<CaptureResult> {
  host.draw()
  host.collector.effects(host.pump())
  const png = await host.capture()
  return { facts: host.collector.facts(), capture: { name: `${scenario}.png`, width: WIDTH, height: HEIGHT, mime: 'image/png', base64: base64Of(png) } }
}

async function runSimpleScenario(_page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const host = requireCaptureHost()
  const pacer = createShowPacer(String(args.scenario))
  host.pauseLoop()
  await advanceToPlaying(host, pacer)
  await exerciseLocal(host, pacer)
  // CharMode.ground is 0: settle the exercised character back to its upright captured state.
  for (let i = 0; i < 240 && host.localMode() !== 0; i++) await stepOnce(host, pacer, () => NEUTRAL_CODE)
  return captureScenario(String(args.scenario), host)
}

async function runRoundScenario(_page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const host = requireCaptureHost()
  const pacer = createShowPacer(String(args.scenario))
  host.pauseLoop()
  await advanceToPlaying(host, pacer)
  await exerciseLocal(host, pacer)
  for (let i = 0; i < 240; i++) {
    const screen = host.screen()
    if (screen === 'results' || screen === 'podium' || screen === 'done') break
    await stepOnce(host, pacer, () => showCode({ moveX: 1, moveZ: 1 }))
  }
  return captureScenario(String(args.scenario), host)
}

/**
 * The confirmed podium of a real completed show: the show is remounted with the row's plan (PODIUM_PLAN when
 * the row names none), the first round is presented and exercised with real input, and the remaining ticks are
 * simulated unpresented until the script-confirmed champion. Nothing is forced or skipped in the simulation.
 */
async function runPodiumScenario(_page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const pacer = createShowPacer(String(args.scenario))
  requireCaptureHost().pauseLoop()
  const plan = Array.isArray(args.plan) ? args.plan as readonly number[] : PODIUM_PLAN
  const host = await checkAwait(`remount the show with plan ${plan.join(',')}`, () => requireCaptureHost().remount(plan))
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
