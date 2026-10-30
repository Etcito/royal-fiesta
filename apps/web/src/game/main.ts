// game.html entry, the player page (ARCHITECTURE 1.3): screens -> loading -> hub -> match -> podium -> hub.
// The hub and its matches run in-page with bots, or on the relay when ?server= is given; ?clients=2..4 runs
// that many piloted clients over a LoopbackRelay. Content comes from pickContent, input only from GameInput.
// Every screen and the round HUD are drawn by uaa on canvas#ui, above the RAA views.
/// <reference types="vite/client" />
import { roundOverlay } from '../content/roundOverlay.ts'
import { observeRoundLoad, startup, renderFrame, simStep } from '@royal-fiesta/game/render/roundLoad'
import { UaaError } from '@etcito/uaa'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { basisFromFacing } from '@royal-fiesta/game/client/cameraBasis'
import type { Planar } from '@royal-fiesta/game/client/cameraBasis'
import { controlsToInput, emptyControls, mergeControls } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import { LocalMatch } from '@royal-fiesta/game/client/localMatch'
import { localPadMapStore } from '@royal-fiesta/game/client/padMap'
import type { PadMapStore } from '@royal-fiesta/game/client/padMap'
import { MAX_LOCAL_SEATS, SeatTable, claimSeats } from '@royal-fiesta/game/client/seats'
import type { DeviceId } from '@royal-fiesta/game/client/seats'
import { overviewCamera, pixelViewports, splitLayout } from '@royal-fiesta/game/client/splitLayout'
import type { SplitCell } from '@royal-fiesta/game/client/splitLayout'
import type { GameContent } from '@royal-fiesta/game/content'
import { PlayFlow } from '@royal-fiesta/game/hub/flow'
import { HubWorld } from '@royal-fiesta/game/hub/hubWorld'
import { QueuePad } from '@royal-fiesta/game/hub/queuePad'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import { netSetup } from '@royal-fiesta/game/net/tuning'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { PodiumStage } from '@royal-fiesta/game/render/podiumStage'
import type { CameraPose, RenderPort, Viewport } from '@royal-fiesta/game/render/port'
import { pendingPipelines } from '../render/asyncPipelines.ts'
import { SceneLayer } from '@royal-fiesta/game/render/sceneLayer'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import { skinnedCharacterOf } from '../content/providers/sdf.ts'
import { menuModel } from '@royal-fiesta/game/screens/menuModel'
import type { MenuCmd } from '@royal-fiesta/game/screens/menuModel'
import { Effect, Nav } from '@royal-fiesta/game/screens/nav'
import type { GameScreen, Screen } from '@royal-fiesta/game/screens/nav'
import { SETTINGS_ROWS, adjust, loadSettings, rebind, saveSettings } from '@royal-fiesta/game/screens/settings'
import type { KeyAction, Settings, SettingsStore } from '@royal-fiesta/game/screens/settings'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { MatchSim, Phase } from '@royal-fiesta/sim/match/matchSim'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import type { MatchSetup } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { planCanvases } from '../client/canvases.ts'
import type { ClientCell } from '../client/canvases.ts'
import { hudValues } from '../client/hud.ts'
import type { HudValues } from '../client/hud.ts'
import { mountLoading } from '../content/loading.ts'
import { pickContent } from '../content/source.ts'
import { GameInput, InputDevices } from '../input/input.ts'
import type { DevicePoll, UiEvent } from '../input/input.ts'
import { mountPadRemap } from '../input/padRemapScreen.ts'
import { mountTouchControls } from '../input/touch.ts'
import type { ListenerPose } from '@royal-fiesta/game/audio/emitters'
import { HubView } from '../play/hubView.ts'
import { InPageHubLoop } from '../play/inpageHub.ts'
import { SoundDriver } from '../play/sound.ts'
import { widgetsOf } from '../ui/screenMap.ts'
import type { ScreensDoc, WidgetProps } from '../ui/screenMap.ts'
import { createUaaHost } from '../ui/uaaHost.ts'
import type { UaaCommand, UaaHost, UaaScreenChange } from '../ui/uaaHost.ts'
import uiDocText from '../../../../ui/screens.ui-doc.json?raw'
import { installGameOps } from './ops.ts'
import type { TourGame } from './uiTour.ts'

interface Query {
  course: string | null
  server: string | null
  hub: string | 'new'
  name: string
  colour: number
  party: 2 | 3 | 4
  clients: number
  touch: 0 | 1
}

type Look = { dx: number; dy: number; rx: number; ry: number }

// Content, physics and one port per client canvas, all ready before any mode starts.
interface Loaded { R: RapierModule; content: GameContent; ports: RenderPort[]; canvases: HTMLCanvasElement[]; course: ResolvedCourse | null }

const STEP_S = 1 / 60
const PLAYERS = 8
// The podium screen returns to the hub by itself after this, or earlier with its button.
const PODIUM_HOLD_S = 6

function intParam(q: URLSearchParams, key: string, def: number, min: number, max: number): number {
  const raw = q.get(key)
  if (raw === null) return def
  const n = Number(raw)
  if (!/^-?\d+$/.test(raw) || n < min || n > max) refuse('query', key, `'${raw}' is not an integer in ${min}..${max}; fix ?${key}=`)
  return n
}

// content= is read by pickContent itself.
function parseQuery(search: string): Query {
  const q = new URLSearchParams(search)
  const course = q.get('course')
  if (course !== null && course.length === 0) refuse('query', 'course', 'is empty; pass a course id of the content playlist')
  const server = q.get('server')
  if (server !== null && !/^wss?:\/\/\S+$/.test(server)) refuse('query', 'server', `'${server}' is not a ws:// or wss:// URL; fix ?server=`)
  const hub = q.get('hub') ?? 'new'
  if (hub !== 'new' && !/^\d{4}$/.test(hub)) refuse('query', 'hub', `'${hub}' is not new or a 4-digit code; pass the code the hub shows`)
  const name = q.get('name') ?? 'Bean'
  if (name.length < 1 || name.length > 24) refuse('query', 'name', `has ${name.length} characters; choose a name of 1..24 characters`)
  const colour = intParam(q, 'colour', Math.floor(Math.random() * 8), 0, 7)
  const party = intParam(q, 'party', 4, 2, 4) as 2 | 3 | 4
  const clients = intParam(q, 'clients', 1, 1, 4)
  const touch = intParam(q, 'touch', 0, 0, 1) as 0 | 1
  if (course !== null && server !== null) refuse('query', 'course', 'plays in-page with bots; drop ?server= or ?course=')
  if (clients > 1 && server !== null) refuse('query', 'clients', `${clients} in-page clients use a LoopbackRelay; drop ?server= or ?clients=`)
  if (clients > 1 && course !== null) refuse('query', 'clients', `?course= plays one client with bots; drop ?clients= or ?course=`)
  return { course, server, hub, name, colour, party, clients, touch }
}

// A coarse pointer (a phone or tablet) uses the on-screen controls; ?touch=1 asks for them on any device.
function touchWanted(search: string): boolean {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true
  return new URLSearchParams(search).get('touch') === '1'
}

function requiredElement<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (found === null) throw new Error(`game.html needs ${selector}`)
  return found
}

// PlayFlow applies controlsToInput with the character facing, so the camera-relative world move w is
// re-expressed as a stick in that frame: stickX = w · right, stickY = w · forward of basisFromFacing(charFacing).
function inCharacterFrame(w: PlayerInput, charFacing: Planar, out: RawControls): RawControls {
  const b = basisFromFacing(charFacing)
  out.left = out.right = out.forward = out.back = false
  out.stickX = w.moveX * b.right.x + w.moveZ * b.right.z
  out.stickY = w.moveX * b.forward.x + w.moveZ * b.forward.z
  out.jump = w.jump
  out.dive = w.dive
  out.grab = w.grab
  return out
}

