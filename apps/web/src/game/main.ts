// game.html entry, the player page (ARCHITECTURE 1.3): screens -> loading -> hub -> match -> podium -> hub.
// The hub and its matches run in-page with bots, or on the relay when ?server= is given; ?clients=2..4 runs
// that many piloted clients over a LoopbackRelay. Content comes from pickContent, input only from GameInput.
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { basisFromFacing } from '@royal-fiesta/game/client/cameraBasis'
import type { Planar } from '@royal-fiesta/game/client/cameraBasis'
import { controlsToInput, emptyControls } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import type { GameContent } from '@royal-fiesta/game/content'
import { PlayFlow } from '@royal-fiesta/game/hub/flow'
import { HubWorld } from '@royal-fiesta/game/hub/hubWorld'
import { QueuePad } from '@royal-fiesta/game/hub/queuePad'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import { netSetup } from '@royal-fiesta/game/net/tuning'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { PodiumStage } from '@royal-fiesta/game/render/podiumStage'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import { menuModel, moveFocus } from '@royal-fiesta/game/screens/menuModel'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import { Effect, Nav } from '@royal-fiesta/game/screens/nav'
import type { GameScreen, Screen } from '@royal-fiesta/game/screens/nav'
import { SETTINGS_ROWS, adjust, loadSettings, rebind, saveSettings } from '@royal-fiesta/game/screens/settings'
import type { KeyAction, Settings } from '@royal-fiesta/game/screens/settings'
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
import { mountHud } from '../client/hud.ts'
import { mountLoading } from '../content/loading.ts'
import { pickContent } from '../content/source.ts'
import { GameInput } from '../input/input.ts'
import type { UiEvent } from '../input/input.ts'
import { HubView } from '../play/hubView.ts'
import { InPageHubLoop } from '../play/inpageHub.ts'
import { SoundDriver } from '../play/sound.ts'
import { installGameOps } from './ops.ts'

interface Query {
  course: string | null
  server: string | null
  hub: string | 'new'
  name: string
  colour: number
  party: 2 | 3 | 4
  clients: number
}

type Hud = ReturnType<typeof mountHud>
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
  if (course !== null && server !== null) refuse('query', 'course', 'plays in-page with bots; drop ?server= or ?course=')
  if (clients > 1 && server !== null) refuse('query', 'clients', `${clients} in-page clients use a LoopbackRelay; drop ?server= or ?clients=`)
  if (clients > 1 && course !== null) refuse('query', 'clients', `?course= plays one client with bots; drop ?clients= or ?course=`)
  return { course, server, hub, name, colour, party, clients }
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

function loop(frame: (dtS: number) => void): void {
  let last = performance.now()
  const tick = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, now - last) / 1000)
    last = now
    frame(dt)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
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

const FONT = 'font-family: "Baloo 2", "Fredoka", "Arial Rounded MT Bold", system-ui, sans-serif; color: #fff;'

function el(tag: string, css: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag)
  e.style.cssText = css
  parent.appendChild(e)
  return e
}

// The DOM menu: draws a MenuModel with one focused button. It reads no events itself: the app feeds it
// GameInput's UI events, and a click is mapped back to a button by hit-testing the page.
class MenuView {
  focus = 0
  private readonly root: HTMLElement
  private readonly panel: HTMLElement
  private readonly info: HTMLElement
  private readonly hint: HTMLElement
  private buttons: HTMLElement[] = []
  private shown = ''

  constructor(root: HTMLElement) {
    this.root = root
    this.panel = el('div', 'position: absolute; left: 50%; transform: translateX(-50%); display: none; z-index: 20;' +
      ' flex-direction: column; align-items: center; gap: 12px; padding: 28px 40px; border-radius: 24px; box-sizing: border-box;' +
      ' max-width: 92vw; max-height: 92vh; overflow: auto; background: rgba(27, 15, 46, 0.9); pointer-events: auto;' + FONT, root)
    this.info = el('div', 'position: absolute; top: 16px; left: 16px; z-index: 15; font-size: 20px; font-weight: 700;' +
      ' white-space: pre-line; text-shadow: 0 2px 0 #2a1240;' + FONT, root)
    this.hint = el('div', 'position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 15;' +
      ' font-size: 16px; opacity: 0.85; white-space: nowrap; text-shadow: 0 2px 0 #2a1240;' + FONT, root)
  }

  get count(): number {
    return this.buttons.length
  }

