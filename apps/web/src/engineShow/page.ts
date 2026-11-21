import { loadEngine } from '@etcito/game-engine'
import type { EngineInstance } from '@etcito/game-engine/loader'
import { schemaLayout } from '@etcito/game-engine/script'
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
import { createEngineShowReady } from './ready.ts'
import { engineShowTestMode } from './testMode.ts'

const AREA = 'engine-show'
const WIDTH = 1920
const HEIGHT = 1080
const SEATS = 60
const MAX_HUMANS = 8
const LOCAL_SEAT = 0
const PUBLICATION_URL = 'ege/rf-publication.json'
const STEP_CAP_S = 0.25
const STICK_DEADZONE = 0.15

/** The dedicated page's startup options; the bootstrap defaults to local mode, sixty seats and one human. */
export interface EngineShowPageOptions {
  mode: 'local' | 'online'
  testMode: boolean
  seed: number
  humans: number
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
  unsubscribe: (() => void) | null
  frame: number
}

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
  const { canvas, status } = mountInterface(root)
  const internal = {
    ready: false,
    error: null as string | null,
    screen: 'loading',
    snapshot: null as EngineShowSnapshot | null,
    moduleKey: '',
  }
  let live: LiveShow | null = null
  let disposed = false
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
    live.scene.update(live.read, null, 1, dtS)
    live.port.render()
    internal.snapshot = live.runtime.snapshot()
  }
  function loop(now: number): void {
    if (disposed || live === null) return
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
    if (live === null || typeof requestAnimationFrame !== 'function') return
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
    const runtime = await createEngineShow({
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
      testMode: engineShowTestMode(options.testMode).enabled,
    })
    if (disposed) {
      runtime.dispose()
      return
    }
    let read: EngineShowView | null = null
    let scene: SceneView | null = null
    let effects: EngineShowEffects | null = null
    let port: ResizablePort | null = null
    try {
      options.onRuntime?.(runtime)
      read = new EngineShowView(runtime)
      read.refresh(1)
      const currentRead = read
      effects = new EngineShowEffects(runtime, { sound: () => {}, grant: () => {} })
      port = await createPort(canvas, authored.zoneContent)
      if (disposed) throw new Error('the engine show was disposed while it was preparing')
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
      const current: LiveShow = { runtime, read: currentRead, scene: currentScene, effects, port, unsubscribe: null, frame: 0 }
      current.unsubscribe = runtime.onPresentation(observation => {
        if (observation.kind !== 'post-tick') return
        currentRead.refresh(1)
        currentScene.observeTick(currentRead)
        internal.snapshot = observation.snapshot
        internal.screen = observation.snapshot.screen
      })
      internal.snapshot = runtime.snapshot()
      internal.screen = internal.snapshot.screen
      live = current
    } catch (error) {
      port?.dispose()
      scene?.dispose()
      read?.dispose()
      effects?.dispose()
      runtime.dispose()
      throw error
    }
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const current = live
    live = null
    if (current !== null) {
      if (current.frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(current.frame)
      current.unsubscribe?.()
      current.effects.dispose()
      current.scene.dispose()
      current.read.dispose()
      current.port.dispose()
      current.runtime.dispose()
    }
    input.detach()
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
  if (options.onRuntime !== undefined && typeof options.onRuntime !== 'function') {
    refuse(AREA, 'options.onRuntime', 'must be a function receiving the prepared runtime')
  }
}

function humanFlags(count: number): boolean[] {
  return Array.from({ length: SEATS }, (_, roomSeat) => roomSeat < count)
}

function mountInterface(root: HTMLElement): { canvas: HTMLCanvasElement; status: HTMLElement } {
  const owner = root.ownerDocument ?? (typeof document === 'undefined' ? null : document)
  if (owner === null) refuse(AREA, 'root', 'has no document; mount the page inside a browser document')
  const canvas = owner.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  canvas.id = 'view'
  const status = owner.createElement('div')
  status.id = 'status'
  status.textContent = 'loading'
  root.append(canvas, status)
  return { canvas, status }
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
  const loaded = await loadV1Courses(() => {}, undefined, show.courses.map(course => course.id))
  const byId = new Map(loaded.courses.map(course => [course.id, course]))
  const courses: CourseV1[] = []
  for (const course of show.courses) {
    const found = byId.get(course.id)
    if (found === undefined) refuse(AREA, `courses/${course.id}.course.json`, 'is missing from the product course loader')
    courses.push(found)
  }
  const resolver = browserGameAssets()
  const ids = [...new Set(courses.flatMap(course => course.assetIds))]
  const resolved = await Promise.all(ids.map(async id => [id, await resolver.resolve(id)] as const))
  return {
    courses,
    assets: new Map(resolved),
    zones: show.zones,
    season: show.season,
    zoneContent: zone,
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