function emptyViewState(): MatchViewState {
  return {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: -1, roundKind: null, final: false, courseIndex: -1,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
}

function emptyChar(): CharState {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
}

function emptyCharView(): CharacterView {
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function byId(a: ResolvedCourse, b: ResolvedCourse): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const PLACES = ['1st', '2nd', '3rd']

function playerNames(seat: number, name: string): string[] {
  return Array.from({ length: PLAYERS }, (_, p) => (p === seat ? name : `Bean ${p + 1}`))
}

function podiumLines(podium: readonly number[], names: readonly string[]): string[] {
  return podium.map((p, i) => `${PLACES[i]} ${names[p] ?? `Bean ${p + 1}`}`)
}

// The game screen a match shows from its sim view; the podium stage takes over once a podium is known.
function matchScreen(v: MatchViewState, localStatus: number, podium: boolean): GameScreen {
  if (podium || v.phase === Phase.podium || v.phase === Phase.done) return 'podium'
  if (v.phase === Phase.intro) return 'countdown'
  if (v.phase === Phase.playing) return localStatus === PlayerStatus.alive ? 'round' : 'spectate'
  return 'result'
}

// Calls frame once per page frame and returns the stop.
type FrameLoop = (frame: (dtS: number) => void) => () => void

// Where the App keeps its settings and what calls its frames: the page's localStorage and rAF loop, or
// the uiTour op's in-memory store and its own frame steps. beforeLoad runs as each load starts; a throw fails
// that load as any load failure does (the uiTour op refuses the boot load so it can reach 'loading' with Retry).
interface AppEnv { store: SettingsStore; padStorage: Storage | null; loop: FrameLoop; beforeLoad?: () => Promise<void> }

// The page's FrameLoop, on requestAnimationFrame. An op tears the App down before building its own views.
function loop(frame: (dtS: number) => void): () => void {
  let last = performance.now()
  let id = 0
  const tick = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, now - last) / 1000)
    last = now
    frame(dt)
    id = requestAnimationFrame(tick)
  }
  id = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(id)
}

// One canvas per client, appended to the #views grid in client order.
function mountCanvas(root: HTMLElement, cell: ClientCell): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = cell.canvasWidth
  canvas.height = cell.canvasHeight
  canvas.dataset.client = String(cell.client)
  root.appendChild(canvas)
  return canvas
}

// The backing (canvas.width/height) size the S26 pixel viewports cover: their union's far edge.
function backingSize(viewports: readonly Viewport[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const v of viewports) {
    width = Math.max(width, v.x + v.width)
    height = Math.max(height, v.y + v.height)
  }
  return { width, height }
}

// What the app hands a running mode each page frame. world is the camera-relative move (controlsToInput
// with the orbit camera's ground facing); a paused mode keeps drawing but does not step.
interface FrameIn {
  dt: number; paused: boolean; world: PlayerInput; emote: number
  // This frame's device polls (0..deviceCount) for the local seats.
  devices: readonly DevicePoll[]; deviceCount: number
}
interface HudState { view: MatchViewState; names: string[]; seat: number }

interface Mode {
  // Advances one page frame and returns the game screen it is on.
  frame(f: FrameIn): GameScreen
  // Lines for the hub overlay and the queue, result and podium panels.
  lines(): string[]
  // The match being drawn (for the sound), if any.
  sim(): MatchSim | null
  // What the match HUD shows, null outside a match.
  hud(): HudState | null
  // The podium has been held long enough: the app sends toHub.
  readonly finished: boolean
  // A refusal the mode cannot recover from: the app shows the error screen.
  readonly failure: string | null
  enqueue(): void
  dequeue(): void
  leaveMatch(): void
  dispose(): void
  // Local split screen: a device with a seat, and seat 0's sound listener when its camera exists.
  seated?(device: DeviceId): boolean
  listener?(): ListenerPose | null
}

interface ModeCtx {
  loaded: Loaded; q: Query; orbit: OrbitCamera; prepared?: boolean
  // Touch controls drive seat 0 and hold it: the local table then has room for one seat only.
  touch: boolean
  // Local play's S26 canvas layout (App.setLayout): one cell per seat, plus the overview cell at 3.
  setLayout: (seats: number) => void
}

// Draws one match on port 0: the SceneView framed by the orbit camera while rounds run, then the
// PodiumStage (content.podium()) once a podium is known.
class MatchPresenter {
  readonly view = emptyViewState()
  podiumS = 0
  private readonly c: ModeCtx
  private readonly stage: PodiumStage
  private scene: SceneView | null = null
  private podium: number[] | null = null

  constructor(c: ModeCtx) {
    this.c = c
    const content = c.loaded.content
    this.stage = new PodiumStage({
      port: c.loaded.ports[0], viewport: 0, bean: content.character(), block: content.assets('wall-block'), layout: content.podium(),
    })
  }

  get onPodium(): boolean {
    return this.podium !== null
  }

  get places(): readonly number[] | null {
    return this.podium
  }

  begin(seat: number): void {
    this.end()
    const { content, ports } = this.c.loaded
    const orbit = this.c.orbit
    // Each match starts looking along +Z.
    orbit.reset(0)
    this.scene = new SceneView({
      port: ports[0], viewport: 0, localPlayer: seat, assets: name => content.assets(name), bean: content.character(),
      character: content.character(), dressing: content.dressing(), camera: focus => orbit.pose(focus),
      loadingPaint: !this.c.prepared, skinned: skinnedCharacterOf(content),
    })
  }

  // podium: the places to show once known (null before). The HUD is drawn by the app's screen rules.
  draw(sim: MatchSim, smoother: Parameters<SceneView['update']>[1], alpha: number, dt: number, podium: readonly number[] | null): void {
    if (podium !== null && podium.length > 0 && this.podium === null) {
      this.podium = podium.slice(0, 3)
      this.stage.show(this.podium)
      this.podiumS = 0
    }
    if (this.podium !== null) {
      this.podiumS += dt
      this.stage.update(dt)
      return
    }
    this.scene?.update(sim, smoother, alpha, dt)
  }

  end(): void {
    this.scene?.dispose()
    this.scene = null
    this.podium = null
    this.podiumS = 0
    this.stage.hide()
  }

  dispose(): void {
    this.end()
    this.stage.dispose()
  }
}

// ?course=<id>: one sprint round of that course. MatchSetup needs a race and a survival course, so the
// playlist's courses of the other kind ride along and round 0 can only pick the chosen one: 8 players
// make round 0 a race; a survival round 0 needs <= 3 alive (planRound), so 1 human + 2 bots.
function courseSetup(seed: number, chosen: ResolvedCourse, playlist: readonly ResolvedCourse[]): MatchSetup {
  if (chosen.kind !== 'race' && chosen.kind !== 'survival') {
    refuse('query', 'course', `'${chosen.id}' is a ${chosen.kind} course; pass a race or survival course of the playlist`)
  }
  const other = chosen.kind === 'race' ? 'survival' : 'race'
  const courses = [chosen, ...playlist.filter(c => c.kind === other)].sort(byId)
  const players = chosen.kind === 'race' ? PLAYERS : 3
  return { seed, playerCount: players, humans: Array.from({ length: players }, (_, p) => p === 0), profile: 'sprint', courses }
}

interface LocalRun { match: LocalMatch; singleRace: boolean; order: number[] }

function deviceName(device: DeviceId): string {
  if (device === 'keyboard') return 'Keyboard'
  if (device === 'touch') return 'Touch'
  return `Pad ${Number(device.slice(4)) + 1}`
}

// The hub's join prompt: 'P1 Keyboard, P2 Pad 1, ...'.
function seatLine(seats: readonly { device: DeviceId }[]): string {
  return seats.map((seat, k) => `P${k + 1} ${deviceName(seat.device)}`).join(', ')
}

// The XZ facing a camera looks along, in the default +Z when it has none or looks straight down.
function cameraFacing(cam: CameraPose | null): Planar {
  if (cam === null) return { x: 0, z: 1 }
  const dx = cam.target[0] - cam.eye[0]
  const dz = cam.target[2] - cam.eye[2]
  const len = Math.hypot(dx, dz)
  return len === 0 ? { x: 0, z: 1 } : { x: dx / len, z: dz / len }
}

// Local split screen's views: one SceneView per seat on the shared port (viewport k, localPlayer k),
// the overview camera in the fourth cell at three seats, and the PodiumStage once a podium is known.
// Seat 0 keeps the orbit camera; the other seats follow their own player.
class LocalPresenter {
  readonly view = emptyViewState()
  podiumS = 0
  private readonly c: ModeCtx
  private readonly stage: PodiumStage
  private scenes: SceneView[] = []
  private seats = 0
  private podium: number[] | null = null
  private overviewIndex = -1
  private overviewCam: CameraPose | null = null
  private readonly state = emptyViewState()

  constructor(c: ModeCtx) {
    this.c = c
    const content = c.loaded.content
    this.stage = new PodiumStage({
      port: c.loaded.ports[0], viewport: 0, bean: content.character(), block: content.assets('wall-block'), layout: content.podium(),
    })
  }

  get onPodium(): boolean {
    return this.podium !== null
  }

  get places(): readonly number[] | null {
    return this.podium
  }

