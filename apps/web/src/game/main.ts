/// <reference types="vite/client" />
import { browserZones } from '../client/sources.ts'
import { localPlayerCount } from './localPlayers.ts'
import { localBotCount } from './localBots.ts'
import startSeasonJson from '../../../../courses/season.json?raw'
import { DEFAULT_LOBBY_BOTS } from '@royal-fiesta/game/hub/hubBots'
import { playerLook } from '../play/playerLook.ts'
import type { WornLook } from '@royal-fiesta/game/render/wornLook'
import { checkAwait, checkPhase } from './checkProgress.ts'
// game.html entry: start -> lobby -> show. Online shows share one zone relay room through the final.
// The hub and its matches run in-page with bots, or on the relay when ?server= is given; ?clients=2..4 runs
// that many piloted clients over a LoopbackRelay. Content comes from pickContent, input only from GameInput.
// ?players=1..4 (alias ?local=) reserves local human seats in one split-screen canvas; works with ?course= and ?bots=.
// Every screen and the round HUD are drawn by uaa on canvas#ui, above the RAA views.
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
import { strokeTuningFromUrl } from './strokeTuner.ts'
import { localPadMapStore } from '@royal-fiesta/game/client/padMap'
import type { PadMapStore } from '@royal-fiesta/game/client/padMap'
import { MAX_LOCAL_SEATS, SeatTable, claimSeats } from '@royal-fiesta/game/client/seats'
import type { DeviceId } from '@royal-fiesta/game/client/seats'
import { overviewCamera, pixelViewports, splitLayout } from '@royal-fiesta/game/client/splitLayout'
import type { SplitCell } from '@royal-fiesta/game/client/splitLayout'
import type { GameContent } from '@royal-fiesta/game/content'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { cosmeticOf, LOCAL_COSMETICS, startScreen, startStep } from '@royal-fiesta/game/flow/startScreen'
import type { StartScreenModel } from '@royal-fiesta/game/flow/startScreen'
import { economyOwned, rewardOffline } from '@royal-fiesta/game/economy/owned'
import { createEconomyStub } from '@royal-fiesta/game/economy/stub'
import type { EconomyConfig } from '@royal-fiesta/game/economy/stub'
import { PlayFlow } from '@royal-fiesta/game/hub/flow'
import { HubWorld } from '@royal-fiesta/game/hub/hubWorld'
import { QueuePad } from '@royal-fiesta/game/hub/queuePad'
import { DEFAULT_NAME, LOCAL_LOBBY_WAIT_S, LocalCountdown, cleanName, lobbyLines } from '@royal-fiesta/game/hub/lobby'
import type { LobbyPick } from '@royal-fiesta/game/hub/lobby'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import { classicNetSetup, NET_PLAYERS } from '@royal-fiesta/game/net/tuning'
import { globalWsFactory, type WsFactory } from '@royal-fiesta/game/net/ws'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { PodiumStage } from '@royal-fiesta/game/render/podiumStage'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { CameraPose, RenderPort, SkinnedAssetT, Vec3T, Viewport } from '@royal-fiesta/game/render/port'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { pendingPipelines } from '../render/asyncPipelines.ts'
import { RoundGate } from '../render/pipelineGate.ts'
import type { RoundStage } from '../render/pipelineGate.ts'
import { SceneLayer } from '@royal-fiesta/game/render/sceneLayer'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import { SdfContent, skinnedCharacterOf } from '../content/providers/sdf.ts'
import { menuModel } from '@royal-fiesta/game/screens/menuModel'
import type { MenuCmd } from '@royal-fiesta/game/screens/menuModel'
import { ECONOMY_SCREENS, Effect, FLOW_SCREENS, Nav, backTogglesPause, flowAction } from '@royal-fiesta/game/screens/nav'
import type { Action, EconomyScreen, GameScreen, Screen } from '@royal-fiesta/game/screens/nav'
import { adjust, cycle, loadSettings, rebind, saveSettings } from '@royal-fiesta/game/screens/settings'
import type { KeyAction, Settings, SettingsStore } from '@royal-fiesta/game/screens/settings'
import { PAGE_ROWS, SETTINGS_CARD_IDS, SETTINGS_PAGES, pageAfterScreen, pageItems, type SettingsPage } from '@royal-fiesta/game/screens/settingsPages'
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
import { BootStages, wavedashReady, wavedashUsername } from '../platform/wavedash.ts'
import { probeWanted, runProbe } from '../platform/probe.ts'
import { pickContent } from '../content/source.ts'
import { GameInput, InputDevices } from '../input/input.ts'
import type { DevicePoll, UiEvent } from '../input/input.ts'
import { mountPadRemap } from '../input/padRemapScreen.ts'
import { mountTouchControls } from '../input/touch.ts'
import type { ListenerPose } from '@royal-fiesta/game/audio/emitters'
import { HubView } from '../play/hubView.ts'
import { NameTags } from '../play/nameTags.ts'
import { InPageHubLoop } from '../play/inpageHub.ts'
import { SoundDriver } from '../play/sound.ts'
import { widgetsOf } from '../ui/screenMap.ts'
import type { ScreensDoc, WidgetProps } from '../ui/screenMap.ts'
import { settingsWidgetProps } from '../ui/settingsWidgets.ts'
import { SettingsScene, type SettingsSceneFrame } from './settingsScene.ts'
import { createUaaHost } from '../ui/uaaHost.ts'
import type { UaaCommand, UaaHost, UaaScreenChange } from '../ui/uaaHost.ts'
import uiDocText from '../../../../ui/screens.ui-doc.json?raw'
import economyDocText from '../../../../economy/royal-fiesta.economy.json?raw'
import { createGameEconomy, economyUrl, rarityPrices } from '../platform/economy.ts'
import type { GameEconomy } from '../platform/economy.ts'
import { defaultRelay, onlineRelay } from '../platform/relay.ts'
import { installGameOps } from './ops.ts'
import { NetDiag } from './netDiag.ts'
import { NetPump } from './netPump.ts'
import { communityBase, listCommunityLevels, loadCommunityPack } from '../content/community.ts'
import { browserGameAssets, installContentOverlay } from '../content/v1Data.ts'
import { mountCommunityPanel } from './communityPanel.ts'
import { carouselCell, mountStartScreen } from '../screens/startScreen.ts'
import type { StartArt, StartScreenView } from '../screens/startScreen.ts'
import { mountVote } from '../screens/vote.ts'
import { mountCountdown } from '../screens/countdown.ts'
import { mountElimShow } from '../screens/elimShow.ts'
import { mountEndScreen } from '../screens/endScreen.ts'
import { ShowMode } from './showMode.ts'
import { loadShowContent } from './showContent.ts'
import type { ShowContent } from './showContent.ts'
import type { ShowModeOptions } from './showMode.ts'
import type { ShowFrame } from './showDirector.ts'
import type { OnlineMatch } from '@royal-fiesta/game/net/onlineMatch'
import { EconomyScreens } from './economyScreens.ts'
import type { ElimShowModel } from '@royal-fiesta/game/flow/elimShow'
import type { BootOptions, TourGame } from './uiTour.ts'
import { GraphicsSettings, loadGraphicsContract } from './graphicsSettings.ts'
import { FpsCounter, FramePacer, frameInterval } from './framePacing.ts'
import { setRenderOptions } from '../render/renderOptions.ts'
import { gameRenderOptions } from '../sdf/sdfPort.ts'
import type { ShadingMode, ShadingReport, PartWorldBounds, ResizablePort } from '../sdf/sdfPort.ts'
import { validateGameplay } from './checks/fieldShading.ts'

interface Query {
  players: number | null
  bots: number | null
  course: string | null
  // ?community=<level id>: a published community level (docs/community-levels.md), played as ?course= of its course.
  community: string | null
  // ?chash= pins the level to one content hash (a match descriptor does this).
  chash: string | null
  server: string | null
  hub: string | 'new'
  name: string
  colour: number
  lobbybots: number
  party: 2 | 3 | 4
  clients: number
  touch: 0 | 1
  // The local hub's countdown before its round starts by itself (online, the GameSaloon server sets it).
  wait: number
  // ?test=1: every show timer at its minimum, so UI checks step the phases instead of sleeping in real time.
  test: boolean
}

type Look = { dx: number; dy: number; rx: number; ry: number }

// Content, physics and one port per client canvas, all ready before any mode starts.
// show: the season maps and zone sidecars of the show (ShowMode), loaded when Play can go online.
interface Loaded { R: RapierModule; content: GameContent; ports: RenderPort[]; canvases: HTMLCanvasElement[]; course: ResolvedCourse | null; show: ShowContent | null }

const STEP_S = 1 / 60
const PLAYERS = 8
// The podium screen returns to the hub by itself after this, or earlier with its button.
const PODIUM_HOLD_S = 6
// ?test=1: keep an observable one-second vote, stepped without real-time waiting.
// The network intermission still takes its minimum.
const TEST_VOTE_MS = 1000
const TEST_INTERMISSION_MS = 0
const LOCAL_LOBBY_WAIT_LOCAL_S = 2

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
  const players = localPlayerCount(q)
  const bots = localBotCount(q)
  if (players !== null && bots !== null && players > bots) refuse('query', 'bots', 'total roster must include all ?players= human seats; increase ?bots=')
  const course = q.get('course')
  if (course !== null && course.length === 0) refuse('query', 'course', 'is empty; pass a course id of the content playlist')
  const community = q.get('community')
  if (community !== null && !/^ugc-[a-z0-9-]{1,36}-[0-9a-f]{8}$/.test(community)) refuse('query', 'community', `'${community}' is not a community level id; pick one in Community levels`)
  const chash = q.get('chash')
  if (chash !== null && !/^[0-9a-f]{64}$/.test(chash)) refuse('query', 'chash', 'is not a 64 hex content hash')
  const server = q.get('server')
  if (server !== null && !/^wss?:\/\/\S+$/.test(server)) refuse('query', 'server', `'${server}' is not a ws:// or wss:// URL; fix ?server=`)
  const hub = q.get('hub') ?? 'new'
  if (hub !== 'new' && !/^\d{4}$/.test(hub)) refuse('query', 'hub', `'${hub}' is not new or a 4-digit code; pass the code the hub shows`)
  const name = q.get('name') ?? 'Bean'
  if (name.length < 1 || name.length > 24) refuse('query', 'name', `has ${name.length} characters; choose a name of 1..24 characters`)
  const colour = intParam(q, 'colour', Math.floor(Math.random() * 8), 0, 7)
  const lobbybots = intParam(q, 'lobbybots', DEFAULT_LOBBY_BOTS, 0, 8)
  const party = intParam(q, 'party', 4, 2, 4) as 2 | 3 | 4
  const clients = intParam(q, 'clients', 1, 1, 4)
  const touch = intParam(q, 'touch', 0, 0, 1) as 0 | 1
  const test = intParam(q, 'test', 0, 0, 1) === 1
  // The offline lobby's countdown is a real wait: test mode takes its minimum (LocalCountdown needs > 0).
  // Tested on this machine the lobby waits 2 s (owner 2026-11-02); ?wait= sets any value, a hosted page keeps the full wait.
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname ?? '')
  const wait = test ? 1 : intParam(q, 'wait', localHost ? LOCAL_LOBBY_WAIT_LOCAL_S : LOCAL_LOBBY_WAIT_S, 1, 600)
  if (community !== null && (server !== null || course !== null)) refuse('query', 'community', 'plays one level in-page with bots; drop ?server= and ?course=')
  if (community !== null && clients > 1) refuse('query', 'clients', 'a community level plays one client with bots; drop ?clients=')
  if (course !== null && server !== null) refuse('query', 'course', 'plays in-page with bots; drop ?server= or ?course=')
  if (clients > 1 && server !== null) refuse('query', 'clients', `${clients} in-page clients use a LoopbackRelay; drop ?server= or ?clients=`)
  if (clients > 1 && course !== null) refuse('query', 'clients', `?course= plays one client with bots; drop ?clients= or ?course=`)
  return { players, bots, course, community, chash, server, hub, name, colour, lobbybots, party, clients, touch, wait, test }
}

// A coarse pointer (a phone or tablet) uses the on-screen controls; ?touch=1 asks for them on any device.
function touchWanted(search: string): boolean {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true
  return new URLSearchParams(search).get('touch') === '1'
}