  // low: the panel sits at the bottom so the view behind it (podium, round, a loading refusal) stays visible.
  render(model: MenuModel, low: boolean, linesOn: boolean): void {
    this.focus = model.buttons.length === 0 ? -1 : Math.min(Math.max(0, this.focus), model.buttons.length - 1)
    const key = JSON.stringify([model, low, linesOn, this.focus])
    if (key === this.shown) return
    this.shown = key
    this.hint.textContent = model.hint
    if (model.overlay) {
      this.panel.style.display = 'none'
      this.info.textContent = model.lines.join('\n')
      this.buttons = []
      return
    }
    this.info.textContent = ''
    const p = this.panel
    p.replaceChildren()
    p.style.display = 'flex'
    p.style.top = low ? '' : '50%'
    p.style.bottom = low ? '48px' : ''
    p.style.transform = low ? 'translateX(-50%)' : 'translate(-50%, -50%)'
    p.dataset.screen = model.screen
    el('div', 'font-size: 44px; font-weight: 900; color: #ff6b9e;', p).textContent = model.title
    if (linesOn) for (const line of model.lines) el('div', 'font-size: 20px; text-align: center; overflow-wrap: anywhere;', p).textContent = line
    this.buttons = model.buttons.map((b, i) => {
      const e = el('div', 'min-width: 320px; padding: 10px 24px; border-radius: 18px; text-align: center; cursor: pointer;' +
        ` font-size: 24px; font-weight: 800; border: 3px solid #2a1240; background: ${i === this.focus ? '#ff4f8b' : '#8a4dff'};`, p)
      e.dataset.button = String(i)
      e.textContent = b.label
      return e
    })
  }

  // GameInput click coordinates are overlay backing pixels; -1 when no button is under them.
  buttonAt(x: number, y: number): number {
    const r = this.root.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const hit = document.elementFromPoint(r.left + x / dpr, r.top + y / dpr)
    const button = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-button]') : null
    if (button === null || !this.panel.contains(button)) return -1
    return Number(button.dataset.button)
  }

  move(dir: number): void {
    this.focus = moveFocus(this.focus, dir, this.buttons.length)
  }
}

// What the app hands a running mode each page frame. world is the camera-relative move (controlsToInput
// with the orbit camera's ground facing); a paused mode keeps drawing but does not step.
interface FrameIn { dt: number; paused: boolean; world: PlayerInput; emote: number }
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
}

interface ModeCtx { loaded: Loaded; q: Query; orbit: OrbitCamera }

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

interface LocalMatch { sim: MatchSim; inputs: PlayerInput[]; acc: number; singleRace: boolean; order: number[] }

// The in-page game: the local hub (HubWorld + queue pad), then a match against bots on a plain MatchSim
// (no peers, so no rollback), its podium, and the hub again. The player is always player 0.
class LocalMode implements Mode {
  failure: string | null = null
  private readonly c: ModeCtx
  private readonly presenter: MatchPresenter
  private readonly hubView: HubView
  private hub: HubWorld
  private pad = new QueuePad()
  private hubAcc = 0
  private match: LocalMatch | null = null
  private readonly names: string[]
  private readonly local = emptyChar()
  private readonly cv = emptyCharView()

  constructor(c: ModeCtx) {
    this.c = c
    const { R, content, ports } = c.loaded
    this.names = playerNames(0, c.q.name)
    this.hub = new HubWorld(R, content.hub(), 0)
    this.hubView = new HubView(ports[0], 0, name => content.assets(name), content.character(), content.hub(), {
      orbit: c.orbit, character: content.character(), dressing: content.dressing(),
    })
    this.presenter = new MatchPresenter(c)
    // ?course= goes straight into its round.
    if (c.loaded.course !== null) this.enqueue()
  }

  get finished(): boolean {
    const m = this.match
    if (m === null) return false
    if (this.presenter.onPodium) return this.presenter.podiumS >= PODIUM_HOLD_S
    return m.sim.done || (this.over(m) && m.order.length === 0)
  }

  sim(): MatchSim | null {
    return this.match?.sim ?? null
  }

  enqueue(): void {
    if (this.match !== null) return
    const { R, content, course } = this.c.loaded
    const seed = Date.now() >>> 0
    const setup = course !== null ? courseSetup(seed, course, content.playlist()) : netSetup(seed, 1, 'sprint', content.playlist())
    const sim = new MatchSim(R, setup)
    const inputs = Array.from({ length: setup.playerCount }, () => neutralInput())
    this.match = { sim, inputs, acc: 0, singleRace: course !== null && course.kind === 'race', order: [] }
    // Hide the hub before the match view's first update (its dressing leaves before the course's enters).
    this.hubView.setVisible(false)
    this.presenter.begin(0)
  }