  begin(match: LocalMatch, seats: number): void {
    this.end()
    const { content, ports } = this.c.loaded
    const orbit = this.c.orbit
    // Each match starts looking along +Z.
    orbit.reset(0)
    this.seats = seats
    this.scenes = []
    for (let k = 0; k < seats; k++) {
      this.scenes.push(new SceneView({
        port: ports[0], viewport: k, localPlayer: k, assets: name => content.assets(name), bean: content.character(),
        character: content.character(), dressing: content.dressing(),
        camera: k === 0 ? focus => orbit.pose(focus) : undefined,
        loadingPaint: !this.c.prepared, skinned: skinnedCharacterOf(content),
      }))
    }
  }

  // The facing a seat's own camera looks along (default +Z before its first update).
  facing(seat: number): Planar {
    return cameraFacing(this.scenes[seat]?.camera ?? null)
  }

  // Seat 0's sound listener: the eye plus the normalised XZ of target - eye, or null without a camera.
  listener(): ListenerPose | null {
    const cam = this.scenes[0]?.camera
    if (cam === null || cam === undefined) return null
    const f = cameraFacing(cam)
    return { x: cam.eye[0], y: cam.eye[1], z: cam.eye[2], fx: f.x, fz: f.z }
  }

  // Returns true when this draw put the podium up: the caller then gives the stage the whole canvas.
  draw(match: LocalMatch, alpha: number, dt: number, podium: readonly number[] | null): boolean {
    if (podium !== null && podium.length > 0 && this.podium === null) {
      this.podium = podium.slice(0, 3)
      this.disposeScenes()
      this.stage.show(this.podium)
      this.podiumS = 0
      return true
    }
    if (this.podium !== null) {
      this.podiumS += dt
      this.stage.update(dt)
      return false
    }
    for (const view of this.scenes) view.update(match.sim, null, alpha, dt)
    if (this.seats === 3) {
      const ci = match.sim.phase(this.state).courseIndex
      if (ci !== this.overviewIndex) {
        this.overviewIndex = ci
        const course = match.sim.course()
        this.overviewCam = course === null ? null : overviewCamera(course)
      }
      if (this.overviewCam !== null) this.c.loaded.ports[0].setCamera(3, this.overviewCam)
    }
    return false
  }

  end(): void {
    this.disposeScenes()
    this.podium = null
    this.podiumS = 0
    this.overviewIndex = -1
    this.overviewCam = null
    this.stage.hide()
  }

  dispose(): void {
    this.end()
    this.stage.dispose()
  }

  private disposeScenes(): void {
    for (const view of this.scenes) view.dispose()
    this.scenes = []
  }
}

// The in-page game: the local hub (HubWorld + queue pad), then a match against bots on the local-play
// LocalMatch (no peers, so no rollback), its podium, and the hub again. The first device pressed or used holds seat 0; in the hub
// another device's join button takes the next seat, and each seat drives its own player.
class LocalMode implements Mode {
  failure: string | null = null
  private readonly c: ModeCtx
  private readonly presenter: LocalPresenter
  private readonly hubView: HubView
  private hub: HubWorld
  private pad = new QueuePad(1)
  private hubAcc = 0
  private readonly seats: SeatTable
  private match: LocalRun | null = null
  private prepared: LocalRun | null = null
  private readonly hubLayer: SceneLayer
  private readonly matchLayer: SceneLayer
  private readonly names: string[]
  private readonly local = emptyChar()
  private readonly cv = emptyCharView()
  private readonly still = emptyControls()

  constructor(c: ModeCtx) {
    this.c = c
    const { R, content, ports } = c.loaded
    // Touch holds seat 0 and leaves no room to join, so the layout stays at one seat.
    this.seats = new SeatTable(c.touch ? 1 : MAX_LOCAL_SEATS)
    // Touch is the only device on a touch screen. Elsewhere nothing is seated: the first device pressed or used is P1.
    if (c.touch) this.seats.join('touch')
    this.names = playerNames(0, c.q.name)
    this.hub = new HubWorld(R, content.hub(), 0)
    this.hubLayer = new SceneLayer(ports[0])
    this.matchLayer = new SceneLayer(ports[0])
    this.hubView = new HubView(this.hubLayer.port, 0, name => content.assets(name), content.character(), content.hub(), {
      orbit: c.orbit, character: content.character(), dressing: content.dressing(),
    })
    this.presenter = new LocalPresenter({ ...c, prepared: true, loaded: { ...c.loaded, ports: [this.matchLayer.port] } })
    this.prepareMatch()
    // ?course= goes straight into its round.
    if (c.loaded.course !== null) this.enqueue()
  }

  get finished(): boolean {
    const m = this.match
    if (m === null) return false
    if (this.presenter.onPodium) return this.presenter.podiumS >= PODIUM_HOLD_S
    return m.match.done || (this.over(m) && m.order.length === 0)
  }

  sim(): MatchSim | null {
    return this.match?.match.sim ?? null
  }

  seated(device: DeviceId): boolean {
    return this.seats.seatOf(device) !== -1
  }

  listener(): ListenerPose | null {
    return this.presenter.listener()
  }

  enqueue(): void {
    if (this.match !== null) return
    // ?course= starts a round before any device was used: the keyboard takes P1 then.
    if (this.seats.seats.length === 0) this.seats.join('keyboard')
    const count = this.seats.seats.length
    if (count === 1 && this.prepared !== null) {
      // The prepared 1-seat match is already stepped past its intro and warmed.
      this.match = this.prepared
      this.prepared = null
      this.c.setLayout(1)
    } else {
      this.prepared?.match.dispose()
      this.prepared = null
      const run = this.buildMatch(count)
      this.match = run
      this.c.setLayout(count)
      this.presenter.begin(run.match, count)
    }
    this.hubLayer.setVisible(false)
    this.matchLayer.setVisible(true)
    this.c.orbit.reset(0)
  }

  dequeue(): void {}

  // A fresh local match: seats humans, fixed profile, the playlist's courses (or ?course='s course list).
  private buildMatch(seats: number): LocalRun {
    const { R, content, course } = this.c.loaded
    const seed = Date.now() >>> 0
    const courses = course !== null
      ? courseSetup(seed, course, content.playlist()).courses
      : netSetup(seed, seats, 'sprint', content.playlist()).courses
    const match = startup('Local round', () => new LocalMatch({ R, seats, seed, profile: 'sprint', courses }))
    return { match, singleRace: course !== null && course.kind === 'race', order: [] }
  }

  // Warms the menu behind a 1-seat match; enqueue reuses it only while the table still holds one seat.
  private prepareMatch(): void {
    const { ports } = this.c.loaded
    const run = this.buildMatch(1)
    // Enter round zero and finish its intro before handing control to the local player.
    simStep(run.match, 'Round physics / bots / intro', () => {
      do { run.match.frame(STEP_S, () => {}) } while (run.match.sim.phase(this.presenter.view).phase === Phase.intro)
    })
    this.prepared = run
    this.hubLayer.setVisible(false)
    this.matchLayer.setVisible(true)
    this.presenter.begin(run.match, 1)
    this.presenter.draw(run.match, 1, 0, null)
    renderFrame(this.matchLayer.port, () => ports[0].render())
    this.matchLayer.setVisible(false)
    this.hubLayer.setVisible(true)
    this.hubView.update(this.hub.state(this.local), this.c.q.colour, [], this.hub.tick, 0, this.hub.emote(performance.now()))
    ports[0].render()
  }

  // Async compilation can omit lit draws on the first render. Submit the complete
  // course once those pipelines exist, and read it back to finish GPU work before Play.
  async ready(): Promise<void> {
    const { ports } = this.c.loaded
    // Compilation completes independently of presentation. In the GPU host rAF may never fire;
    // uiTour steps the App itself, so waiting for an animation callback would strand it on loading.
    while (pendingPipelines() > 0) await new Promise<void>(resolve => setTimeout(resolve, 10))
    this.hubLayer.setVisible(false)
    this.matchLayer.setVisible(true)
    const run = this.prepared ?? this.match
    if (run !== null) this.presenter.draw(run.match, 1, 0, null)
    ports[0].render()
    await ports[0].capture()
    if (this.match === null) {
      this.matchLayer.setVisible(false)
      this.hubLayer.setVisible(true)
      this.hubView.update(this.hub.state(this.local), this.c.q.colour, [], this.hub.tick, 0, this.hub.emote(performance.now()))
      ports[0].render()
      await ports[0].capture()
    }
  }