// mountTouchControls registers its pointer listeners synchronously; count them for the lobby inventory.
function mountCountedTouch(root: HTMLElement): { touch: ReturnType<typeof mountTouchControls>; listeners: number } {
  const add = EventTarget.prototype.addEventListener
  let listeners = 0
  EventTarget.prototype.addEventListener = function (this: EventTarget, ...args: Parameters<typeof add>) {
    listeners++
    return add.apply(this, args)
  }
  try {
    return { touch: mountTouchControls(root), listeners }
  } finally {
    EventTarget.prototype.addEventListener = add
  }
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

// Calls frame once per page frame and returns the stop. `interval` (ms, 0 = every display refresh) caps the page's
// frame rate (Graphics: 60 fps by default, Vmax); a loop that steps frames itself (the uiTour op) ignores it.
type FrameLoop = (frame: (dtS: number) => void, interval?: () => number) => () => void

// Where the App keeps its settings and what calls its frames: the page's localStorage and rAF loop, or
// the uiTour op's in-memory store and its own frame steps. beforeLoad runs as each load starts; a throw fails
// that load as any load failure does (the uiTour op refuses the boot load so it can reach 'loading' with Retry).
/** Penguins in a show started from Play: you and 59 bots (owner 2026-11-05); ?seats= / ?bots= change it. */
const DEFAULT_SHOW_SEATS = NET_PLAYERS

interface AppEnv { store: SettingsStore; padStorage: Storage | null; loop: FrameLoop; beforeLoad?: () => Promise<void>; showSeats?: number; starterInventory?: boolean; fieldGameplay?: boolean; atlasBytes?: number }

// The page's FrameLoop, on requestAnimationFrame. An op tears the App down before building its own views.
// A callback the frame cap does not render is skipped (FramePacer, off rAF timestamps); dt is the time since the last
// rendered frame, so the simulations' fixed-tick accumulators see the same time whatever the cap.
function loop(frame: (dtS: number) => void, interval: () => number = () => 0): () => void {
  const pacer = new FramePacer(interval)
  let last = performance.now()
  let id = 0
  const tick = (now: number) => {
    id = requestAnimationFrame(tick)
    if (!pacer.shouldRender(now)) return
    const dt = Math.min(0.1, Math.max(0, now - last) / 1000)
    last = now
    frame(dt)
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
  // The mode has ended: the app returns a show to start, or a V1 match to the hub.
  readonly finished: boolean
  // A refusal the mode cannot recover from: the app shows the error screen.
  readonly failure: string | null
  enqueue(): void
  dequeue(): void
  // The online lobby choice ('default': join a waiting lobby, else a new one).
  pick?(p: LobbyPick | 'default'): void
  leaveMatch(): void
  dispose(): void
  // Local split screen: a device with a seat, and seat 0's sound listener when its camera exists.
  seated?(device: DeviceId): boolean
  listener?(): ListenerPose | null
  // Where the screen's course, hub or podium is drawn: App's RoundGate warms it and guards each countdown.
  roundStage(): RoundStage | null
}

// The show owns its simulation and canvas; App owns navigation, screen views and sound.
class ShowAdapter implements Mode {
  readonly show: ShowMode
  readonly localName: string
  private readonly actions: Action[] = []
  private lastResults: NonNullable<ShowMode['models']>['results'] = null
  private rewardedResults = 0
  private readonly economy: GameEconomy
  private readonly test: boolean
  private readonly seats = new SeatTable()
  private readonly inputs = Array.from({ length: 4 }, () => neutralInput())
  private endConfirmed = false
  elapsedMs = 0
  round = 0

  constructor(show: ShowMode, localName: string, economy: GameEconomy, test = false) {
    this.show = show
    this.localName = localName
    this.economy = economy
    this.test = test
  }

  inspectSeats() { return { seats: this.seats.seats.map(seat => ({ ...seat })), ...this.show.inspectHumans() } }

  name = (seat: number): string => seat === 0 ? this.localName : `Bot ${seat}`
  action(action: Action): void {
    // ?test=1: the winner reveal wait is 0, so a confirm on the end screen leaves at once.
    if (this.test && action === 'confirm' && this.show.models?.screen === 'endScreen') this.endConfirmed = true
    this.actions.push(action)
  }
  pickVote(index: number): void { this.show.pick(index) }
  hoverVote(index: number): void { this.show.hover(index) }
  get finished(): boolean {
    if (this.test) return this.endConfirmed || this.show.finished
    return this.show.finished
  }
  get failure(): string | null { return this.show.failure }
  sim(): null { return null }
  hud(): HudState | null { return this.show.hud() }
  listener(): ListenerPose | null { return this.show.listener() }
  enqueue(): void {}
  dequeue(): void {}
  leaveMatch(): void {}
  dispose(): void { this.show.dispose() }
  roundStage(): RoundStage | null { return this.show.roundStage() }
  lines(): string[] {
    return this.show.models?.endScreen?.podium.map((p, i) => `${PLACES[i]} ${this.name(p.seat)}`) ?? []
  }

  frame(f: FrameIn): GameScreen {
    const before = this.show.screen()
    if (!f.paused) {
      if (this.show.humanCount > 1 || this.show.fixedSeats) this.seats.reserve(this.show.humanCount, f.devices.slice(0, f.deviceCount).map(p => p.device))
      else if (this.seats.seats.length === 0) claimSeats(this.seats, f.devices, f.deviceCount, true, false)
      for (let k = 0; k < this.show.humanCount; k++) {
        const poll = f.devices.slice(0, f.deviceCount).find(p => p.device === this.seats.seats[k]?.device)
        controlsToInput(poll?.controls ?? emptyControls(), this.show.facing(k), this.inputs[k])
      }
      for (const action of this.actions) this.show.frame(0, action, this.inputs)
      this.show.frame(f.dt, null, this.inputs)
    }
    this.actions.length = 0
    const rounds = this.show.results()
    while (this.rewardedResults < rounds.length) {
      const latest = rounds[this.rewardedResults++]
      if (this.economy.stub !== null) rewardOffline(this.economy.stub, latest, [0])
    }
    const screen = this.show.screen()
    this.elapsedMs = screen === before ? this.elapsedMs + (f.paused ? 0 : f.dt * 1000) : 0
    const results = this.show.models?.results
    if (results != null && results !== this.lastResults) {
      this.lastResults = results
      this.round++
    }
    return screen
  }
}

interface ModeCtx {
  look?: () => WornLook | null
  loaded: Loaded; q: Query; orbit: OrbitCamera; prepared?: boolean
  // The game's views element: an online show adds its round canvas there.
  views?: HTMLElement
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
      character: content.character(), dressing: content.dressing(), camera: (focus, dt, clip) => orbit.pose(focus, dt, clip),
      look: this.c.look, loadingPaint: !this.c.prepared, skinned: skinnedCharacterOf(content),
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
  if (device.startsWith('pending:')) return 'Waiting for pad'
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
        camera: k === 0 ? (focus, dt, clip) => orbit.pose(focus, dt, clip) : undefined,
        look: this.c.look, lookPlayer: 0, loadingPaint: !this.c.prepared, skinned: skinnedCharacterOf(content),
      }))
    }
  }

  cameras(): (CameraPose | null)[] { return this.scenes.map(scene => scene.camera) }

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
    if (this.seats === 3 && this.c.q.players === null) {
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
  showRequested = false
  private readonly c: ModeCtx
  private readonly presenter: LocalPresenter
  private readonly hubView: HubView
  private hub: HubWorld
  private pad = new QueuePad(1)
  // The round starts by itself when it ends; Enter or the green pad still start it early.
  private readonly countdown: LocalCountdown
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
  private disposed = false

  // The hub (HubWorld + HubView) is only alive until this mode is disposed; a live inventory reads this.
  get hubAlive(): boolean {
    return !this.disposed
  }

  setVisible(visible: boolean): void {
    this.hubLayer.setVisible(visible && this.match === null)
    this.matchLayer.setVisible(visible && this.match !== null)
  }

  constructor(c: ModeCtx) {
    this.c = c
    const { R, content, ports } = c.loaded
    // Touch holds seat 0 and leaves no room to join, so the layout stays at one seat.
    this.seats = new SeatTable(c.touch && c.q.players === null ? 1 : MAX_LOCAL_SEATS)
    // Touch is the only device on a touch screen. Elsewhere nothing is seated: the first device pressed or used is P1.
    if (c.q.players !== null) this.seats.reserve(c.q.players, [])
    else if (c.touch) this.seats.join('touch')
    this.names = playerNames(0, c.q.name)
    this.countdown = new LocalCountdown(c.q.wait)
    this.hub = new HubWorld(R, content.hub(), 0, c.q.lobbybots)
    this.hubLayer = new SceneLayer(ports[0])
    this.matchLayer = new SceneLayer(ports[0])
    this.hubView = new HubView(this.hubLayer.port, 0, name => content.assets(name), content.character(), content.hub(), {
      look: c.look, orbit: c.orbit, character: content.character(), dressing: content.dressing(), skinned: skinnedCharacterOf(content),
    })
    this.presenter = new LocalPresenter({ ...c, prepared: true, loaded: { ...c.loaded, ports: [this.matchLayer.port] } })
    if (!this.startsShow) this.prepareMatch()
    // ?course= goes straight into its round.
    if (c.loaded.course !== null) this.enqueue()
  }

  get finished(): boolean {
    const m = this.match
    if (m === null) return false
    if (this.presenter.onPodium) return this.presenter.podiumS >= (this.c.q.test ? 0 : PODIUM_HOLD_S)
    return m.match.done || (this.over(m) && m.order.length === 0)
  }

  sim(): MatchSim | null {
    return this.match?.match.sim ?? null
  }

  inspectSeats(all = false) {
    return {
      seats: this.seats.seats.map(s => ({ ...s })),
      cameras: this.presenter.cameras().map(camera => camera === null ? null : { ...camera, eye: [...camera.eye], target: [...camera.target] }),
      characters: Array.from({ length: all ? PLAYERS : Math.max(1, this.seats.seats.length) }, (_, k) => {
        const c = this.match?.match.sim.character(k, emptyCharView())
        return c === undefined ? null : { ...c, pos: { ...c.pos }, vel: { ...c.vel }, facing: { ...c.facing } }
      }),
    }
  }

  seated(device: DeviceId): boolean {
    return this.seats.seatOf(device) !== -1
  }

  listener(): ListenerPose | null {
    return this.presenter.listener()
  }

  // Explicit bot rosters use the single-world show, including a pinned ?course= opening.
  private get startsShow(): boolean {
    return this.c.q.server === null && this.c.q.clients === 1 && (this.c.q.course === null || this.c.q.bots !== null)
  }

  enqueue(): void {
    if (this.startsShow) {
      this.showRequested = true
      return
    }
    if (this.match !== null) return
    // An unclaimed P1 remains available to the first active device during the round.
    const count = Math.max(1, this.seats.seats.length)
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
      : classicNetSetup(seed, seats, 'sprint', content.playlist()).courses
    // ?tune=1 hands the live-tuned belly stroke to this local sim only (online matches keep the defaults).
    const slideStroke = strokeTuningFromUrl() ?? undefined
    const match = startup('Local round', () => new LocalMatch({ R, seats, seed, profile: 'sprint', courses, slideStroke }))
    return { match, singleRace: course !== null && course.kind === 'race', order: [] }
  }

  // Warms the menu behind a 1-seat match; enqueue reuses it only while the table still holds one seat.
  private prepareMatch(): void {
    const { ports } = this.c.loaded
    checkPhase('local scene: build warmup match')
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
    this.hubView.update(this.hub.state(this.local), this.c.q.colour, this.hub.botViews(), this.hub.tick, 0, this.hub.emote(performance.now()))
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
      this.hubView.update(this.hub.state(this.local), this.c.q.colour, this.hub.botViews(), this.hub.tick, 0, this.hub.emote(performance.now()))
      ports[0].render()
      await ports[0].capture()
    }
  }

  roundStage(): RoundStage | null {
    const run = this.match
    if (run === null) return { port: this.hubLayer.port, course: 'hub' }
    if (this.presenter.onPodium) return { port: this.matchLayer.port, course: 'podium' }
    const course = run.match.sim.course()
    return course === null ? null : { port: this.matchLayer.port, course: course.id }
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
    this.hub = new HubWorld(this.c.loaded.R, this.c.loaded.content.hub(), 0, this.c.q.lobbybots)
    this.pad = new QueuePad(1)
    this.countdown.reset()
    this.hubAcc = 0
    this.c.orbit.reset(0)
    this.prepareMatch()
  }

  frame(f: FrameIn): GameScreen {
    if (this.c.q.players !== null) this.seats.reserve(this.c.q.players, f.devices.slice(0, f.deviceCount).map(p => p.device))
    else if (this.match !== null && this.seats.seats.length === 0) claimSeats(this.seats, f.devices, f.deviceCount, !f.paused, false)
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
        `Round starts in ${this.countdown.secondsLeft} s - bots fill the empty places`,
        this.seats.seats.length === 0 ? 'Press any button to take P1' : seatLine(this.seats.seats),
        'Press Start on another controller to join - Enter or the green pad starts now',
      ]
    }
    if (this.presenter.places !== null) return podiumLines(this.presenter.places, this.names)
    const v = this.presenter.view
    if (m.singleRace && v.phase >= Phase.roundEnd && m.order.length === 0) return ['Nobody qualified']
    return [`Round ${v.roundIndex + 1}: ${v.qualifiedCount} qualified, ${v.alive} still running`]
  }

  dispose(): void {
    this.disposed = true
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
    if (this.c.q.players === null) claimSeats(this.seats, f.devices, f.deviceCount, !f.paused)
    if (f.emote !== 0) this.hub.setEmote(f.emote, now)
    if (!f.paused) {
      this.hubAcc = Math.min(this.hubAcc + f.dt, 8 * STEP_S)
      while (this.hubAcc >= STEP_S) {
        this.hubAcc -= STEP_S
        this.hub.step(f.world)
        const pad = this.pad.update(this.hub.onQueuePad())
        if (this.countdown.step(STEP_S) || pad === 'armed') {
          this.enqueue()
          if (this.match !== null) return this.frameMatch(this.match, f)
        }
      }
    }
    this.hubView.update(this.hub.state(this.local), this.c.q.colour, this.hub.botViews(), this.hub.tick, f.dt, this.hub.emote(now))
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
    if (this.presenter.draw(run.match, this.over(run) ? 1 : alpha, f.paused ? 0 : f.dt, podium)) this.c.setLayout(1)
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

// The name the other players see: ?name= when given, else the Wavedash display name, else the default (the lobby then
// shows 'Bean <n>' by arrival order). Only a display name, never an account id.
function onlineName(queryName: string): string {
  const own = queryName !== DEFAULT_NAME ? queryName : (wavedashUsername() ?? DEFAULT_NAME)
  const name = cleanName(own)
  return name.length > 0 ? name : DEFAULT_NAME
}

// One relay client (?server=): this page's bean in the online hub (PlayFlow), its matches and podiums.
// PlayFlow enters a GameSaloon lobby by itself and returns to the hub after each round, so the queue and leave commands
// only explain that; a paused page sends no move (the match cannot pause for the others).
// Always-visible, discreet diagnostics line (bottom-left): build, relay host, lobby, own key, members, socket status.
// Also logged with console.info('[lobby]'). Hidden later by step 3.
function bakedOrNull(): string | null {
  try { return defaultRelay() } catch { return null }
}

function relayHost(url: string | null): string {
  if (url === null) return 'none'
  try { return new URL(url).host } catch { return 'invalid' }
}

class LobbyDiag {
  private static inst: LobbyDiag | null = null
  static get(): LobbyDiag {
    return (LobbyDiag.inst ??= new LobbyDiag())
  }

  private readonly el: HTMLElement | null
  private build = 'build ?'
  private relay = 'none'
  private conn = 'idle'
  private lobby = ''
  private mesh = ''
  private last = ''

  private constructor() {
    if (typeof document === 'undefined') {
      this.el = null
      return
    }
    const el = document.createElement('div')
    el.id = 'lobby-diag'
    el.style.cssText = 'position:fixed;left:6px;bottom:4px;z-index:9999;font:10px/1.3 monospace;color:#fff;opacity:.55;'
      + 'background:rgba(0,0,0,.35);padding:1px 4px;border-radius:3px;pointer-events:none;max-width:96vw;white-space:pre-wrap'
    document.body.appendChild(el)
    this.el = el
    void fetch('rf-build.json').then(r => (r.ok ? r.json() : null)).then((s: { commit?: string | null; builtAt?: string } | null) => {
      this.build = s === null ? 'build dev' : `build ${(s.commit ?? 'nogit').slice(0, 7)} ${s.builtAt ?? ''}`
      this.render()
    }, () => { this.build = 'build dev'; this.render() })
    this.render()
  }

  setRelay(host: string): void { this.relay = host; this.render() }
  setConn(s: string): void { this.conn = s; this.render() }
  setLobby(s: string): void { this.lobby = s; this.render() }
  setMesh(s: string): void { this.mesh = s; this.render() }

  private render(): void {
    const text = `${this.build} | relay ${this.relay} | ${this.conn}${this.lobby ? ` | ${this.lobby}` : ''}${this.mesh ? ` | ${this.mesh}` : ''}`
    if (this.el !== null) this.el.textContent = text
    if (text !== this.last) {
      this.last = text
      console.info('[lobby]', text)
    }
  }
}

// Wraps the socket factory so the diagnostics line shows open/closed with the close code.
function diagWs(inner: WsFactory): WsFactory {
  return url => {
    const ws = inner(url)
    const d = LobbyDiag.get()
    let wasOpen = false
    const poll = setInterval(() => {
      if (ws.readyState === 1 && !wasOpen) { wasOpen = true; d.setConn('open') }
      if (ws.readyState === 3) clearInterval(poll)
    }, 100)
    // The client assigns onclose right after creation; wrap it on the next microtask.
    queueMicrotask(() => {
      const clientHandler = ws.onclose
      ws.onclose = e => {
        clearInterval(poll)
        d.setConn(`closed code ${e.code}${e.reason ? ` ${e.reason}` : ''}${wasOpen ? '' : ' (before open)'}`)
        clientHandler?.(e)
      }
    })
    return ws
  }
}

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
  // The shared hub: every lobby member's name over its bean.
  private readonly tags: NameTags | null
  private readonly localName: string
  /** Penguins of the online show, bots included: ?bots= or NET_PLAYERS (60). */
  private readonly seats: number
  // Steps the flow while the window draws no frames (hidden or behind the other window), see netPump.ts.
  private readonly pump: NetPump
  private readonly netDiag = new NetDiag()

  // The network show's rounds, screens and loading: ShowMode, the in-page show's presenter, on the flow's match.
  private showMode: ShowMode | null = null
  private showMatch: OnlineMatch | null = null
  readonly show = { models: null as ShowFrame | null, cues: (): string[] => this.showMode?.cues() ?? [] }
  elapsedMs = 0
  round = 0
  get localSeat(): number { return this.seat }
  name = (seat: number): string => this.names[seat] ?? `Bot ${seat + 1}`
  action(action: Action): void { this.showMode?.frame(0, action, []) }
  pickVote(index: number): void { this.showMode?.pick(index) }
  hoverVote(index: number): void { this.showMode?.hover(index) }

  constructor(c: ModeCtx, server: string) {
    this.c = c
    this.pump = new NetPump(dt => this.background(dt))
    const { R, content, ports, show } = c.loaded
    const q = c.q
    if (show === null) refuse('game', 'online.show', 'the online show content is not loaded; reload the page')
    this.seats = q.bots ?? NET_PLAYERS
    this.localName = onlineName(q.name)
    this.names = playerNames(0, this.localName)
    this.flow = new PlayFlow({
      R, relayUrl: server, ws: diagWs(globalWsFactory()), hubCode: q.hub, name: this.localName, colour: q.colour,
      courses: show.courses, zones: show.zones, season: show.season, plaza: content.hub(), partySize: q.party, now: () => performance.now(), pilot: false,
      // GameSaloon timed lobbies: the hub enters one by itself; no pad, no key.
      matchmaking: 'lobby', voteMs: 5000, intermissionMs: 12000,
      // ?bots= (total penguins) shrinks the online show too; both pages of a lobby pass the same value.
      seats: this.seats,
      presentationDone: () => this.show.models?.finished === true,
      log: ev => {
        if (ev.state === 'match' && typeof ev.detail.seat === 'number') this.seat = ev.detail.seat
        if (ev.state === 'failed') this.failure = String(ev.detail.message ?? 'the relay connection failed')
        console.info('[game]', ev.state, ev.detail)
        if (ev.state === 'failed') LobbyDiag.get().setConn(`failed: ${this.failure}`)
      },
    })
    LobbyDiag.get().setRelay(relayHost(server))
    LobbyDiag.get().setConn('connecting')
    this.hubView = new HubView(ports[0], 0, name => content.assets(name), content.character(), content.hub(), {
      look: c.look, orbit: c.orbit, character: content.character(), dressing: content.dressing(), skinned: skinnedCharacterOf(content),
    })
    this.presenter = new MatchPresenter(c)
    const canvas = c.loaded.canvases[0]
    this.tags = typeof document === 'undefined' || canvas === undefined ? null : new NameTags(canvas)
    // Two pages on one machine: the hidden one runs on the NetPump worker clock (bg/s); log each switch with the tick.
    if (typeof document !== 'undefined') {
      this.onVisibility = () => console.info(`[online] page ${document.visibilityState} at tick ${this.flow.match?.sim.tick ?? '-'} (${this.flow.state})`)
      this.onPageHide = () => this.flow.close('its page was closed')
      document.addEventListener('visibilitychange', this.onVisibility)
      addEventListener('pagehide', this.onPageHide)
    }
    void this.flow.start()
  }

  private onVisibility: (() => void) | null = null
  private onPageHide: (() => void) | null = null

  // This client as the lobby shows it ('Bean 2' for a default name), else its own name.
  private shownName(): string {
    const v = this.flow.lobby.view
    return v.members.find(m => m.k === v.you)?.name ?? this.localName
  }

  // The round's names: the lobby's players in seat order (the server seats them in lobby order), bots after them.
  private roundNames(): string[] {
    const players = this.flow.lobby.view.members.filter(m => m.role === 'player')
    if (players.length === 0) return Array.from({ length: this.seats }, (_, seat) => seat === this.seat ? this.localName : `Bot ${seat + 1}`)
    return Array.from({ length: this.seats }, (_, p) => (p < players.length ? players[p].name : `Bot ${p + 1}`))
  }

  sim(): MatchSim | null {
    return this.flow.match?.sim ?? null
  }

  // Lobby id, start countdown, relay round trip and every member by presence key (two pages of one account share a
  // name) for the diagnostics line; the mesh peers follow once the round's channels open.
  private diag(): void {
    const v = this.flow.lobby.view
    const names = v.members.map(m => `${m.name}#${m.k}${m.k === v.you ? '(you)' : ''}${m.role === 'spectator' ? '(watching)' : ''}`).join(' ')
    const starts = v.startsAt === null ? '' : ` starts in ${Math.max(0, Math.ceil((v.startsAt - performance.now()) / 1000))}s`
    const rtt = this.flow.relayRtt
    LobbyDiag.get().setLobby(`lobby ${v.id ?? '-'}${starts} relay rtt ${rtt === null ? '-' : `${rtt.toFixed(0)}ms`} | ${v.members.length || v.names.length} players: ${names || v.names.join(' ')} | ${this.flow.state}`)
    LobbyDiag.get().setMesh(Object.entries(this.flow.mesh?.peers ?? {}).map(([peer, link]) =>
      `p${peer} fast:${link.fast} reliable:${link.reliable} rtt ${link.rtt === null ? 'pending' : `${link.rtt.toFixed(1)}ms`}${link.reason ? ` (${link.reason})` : ''}`).join(' | '))
  }

  hud(): HudState | null {
    if (this.flow.match === null) return null
    return this.showMode?.hud() ?? { view: this.presenter.view, names: this.names, seat: this.seat }
  }

  // The lobby is entered by itself and its server starts the round: nothing to queue or cancel.
  enqueue(): void {}
  dequeue(): void {}

  roundStage(): RoundStage | null {
    const port = this.c.loaded.ports[0]
    if (this.flow.match === null) return { port, course: 'hub' }
    return this.showMode?.roundStage() ?? null
  }

  pick(p: LobbyPick | 'default'): void {
    this.flow.pick(p === 'default' ? this.flow.lobby.defaultPick() : p)
  }

  // Leave closes the flow: the other pages get 'left the match' and a bot takes the seat. The app then opens a
  // fresh online hub (Effect.leaveMatch).
  leaveMatch(): void {
    console.info(`[online] leaving at tick ${this.flow.match?.sim.tick ?? '-'} (${this.flow.state})`)
    this.flow.close('the player left the match')
  }

  // A NetPump step: the flow advances with idle controls (the window has no focus) and nothing is drawn.
  private background(dtS: number): void {
    this.flow.frame(dtS, null, 0)
    this.stepShow(dtS)
    this.sampleNet(performance.now(), false)
  }

  private stepShow(dtS: number): void {
    const match = this.flow.match
    if (match !== this.showMatch) {
      this.showMode?.dispose()
      this.showMode = null
      this.showMatch = match
      this.show.models = null
      const { R, show } = this.c.loaded
      if (match !== null && show !== null && this.c.views !== undefined) {
        this.names = this.roundNames()
        this.showMode = ShowMode.online({ R, views: this.c.views, orbit: this.c.orbit, look: this.c.look?.() ?? null,
          seats: this.seats, seed: 0, localName: this.localName, localSeat: this.seat, name: this.name,
          voteMs: 5000, intermissionMs: 12000 }, match.full, show)
      }
    }
    const mode = this.showMode
    if (mode === null) return
    mode.frame(dtS, null, [])
    if (mode.failure !== null && this.failure === null) this.failure = mode.failure
    const before = this.show.models
    const models = mode.models
    this.elapsedMs = models?.screen === before?.screen ? this.elapsedMs + dtS * 1000 : 0
    if (models?.results && models.results !== before?.results) this.round++
    this.show.models = models
  }

  private sampleNet(nowMs: number, drawn: boolean): void {
    const match = this.flow.match
    if (match === null) this.netDiag.clear()
    else this.netDiag.sample({ ...match.session.stats, confirmedDomains: match.zones?.stats.confirmedTick,
      peers: this.flow.mesh?.peers }, this.pump.pumped, nowMs, drawn)
  }

  frame(f: FrameIn): GameScreen {
    const flow = this.flow
    const now = performance.now()
    const before = flow.state
    let facing: Planar = { x: 0, z: 1 }
    if (flow.match !== null) facing = flow.match.sim.character(this.seat, this.cv).facing
    else if (inHub(before)) facing = flow.hub.state(this.local).facing
    this.diag()
    flow.frame(this.pump.frame(f.dt), f.paused ? null : inCharacterFrame(f.world, facing, this.moved), f.paused ? 0 : f.emote)
    this.sampleNet(now, true)
    const match = flow.match
    this.stepShow(f.dt)
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
        this.presenter.end()
        this.names = this.roundNames()
      }
    }
    // Entering, waiting in or watching a lobby keeps the walkable hub: the player is never asked join or spectate.
    let screen: GameScreen = 'hub'
    if (match !== null) {
      const v = match.sim.phase(this.presenter.view)
      screen = this.show.models?.screen ?? matchScreen(v, match.sim.character(this.seat, this.cv).status, false)
    } else if (inHub(flow.state)) {
      this.hubView.update(flow.hub.state(this.local), this.c.q.colour, flow.remotes(now), flow.hub.tick, f.dt, flow.hub.emote(now))
    }
    if (match === null && inHub(flow.state)) this.tags?.update(this.hubView.camera, this.hubView.tags(this.shownName()))
    else this.tags?.update(null, [])
    renderFrame(this.c.loaded.ports[0], () => this.c.loaded.ports[0].render())
    return screen
  }

  lines(): string[] {
    const flow = this.flow
    const state = flow.state
    if (this.presenter.places !== null) return [...podiumLines(this.presenter.places, this.names), this.note]
    const lines: string[] = []
    if (flow.hubCode !== null) lines.push(`Hub ${flow.hubCode} - ${this.localName}`)
    if (state === 'connecting') lines.push('Connecting...')
    else if (state === 'hub') lines.push('Joining a lobby...')
    else if (state === 'queued' || state === 'choosing' || state === 'watching') lines.push(...lobbyLines(flow.lobby, performance.now(), this.seats))
    else if (state === 'returning') lines.push('Back to the hub...')
    else if (flow.match !== null) lines.push(`Round ${this.presenter.view.roundIndex + 1}: ${this.presenter.view.qualifiedCount} qualified`)
    if (this.note.length > 0) lines.push(this.note)
    return lines
  }

  dispose(): void {
    this.pump.dispose()
    this.netDiag.dispose()
    this.showMode?.dispose()
    this.showMode = null
    this.flow.close()
    if (this.onVisibility !== null) document.removeEventListener('visibilitychange', this.onVisibility)
    if (this.onPageHide !== null) removeEventListener('pagehide', this.onPageHide)
    this.presenter.dispose()
    this.hubView.dispose()
    this.tags?.dispose()
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
      R, courses: content.playlist(), zones: browserZones(content.playlist()), plaza: content.hub(), partySize: c.q.clients as 2 | 3 | 4, now: () => performance.now(), pilot: true,
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
  roundStage(): RoundStage | null {
    const port = this.c.loaded.ports[0]
    const sim = this.sim()
    if (sim === null) return { port, course: 'hub' }
    const course = sim.course()
    return course === null ? null : { port, course: course.id }
  }

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

// Flow states where the bean walks the hub: waiting in, choosing or watching a lobby included.
function inHub(state: string): boolean {
  return state === 'hub' || state === 'queued' || state === 'choosing' || state === 'watching'
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

// The wardrobe the start screen keeps: the body colour and the item worn in each bin slot.
const WARDROBE_KEY = 'rf.wardrobe'

interface Wardrobe { colour: number; worn: Record<string, string>; version?: number }

function readWardrobe(store: SettingsStore, fallbackColour: number): Wardrobe {
  const raw = store.getItem(WARDROBE_KEY)
  if (raw === null) return { colour: fallbackColour, worn: {} }
  try {
    const data = JSON.parse(raw) as { colour?: unknown; worn?: unknown; version?: number }
    const colour = typeof data.colour === 'number' && Number.isInteger(data.colour) ? data.colour : fallbackColour
    const worn: Record<string, string> = {}
    if (typeof data.worn === 'object' && data.worn !== null) {
      for (const [slot, item] of Object.entries(data.worn)) if (typeof item === 'string') worn[slot] = item
    }
    return { colour, worn, version: data.version }
  } catch {
    return { colour: fallbackColour, worn: {} }
  }
}

// The hub's S13 environment, read through the same dressing the hub view uses: a recorder port takes the
// environment and ignores the decor instances, so the start layer only gets the lighting.
function hubEnvironment(content: GameContent): Readonly<Record<string, unknown>> | null {
  let environment: Readonly<Record<string, unknown>> | null = null
  let handle = 1
  const recorder = {
    setEnvironment: (env: Readonly<Record<string, unknown>> | null): void => { environment = env },
    registerAsset: (): number => handle++,
    createInstance: (): number => handle++,
    setTransform: (): void => {},
    destroyInstance: (): void => {},
  } as unknown as RenderPort
  const dressing = content.dressing()
  try {
    dressing.enter(recorder, content.hub().id)
    dressing.leave(recorder)
  } catch (e) {
    console.warn('[start] hub environment unavailable:', messageOf(e))
    return null
  }
  return environment
}

// The hub's own asset names and instance count (plaza obstacles, mechanisms and the local bean). The
// dressing's decor is not in the course record; a leaked lobby instance is still counted by the port.
function hubInventory(content: GameContent): { assets: string[]; instances: number } {
  const plaza = content.hub()
  const assets = new Set<string>()
  let instances = 1
  for (const obstacle of plaza.obstacles) { assets.add(obstacle.asset); instances++ }
  for (const item of plaza.mechanisms?.items ?? []) { assets.add(item.asset); instances++ }
  try { assets.add(content.character().id) } catch { /* the hub still has its obstacles */ }
  return { assets: [...assets].sort(), instances }
}

// Wraps the stage port so the App can free every asset the lobby registered (RenderPort.releaseAsset).
function trackLobbyAssets(port: RenderPort, into: Set<number>): RenderPort {
  return new Proxy(port, {
    get(target, key) {
      if (key === 'registerAsset') {
        return (name: string, asset: PrimsAsset): number => {
          const handle = target.registerAsset(name, asset)
          into.add(handle)
          return handle
        }
      }
      if (key === 'registerSkinned') {
        const register = target.registerSkinned
        if (register === undefined) return undefined
        return (assetId: string, skin: SkinnedAssetT): number => {
          const handle = register.call(target, assetId, skin)
          into.add(handle)
          return handle
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// The page: Nav drives every screen; its effects start and stop modes and the load. The uaa host draws
// the screen nav is on and reports its button presses back as menu commands.
class App {
  readonly nav = new Nav()
  private settings: Settings
  private settingsPage: SettingsPage = 'audio'
  private settingsScene: SettingsScene | null = null
  // The screen the last draw() showed: entering Settings opens it on Audio.
  private drawnScreen: Screen | null = null
  private settingsError: string | null
  // The Graphics page and options (MAMA's render-options contract) and the FPS counter they show.
  private readonly graphics: GraphicsSettings
  private readonly fps: FpsCounter
  // The shading mode already pushed to the loaded SDF content (the page address applied on top).
  private liveShading: ShadingMode | null = null
  private rebinding: KeyAction | null = null
  private pendingRebind: KeyAction | null = null
  private mode: Mode | null = null
  // Every mode's course, hub and podium go through this gate (render/pipelineGate.ts).
  private readonly roundGate = new RoundGate()
  private showLoad = 0
  private showView: { screen: Screen; update(): void; unmount(): void } | null = null
  private preparedLocal: LocalMode | null = null
  private readonly loadingOverlay = roundOverlay()
  private roundLoading: string | null = null
  // The uaa screen transitions run on the frames' clock, not the wall clock: an op steps game time faster
  // than real time, and a 150 ms exit fade on performance.now() outlived the whole 1 s test vote, so uaa
  // replaced the pending 'vote' before entering it. Starts after the host's own creation time.
  private uiNowMs = performance.now()
  private stopRoundLoad: (() => void) | null = null
  private loaded: Loaded | null = null
  private query: Query | null = null
  private emote = 0
  private stopLoop: (() => void) | null = null
  private disposed = false
  private readonly errorEvents = new AbortController()
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
  private readonly sound: SoundDriver
  private readonly economy: GameEconomy
  private readonly economyScreens: EconomyScreens
  private economyScreen: EconomyScreen | null = null
  private startModel: StartScreenModel | null = null
  // Every cosmetic the current catalog offers plus the local ones; buildStartArt mounts each of them.
  private startCosmetics: readonly { id: string; slot: string }[] = []
  private startArt: StartArt | null = null
  private startView: StartScreenView | null = null
  private readonly orbit = new OrbitCamera()
  private readonly world = neutralInput()
  private readonly touchScratch = emptyControls()
  // Mobile touch controls and the settings screen's controller remap (both draw on their own canvas).
  private readonly touchRoot: HTMLElement
  private readonly touchOn: boolean
  private readonly touch: ReturnType<typeof mountTouchControls> | null
  // DOM/window listeners the lobby views and touch controls registered (HubView and LocalMode add none).
  private lobbyListeners = 0
  // Asset handles the lobby registered on the stage port, freed when the show starts (releaseAsset).
  private readonly lobbyAssets = new Set<number>()
  // The show has no MatchSim, so SoundDriver.frame would restart the lobby music; keep it stopped.
  private lobbySoundOff = false
  private readonly remapRoot: HTMLElement
  private readonly remapButton: HTMLButtonElement
  private readonly community: { setVisible(on: boolean): void; dispose(): void } | null
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
    // The App's store (the page's storage, or memory when the frame refuses it), never the bare global.
    this.sound = new SoundDriver({ store: env.store })
    const config = JSON.parse(economyDocText) as EconomyConfig
    const name = onlineName(new URLSearchParams(search).get('name') ?? DEFAULT_NAME)
    // A build without VITE_RF_ECONOMY uses the offline stub; ?test=1 has it own the whole drop, so a check
    // can walk every catalog cosmetic through the start screen's bins.
    const url = economyUrl()
    const test = new URLSearchParams(search).get('test') === '1'
    if (test && url === null && !env.starterInventory) {
      const stub = createEconomyStub({
        config, me: { owned: config.catalog.shop.items.map(item => item.id) },
      })
      this.economy = {
        port: stub, stub, banned: config.settings.filter.banned_words, prices: rarityPrices(config),
        close: () => {},
      }
    } else {
      this.economy = createGameEconomy({ url, store: this.env.store, name, config })
    }
    this.economyScreens = new EconomyScreens({
      host: this.host, port: this.economy.port, banned: this.economy.banned,
      cue: id => this.sound.cue(id),
      parent: { appendChild: field => this.screens.appendChild(field as HTMLTextAreaElement) },
    })
    try {
      this.nav.onlineOnly = defaultRelay() !== null
    } catch {
      this.nav.onlineOnly = true // a malformed baked relay: Play refuses with that message, it never plays offline
    }
    if (env.fieldGameplay && test) this.nav.onlineOnly = false
    LobbyDiag.get().setRelay(this.nav.onlineOnly ? relayHost(bakedOrNull()) : 'none')
    const saved = loadSettings(env.store)
    this.settings = saved.settings
    this.settingsError = saved.error
    this.fps = new FpsCounter(this.screens)
    this.graphics = new GraphicsSettings(env.store, options => {
      setRenderOptions(options)
      this.fps.setVisible(options.showFps === true)
      this.applyShading(options.shading)
    })
    void loadGraphicsContract().then(contract => { if (!this.disposed) this.graphics.attach(contract) })
    // A coarse pointer or ?touch=1 mounts the virtual joystick and buttons over #views; seat 0 is touch.
    this.touchRoot = requiredElement<HTMLElement>('#touch')
    this.touchOn = touchWanted(search)
    if (this.touchOn) {
      const mounted = mountCountedTouch(this.touchRoot)
      this.touch = mounted.touch
      this.lobbyListeners = mounted.listeners
    } else this.touch = null
    this.touchRoot.hidden = true
    this.remapRoot = requiredElement<HTMLElement>('#remap')
    this.remapButton = requiredElement<HTMLButtonElement>('#open-remap')
    this.remapButton.hidden = true
    this.remapButton.addEventListener('click', this.onOpenRemap)
    const levelsBase = communityBase(search)
    this.community = levelsBase === null ? null : mountCommunityPanel(requiredElement<HTMLButtonElement>('#open-community'), requiredElement<HTMLElement>('#community-panel'), {
      list: () => listCommunityLevels(levelsBase),
      play: id => { const next = new URLSearchParams(search); next.delete('course'); next.set('community', id); location.search = next.toString() },
    })
    this.remapRoot.addEventListener('rf-remap-close', this.onRemapClose)
    // Clicking the (single) game canvas locks the pointer for the mouse look.
    this.input = new GameInput(window, screens, () => this.mode instanceof ShowAdapter ? this.mode.show.lookCanvas : (this.loaded?.canvases.length === 1 ? this.loaded.canvases[0] : null))
    // Every device is polled once per frame; key events bubble from the focused element to the body.
    this.padStore = localPadMapStore(env.padStorage)
    this.devices = new InputDevices(document.body, () => navigator.getGamepads?.() ?? [], this.padStore, this.touch)
    // The local canvas follows #views when it is resized (S26): the CSS size and DPR reach port.resize.
    this.viewsObserver = new ResizeObserver(() => this.resizeViews())
    this.viewsObserver.observe(this.views)
    this.observeErrors()
  }

  // These handlers retain the App, host and GPU device. They belong to this App,
  // and must be removed before its resources are released or a new App takes the page.
  private observeErrors(): void {
    const signal = this.errorEvents.signal
    window.addEventListener('error', e => this.fail(messageOf(e.error ?? e.message)), { signal })
    window.addEventListener('unhandledrejection', e => this.fail(messageOf(e.reason)), { signal })
  }

  // The load lands on the start screen, the game's root (there is no title menu); ?course= and ?community= skip it:
  // the load lands in the hub, which starts the round.
  start(): void {
    let next: 'start' | 'hub' = 'start'
    try {
      const parsed = parseQuery(this.search)
      if ((parsed.course !== null || parsed.community !== null) && !this.env.fieldGameplay) next = 'hub'
    } catch {
      // The load parses again and shows the refusal.
    }
    this.run(this.nav.dispatch({ kind: 'load', next }))
    this.stopLoop = this.env.loop(dt => {
      try {
        this.frame(dt)
        this.fps.frame(performance.now())
      } catch (e) {
        console.error(e)
        this.fail(messageOf(e))
      }
    }, () => frameInterval(this.graphics.options.frameRate))
  }

  // Live scene/GPU inventory: what the page is showing and holding right now, read by the UI checks.
  inventory(): {
    local: unknown
    mode: string | null
    screen: Screen
    hub: { alive: boolean; assets: string[]; instances: number }
    ports: { inventory: ReturnType<NonNullable<RenderPort['inventory']>> | null; inDom: boolean; displayed: boolean }[]
    startView: boolean
    sound: ReturnType<SoundDriver['inventory']>
    listeners: number
    camera: { yaw: number; pitch: number; rendered: CameraPose | null }
    settingsScene: SettingsSceneFrame | null
    field?: { graphics: Readonly<Record<string, unknown>>; normals: ShadingReport; bounds: PartWorldBounds[] }
  } {
    const loaded = this.loaded
    const local = this.mode instanceof LocalMode ? this.mode : this.preparedLocal
    const alive = local !== null && local.hubAlive
    const hub = loaded === null ? { assets: [], instances: 0 } : hubInventory(loaded.content)
    const ports = (loaded?.ports ?? []).map((port, i) => {
      const canvas = loaded!.canvases[i]
      return {
        inventory: port.inventory?.() ?? null,
        inDom: canvas?.isConnected === true,
        displayed: canvas !== undefined && canvas.style.display !== 'none',
      }
    })
    return {
      local: this.mode instanceof LocalMode ? this.mode.inspectSeats(this.env.fieldGameplay) : this.mode instanceof ShowAdapter ? this.mode.inspectSeats() : null,
      mode: this.mode === null ? null : this.mode.constructor.name,
      screen: this.nav.screen,
      hub: { alive, assets: alive ? hub.assets : [], instances: alive ? hub.instances : 0 },
      ...(this.env.fieldGameplay && this.query?.test && loaded ? { field: { graphics: this.graphics.options,
        normals: (loaded.ports[0] as ResizablePort).shadingReport(), get bounds() { return (loaded.ports[0] as ResizablePort).worldBounds() } } } : {}),
      ports,
      startView: this.startView !== null,
      sound: this.sound.inventory(),
      listeners: this.lobbyListeners,
      camera: { yaw: this.orbit.yaw, pitch: this.orbit.pitch, rendered: this.mode instanceof ShowAdapter ? this.mode.show.camera : null },
      settingsScene: this.settingsScene?.frame ?? null,
    }
  }

  async inspectEconomy() {
    return { offline: this.economy.stub !== null, me: await this.economy.port.me(), catalog: await this.economy.port.catalog(),
      bins: this.startModel?.bins, shop: this.economyScreens.shop }
  }

  fail(message: string): void {
    if (this.disposed) return
    // Whatever the error screen shows is also logged: a run that ends on it names its cause in the log.
    console.error(`[error-screen] ${message}`)
    this.lobbySoundOff = false
    this.roundLoading = null
    this.loadingOverlay.hide()
    this.run(this.nav.dispatch({ kind: 'error', message }))
    // A refusal must be readable, never hidden behind the Wavedash shell's loading screen.
    boot.done()
    wavedashReady()
  }

  // A uaa button or back press. One that comes from a screen nav has already left (two inputs in one
  // batch) is dropped, as is any while a key is being rebound.
  command(c: UaaCommand): void {
    if (this.disposed || this.rebinding !== null || c.screen !== this.nav.screen) return
    if (c.cmd.k === 'back') this.back()
    else this.activate(c.cmd)
  }

  // Nav returns from every settings page to the screen that opened it.
  private back(): void {
    // A failed ?community= / ?course= load has no start screen behind it and Retry loads the same level again, so
    // Back did nothing: it leaves that level for the page without it (the start screen).
    if (this.nav.screen === 'error' && this.loaded === null) {
      const next = new URLSearchParams(this.search)
      if (next.has('community') || next.has('course')) {
        for (const key of ['community', 'chash', 'course']) next.delete(key)
        location.search = next.toString()
        return
      }
    }
    this.run(this.nav.dispatch({ kind: 'back' }))
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
    this.errorEvents.abort()
    this.loadingOverlay.hide(true)
    this.stopRoundLoad?.()
    this.stopRoundLoad = null
    this.stopLoop?.()
    this.stopLoop = null
    this.fps.dispose()
    this.stopMode()
    this.economyScreens.close()
    this.economy.close()
    this.startView?.unmount()
    this.startView = null
    this.startModel = null
    this.startArt = null
    this.preparedLocal?.dispose()
    this.preparedLocal = null
    void this.showAhead?.then(show => show?.dispose())
    this.showAhead = null
    this.viewsObserver.disconnect()
    this.cells = []
    this.closeRemap()
    this.remapButton.removeEventListener('click', this.onOpenRemap)
    this.remapRoot.removeEventListener('rf-remap-close', this.onRemapClose)
    this.remapButton.hidden = true
    this.community?.dispose()
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
    const screen = this.nav.screen
    if (this.economyScreen !== null && this.economyScreen !== screen) {
      const from = this.economyScreen
      this.economyScreens.close()
      this.economyScreen = null
      if (screen === 'start' && (from === 'shop' || from === 'inbox')) void this.refreshStart()
    }
    for (const fx of effects) {
      if (fx === Effect.load) void this.load()
      else if (fx === Effect.openShop || fx === Effect.openInbox || fx === Effect.openCommission) {
        const screen = fx === Effect.openShop ? 'shop' : fx === Effect.openInbox ? 'inbox' : 'commission'
        this.economyScreen = screen
        void this.economyScreens.open(screen)
      }
      else if (fx === Effect.startHub) this.startMode()
      else if (fx === Effect.startOnline) this.startOnline()
      else if (fx === Effect.enqueue) this.mode?.enqueue()
      else if (fx === Effect.dequeue) this.mode?.dequeue()
      else if (fx === Effect.pickJoin) this.mode?.pick?.('join')
      else if (fx === Effect.pickSpectate) this.mode?.pick?.('spectate')
      else if (fx === Effect.pickNew) this.mode?.pick?.('new')
      else if (fx === Effect.pickDefault) this.mode?.pick?.('default')
      else if (fx === Effect.leaveMatch) {
        if (this.mode instanceof ShowAdapter || this.mode === null) this.startMode()
        else if (this.mode instanceof OnlineMode) { this.mode.leaveMatch(); this.startOnline() }
        else this.mode?.leaveMatch()
      }
      else if (fx === Effect.leaveGame) this.stopMode()
      // pause and resume: frame() reads the paused state from nav.screen.
    }
    // Back from inbox or commission returns to shop without a nav effect.
    if ((ECONOMY_SCREENS as readonly Screen[]).includes(screen) && this.economyScreen !== screen) {
      this.economyScreen = screen as EconomyScreen
      void this.economyScreens.open(this.economyScreen)
    }
  }

  private async load(): Promise<void> {
    // The 'loading' screen's bar and label; a refusal goes to the error screen.
    const loading = mountLoading(null, { progress: (fraction, label) => this.host.setLoading(fraction, label) })
    this.host.setLoading(0, 'Starting...')
    try {
      await this.env.beforeLoad?.()
      let q = parseQuery(this.search)
      if (q.community !== null) {
        // Hash verified before any byte is used; the pack's files then overlay the content for this page.
        const base = communityBase(this.search)
        if (base === null) throw new Error('community levels need ?levels=<levels URL> or a build with VITE_RF_LEVELS_URL')
        this.loadingOverlay.show('Downloading the community level')
        const pack = await loadCommunityPack(base, q.community, q.chash ?? undefined)
        installContentOverlay(pack.files)
        q = { ...q, course: pack.manifest.courseId }
      }
      this.query = q
      const content = pickContent(new URLSearchParams(this.search))
      boot.enter('physics (Rapier wasm)')
      const R = await checkAwait('Rapier initialization', () => initRapier())
      boot.enter('content')
      let phase = ''
      await checkAwait('boot content', () => content.load('sprint', progress => {
        if (this.disposed) return
        if (progress.phase !== phase) boot.enter(`content: ${phase = progress.phase}`)
        this.loadingOverlay.show(progress.label, progress.done, progress.total)
        loading.update(progress)
        this.run(this.nav.dispatch({ kind: 'progress', progress }))
      }))
      if (this.env.fieldGameplay && content instanceof SdfContent && content.meshData().failed.size) throw new Error(`fieldShading: failed assets: ${[...content.meshData().failed.keys()].join(', ')}`)
      // ?course=<hub> opens the hub itself: the hub is the lobby, not a round (courseSetup refuses hubs).
      const picked = q.course === null ? null : content.course(q.course)
      const course = picked !== null && picked.kind === 'hub' ? null : picked
      this.loadingOverlay.show('Creating renderer')
      boot.enter('renderer')
      const { ports, canvases } = await checkAwait('boot render ports', () => this.mountPorts(content, q))
      if (this.disposed) {
        // An op took the page during the load: its ports are not ours to keep.
        for (const port of ports) port.dispose()
        this.views.replaceChildren()
        return
      }
      this.stopRoundLoad?.()
      this.stopRoundLoad = observeRoundLoad(label => {
        checkPhase(`round load: ${label ?? 'ready'}`)
        // Show preparation is background work; its director owns the visible load hold. The show prepared behind
        // the start screen loads silently too.
        if (this.mode instanceof ShowAdapter || this.showAhead !== null) return
        this.roundLoading = label
        if (label !== null) {
          this.loadingOverlay.show(label)
          this.host.setLoading(0, label)
        } else this.loadingOverlay.hide()
      }, content.report())
      // The online show plays the in-page show's season maps and zone sidecars.
      const show = q.server !== null || this.nav.onlineOnly ? await checkAwait('online show content', () => loadShowContent('sprint')) : null
      this.loaded = { R, content, ports, canvases, course, show }
      if (ports[0] !== undefined) ports[0] = trackLobbyAssets(ports[0], this.lobbyAssets)
      if (ports[0] !== undefined) {
        this.settingsScene = new SettingsScene()
        ports[0] = this.settingsScene.wrap(ports[0], content.character().id, () => {
          if (this.nav.screen !== 'settings') return null
          // The shown card: Graphics has one per row count (settingsCardId); hidden widgets have no rect.
          const panel = SETTINGS_CARD_IDS.map(id => this.host.widgetRect(id)).find(rect => rect !== null) ?? null
          return panel === null ? null : { panel, width: this.screens.clientWidth, height: this.screens.clientHeight }
        })
      }
      this.resizeViews()
      if (q.server === null && q.clients === 1) {
        boot.enter('first frame (pipelines, capture)')
        this.preparedLocal = new LocalMode({ look: () => this.wornLook(), loaded: this.loaded, q, orbit: this.orbit, touch: this.touchOn, setLayout: seats => this.setLayout(seats) })
        await checkAwait('local scene pipelines and capture', () => this.preparedLocal!.ready())
      }
      try {
        await checkAwait('start menu content', () => this.prepareStart(this.loaded!))
      } catch (e) {
        console.warn('[start] view unavailable:', messageOf(e))
      }
      // Lands on the start screen (nav's root), or in the hub for ?course= / ?community=.
      this.run(this.nav.dispatch({ kind: 'loaded' }))
      if (this.roundLoading === null) this.loadingOverlay.hide()
      boot.done()
    } catch (e) {
      console.error(e)
      this.fail(messageOf(e))
    }
  }

  // One canvas and port per client; content.createPort already inits the port on its canvas. Local play
  // (no relay, one client) instead mounts one canvas split into seats by S26's splitLayout.
  private createPort(content: GameContent, target: Parameters<GameContent['createPort']>[0]) {
    if (!this.env.fieldGameplay || !this.query?.test || !(content instanceof SdfContent)) return content.createPort(target)
    return content.createPort(target, { ...gameRenderOptions(this.search, { shading: this.graphics.options.shading as ShadingMode }), atlasBytes: this.env.atlasBytes })
  }

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
        ports.push(await this.createPort(content, { canvas, width: cell.canvasWidth, height: cell.canvasHeight, viewports: [cell.viewport] }))
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
      const port = await this.createPort(content, { canvas, width: backing.width, height: backing.height, viewports })
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
    this.cells = splitLayout(seats, seats === 3 && this.query?.players === null)
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

  // Builds the flow-web start screen from the loaded content: the penguin on its own layer of the stage
  // port, its cosmetic mounts and the hub environment, with the wardrobe read from the settings store.
  private async prepareStart(loaded: Loaded): Promise<void> {
    if (loaded.ports[0] === undefined) return
    await this.refreshStart()
  }

  private async refreshStart(): Promise<void> {
    const loaded = this.loaded
    if (loaded === null) return
    let owned: readonly string[] = []
    let badge = 0
    let cosmetics: readonly { id: string; slot: string }[] = LOCAL_COSMETICS
    const source = economyOwned(this.economy.port)
    try {
      const [items, unread, catalog] = await Promise.all([
        source.owned(), source.unread(), this.economy.port.catalog(),
      ])
      owned = items
      badge = unread
      // The special bin is a catalog slot too: its three items dress the penguin like any other piece.
      cosmetics = [...new Map([...LOCAL_COSMETICS, ...catalog.items].map(item => [item.id, item])).values()]
    } catch (e) {
      console.warn('[start] wardrobe unavailable:', messageOf(e))
    }
    if (this.disposed || this.loaded !== loaded) return
    this.startCosmetics = cosmetics
    const saved = readWardrobe(this.env.store, this.query?.colour ?? 0)
    // Older saves did not distinguish an untouched bin from an explicit None choice.
    // Dress the offline starter once; future saves retain explicit empty slots.
    if (this.economy.stub !== null && saved.version !== 2) {
      for (const slot of ['head', 'body', 'bottom', 'special']) {
        if (!owned.includes(saved.worn[slot])) {
          const first = cosmetics.find(item => item.slot === slot && owned.includes(item.id))
          if (first) saved.worn[slot] = first.id
        }
      }
    }
    this.startModel = startScreen(owned, cosmetics, badge, saved)
    if (this.economy.stub !== null && saved.version !== 2) this.saveWardrobe(this.startModel)
    // The mounts follow this catalog: rebuild the art once the wardrobe is known and remount its view so a
    // cosmetic bought since the last visit draws its worn instance.
    const port = loaded.ports[0]
    if (port !== undefined) {
      try {
        const art = await this.buildStartArt(loaded.content, port)
        if (this.disposed || this.loaded !== loaded) return
        this.startArt = art
        this.startView?.unmount()
        this.startView = null
      } catch (e) {
        console.warn('[start] art unavailable:', messageOf(e))
      }
    }
    this.startView?.update(this.startModel, null)
  }

  // StartArt: the character, every catalog and local cosmetic mounted on the body anchors (mountedBounds'
  // rule), the hub's S13 environment, and a SceneLayer over the stage port so hiding the screen restores it.
  private async buildStartArt(content: GameContent, stage: RenderPort): Promise<StartArt> {
    const layer = new SceneLayer(stage)
    const character = content.character()
    const resolver = browserGameAssets()
    let body: GameAsset | null = null
    try {
      body = (await resolver.resolve(character.id)).asset
    } catch (e) {
      console.warn('[start] character anchors unavailable:', messageOf(e))
    }
    const mounts = new Map<string, Vec3T>()
    const bounds = new Map<string, { min: Vec3T; max: Vec3T }>()
    for (const item of this.startCosmetics) {
      try {
        const costume = (await resolver.resolve(cosmeticOf(item.id)?.asset ?? item.id)).asset
        // The start carousels draw the cosmetic itself in 3D, centred and fitted with its asset bounds.
        const { min, max } = costume.bounds
        bounds.set(item.id, { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] })
        if (body === null) continue
        if (stage.skinOf?.(costume.id)) { mounts.set(item.id, [0, 0, 0]); continue }
        const names = Object.keys(costume.anchors)
        if (names.length !== 1) continue
        const bodyAnchor = body.anchors[names[0]]
        const costumeAnchor = costume.anchors[names[0]]
        if (bodyAnchor === undefined || costumeAnchor === undefined) continue
        mounts.set(item.id, [
          bodyAnchor.t.x - costumeAnchor.t.x,
          bodyAnchor.t.y - costumeAnchor.t.y,
          bodyAnchor.t.z - costumeAnchor.t.z,
        ])
      } catch {
        // A costume the asset store does not carry is skipped by the renderer's mount lookup.
      }
    }
    return {
      port: layer.port,
      wallet: await this.economy.port.me().then(({ coins, tickets }) => ({ coins, tickets })).catch(() => undefined),
      character,
      skinned: skinnedCharacterOf(content),
      costume: (id: string): PrimsAsset | null => {
        try {
          return content.assets(cosmeticOf(id)?.asset ?? id)
        } catch {
          return null
        }
      },
      mounts,
      bounds,
      scene: content.startScene?.(JSON.parse(startSeasonJson).id),
      dressing: content.dressing(),
      environment: hubEnvironment(content),
    }
  }

  private startMode(): void {
    const loaded = this.loaded
    const q = this.query
    if (loaded === null || q === null) return this.fail(refusal('game', 'start', 'the content is not loaded; retry the load'))
    this.stopMode()
    const c: ModeCtx = { look: () => this.wornLook(), loaded, q, orbit: this.orbit, touch: this.touchOn, setLayout: seats => this.setLayout(seats), views: this.views }
    try {
      const pending = this.pendingRelay
      this.pendingRelay = null
      if (q.server !== null) this.mode = new OnlineMode(c, q.server)
      else if (pending !== null) this.mode = new OnlineMode(c, pending)
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

  // Play goes online by itself when ?server= is given. Otherwise a build default relay (VITE_RF_SERVER,
  // platform/relay.ts) makes the start screen's Play the online lobby (Nav.onlineOnly sends startOnline).
  // With neither, Play plays in-page with bots and never comes here; a startOnline without a relay says so.
  private startOnline(): void {
    let relay: string | null
    try {
      relay = onlineRelay(this.query?.server ?? null, defaultRelay())
    } catch (e) {
      return this.fail(messageOf(e))
    }
    if (relay === null) {
      return this.fail(refusal('query', 'server', 'online play needs a relay; pass ?server=wss://host/... or rebuild with VITE_RF_SERVER=wss://host/ws'))
    }
    this.pendingRelay = this.query?.server === null ? relay : null
    this.run(this.nav.enterHub())
  }

  // The build default relay armed by the online Play, consumed by the next startMode.
  private pendingRelay: string | null = null

  private wornLook(): WornLook | null {
    return playerLook(this.startModel, this.startArt)
  }

  // The options of the show Play starts (startShow, and the one preloaded behind the start screen).
  private showOptions(loaded: Loaded, q: Query, look: WornLook | null): ShowModeOptions {
    return {
      R: loaded.R, views: this.views, orbit: this.orbit, look,
      humans: q.players ?? 1, fixedSeats: q.players !== null,
      seats: Math.max(q.players ?? 1, q.bots ?? intParam(new URLSearchParams(this.search), 'seats', this.env.showSeats ?? DEFAULT_SHOW_SEATS, 2, 60)),
      openingCourse: q.course ?? undefined,
      seed: Date.now(), localName: q.name,
      voteMs: q.test ? TEST_VOTE_MS : undefined,
      intermissionMs: q.test ? TEST_INTERMISSION_MS : undefined,
    }
  }

  // The show Play will start, created behind the start screen with its first (unvoted) round loading on its own
  // canvas and port, so Play starts without the course load. One job at a time: it starts once the start screen
  // compiles nothing, and its warm-up draw goes one asset at a time (ShowModeOptions.background).
  private showAhead: Promise<ShowMode | null> | null = null

  private preloadShow(): void {
    const loaded = this.loaded
    const q = this.query
    if (this.showAhead !== null || this.disposed || loaded === null || q === null || this.startView === null) return
    // Only when Play starts the in-page show (LocalMode.startsShow, no build default relay); UI checks (?test=1)
    // step the start screen without it.
    if (q.server !== null || q.clients !== 1 || (q.course !== null && q.bots === null) || this.nav.onlineOnly || q.test) return
    if (pendingPipelines() > 0) return
    this.showAhead = ShowMode.create({ ...this.showOptions(loaded, q, this.wornLook()), background: true }).then(show => {
      if (!this.disposed && show.failure === null && show.preload()) return show
      show.dispose()
      return null
    }, (e: unknown) => {
      console.warn('[show] preload failed:', messageOf(e))
      return null
    })
  }

  private async startShow(): Promise<void> {
    const loaded = this.loaded
    const q = this.query
    if (loaded === null || q === null) return
    const look = this.wornLook()
    const ahead = this.showAhead
    this.showAhead = null
    this.stopMode()
    // The show owns its own canvas and port: release the lobby (start view, hub, its assets and sound)
    // before it registers the first round's assets on its port.
    this.releaseLobby()
    const load = this.showLoad
    this.roundLoading = 'Preparing show'
    this.loadingOverlay.show(this.roundLoading)
    this.host.setLoading(0, this.roundLoading)
    this.setLayout(1)
    try {
      let show = ahead === null ? null : await ahead
      if (show !== null && (show.failure !== null || !show.fits(this.views))) {
        show.dispose()
        show = null
      }
      show = show?.adopt(look) ?? await ShowMode.create(this.showOptions(loaded, q, look))
      if (this.disposed || load !== this.showLoad) { show.dispose(); return }
      if (show.failure !== null) { this.fail(show.failure); return }
      this.roundLoading = null
      this.loadingOverlay.hide()
      this.mode = new ShowAdapter(show, q.name, this.economy, q.test)
      this.run(this.nav.dispatch({ kind: 'game', screen: 'vote' }))
      this.hudRound = -2
    } catch (e) {
      if (!this.disposed && load === this.showLoad) this.fail(messageOf(e))
    }
  }

  private unmountShowView(): void {
    this.showView?.unmount()
    this.showView = null
  }

  // Unmount the start view and free every asset the lobby registered, stop its sound and let the show
  // start from a clean stage port. The start view and hub rebuild on return (draw / startMode).
  private releaseLobby(): void {
    this.startView?.unmount()
    this.startView = null
    this.preparedLocal?.dispose()
    this.preparedLocal = null
    const port = this.loaded?.ports[0]
    try {
      if (port?.releaseAsset !== undefined) for (const handle of this.lobbyAssets) port.releaseAsset(handle)
    } catch (e) {
      console.warn('[lobby] asset release failed:', messageOf(e))
    }
    this.lobbyAssets.clear()
    this.sound.dispose()
    this.lobbySoundOff = true
  }

  private stopMode(): void {
    this.showLoad++
    this.unmountShowView()
    this.roundLoading = null
    this.loadingOverlay.hide()
    this.lobbySoundOff = false
    // A mode stopping returns to a fresh start menu: focus the first bin, as on the first entry.
    if (this.startModel !== null) this.startModel = { ...this.startModel, focus: 'bins', bin: 0 }
    if (this.mode instanceof LocalMode && !this.disposed && this.nav.screen === 'start') {
      this.preparedLocal?.dispose()
      this.preparedLocal = this.mode
    } else this.mode?.dispose()
    this.mode = null
    this.orbit.reset(0)
    this.input.look.release()
  }

  private frame(dt: number): void {
    const nav = this.nav
    this.uiNowMs += this.env.fieldGameplay ? 1000 : Math.max(0, dt) * 1000
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
    // The wardrobe owns the shared stage while open. Keep the prepared lobby
    // alive without advancing or drawing it behind the character preview.
    const wardrobe = nav.screen === 'start' || (nav.screen === 'settings' && nav.settingsFrom === 'start')
    this.preparedLocal?.setVisible(!wardrobe)
    if (mode instanceof LocalMode) mode.setVisible(!wardrobe)
    if (mode !== null && nav.live && nav.screen !== 'start') {
      const paused = nav.screen === 'pause' || nav.screen === 'settings'
      const screen = mode.frame({
        dt, paused, world: this.world, emote: playing ? this.emote : 0, devices: this.devicePolls, deviceCount,
      })
      if (mode.failure !== null) return this.fail(mode.failure)
      this.roundGate.frame(screen, mode.roundStage())
      this.run(nav.dispatch({ kind: 'game', screen }))
      if (mode instanceof LocalMode && mode.showRequested) void this.startShow()
      if (mode instanceof ShowAdapter || mode instanceof OnlineMode) {
        for (const cue of mode.show.cues()) this.sound.cue(cue)
        if (mode.finished && nav.screen === 'endScreen') this.run(nav.dispatch({ kind: 'action', action: 'confirm' }))
      } else if (mode.finished) {
        // A podium-less single race passes through the podium screen too, to reach toHub.
        this.run(nav.dispatch({ kind: 'game', screen: 'podium' }))
        if (nav.screen === 'podium') this.run(nav.dispatch({ kind: 'action', action: 'toHub' }))
      }
    }
    this.emote = 0
    // The show has no MatchSim; skip SoundDriver.frame so it cannot restart the lobby music it stopped.
    if (!this.lobbySoundOff) this.sound.frame(this.mode?.sim() ?? null, this.mode?.listener?.() ?? undefined)
    this.draw()
  }

  // Persists the wardrobe after a wear or colour change.
  private saveWardrobe(model: StartScreenModel): void {
    const worn: Record<string, string> = {}
    for (const bin of model.bins) if (bin.worn >= 0) worn[bin.slot] = bin.items[bin.worn]
    try {
      this.env.store.setItem(WARDROBE_KEY, JSON.stringify({ version: 2, colour: model.colour, worn }))
    } catch (e) {
      console.warn('[start] wardrobe not saved:', messageOf(e))
    }
  }

  // One start-screen flow action: startStep names the new model and effect, and the renderer gets both.
  private startAction(action: Action, base?: StartScreenModel): void {
    const model = base ?? this.startModel
    if (model === null) {
      if (action === 'play' || action === 'shop') this.run(this.nav.dispatch({ kind: 'action', action }))
      return
    }
    const step = startStep(model, action)
    this.startModel = step.model
    this.startView?.update(step.model, { action, effect: step.effect })
    if (step.effect === 'wear') this.saveWardrobe(step.model)
    else if (step.effect === 'play') this.run(this.nav.dispatch({ kind: 'action', action: 'play' }))
    else if (step.effect === 'shop') this.run(this.nav.dispatch({ kind: 'action', action: 'shop' }))
  }

  // A uaa start-screen button: focus it, then confirm it, so its step and cue are the same as a key's.
  private startButton(action: 'play' | 'shop'): void {
    const model = this.startModel
    if (model === null) {
      this.run(this.nav.dispatch({ kind: 'action', action }))
      return
    }
    this.startAction('confirm', model.focus === action ? model : { ...model, focus: action })
  }

  private showLoading(models: ShowFrame): void {
    this.roundLoading = models.loading ? 'Loading round…' : null
    if (models.loading && this.host.currentScreen() === 'loading') this.loadingOverlay.show(this.roundLoading!)
    else this.loadingOverlay.hide(true)
  }

  // Mount once per visible flow screen. Director cues are authoritative; only the crown reveals
  // originate in a renderer. The round/spectate screens keep the existing HUD drawing path.
  private drawShow(): boolean {
    const mode = this.mode
    const loaded = this.loaded
    if (!(mode instanceof ShowAdapter || mode instanceof OnlineMode) || loaded === null) return false
    const screen = this.nav.screen
    const models = mode.show.models
    if (models === null || models.screen !== screen) return false
    this.showLoading(models)
    const stage = loaded.ports[0]
    const deps = {
      cue: (id: string): void => { if (id.startsWith('flow.crown-')) this.sound.cue(id) },
      look: this.wornLook(), stage, character: loaded.content.character(), names: mode.name, localSeat: mode instanceof OnlineMode ? mode.localSeat : 0, parent: this.screens,
    }
    // The director calls this screen countdown during its load hold. Do not mount the countdown
    // renderer or draw the legacy sim countdown until worldReady has released that hold.
    if (models.loading) {
      this.host.present(menuModel('loading', [], { settings: this.settings, rebinding: null, error: null, info: [] }))
      this.host.setLoading(0, 'Loading round…')
      this.screens.style.pointerEvents = 'none'
      return true
    }
    if (this.showView === null) {
      if (screen === 'vote' && models.vote !== null) {
        const view = mountVote(this.host, models.vote, deps)
        this.showView = { screen, update: () => view.update(mode.show.models!.vote!, null), unmount: () => view.unmount() }
      } else if (screen === 'countdown' && models.countdown !== null) {
        const view = mountCountdown(this.host, models.countdown, deps)
        this.showView = { screen, update: () => view.update(mode.show.models!.countdown!), unmount: () => view.unmount() }
      } else if (screen === 'elimShow' && models.elimShow !== null) {
        // elimShowAt mutates its input's lastMs/grid. The director has already stepped its copy;
        // sharing it would consume every drop before the renderer can start its throw animation.
        const source = models.elimShow
        const model: ElimShowModel = {
          ...source, lastMs: 0,
          grid: source.grid.map(cell => ({ ...cell, state: cell.state === 'gone' ? 'gone' : 'stay' })),
          counter: { ...source.counter }, schedule: source.schedule.map(entry => ({ ...entry })),
        }
        const view = mountElimShow(this.host, model, deps)
        this.showView = { screen, update: () => view.update(model, mode.elapsedMs), unmount: () => view.unmount() }
      } else if (screen === 'endScreen' && models.endScreen !== null) {
        const view = mountEndScreen(this.host, models.endScreen, deps)
        this.showView = { screen, update: () => view.update(mode.show.models!.endScreen!, mode.elapsedMs), unmount: () => view.unmount() }
      } else if (screen === 'podium' && models.endScreen !== null) {
        const podium = new PodiumStage({
          look: place => models.endScreen!.podium[place]?.seat === deps.localSeat ? deps.look : null, port: stage, viewport: 0, bean: deps.character, block: loaded.content.assets('wall-block'), layout: loaded.content.podium(),
        })
        // Palette indices draw the podium; the look hook above uses the actual room seat.
        podium.show(models.endScreen.podium.map(p => p.seat % PALETTE.length))
        let lastMs = mode.elapsedMs
        this.showView = {
          screen,
          update: () => {
            podium.update((mode.elapsedMs - lastMs) / 1000)
            lastMs = mode.elapsedMs
            this.host.present(menuModel('podium', this.nav.actions(), {
              settings: this.settings, rebinding: null, error: null, info: mode.lines(),
            }))
          },
          unmount: () => podium.dispose(),
        }
      }
    }
    if (this.showView === null) return false
    this.showView.update()
    this.screens.style.pointerEvents = screen === 'endScreen' || screen === 'result' || screen === 'podium' || screen === 'vote' ? 'auto' : 'none'
    if (screen === 'result' || screen === 'elimShow' || screen === 'podium' || screen === 'endScreen') {
      loaded.canvases[0].style.display = ''
      stage.render()
    }
    return true
  }

  // Presents nav's screen through the uaa host, with the round HUD on the HUD screens, then renders it.
  private draw(): void {
    const nav = this.nav
    this.settingsPage = pageAfterScreen(this.drawnScreen, nav.screen, this.settingsPage)
    this.drawnScreen = nav.screen
    if (this.showView?.screen !== nav.screen) this.unmountShowView()
    // The remap belongs to the settings screen; #touch takes the pointer only where the game does.
    if (this.remap !== null && nav.screen !== 'settings') this.closeRemap()
    this.touchRoot.hidden = this.touch === null || !(nav.live && PLAYING.includes(nav.screen))
    this.remapButton.hidden = !(nav.screen === 'settings' && this.remap === null)
    this.community?.setVisible(nav.screen === 'start')
    // The start screen draws its own penguin layer and presents its own menu; nav still owns leaving it.
    if (nav.screen === 'start') {
      if (this.startView === null && this.startArt !== null && this.startModel !== null) {
        this.startView = mountStartScreen(this.host, this.startModel, {
          cue: id => this.sound.cue(id), stage: this.loaded?.ports[0], character: this.startArt.character, localSeat: 0,
          // canvas#ui follows #screens; the carousels place their 3D cosmetics under its cells.
          viewSize: () => ({ width: this.screens.clientWidth, height: this.screens.clientHeight }),
        }, this.startArt)
      }
      if (this.startView !== null && this.startModel !== null) {
        this.touchRoot.hidden = true
        this.remapButton.hidden = true
        this.screens.style.pointerEvents = 'auto'
        this.startView.setVisible(true)
        this.startView.update(this.startModel, null)
        this.resize()
        // The mode rendered its camera before draw() updated the wardrobe scene.
        // Submit the start camera and newly worn instances before presenting the UI.
        this.loaded?.ports[0]?.render()
        this.host.frame(this.uiNowMs)
        this.preloadShow()
        return
      }
    }
    // Settings opened from the start screen keeps the wardrobe scene (penguin, worn cosmetics, decor) behind
    // its compact panel: no carousels and no start widgets, just the backdrop.
    const startBackdrop = nav.screen === 'settings' && nav.settingsFrom === 'start' && this.startView !== null
    if (startBackdrop) this.startView!.setBackdrop(true)
    else this.startView?.setVisible(false)
    if ((ECONOMY_SCREENS as readonly Screen[]).includes(nav.screen)) {
      this.screens.style.pointerEvents = 'auto'
      this.economyScreens.draw(nav.screen as EconomyScreen)
      this.resize()
      this.host.frame(this.uiNowMs)
      return
    }
    if (this.drawShow()) {
      this.resize()
      this.host.frame(this.uiNowMs)
      if ((this.mode instanceof ShowAdapter || this.mode instanceof OnlineMode) && this.mode.show.models !== null) this.showLoading(this.mode.show.models)
      return
    }
    const mode = this.mode
    const hud = mode === null || !HUD_SCREENS.includes(nav.screen) ? null : mode.hud()
    const values = hud === null ? null : hudValues(hud.view, hud.names, hud.seat, this.roundTicks(hud.view))
    if (hud === null) this.hudRound = -2
    let info = mode !== null && (nav.screen === 'hub' || !PLAYING.includes(nav.screen)) ? mode.lines() : []
    // The spectate banner has no HUD pills: its lines carry the round and the qualified count.
    if (nav.screen === 'spectate' && values !== null) info = [values.kind, values.qualified ?? '']
    const error = nav.screen === 'settings' ? this.settingsError : nav.error
    const page = this.settingsPage
    const reducedMotion = nav.screen === 'settings' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const items = nav.screen !== 'settings' ? [] : page === 'graphics' ? this.graphics.items()
      : pageItems(page, this.settings, { rebinding: this.rebinding, reducedMotion })
    const model = menuModel(this.roundLoading === null ? nav.screen : 'loading', this.roundLoading === null ? nav.actions() : [], {
      settings: this.settings, rebinding: this.rebinding, error, info,
      page, items, reducedMotion, note: page === 'graphics' ? this.graphics.notes() : undefined,
    })
    // Overlays leave the pointer to the views (pointer lock on the game canvas); menus take clicks.
    this.screens.style.pointerEvents = model.overlay ? 'none' : 'auto'
    this.resize()
    this.host.present({ ...model, lines: fitLines(model.lines, lineSlots(model.screen)) })
    if (model.screen === 'settings') this.host.setHud(settingsWidgetProps(page, items, this.host.focused(), nav.settingsFrom))
    if (hud !== null && values !== null) this.host.setHud(hudWidgets(values, hud.view))
    // Submit the wardrobe scene's last camera and instances before the panel, so the backdrop is current.
    if (nav.screen === 'settings') this.loaded?.ports[0]?.render()
    this.host.frame(this.uiNowMs)
  }

  private roundTicks(v: MatchViewState): number {
    if (v.roundIndex !== this.hudRound) {
      this.hudRound = v.roundIndex
      this.hudRoundTicks = 0
    }
    this.hudRoundTicks = Math.max(this.hudRoundTicks, v.roundTicksLeft)
    return this.hudRoundTicks
  }

  // canvas#ui follows #screens (the whole page) and the device pixel ratio; the views follow #views here too,
  // since a frame that runs no rendering steps (the GPU client's off-screen frame) never delivers ResizeObserver.
  private resize(): void {
    this.resizeViews()
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
    if ((ECONOMY_SCREENS as readonly Screen[]).includes(this.nav.screen)) {
      const screen = this.nav.screen as EconomyScreen
      if (ev.k === 'back') {
        if (screen === 'shop' && this.economyScreens.cancelShop()) return
        this.run(this.nav.dispatch({ kind: 'back' }))
      } else {
        const action = flowAction(ev)
        if (action !== null) {
          void this.economyScreens.action(screen, action).then(open => {
            if (!this.disposed && this.nav.screen === screen && (open === 'inbox' || open === 'commission')) {
              this.run(this.nav.dispatch({ kind: 'action', action: open }))
            }
          })
        } else if (ev.k === 'click') {
          if (screen === 'shop' && this.economyScreens.pickShop(ev.x, ev.y)) return
          host.input({ kind: 'pointer', phase: 'move', x: ev.x, y: ev.y })
          host.input({ kind: 'pointer', phase: 'down', x: ev.x, y: ev.y })
          host.input({ kind: 'pointer', phase: 'up', x: ev.x, y: ev.y })
        }
      }
      return
    }
    // Flow screens take keys and pad events as nav actions (flowAction), not as uaa focus. Start runs
    // startStep; vote and elimShow's models are driven by the show flow. Without a start model the start
    // menu falls back to the standard uaa focus path.
    if (this.nav.screen === 'start' && this.startModel !== null) {
      if (ev.k === 'back') {
        this.run(this.nav.dispatch({ kind: 'back' }))
        return
      }
      const action = flowAction(ev)
      if (action !== null) {
        this.startAction(action)
        return
      }
      if (ev.k === 'click') {
        const dpr = globalThis.devicePixelRatio || 1
        const hit = (id: string) => {
          const r = host.widgetRect(id)
          return r && ev.x / dpr >= r.x && ev.x / dpr <= r.x + r.w && ev.y / dpr >= r.y && ev.y / dpr <= r.y + r.h
        }
        for (let row = 0; row < this.startModel.bins.length; row++) {
          const bin = this.startModel.bins[row]
          for (const [name, action] of [['prev', 'left'], ['next', 'right']] as const) {
            if (hit(`carousel-${name}-${row}`)) { this.startAction(action, { ...this.startModel, focus: 'bins', bin: row }); return }
          }
          // The cell shows what is worn (the arrows wear it): clicking it only focuses its bin.
          if (hit(carouselCell(row))) {
            this.startModel = { ...this.startModel, focus: 'bins', bin: row }
            this.startView?.update(this.startModel, null)
            return
          }
        }
        for (let i = 0; i < 8; i++) if (hit(`palette-${i}`)) {
          this.startAction('confirm', { ...this.startModel, focus: 'palette', colour: i }); return
        }
        host.input({ kind: 'pointer', phase: 'move', x: ev.x, y: ev.y })
        host.input({ kind: 'pointer', phase: 'down', x: ev.x, y: ev.y })
        host.input({ kind: 'pointer', phase: 'up', x: ev.x, y: ev.y })
      }
      return
    }
    // Pausing and resuming are the game's, not the menu's: the uaa host drops input while a screen
    // transition plays (on the real clock), which would swallow an Escape pressed as the result screen
    // pops in, or as the pause menu fades in.
    if (ev.k === 'back' && this.nav.live && backTogglesPause(this.nav.screen)) {
      this.run(this.nav.dispatch({ kind: 'back' }))
      return
    }
    if ((this.mode instanceof ShowAdapter || this.mode instanceof OnlineMode) && (this.nav.screen === 'result' || this.nav.screen === 'endScreen')) {
      const action = flowAction(ev)
      if (action === 'confirm') {
        this.mode.action(action)
        return
      }
    }
    // The vote cards take the pointer: hovering focuses, clicking votes the card under it.
    if (this.nav.screen === 'vote' && ev.k === 'click' && (this.mode instanceof ShowAdapter || this.mode instanceof OnlineMode)) {
      const index = this.voteIndexAt(ev.x, ev.y)
      if (index !== null) {
        this.mode.pickVote(index)
        return
      }
    }
    if (this.nav.screen !== 'start' && (FLOW_SCREENS as readonly Screen[]).includes(this.nav.screen)) {
      if (ev.k === 'back') this.run(this.nav.dispatch({ kind: 'back' }))
      else {
        const action = flowAction(ev)
        if (action !== null) {
          if (this.mode instanceof ShowAdapter || this.mode instanceof OnlineMode) this.mode.action(action)
          else this.run(this.nav.dispatch({ kind: 'action', action }))
        }
      }
      return
    }
    if (ev.k === 'back') host.input({ kind: 'back' })
    else if (ev.k === 'emote') this.emote = ev.id
    else if (ev.k === 'focus') host.input({ kind: 'nav', dir: ev.dir < 0 ? 'up' : 'down' })
    else if (ev.k === 'adjust') {
      if (this.nav.screen === 'settings' && this.remap === null) {
        const focused = host.focused()
        const rowIndex = focused?.match(/^row-(\d+)$/) ?? null
        if (rowIndex !== null) {
          const index = Number(rowIndex[1])
          if (this.settingsPage === 'graphics') this.graphics.adjust(index, ev.dir)
          else {
            const row = PAGE_ROWS[this.settingsPage][index]
            if (row !== undefined && (row.kind === 'volume' || row.kind === 'bus'
              || row.kind === 'mouseSensitivity' || row.kind === 'stickSensitivity' || row.kind === 'invertY')) {
              this.apply(adjust(this.settings, row, ev.dir))
            }
          }
          return
        }
        host.input({ kind: 'nav', dir: ev.dir < 0 ? 'left' : 'right' })
        const nextFocus = host.focused()
        const page = SETTINGS_PAGES.find(p => nextFocus === `tab-${p}`)
        if (page !== undefined) this.settingsPage = page
      } else host.input({ kind: 'nav', dir: ev.dir < 0 ? 'left' : 'right' })
    } else if (ev.k === 'select') {
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
    if (this.nav.screen === 'vote' && (this.mode instanceof ShowAdapter || this.mode instanceof OnlineMode)) {
      const index = this.voteIndexAt(p.x, p.y)
      if (index !== null) this.mode.hoverVote(index)
    }
  }

  // The vote card under a pointer position (GameInput's overlay backing px): the candidate index, or null.
  private voteIndexAt(x: number, y: number): number | null {
    if (!(this.mode instanceof ShowAdapter || this.mode instanceof OnlineMode)) return null
    const model = this.mode.show.models?.vote
    if (model == null) return null
    const dpr = window.devicePixelRatio || 1
    const px = x / dpr
    const py = y / dpr
    const count = Math.min(3, model.candidates.length)
    for (let slot = 0; slot < 3; slot++) {
      const rect = this.host.widgetRect(`vote-card-${slot}`)
      if (rect === null || px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue
      if (count === 1) return slot === 1 ? 0 : null
      return slot < count ? slot : null
    }
    return null
  }

  private activate(cmd: MenuCmd): void {
    if (cmd.k === 'action' && this.nav.screen === 'start' && (cmd.action === 'play' || cmd.action === 'shop')) {
      this.startButton(cmd.action)
      return
    }
    if (cmd.k === 'action' && cmd.action === 'confirm' && (this.mode instanceof ShowAdapter || this.mode instanceof OnlineMode)
      && (this.nav.screen === 'result' || this.nav.screen === 'endScreen')) {
      this.mode.action('confirm')
      return
    }
    if (cmd.k === 'action') this.run(this.nav.dispatch({ kind: 'action', action: cmd.action }))
    else if (cmd.k === 'back') this.back()
    else if (cmd.k === 'tab') this.settingsPage = cmd.page
    else if (cmd.k === 'row' && this.nav.screen === 'settings') {
      if (this.settingsPage === 'graphics') {
        this.graphics.activate(cmd.row)
        return
      }
      const row = PAGE_ROWS[this.settingsPage][cmd.row]
      if (row === undefined) return
      if (row.kind === 'key') this.pendingRebind = row.action
      else if (row.kind === 'remap') this.openRemap()
      else if (row.kind === 'reducedMotion') return
      else if (row.kind === 'reset' && row.scope === 'all') {
        this.apply(adjust(this.settings, row, 1))
        this.graphics.reset()
      } else this.apply(cycle(this.settings, row))
    }
  }

  // The Graphics shading row applies to the SDF content already on screen, without reloading it; `?normals=vertex`
  // still wins for the session. Before the first load the provider reads the same options for its new port.
  private applyShading(value: unknown): void {
    const content = this.loaded?.content
    const chosen: ShadingMode | null = value === 'field' || value === 'vertex' || value === 'baked' ? value : null
    if (!(content instanceof SdfContent) || chosen === null) return
    const { shading } = gameRenderOptions(this.search, { shading: chosen })
    if (shading === this.liveShading) return
    this.liveShading = shading
    content.setShading(shading)
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
  canvas: HTMLCanvasElement, env: AppEnv, taken: () => boolean, onScreen?: (e: UaaScreenChange) => void, searchOverride?: string,
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
  const search = new URLSearchParams(searchOverride ?? window.location.search)
  if (searchOverride === undefined && (window as Window & { __nmcCheckTest?: boolean }).__nmcCheckTest) search.set('test', '1')
  const booted = new App(views, screens, host, `?${search}`, env)
  created = booted
  booted.start()
  return { app: booted, host }
}

// The uiTour op's App: the page's App on a new canvas#ui (the torn-down App emptied #screens), its settings
// in memory (the GPU page's opaque origin has no storage) and its frames stepped by the op instead of rAF.
// With refuseFirstLoad (the tours only) its boot load is refused before it starts, so the tour reaches 'loading'
// with a real click on the error screen's Retry (docs/screens.md: page load or Retry after a failed load); that
// retry is the real load. The check ops boot without it, straight to start.
async function startForOp(onScreen: (e: UaaScreenChange) => void, options: BootOptions & { fieldGameplay?: boolean; atlasBytes?: number } = {}): Promise<TourGame> {
  if (options.fieldGameplay || options.atlasBytes !== undefined) validateGameplay({ search: options.search, sequence: ['start'], atlasBytes: options.atlasBytes })
  const { views, screens } = pageRoots()
  const ui = document.createElement('canvas')
  ui.id = 'ui'
  screens.replaceChildren(ui)
  const saved = new Map<string, string>(Object.entries(options.saved ?? {}))
  let frame: ((dtS: number) => void) | null = null
  let loads = 0
  const env: AppEnv = {
    store: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => void saved.set(key, value) },
    padStorage: null,
    showSeats: 8,
    starterInventory: options.starterInventory, fieldGameplay: options.fieldGameplay, atlasBytes: options.atlasBytes,
    loop: f => {
      frame = f
      return () => { frame = null }
    },
    beforeLoad: async () => {
      if (options.refuseFirstLoad === true && loads++ === 0) throw new Error('uiTour: the boot load is refused so the tour reaches loading with Retry')
    },
  }
  const booted = await start(ui, env, () => false, onScreen, options.search ?? (options.plain ? '' : undefined))
  if (booted === null) throw new Error('uiTour: the App did not start')
  return { host: booted.host, ui, views, step: dt => frame?.(dt), inventory: () => booted.app.inventory(),
    inspect: () => booted.app.inspectEconomy(), dispose: () => booted.app.dispose() }
}

// Nothing mounted: write the message into the page rather than only the console, and let the Wavedash shell show it.
function bootFailed(e: unknown): void {
  console.error(e)
  document.body.textContent = `Royal Fiesta could not start: ${bootMessage(e)}`
  document.body.style.cssText = 'color: #fff; font: bold 18px system-ui, sans-serif; padding: 32px'
  boot.done()
  wavedashReady()
}

// A stage that has taken more than 10 s is named under the page's loading bar, so a stuck boot says where it is.
function showStall(stage: string, seconds: number): void {
  const aside = document.querySelector<HTMLElement>('#round-loading')
  if (aside === null) return
  let line = aside.querySelector<HTMLElement>('[data-stall]')
  if (line === null) {
    line = document.createElement('small')
    line.dataset.stall = ''
    line.style.cssText = 'font: 14px system-ui, sans-serif; opacity: 0.75'
    aside.append(line)
  }
  line.textContent = `Still on: ${stage} (${seconds} s)`
}

// Site storage can be refused in a third-party frame (blocked third-party storage throws on access): settings
// then live in memory for this visit instead of failing the boot.
function pageStorage(): Storage | null {
  try {
    const s = window.localStorage
    s.getItem('royal-fiesta')
    return s
  } catch (e) {
    console.warn('[boot] localStorage refused; settings are kept for this visit only:', e)
    return null
  }
}

function memoryStore(): SettingsStore {
  const saved = new Map<string, string>()
  return { getItem: key => saved.get(key) ?? null, setItem: (key, value) => void saved.set(key, value) }
}

// Started by the page's own boot only (an ops page has no boot to watch).
let bootStages: BootStages | null = null
const boot = { enter: (stage: string) => bootStages?.enter(stage), done: () => bootStages?.done() }

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
    const storage = pageStorage()
    bootStages = new BootStages(showStall)
    boot.enter('ui host (fonts, images, WebGPU)')
    // R3: game.html's own loading screen (#round-loading) is up from the first byte, so the Wavedash shell shows the
    // frame now: the player sees the game's title, stage and bar instead of the shell's "Still Loading 0%".
    wavedashReady()
    start(canvas, { store: storage ?? memoryStore(), padStorage: storage, loop }, () => opTookPage).then(s => { app = s?.app ?? null }, bootFailed)
  }
} catch (e) {
  bootFailed(e)
}
// The frame probe, off by default (docs/wavedash.md, "Frame probe").
if (!opsMode && probeWanted(window.location.search)) {
  runProbe().catch(e => console.error('[probe] failed:', e))
}