  dequeue(): void {}

  leaveMatch(): void {
    const m = this.match
    if (m === null) return
    this.presenter.end()
    m.sim.free()
    this.match = null
    // Back at the spawn, off the queue pad, as PlayFlow does after a match.
    this.hub.free()
    this.hub = new HubWorld(this.c.loaded.R, this.c.loaded.content.hub(), 0)
    this.pad = new QueuePad()
    this.hubAcc = 0
    this.c.orbit.reset(0)
    this.hubView.setVisible(true)
  }

  frame(f: FrameIn): GameScreen {
    const screen = this.match === null ? this.frameHub(f) : this.frameMatch(this.match, f)
    this.c.loaded.ports[0].render()
    return screen
  }

  hud(): HudState | null {
    return this.match === null ? null : { view: this.presenter.view, names: this.names, seat: 0 }
  }

  lines(): string[] {
    const m = this.match
    if (m === null) {
      const course = this.c.loaded.course
      const what = course === null ? 'a match against bots' : course.name
      return [`${this.c.q.name} - local hub`, `Walk onto the green pad or press Enter to play ${what}`]
    }
    if (this.presenter.places !== null) return podiumLines(this.presenter.places, this.names)
    const v = this.presenter.view
    if (m.singleRace && v.phase >= Phase.roundEnd && m.order.length === 0) return ['Nobody qualified']
    return [`Round ${v.roundIndex + 1}: ${v.qualifiedCount} qualified, ${v.alive} still running`]
  }

  dispose(): void {
    this.presenter.dispose()
    this.match?.sim.free()
    this.match = null
    this.hubView.dispose()
    this.hub.free()
  }

  private frameHub(f: FrameIn): GameScreen {
    const now = performance.now()
    if (f.emote !== 0) this.hub.setEmote(f.emote, now)
    if (!f.paused) {
      this.hubAcc = Math.min(this.hubAcc + f.dt, 8 * STEP_S)
      while (this.hubAcc >= STEP_S) {
        this.hubAcc -= STEP_S
        this.hub.step(f.world)
        if (this.pad.update(this.hub.onQueuePad()) === 'armed') {
          this.enqueue()
          return this.frameMatch(this.match!, f)
        }
      }
    }
    this.hubView.update(this.hub.state(this.local), this.c.q.colour, [], this.hub.tick, f.dt, this.hub.emote(now))
    return 'hub'
  }

  // A single ?course= race ends with its round; every other match runs to its own podium.
  private over(m: LocalMatch): boolean {
    return m.sim.done || (m.singleRace && this.presenter.view.phase >= Phase.roundEnd)
  }

  private frameMatch(m: LocalMatch, f: FrameIn): GameScreen {
    const sim = m.sim
    const view = sim.phase(this.presenter.view)
    if (!f.paused && !this.over(m)) {
      m.acc = Math.min(m.acc + f.dt, 8 * STEP_S)
      while (m.acc >= STEP_S && !this.over(m)) {
        m.acc -= STEP_S
        Object.assign(m.inputs[0], f.world)
        sim.step(m.inputs)
        sim.phase(view)
        if (m.singleRace) this.noteQualified(m)
      }
    }
    let podium: readonly number[] | null = null
    if (m.singleRace) podium = this.over(m) ? m.order : null
    else if (view.phase >= Phase.podium) podium = view.podium
    this.presenter.draw(sim, null, this.over(m) ? 1 : m.acc / STEP_S, f.dt, podium)
    return matchScreen(view, sim.character(0, this.cv).status, this.presenter.onPodium)
  }

  // The single race's podium is its qualification order.
  private noteQualified(m: LocalMatch): void {
    for (let p = 0; p < m.inputs.length; p++) {
      if (!m.order.includes(p) && m.sim.character(p, this.cv).status === PlayerStatus.qualified) m.order.push(p)
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
    this.c.loaded.ports[0].render()
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
    }, ports, { assets: name => content.assets(name), bean: content.character(), character: content.character(), dressing: content.dressing() })
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
// Menus drawn low so the view behind them stays visible.
const LOW: readonly Screen[] = ['queue', 'result', 'podium']

// A refusal string for a check the page makes itself (refuse throws, so catch its message).
function refusal(area: string, where: string, what: string): string {
  try {
    return refuse(area, where, what)
  } catch (e) {
    return messageOf(e)
  }
}

// The page: Nav drives every screen; its effects start and stop modes and the load.
class App {
  readonly nav = new Nav()
  private settings: Settings
  private settingsError: string | null
  private rebinding: KeyAction | null = null
  private pendingRebind: KeyAction | null = null
  private model: MenuModel | null = null
  private mode: Mode | null = null
  private loaded: Loaded | null = null
  private query: Query | null = null
  private loading: ReturnType<typeof mountLoading> | null = null
  private loadingShown = ''
  private emote = 0
  private readonly views: HTMLElement
  private readonly hudRoot: HTMLElement
  private readonly screens: HTMLElement
  private readonly search: string
  private readonly menu: MenuView
  private readonly hud: Hud
  private readonly input: GameInput
  private readonly sound = new SoundDriver()
  private readonly orbit = new OrbitCamera()
  private readonly world = neutralInput()