  leaveMatch(): void {
    const run = this.match
    if (run === null) return
    this.presenter.end()
    this.c.setLayout(1)
    run.match.dispose()
    this.match = null
    // Back at the spawn, off the queue pad, as PlayFlow does after a match.
    this.hub.free()
    this.hub = new HubWorld(this.c.loaded.R, this.c.loaded.content.hub(), 0)
    this.pad = new QueuePad(1)
    this.hubAcc = 0
    this.c.orbit.reset(0)
    this.prepareMatch()
  }

  frame(f: FrameIn): GameScreen {
    const screen = this.match === null ? this.frameHub(f) : this.frameMatch(this.match, f)
    renderFrame(this.match === null ? this.c.loaded.ports[0] : this.matchLayer.port, () => this.c.loaded.ports[0].render())
    return screen
  }

  hud(): HudState | null {
    return this.match === null ? null : { view: this.presenter.view, names: this.names, seat: 0 }
  }

  lines(): string[] {
    const m = this.match
    if (m === null) {
      return [
        this.seats.seats.length === 0 ? 'Press any button to take P1' : seatLine(this.seats.seats),
        'Press Start/Enter on another controller to join - walk onto the green pad or press Enter to play',
      ]
    }
    if (this.presenter.places !== null) return podiumLines(this.presenter.places, this.names)
    const v = this.presenter.view
    if (m.singleRace && v.phase >= Phase.roundEnd && m.order.length === 0) return ['Nobody qualified']
    return [`Round ${v.roundIndex + 1}: ${v.qualifiedCount} qualified, ${v.alive} still running`]
  }

  dispose(): void {
    this.presenter.dispose()
    this.match?.match.dispose()
    this.match = null
    this.prepared?.match.dispose()
    this.prepared = null
    this.hubView.dispose()
    this.hub.free()
  }

  private frameHub(f: FrameIn): GameScreen {
    const now = performance.now()
    // A device's join button takes the next free seat while the hub is live; a match freezes the seats.
    claimSeats(this.seats, f.devices, f.deviceCount, !f.paused)
    if (f.emote !== 0) this.hub.setEmote(f.emote, now)
    if (!f.paused) {
      this.hubAcc = Math.min(this.hubAcc + f.dt, 8 * STEP_S)
      while (this.hubAcc >= STEP_S) {
        this.hubAcc -= STEP_S
        this.hub.step(f.world)
        const pad = this.pad.update(this.hub.onQueuePad())
        if (pad === 'armed') {
          this.enqueue()
          if (this.match !== null) return this.frameMatch(this.match, f)
        }
      }
    }
    this.hubView.update(this.hub.state(this.local), this.c.q.colour, [], this.hub.tick, f.dt, this.hub.emote(now))
    return 'hub'
  }

  // A single ?course= race ends with its round; every other match runs to its own podium.
  private over(run: LocalRun): boolean {
    return run.match.done || (run.singleRace && this.presenter.view.phase >= Phase.roundEnd)
  }

  private frameMatch(run: LocalRun, f: FrameIn): GameScreen {
    const sim = run.match.sim
    let alpha = 1
    if (!f.paused && !this.over(run)) {
      alpha = run.match.frame(f.dt, (seat, out) => this.sample(seat, f, out))
      if (run.singleRace) this.noteQualified(run)
    }
    const view = sim.phase(this.presenter.view)
    let podium: readonly number[] | null = null
    if (run.singleRace) podium = this.over(run) ? run.order : null
    else if (view.phase >= Phase.podium) podium = view.podium
    if (this.presenter.draw(run.match, this.over(run) ? 1 : alpha, f.dt, podium)) this.c.setLayout(1)
    return matchScreen(view, sim.character(0, this.cv).status, this.presenter.onPodium)
  }

  // One seat's input: its device's controls turned by seat 0's orbit or the seat's own camera facing.
  private sample(seat: number, f: FrameIn, out: PlayerInput): void {
    const row = this.seats.seats[seat]
    const controls = row === undefined ? this.still : this.deviceControls(row.device, f)
    const facing = seat === 0 ? this.c.orbit.ground() : this.presenter.facing(seat)
    controlsToInput(controls, facing, out)
  }

  private deviceControls(device: DeviceId, f: FrameIn): RawControls {
    for (let i = 0; i < f.deviceCount; i++) {
      const poll = f.devices[i]
      if (poll.device === device) return poll.controls
    }
    return this.still
  }

  // The single race's podium is its qualification order.
  private noteQualified(run: LocalRun): void {
    for (let p = 0; p < PLAYERS; p++) {
      if (!run.order.includes(p) && run.match.sim.character(p, this.cv).status === PlayerStatus.qualified) run.order.push(p)
    }
  }
}

// One relay client (?server=): this page's bean in the online hub (PlayFlow), its matches and podiums.
// PlayFlow queues from the green pad and returns to the hub by itself, so the queue and leave commands
// only explain that; a paused page sends no move (the match cannot pause for the others).
class OnlineMode implements Mode {
  failure: string | null = null
  readonly finished = false
  private readonly c: ModeCtx
  private readonly flow: PlayFlow
  private readonly presenter: MatchPresenter
  private readonly hubView: HubView
  private seat = 0
  private names: string[]
  private viewed: MatchSim | null = null
  private note = ''
  private readonly local = emptyChar()
  private readonly cv = emptyCharView()
  private readonly moved = emptyControls()

  constructor(c: ModeCtx, server: string) {
    this.c = c
    const { R, content, ports } = c.loaded
    const q = c.q
    this.names = playerNames(0, q.name)
    this.flow = new PlayFlow({
      R, relayUrl: server, ws: globalWsFactory(), hubCode: q.hub, name: q.name, colour: q.colour,
      courses: content.playlist(), plaza: content.hub(), partySize: q.party, now: () => performance.now(), pilot: false,
      log: ev => {
        if (ev.state === 'match' && typeof ev.detail.seat === 'number') this.seat = ev.detail.seat
        if (ev.state === 'failed') this.failure = String(ev.detail.message ?? 'the relay connection failed')
        console.info('[game]', ev.state, ev.detail)
      },
    })
    this.hubView = new HubView(ports[0], 0, name => content.assets(name), content.character(), content.hub(), {
      orbit: c.orbit, character: content.character(), dressing: content.dressing(),
    })
    this.presenter = new MatchPresenter(c)
    void this.flow.start()
  }

  sim(): MatchSim | null {
    return this.flow.match?.sim ?? null
  }

  hud(): HudState | null {
    return this.flow.match === null ? null : { view: this.presenter.view, names: this.names, seat: this.seat }
  }

  enqueue(): void {
    this.note = 'Walk onto the green pad to queue'
  }

  dequeue(): void {
    this.note = 'Step off the green pad to leave the queue'
  }

  leaveMatch(): void {
    if (this.flow.match !== null) this.note = 'An online match cannot be left; it returns to the hub when it ends'
  }

  frame(f: FrameIn): GameScreen {
    const flow = this.flow
    const now = performance.now()
    const before = flow.state
    let facing: Planar = { x: 0, z: 1 }
    if (flow.match !== null) facing = flow.match.sim.character(this.seat, this.cv).facing
    else if (before === 'hub' || before === 'queued') facing = flow.hub.state(this.local).facing
    flow.frame(f.dt, f.paused ? null : inCharacterFrame(f.world, facing, this.moved), f.paused ? 0 : f.emote)
    const match = flow.match
    const sim = match?.sim ?? null
    if (sim !== this.viewed) {
      this.viewed = sim
      this.note = ''
      if (sim === null) {
        this.presenter.end()
        this.c.orbit.reset(0)
        this.hubView.setVisible(true)
      } else {
        this.hubView.setVisible(false)
        this.presenter.begin(this.seat)
        this.names = playerNames(this.seat, this.c.q.name)
      }
    }
    let screen: GameScreen = flow.state === 'queued' ? 'queue' : 'hub'
    if (match !== null) {
      const v = match.sim.phase(this.presenter.view)
      this.presenter.draw(match.sim, match.session.smoother, 1, f.dt, v.phase >= Phase.podium ? v.podium : null)
      screen = matchScreen(v, match.sim.character(this.seat, this.cv).status, this.presenter.onPodium)
    } else if (flow.state === 'hub' || flow.state === 'queued') {
      this.hubView.update(flow.hub.state(this.local), this.c.q.colour, flow.remotes(now), flow.hub.tick, f.dt, flow.hub.emote(now))
    }
    renderFrame(this.c.loaded.ports[0], () => this.c.loaded.ports[0].render())
    return screen
  }

  lines(): string[] {
    const flow = this.flow
    const state = flow.state
    if (this.presenter.places !== null) return [...podiumLines(this.presenter.places, this.names), this.note]
    const lines: string[] = []
    if (flow.hubCode !== null) lines.push(`Hub ${flow.hubCode} - ${this.c.q.name}`)
    if (state === 'connecting') lines.push('Connecting...')
    else if (state === 'hub') lines.push('Walk onto the green pad to queue')
    else if (state === 'queued') lines.push(`Queued for ${this.c.q.party} players...`)
    else if (state === 'returning') lines.push('Back to the hub...')
    else if (flow.match !== null) lines.push(`Round ${this.presenter.view.roundIndex + 1}: ${this.presenter.view.qualifiedCount} qualified`)
    if (this.note.length > 0) lines.push(this.note)
    return lines
  }

  dispose(): void {
    this.flow.close()
    this.presenter.dispose()
    this.hubView.dispose()
  }
}

// ?clients=2..4: that many piloted clients over a LoopbackRelay, one canvas and port each; InPageHubLoop
// steps, draws and renders them. Client 0's state picks the screen, and nothing reads player input.
class InPageMode implements Mode {
  failure: string | null = null
  readonly finished = false
  private readonly c: ModeCtx
  private readonly hub: InPageHubLoop
  private readonly view = emptyViewState()
  private readonly names = playerNames(-1, '')

  constructor(c: ModeCtx) {
    this.c = c
    const { R, content, ports } = c.loaded
    this.hub = new InPageHubLoop(R, c.q.clients, new LoopbackRelay(), {
      R, courses: content.playlist(), plaza: content.hub(), partySize: c.q.clients as 2 | 3 | 4, now: () => performance.now(), pilot: true,
    }, ports, { assets: name => content.assets(name), bean: content.character(), character: content.character(), dressing: content.dressing(), skinned: skinnedCharacterOf(content) })
  }

  sim(): MatchSim | null {
    return this.hub.flows[0]?.match?.sim ?? null
  }

  hud(): HudState | null {
    const sim = this.sim()
    return sim === null ? null : { view: sim.phase(this.view), names: this.names, seat: 0 }
  }

  enqueue(): void {}
  dequeue(): void {}
  leaveMatch(): void {}

  // Real-time dt even while paused: the relay's rate limits run on the same clock.
  frame(f: FrameIn): GameScreen {
    this.hub.frame(f.dt)
    const failed = this.hub.events.find(e => e.state === 'failed')
    if (failed !== undefined) this.failure = String(failed.detail.message ?? `${failed.client} failed`)
    const flow = this.hub.flows[0]
    if (flow === undefined) return 'hub'
    const sim = flow.match?.sim ?? null
    if (sim !== null) return matchScreen(sim.phase(this.view), PlayerStatus.alive, false)
    return flow.state === 'queued' ? 'queue' : 'hub'
  }

  lines(): string[] {
    const flows = this.hub.flows
    const lines = [`Hub ${flows[0]?.hubCode ?? '....'} - ${flows.length}/${this.c.q.clients} piloted clients`]
    lines.push(flows.map((f, k) => `Bean ${k + 1} ${f.state}`).join(', '))
    if (this.view.phase >= Phase.podium) lines.push(...podiumLines(this.view.podium, this.names))
    return lines
  }

  dispose(): void {
    this.hub.dispose()
  }
}

// Screens where the game has the controls and the mouse looks; the rest are menus over it.
const PLAYING: readonly Screen[] = ['hub', 'countdown', 'round', 'spectate']
const HUD_SCREENS: readonly Screen[] = ['countdown', 'round', 'spectate']

// The uaa document (uaaHost loads the same file): each screen has a fixed number of line-<i> slots.
const UI_DOC = JSON.parse(uiDocText) as ScreensDoc
const LINE_SLOT = /^line-\d+$/

function lineSlots(screen: Screen): number {
  return widgetsOf(UI_DOC, screen).filter(w => LINE_SLOT.test(w.id)).length
}

// Empty lines are dropped; lines past the last slot join it (a screen without slots shows none).
function fitLines(lines: readonly string[], slots: number): string[] {
  const shown = lines.filter(line => line.length > 0)
  if (shown.length <= slots || slots === 0) return shown.slice(0, slots)
  return [...shown.slice(0, slots - 1), shown.slice(slots - 1).join(' - ')]
}

// The numbers of a HUD value ('Qualified 1 / 3' -> '1/3', 'Alive 5' -> '5').
function counts(text: string): string {
  return (text.match(/\d+/g) ?? []).join('/')
}

// hud.ts values -> the 'round' screen's hud-* widgets and the countdown badge.
function hudWidgets(h: HudValues, v: MatchViewState): Record<string, WidgetProps> {
  return {
    'hud-kind': { text: h.kind },
    'hud-timer': { visible: h.timeLeft !== null },
    'hud-timer-label': { text: (h.timeLeft ?? '').replace(/^\D+/, '') },
    'hud-time-bar': { value: h.timeFraction ?? 0 },
    'hud-qualified': { visible: h.qualified !== null },
    'hud-qualified-count': { text: { count: counts(h.qualified ?? '') } },
    'hud-alive': { visible: h.alive !== null },
    'hud-alive-count': { text: { count: counts(h.alive ?? '') } },
    'countdown-number': { text: { count: String(Math.max(1, Math.ceil(v.phaseTicksLeft / 60))) } },
  }
}

// A refusal string for a check the page makes itself (refuse throws, so catch its message).
function refusal(area: string, where: string, what: string): string {
  try {
    return refuse(area, where, what)
  } catch (e) {
    return messageOf(e)
  }
}

// The page: Nav drives every screen; its effects start and stop modes and the load. The uaa host draws
// the screen nav is on and reports its button presses back as menu commands.
class App {
  readonly nav = new Nav()
  private settings: Settings
  private settingsError: string | null
  private rebinding: KeyAction | null = null
  private pendingRebind: KeyAction | null = null
  private mode: Mode | null = null
  private preparedLocal: LocalMode | null = null
  private readonly loadingOverlay = roundOverlay()
  private roundLoading: string | null = null
  private stopRoundLoad: (() => void) | null = null
  private loaded: Loaded | null = null
  private query: Query | null = null
  private emote = 0
  private stopLoop: (() => void) | null = null
  private disposed = false
  // The HUD time bar's full length: the most round ticks left seen in the current round.
  private hudRound = -2
  private hudRoundTicks = 0
  private size = ''
  // The local path's S26 split cells and the #views size they were last resized for.
  private cells: SplitCell[] = []
  private viewsSizeKey = ''
  private readonly viewsObserver: ResizeObserver
  private pointer: { x: number; y: number } | null = null
  private readonly views: HTMLElement
  private readonly screens: HTMLElement
  private readonly search: string
  private readonly host: UaaHost
  private readonly env: AppEnv
  private readonly input: GameInput
  private readonly padStore: PadMapStore
  private readonly devices: InputDevices
  private readonly devicePolls: DevicePoll[] = []
  private readonly sound = new SoundDriver()
  private readonly orbit = new OrbitCamera()
  private readonly world = neutralInput()
  private readonly touchScratch = emptyControls()
  // Mobile touch controls and the settings screen's controller remap (both draw on their own canvas).
  private readonly touchRoot: HTMLElement
  private readonly touchOn: boolean
  private readonly touch: ReturnType<typeof mountTouchControls> | null
  private readonly remapRoot: HTMLElement
  private readonly remapButton: HTMLButtonElement
  private remap: { close(): void } | null = null
  private remapHeld = false
  private readonly onOpenRemap = (): void => this.openRemap()
  private readonly onRemapClose = (): void => this.remapClosed()

  constructor(views: HTMLElement, screens: HTMLElement, host: UaaHost, search: string, env: AppEnv) {
    this.views = views
    this.screens = screens
    this.host = host
    this.search = search
    this.env = env
    const saved = loadSettings(env.store)
    this.settings = saved.settings
    this.settingsError = saved.error
    // A coarse pointer or ?touch=1 mounts the virtual joystick and buttons over #views; seat 0 is touch.
    this.touchRoot = requiredElement<HTMLElement>('#touch')
    this.touchOn = touchWanted(search)
    this.touch = this.touchOn ? mountTouchControls(this.touchRoot) : null
    this.touchRoot.hidden = true
    this.remapRoot = requiredElement<HTMLElement>('#remap')
    this.remapButton = requiredElement<HTMLButtonElement>('#open-remap')
    this.remapButton.hidden = true
    this.remapButton.addEventListener('click', this.onOpenRemap)
    this.remapRoot.addEventListener('rf-remap-close', this.onRemapClose)
    // Clicking the (single) game canvas locks the pointer for the mouse look.
    this.input = new GameInput(window, screens, () => (this.loaded?.canvases.length === 1 ? this.loaded.canvases[0] : null))
    // Every device is polled once per frame; key events bubble from the focused element to the body.
    this.padStore = localPadMapStore(env.padStorage)
    this.devices = new InputDevices(document.body, () => navigator.getGamepads?.() ?? [], this.padStore, this.touch)
    // The local canvas follows #views when it is resized (S26): the CSS size and DPR reach port.resize.
    this.viewsObserver = new ResizeObserver(() => this.resizeViews())
    this.viewsObserver.observe(this.views)
  }