  constructor(views: HTMLElement, hudRoot: HTMLElement, screens: HTMLElement, search: string) {
    this.views = views
    this.hudRoot = hudRoot
    this.screens = screens
    this.search = search
    const saved = loadSettings(window.localStorage)
    this.settings = saved.settings
    this.settingsError = saved.error
    this.hud = mountHud(hudRoot)
    hudRoot.style.display = 'none'
    this.menu = new MenuView(screens)
    // Clicking the (single) game canvas locks the pointer for the mouse look.
    this.input = new GameInput(window, screens, () => (this.loaded?.canvases.length === 1 ? this.loaded.canvases[0] : null))
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
    loop(dt => {
      try {
        this.frame(dt)
      } catch (e) {
        console.error(e)
        this.fail(messageOf(e))
      }
    })
  }

  fail(message: string): void {
    this.run(this.nav.dispatch({ kind: 'error', message }))
  }

  private run(effects: readonly Effect[]): void {
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
    this.loading?.close()
    this.loading = mountLoading(this.screens)
    this.loadingShown = ''
    try {
      const q = parseQuery(this.search)
      this.query = q
      const content = pickContent(new URLSearchParams(this.search))
      const R = await initRapier()
      await content.load('sprint', progress => this.run(this.nav.dispatch({ kind: 'progress', progress })))
      const course = q.course === null ? null : content.course(q.course)
      const { ports, canvases } = await this.mountPorts(content, q.clients)
      this.loaded = { R, content, ports, canvases, course }
      this.run(this.nav.dispatch({ kind: 'loaded' }))
    } catch (e) {
      console.error(e)
      this.fail(messageOf(e))
    }
  }