  // ?course= skips the title: the load lands in the hub, which starts the round.
  start(): void {
    let next: 'title' | 'hub' = 'title'
    try {
      if (parseQuery(this.search).course !== null) next = 'hub'
    } catch {
      // The load parses again and shows the refusal.
    }
    this.run(this.nav.dispatch({ kind: 'load', next }))
    this.stopLoop = this.env.loop(dt => {
      try {
        this.frame(dt)
      } catch (e) {
        console.error(e)
        this.fail(messageOf(e))
      }
    })
  }

  fail(message: string): void {
    this.roundLoading = null
    this.loadingOverlay.hide()
    this.run(this.nav.dispatch({ kind: 'error', message }))
  }

  // A uaa button or back press. One that comes from a screen nav has already left (two inputs in one
  // batch) is dropped, as is any while a key is being rebound.
  command(c: UaaCommand): void {
    if (this.disposed || this.rebinding !== null || c.screen !== this.nav.screen) return
    if (c.cmd.k === 'back') this.run(this.nav.dispatch({ kind: 'back' }))
    else this.activate(c.cmd)
  }

  // The settings screen's 'Controller...' button opens the canvas remap over #screens; its close event
  // comes back through the #remap root. The key that opened it must not reach the uaa menu.
  private openRemap(): void {
    if (this.disposed || this.remap !== null || this.nav.screen !== 'settings') return
    this.rebinding = null
    this.pendingRebind = null
    this.input.takeEvents()
    this.remap = mountPadRemap(this.remapRoot, this.padStore, () => navigator.getGamepads?.() ?? [])
  }

  private remapClosed(): void {
    this.remap = null
    this.input.takeEvents()
  }

  private closeRemap(): void {
    const remap = this.remap
    if (remap === null) return
    this.remap = null
    remap.close()
  }

  // Pad button 3 pressed on a device that holds a local seat, as an edge (one true per press).
  private padRemapPressed(mode: Mode | null): boolean {
    let held = false
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (pad === null || pad.connected === false) continue
      if (mode?.seated?.(`pad:${pad.index}`) !== true) continue
      if (pad.buttons[3]?.pressed === true) {
        held = true
        break
      }
    }
    const pressed = held && !this.remapHeld
    this.remapHeld = held
    return pressed
  }

  // Before an op builds its own views: frame loop, mode, RAA ports, uaa host, input and sound released, page emptied.
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loadingOverlay.hide(true)
    this.stopRoundLoad?.()
    this.stopRoundLoad = null
    this.stopLoop?.()
    this.stopLoop = null
    this.stopMode()
    this.preparedLocal?.dispose()
    this.preparedLocal = null
    this.viewsObserver.disconnect()
    this.cells = []
    this.closeRemap()
    this.remapButton.removeEventListener('click', this.onOpenRemap)
    this.remapRoot.removeEventListener('rf-remap-close', this.onRemapClose)
    this.remapButton.hidden = true
    this.touch?.dispose()
    this.devices.dispose()
    this.input.dispose()
    void this.sound.close()
    for (const port of this.loaded?.ports ?? []) port.dispose()
    this.loaded = null
    this.host.destroy()
    this.views.replaceChildren()
    this.screens.replaceChildren()
  }

  private run(effects: readonly Effect[]): void {
    if (this.disposed) return
    for (const fx of effects) {
      if (fx === Effect.load) void this.load()
      else if (fx === Effect.startHub) this.startMode()
      else if (fx === Effect.startOnline) this.startOnline()
      else if (fx === Effect.enqueue) this.mode?.enqueue()
      else if (fx === Effect.dequeue) this.mode?.dequeue()
      else if (fx === Effect.leaveMatch) this.mode?.leaveMatch()
      else if (fx === Effect.leaveGame) this.stopMode()
      // pause and resume: frame() reads the paused state from nav.screen.
    }
  }

  private async load(): Promise<void> {
    // The 'loading' screen's bar and label; a refusal goes to the error screen.
    const loading = mountLoading(null, { progress: (fraction, label) => this.host.setLoading(fraction, label) })
    this.host.setLoading(0, 'Starting...')
    try {
      await this.env.beforeLoad?.()
      const q = parseQuery(this.search)
      this.query = q
      const content = pickContent(new URLSearchParams(this.search))
      const R = await initRapier()
      await content.load('sprint', progress => {
        this.loadingOverlay.show(progress.label, progress.done, progress.total)
        loading.update(progress)
        this.run(this.nav.dispatch({ kind: 'progress', progress }))
      })
      // ?course=<hub> opens the hub itself: the hub is the lobby, not a round (courseSetup refuses hubs).
      const picked = q.course === null ? null : content.course(q.course)
      const course = picked !== null && picked.kind === 'hub' ? null : picked
      this.loadingOverlay.show('Creating renderer')
      const { ports, canvases } = await this.mountPorts(content, q)
      if (this.disposed) {
        // An op took the page during the load: its ports are not ours to keep.
        for (const port of ports) port.dispose()
        this.views.replaceChildren()
        return
      }
      this.stopRoundLoad?.()
      this.stopRoundLoad = observeRoundLoad(label => {
        this.roundLoading = label
        if (label !== null) {
          this.loadingOverlay.show(label)
          this.host.setLoading(0, label)
        } else this.loadingOverlay.hide()
      }, content.report())
      this.loaded = { R, content, ports, canvases, course }
      this.resizeViews()
      if (q.server === null && q.clients === 1) {
        this.preparedLocal = new LocalMode({ loaded: this.loaded, q, orbit: this.orbit, touch: this.touchOn, setLayout: seats => this.setLayout(seats) })
        await this.preparedLocal.ready()
      }
      this.run(this.nav.dispatch({ kind: 'loaded' }))
      if (this.roundLoading === null) this.loadingOverlay.hide()
    } catch (e) {
      console.error(e)
      this.fail(messageOf(e))
    }
  }

  // One canvas and port per client; content.createPort already inits the port on its canvas. Local play
  // (no relay, one client) instead mounts one canvas split into seats by S26's splitLayout.
  private async mountPorts(content: GameContent, q: Query): Promise<{ ports: RenderPort[]; canvases: HTMLCanvasElement[] }> {
    this.views.replaceChildren()
    if (q.server === null && q.clients === 1) return this.mountLocalPort(content)
    this.cells = []
    const plan = planCanvases(Math.max(1, Math.floor(window.innerWidth)), Math.max(1, Math.floor(window.innerHeight)), q.clients)
    this.views.style.gridTemplateColumns = `repeat(${plan.cols}, 1fr)`
    this.views.style.gridTemplateRows = `repeat(${plan.rows}, 1fr)`
    const ports: RenderPort[] = []
    const canvases: HTMLCanvasElement[] = []
    try {
      for (const cell of plan.cells) {
        const canvas = mountCanvas(this.views, cell)
        canvases.push(canvas)
        ports.push(await content.createPort({ canvas, width: cell.canvasWidth, height: cell.canvasHeight, viewports: [cell.viewport] }))
      }
    } catch (e) {
      for (const port of ports) port.dispose()
      this.views.replaceChildren()
      throw e
    }
    return { ports, canvases }
  }

  // Local play's one canvas in a 1x1 #views grid. Its render target is splitLayout(1, false) through
  // pixelViewports, so the backing size is round(css x min(dpr, DPR_CAP)); setLayout grows the seats later.
  private async mountLocalPort(content: GameContent): Promise<{ ports: RenderPort[]; canvases: HTMLCanvasElement[] }> {
    this.cells = splitLayout(1, false)
    this.views.style.gridTemplateColumns = '1fr'
    this.views.style.gridTemplateRows = '1fr'
    const size = this.viewsSize()
    const viewports = pixelViewports(this.cells, size.cssW, size.cssH, size.dpr)
    const backing = backingSize(viewports)
    const canvas = document.createElement('canvas')
    canvas.width = backing.width
    canvas.height = backing.height
    canvas.dataset.client = '0'
    this.views.appendChild(canvas)
    this.viewsSizeKey = size.key
    try {
      const port = await content.createPort({ canvas, width: backing.width, height: backing.height, viewports })
      return { ports: [port], canvases: [canvas] }
    } catch (e) {
      this.views.replaceChildren()
      throw e
    }
  }

  // #views in CSS pixels and the device pixel ratio; key changes drive one resize.
  private viewsSize(): { cssW: number; cssH: number; dpr: number; key: string } {
    const cssW = Math.max(1, this.views.clientWidth)
    const cssH = Math.max(1, this.views.clientHeight)
    const dpr = window.devicePixelRatio || 1
    return { cssW, cssH, dpr, key: `${cssW}x${cssH}@${dpr}` }
  }

  // S26: the local canvas's split cells for a seat count (3 seats add the overview cell, seat -1).
  // The next step drives this for 2..4 seats; local play starts with one.
  private setLayout(seats: number): void {
    this.cells = splitLayout(seats, seats === 3)
    this.viewsSizeKey = ''
    this.resizeViews()
  }

  // A #views size change (ResizeObserver, or setLayout) resizes the local canvas through the sdf port's
  // resize, in backing pixels. A port without resize (non-sdf content) keeps its initial size.
  private resizeViews(): void {
    const loaded = this.loaded
    if (loaded === null || loaded.canvases.length !== 1 || this.cells.length === 0) return
    const size = this.viewsSize()
    if (size.key === this.viewsSizeKey) return
    this.viewsSizeKey = size.key
    const viewports = pixelViewports(this.cells, size.cssW, size.cssH, size.dpr)
    const backing = backingSize(viewports)
    const port = loaded.ports[0] as { resize?: (cssW: number, cssH: number, dpr: number, viewports: Viewport[]) => void }
    if (typeof port.resize !== 'function') return
    port.resize(backing.width, backing.height, 1, viewports)
  }

  private startMode(): void {
    const loaded = this.loaded
    const q = this.query
    if (loaded === null || q === null) return this.fail(refusal('game', 'start', 'the content is not loaded; retry the load'))
    this.stopMode()
    const c: ModeCtx = { loaded, q, orbit: this.orbit, touch: this.touchOn, setLayout: seats => this.setLayout(seats) }
    try {
      if (q.server !== null) this.mode = new OnlineMode(c, q.server)
      else if (q.clients > 1) this.mode = new InPageMode(c)
      else {
        this.mode = this.preparedLocal ?? new LocalMode(c)
        this.preparedLocal = null
      }
    } catch (e) {
      console.error(e)
      this.fail(messageOf(e))
    }
  }

  // Play goes online by itself when ?server= is given; without it, Play online has nowhere to go.
  private startOnline(): void {
    if ((this.query?.server ?? null) === null) {
      return this.fail(refusal('query', 'server', 'Play online needs a relay; pass ?server=wss://host/... or choose Play to play with bots'))
    }
    this.run(this.nav.dispatch({ kind: 'action', action: 'play' }))
  }

  private stopMode(): void {
    this.roundLoading = null
    this.loadingOverlay.hide()
    if (this.mode instanceof LocalMode && !this.disposed && this.nav.screen === 'title') {
      this.preparedLocal?.dispose()
      this.preparedLocal = this.mode
    } else this.mode?.dispose()
    this.mode = null
    this.orbit.reset(0)
    this.input.look.release()
  }

  private frame(dt: number): void {
    const nav = this.nav
    const events = this.input.takeEvents()
    // The remap screen reads the keys itself: they must not also move the uaa settings menu.
    if (this.remap === null) {
      // Local seats own pads: a pad's Start-as-back would pause the hub when a pad joins (seated pads pause
      // below), and a pad's B (cancel) must not pause a match or the hub. Both still go back in every menu.
      const seatedMode = this.mode?.seated !== undefined
      const inGame = PLAYING.includes(nav.screen) || nav.screen === 'result'
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev.k !== 'back') continue
        if ((ev.pad === 'start' && seatedMode) || (ev.pad === 'b' && inGame)) events.splice(i, 1)
      }
      for (const ev of events) this.onEvent(ev)
    }
    this.hover()
    if (this.pendingRebind !== null) {
      // Armed after the batch, so the Enter that chose the row is not taken as the new key.
      this.rebinding = this.pendingRebind
      this.pendingRebind = null
      this.settingsError = null
    }
    if (nav.screen !== 'settings') this.rebinding = null
    // One poll per device: keyboard, every connected pad, then touch.
    this.devices.bindings = this.settings
    const deviceCount = this.devices.poll(this.devicePolls)
    // Pads drive the remap while it is open; their join edges must not reach the local seat table.
    if (this.remap !== null) for (let i = 0; i < deviceCount; i++) this.devicePolls[i].joinPressed = false
    const mode = this.mode
    // Pad button 3 (Y) on a seated pad opens the remap from the settings screen, like #open-remap.
    if (this.padRemapPressed(mode) && nav.screen === 'settings' && this.remap === null) this.openRemap()
    // A seated pad's pause/start button is the same back as Escape (the keyboard's Escape is GameInput's).
    if (mode !== null && nav.live && mode.seated !== undefined) {
      for (let i = 0; i < deviceCount; i++) {
        const poll = this.devicePolls[i]
        // In the pause and settings menus any pad's Start resumes/goes back, seated or not (menus come before seats).
        const menuScreen = nav.screen === 'pause' || nav.screen === 'settings'
        if (poll.device !== 'keyboard' && poll.pausePressed && (menuScreen || mode.seated(poll.device))) {
          this.run(nav.dispatch({ kind: 'back' }))
          break
        }
      }
    }
    const playing = nav.live && PLAYING.includes(nav.screen)
    const s = this.settings
    const look = this.input.takeLook()
    this.input.look.enabled = playing
    if (playing) {
      this.orbit.mouse(look.dx, look.dy, s.mouseSensitivity, s.invertY)
      this.orbit.stick(look.rx, look.ry, dt, s.stickSensitivity, s.invertY)
    } else if (this.input.look.locked) this.input.look.release()
    // Menus read the same keys, so the bean only moves while the game has the controls.
    const controls = this.input.controls(s, !playing)
    // The hub walks on this move: the virtual stick and buttons count like the keys and the first pad.
    if (playing && this.touch !== null && this.touch.active) {
      this.touch.read(this.touchScratch)
      mergeControls(controls, this.touchScratch)
    }
    if (playing) controlsToInput(controls, this.orbit.ground(), this.world)
    else Object.assign(this.world, neutralInput())
    if (mode !== null && nav.live) {
      const paused = nav.screen === 'pause' || nav.screen === 'settings'
      const screen = mode.frame({
        dt, paused, world: this.world, emote: playing ? this.emote : 0, devices: this.devicePolls, deviceCount,
      })
      if (mode.failure !== null) return this.fail(mode.failure)
      this.run(nav.dispatch({ kind: 'game', screen }))
      if (mode.finished) {
        // A podium-less single race passes through the podium screen too, to reach toHub.
        this.run(nav.dispatch({ kind: 'game', screen: 'podium' }))
        if (nav.screen === 'podium') this.run(nav.dispatch({ kind: 'action', action: 'toHub' }))
      }
    }
    this.emote = 0
    this.sound.frame(this.mode?.sim() ?? null, this.mode?.listener?.() ?? undefined)
    this.draw()
  }

  // Presents nav's screen through the uaa host, with the round HUD on the HUD screens, then renders it.
  private draw(): void {
    const nav = this.nav
    // The remap belongs to the settings screen; #touch takes the pointer only where the game does.
    if (this.remap !== null && nav.screen !== 'settings') this.closeRemap()
    this.touchRoot.hidden = this.touch === null || !(nav.live && PLAYING.includes(nav.screen))
    this.remapButton.hidden = !(nav.screen === 'settings' && this.remap === null)
    const mode = this.mode
    const hud = mode === null || !HUD_SCREENS.includes(nav.screen) ? null : mode.hud()
    const values = hud === null ? null : hudValues(hud.view, hud.names, hud.seat, this.roundTicks(hud.view))
    if (hud === null) this.hudRound = -2
    let info = mode !== null && (nav.screen === 'hub' || !PLAYING.includes(nav.screen)) ? mode.lines() : []
    // The spectate banner has no HUD pills: its lines carry the round and the qualified count.
    if (nav.screen === 'spectate' && values !== null) info = [values.kind, values.qualified ?? '']
    const error = nav.screen === 'settings' ? this.settingsError : nav.error
    const model = menuModel(this.roundLoading === null ? nav.screen : 'loading', this.roundLoading === null ? nav.actions() : [], { settings: this.settings, rebinding: this.rebinding, error, info })
    // Overlays leave the pointer to the views (pointer lock on the game canvas); menus take clicks.
    this.screens.style.pointerEvents = model.overlay ? 'none' : 'auto'
    this.resize()
    this.host.present({ ...model, lines: fitLines(model.lines, lineSlots(model.screen)) })
    if (hud !== null && values !== null) this.host.setHud(hudWidgets(values, hud.view))
    this.host.frame(performance.now())
  }

  private roundTicks(v: MatchViewState): number {
    if (v.roundIndex !== this.hudRound) {
      this.hudRound = v.roundIndex
      this.hudRoundTicks = 0
    }
    this.hudRoundTicks = Math.max(this.hudRoundTicks, v.roundTicksLeft)
    return this.hudRoundTicks
  }

  // canvas#ui follows #screens (the whole page) and the device pixel ratio.
  private resize(): void {
    const w = Math.max(1, this.screens.clientWidth)
    const h = Math.max(1, this.screens.clientHeight)
    const dpr = window.devicePixelRatio || 1
    const key = `${w}x${h}@${dpr}`
    if (key === this.size) return
    this.size = key
    this.host.resize(w, h, dpr)
  }

  // Keys go to uaa as nav, activate and back, clicks as pointer presses (GameInput's overlay backing px
  // are canvas#ui backing px); uaa answers through command(). A rebind takes the next key itself.
  private onEvent(ev: UiEvent): void {
    if (this.rebinding !== null) {
      // The Esc that cancels arrives as back, then as its key; neither binds.
      if (ev.k === 'back') this.rebinding = null
      else if (ev.k === 'key' && ev.code !== 'Escape') {
        const action = this.rebinding
        this.rebinding = null
        try {
          this.apply(rebind(this.settings, action, ev.code))
        } catch (e) {
          this.settingsError = messageOf(e)
        }
      }
      return
    }
    const host = this.host
    if (ev.k === 'back') host.input({ kind: 'back' })
    else if (ev.k === 'emote') this.emote = ev.id
    else if (ev.k === 'focus') host.input({ kind: 'nav', dir: ev.dir < 0 ? 'up' : 'down' })
    else if (ev.k === 'adjust') host.input({ kind: 'nav', dir: ev.dir < 0 ? 'left' : 'right' })
    else if (ev.k === 'select') {
      // The hub has no buttons: Enter queues, as the hint says.
      if (this.nav.screen === 'hub') this.run(this.nav.dispatch({ kind: 'action', action: 'queue' }))
      else {
        host.input({ kind: 'activate', phase: 'down' })
        host.input({ kind: 'activate', phase: 'up' })
      }
    } else if (ev.k === 'click') {
      host.input({ kind: 'pointer', phase: 'move', x: ev.x, y: ev.y })
      host.input({ kind: 'pointer', phase: 'down', x: ev.x, y: ev.y })
      host.input({ kind: 'pointer', phase: 'up', x: ev.x, y: ev.y })
    }
  }

  // Hover feedback: the pointer moves over the menus (GameInput only tracks it while #screens takes the pointer).
  private hover(): void {
    const p = this.input.pointer
    if (p === null || (this.pointer !== null && p.x === this.pointer.x && p.y === this.pointer.y)) return
    this.pointer = { x: p.x, y: p.y }
    this.host.input({ kind: 'pointer', phase: 'move', x: p.x, y: p.y })
  }

  private activate(cmd: MenuCmd): void {
    if (cmd.k === 'action') this.run(this.nav.dispatch({ kind: 'action', action: cmd.action }))
    else if (cmd.k === 'back') this.run(this.nav.dispatch({ kind: 'back' }))
    else {
      const row = SETTINGS_ROWS[cmd.row]
      if (row.kind === 'key') this.pendingRebind = row.action
      else this.apply(adjust(this.settings, row, 1))
    }
  }

  private apply(next: Settings): void {
    this.settings = next
    this.settingsError = null
    try {
      saveSettings(this.env.store, next)
    } catch (e) {
      this.settingsError = refusal('settings', 'localStorage', `not saved (${messageOf(e)}); allow site storage to keep settings`)
    }
  }
}