  // One canvas and port per client; content.createPort already inits the port on its canvas.
  private async mountPorts(content: GameContent, clients: number): Promise<{ ports: RenderPort[]; canvases: HTMLCanvasElement[] }> {
    this.views.replaceChildren()
    const plan = planCanvases(Math.max(1, Math.floor(window.innerWidth)), Math.max(1, Math.floor(window.innerHeight)), clients)
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

  private startMode(): void {
    const loaded = this.loaded
    const q = this.query
    if (loaded === null || q === null) return this.fail(refusal('game', 'start', 'the content is not loaded; retry the load'))
    this.stopMode()
    const c: ModeCtx = { loaded, q, orbit: this.orbit }
    try {
      if (q.server !== null) this.mode = new OnlineMode(c, q.server)
      else if (q.clients > 1) this.mode = new InPageMode(c)
      else this.mode = new LocalMode(c)
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
    this.mode?.dispose()
    this.mode = null
    this.orbit.reset(0)
    this.input.look.release()
  }

  private frame(dt: number): void {
    const nav = this.nav
    for (const ev of this.input.takeEvents()) this.onEvent(ev)
    if (this.pendingRebind !== null) {
      // Armed after the batch, so the Enter that chose the row is not taken as the new key.
      this.rebinding = this.pendingRebind
      this.pendingRebind = null
      this.settingsError = null
    }
    if (nav.screen !== 'settings') this.rebinding = null
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
    if (playing) controlsToInput(controls, this.orbit.ground(), this.world)
    else Object.assign(this.world, neutralInput())
    const mode = this.mode
    if (mode !== null && nav.live) {
      const paused = nav.screen === 'pause' || nav.screen === 'settings'
      const screen = mode.frame({ dt, paused, world: this.world, emote: playing ? this.emote : 0 })
      if (mode.failure !== null) return this.fail(mode.failure)
      this.run(nav.dispatch({ kind: 'game', screen }))
      if (mode.finished) {
        // A podium-less single race passes through the podium screen too, to reach toHub.
        this.run(nav.dispatch({ kind: 'game', screen: 'podium' }))
        if (nav.screen === 'podium') this.run(nav.dispatch({ kind: 'action', action: 'toHub' }))
      }
    }
    this.emote = 0
    this.sound.frame(this.mode?.sim() ?? null)
    this.draw()
  }

  private draw(): void {
    const nav = this.nav
    const mode = this.mode
    const hud = mode === null || !HUD_SCREENS.includes(nav.screen) ? null : mode.hud()
    this.hudRoot.style.display = hud === null ? 'none' : ''
    if (hud !== null) this.hud.update(hud.view, hud.names, hud.seat)
    const info = mode !== null && (nav.screen === 'hub' || !PLAYING.includes(nav.screen)) ? mode.lines() : []
    const error = nav.screen === 'settings' ? this.settingsError : nav.error
    this.model = menuModel(nav.screen, nav.actions(), { settings: this.settings, rebinding: this.rebinding, error, info })
    const loadFailed = nav.screen === 'error' && nav.loadNext !== null
    this.menu.render(this.model, loadFailed || LOW.includes(nav.screen), !loadFailed)
    this.drawLoading(loadFailed)
  }

  // The loading view shows the load's progress, then its refusal until the player retries or leaves.
  private drawLoading(loadFailed: boolean): void {
    const nav = this.nav
    if (this.loading === null) return
    if (nav.screen !== 'loading' && !loadFailed) {
      this.loading.close()
      this.loading = null
      return
    }
    const key = JSON.stringify([nav.screen, nav.progress, nav.error])
    if (key === this.loadingShown) return
    this.loadingShown = key
    if (loadFailed) this.loading.fail(nav.error ?? 'the load failed')
    else if (nav.progress !== null) this.loading.update(nav.progress)
  }

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
    if (ev.k === 'back') this.run(this.nav.dispatch({ kind: 'back' }))
    else if (ev.k === 'emote') this.emote = ev.id
    else if (ev.k === 'focus') this.menu.move(ev.dir)
    else if (ev.k === 'adjust') this.adjustFocused(ev.dir)
    else if (ev.k === 'select') {
      // The hub has no buttons: Enter queues, as the hint says.
      if (this.nav.screen === 'hub') this.run(this.nav.dispatch({ kind: 'action', action: 'queue' }))
      else this.activate(this.menu.focus)
    } else if (ev.k === 'click') {
      const index = this.menu.buttonAt(ev.x, ev.y)
      if (index >= 0) {
        this.menu.focus = index
        this.activate(index)
      }
    }
  }

  private activate(index: number): void {
    const button = this.model?.buttons[index]
    if (button === undefined) return
    const cmd = button.cmd
    if (cmd.k === 'action') this.run(this.nav.dispatch({ kind: 'action', action: cmd.action }))
    else if (cmd.k === 'back') this.run(this.nav.dispatch({ kind: 'back' }))
    else {
      const row = SETTINGS_ROWS[cmd.row]
      if (row.kind === 'key') this.pendingRebind = row.action
      else this.apply(adjust(this.settings, row, 1))
    }
  }

  private adjustFocused(dir: number): void {
    const cmd = this.model?.buttons[this.menu.focus]?.cmd
    if (cmd === undefined || cmd.k !== 'row') return
    const row = SETTINGS_ROWS[cmd.row]
    if (row.kind !== 'key' && row.kind !== 'reset') this.apply(adjust(this.settings, row, dir))
  }

  private apply(next: Settings): void {
    this.settings = next
    this.settingsError = null
    try {
      saveSettings(window.localStorage, next)
    } catch (e) {
      this.settingsError = refusal('settings', 'localStorage', `not saved (${messageOf(e)}); allow site storage to keep settings`)
    }
  }
}

function start(): void {
  const views = document.querySelector<HTMLElement>('#views')
  const hudRoot = document.querySelector<HTMLElement>('#hud')
  const screens = document.querySelector<HTMLElement>('#screens')
  if (views === null || hudRoot === null || screens === null) throw new Error('game.html needs main#views, div#hud and div#screens')
  const app = new App(views, hudRoot, screens, window.location.search)
  window.addEventListener('error', e => app.fail(messageOf(e.error ?? e.message)))
  window.addEventListener('unhandledrejection', e => app.fail(messageOf(e.reason)))
  app.start()
}

// ?mode=ops only installs the GPU client ops (controlsProbe, gameCapture); the ops build their own views.
const opsMode = new URLSearchParams(window.location.search).get('mode') === 'ops'
try {
  if (opsMode) installGameOps()
  else start()
} catch (e) {
  // Nothing mounted: write the message into the page rather than only the console.
  document.body.textContent = `Royal Fiesta could not start: ${messageOf(e)}`
  document.body.style.cssText = 'color: #fff; font: bold 18px system-ui, sans-serif; padding: 32px'
}