// The uaa message names its code (GPU_UNAVAILABLE, FONT_LOAD, ...).
function bootMessage(e: unknown): string {
  return e instanceof UaaError ? `${e.code}: ${e.message}` : messageOf(e)
}

function pageRoots(): { views: HTMLElement; screens: HTMLElement } {
  const views = document.querySelector<HTMLElement>('#views')
  const screens = document.querySelector<HTMLElement>('#screens')
  if (views === null || screens === null) throw new Error('game.html needs main#views and div#screens holding canvas#ui')
  return { views, screens }
}

// Boot waits for the uaa host: there is no DOM menu, so a GPU, asset or font failure fails the boot.
// taken: an op took the page while the host was being created; the App then never starts.
async function start(
  canvas: HTMLCanvasElement, env: AppEnv, taken: () => boolean, onScreen?: (e: UaaScreenChange) => void,
): Promise<{ app: App; host: UaaHost } | null> {
  const { views, screens } = pageRoots()
  let created: App | null = null
  const host = await createUaaHost({
    canvas, width: Math.max(1, screens.clientWidth), height: Math.max(1, screens.clientHeight), dpr: window.devicePixelRatio || 1,
    onCommand: c => created?.command(c), onScreen,
  })
  if (taken()) {
    host.destroy()
    return null
  }
  const booted = new App(views, screens, host, window.location.search, env)
  created = booted
  window.addEventListener('error', e => booted.fail(messageOf(e.error ?? e.message)))
  window.addEventListener('unhandledrejection', e => booted.fail(messageOf(e.reason)))
  booted.start()
  return { app: booted, host }
}

// The uiTour op's App: the page's App on a new canvas#ui (the torn-down App emptied #screens), its settings
// in memory (the GPU page's opaque origin has no storage) and its frames stepped by the op instead of rAF.
// Its boot load is refused before it starts, so the tour reaches 'loading' with a real click on the error
// screen's Retry (docs/screens.md: page load or Retry after a failed load); that retry is the real load.
async function startForOp(onScreen: (e: UaaScreenChange) => void): Promise<TourGame> {
  const { views, screens } = pageRoots()
  const ui = document.createElement('canvas')
  ui.id = 'ui'
  screens.replaceChildren(ui)
  const saved = new Map<string, string>()
  let frame: ((dtS: number) => void) | null = null
  let loads = 0
  const env: AppEnv = {
    store: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => void saved.set(key, value) },
    padStorage: null,
    loop: f => {
      frame = f
      return () => { frame = null }
    },
    beforeLoad: async () => {
      if (loads++ === 0) throw new Error('uiTour: the boot load is refused so the tour reaches loading with Retry')
    },
  }
  const booted = await start(ui, env, () => false, onScreen)
  if (booted === null) throw new Error('uiTour: the App did not start')
  return { host: booted.host, ui, views, step: dt => frame?.(dt), dispose: () => booted.app.dispose() }
}

// Nothing mounted: write the message into the page rather than only the console.
function bootFailed(e: unknown): void {
  console.error(e)
  document.body.textContent = `Royal Fiesta could not start: ${bootMessage(e)}`
  document.body.style.cssText = 'color: #fff; font: bold 18px system-ui, sans-serif; padding: 32px'
}

// The GPU runner loads the page without a query, so every load registers the ops (no side effect until
// one is called); ?mode=ops registers them alone, with no App, and so does the runner's opaque origin
// (no storage: the App could not keep its settings, and its failed boot would empty the page an op needs).
// The first op call tears the App down.
const opsMode = new URLSearchParams(window.location.search).get('mode') === 'ops' || window.origin === 'null'
if (opsMode) roundOverlay().hide(true)
let app: App | null = null
let opTookPage = false
try {
  installGameOps(() => {
    opTookPage = true
    app?.dispose()
  }, startForOp)
  if (!opsMode) {
    const canvas = document.querySelector<HTMLCanvasElement>('#screens > canvas#ui')
    if (canvas === null) throw new Error('game.html needs main#views and div#screens holding canvas#ui')
    start(canvas, { store: window.localStorage, padStorage: window.localStorage, loop }, () => opTookPage).then(s => { app = s?.app ?? null }, bootFailed)
  }
} catch (e) {
  bootFailed(e)
}
