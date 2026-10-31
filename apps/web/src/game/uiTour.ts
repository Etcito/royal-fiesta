// GPU op uiTour (game.html): boots the real game App, as the page does, and walks the 'Reached by' column
// of docs/screens.md with real input only: KeyboardEvents on window, synthetic standard-pad button frames and
// pointer/mouse clicks on canvas#ui at the centre of host.widgetRect(id). It never calls nav or App methods; it
// only steps the App's frames (the GPU client's requestAnimationFrame is unreliable) and waits for the host's
// screen callback. Each screen is captured after two settled frames, as the RAA views and canvas#ui composited
// in the task that drew them.
import { refuse } from '@royal-fiesta/sim/refusal'
import type { AdapterInfo } from '../nmc/ops.ts'
import { raaStatus } from '../render/raaStatus.ts'
import type { UaaHost, UaaScreenChange } from '../ui/uaaHost.ts'
import uiDocText from '../../../../ui/screens.ui-doc.json?raw'

// The App the op drives: its uaa host and canvas#ui, the #views root, and its frame callback.
export interface TourGame {
  host: UaaHost
  ui: HTMLCanvasElement
  views: HTMLElement
  // One App frame: input, nav, the mode (dtS of game time) and the uaa frame at performance.now().
  step(dtS: number): void
  dispose(): void
}
export type BootGame = (onScreen: (e: UaaScreenChange) => void) => Promise<TourGame>
export interface TourDeps { boot: BootGame; adapter: () => Promise<AdapterInfo> }

type TourKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
// One real input as the player gives it, with the DOM events it dispatched in order and the screen it was
// given on. x and y: the click point in canvas#ui CSS px (host.widgetRect's space).
export type TourInput =
  | { kind: 'key'; key: TourKey; on: string; events: string[] }
  | { kind: 'click'; target: string; x: number; y: number; on: string; events: string[] }
export interface TourCapture { screen: string; file: string; inputs: TourInput[]; width: number; height: number; sha256: string; bytes: number }
export interface TourTransition { t: number; from: string | null; to: string }
export interface UiTourOutput {
  renderer: 'raa'; adapter: AdapterInfo; software: boolean; captures: TourCapture[]; transitions: TourTransition[]
}
interface OpFile { name: string; blob: Blob }

type Act = { key: TourKey } | { click: string } | { dom: string } | { waitMs: number } | { pad: number } | { padVote: number }
// A leg gives its inputs on the settled previous screen and waits for `until`, or the host to enter `to`.
// current: the host is already on `to`; give the leg's inputs there, settle and capture in place (the first
// vote, whose model mounts after ShowMode has built its matches, so the tour waits before voting).
interface Leg { acts: Act[]; to: string; capture: boolean; timeoutS: number; until?: 'remap-open' | 'remap-closed'; name?: string; current?: boolean }

// docs/screens.md 'Reached by': the boot load is refused (bootGame), so Retry on the error screen enters
// 'loading' with a real click; that load lands on the offline page's start screen (the app opens the wardrobe
// itself), so the tour goes back to title, walks the menus by their buttons (Escape goes back), and Play on
// title opens the start screen again. There four ArrowDowns reach its Play (3 bins, the palette, then Play) and
// Enter runs the hub, where Escape pauses it. Enter in the hub starts the offline show on its vote; the tour
// votes with a real ArrowRight and Enter, then follows the show: the world loads before the countdown, round 0
// is a race the idle player cannot qualify in, so it is spectated from round 1 on. The next vote is played with
// the pad (d-pad right, then A); the remaining votes expire to their first candidate and the show ends on its
// podium and end screen, whose Continue returns to the start menu. The offline queue, lobbyChoice, lobbyLive
// are not in this tour.
const TOUR: readonly Leg[] = [
  { acts: [], to: 'error', capture: false, timeoutS: 20 },
  { acts: [{ click: 'act-retry' }], to: 'loading', capture: true, timeoutS: 10 },
  // The successful load opens the offline page's wardrobe start by itself; Escape goes back to the title.
  { acts: [], to: 'start', capture: false, timeoutS: 120 },
  { acts: [{ key: 'Escape' }], to: 'title', capture: false, timeoutS: 10 },
  { acts: [{ click: 'act-settings' }], to: 'settings', capture: true, timeoutS: 10 },
  // Captured idle, as opened: Enter there would start listening and hide the focused row's button.
  { acts: [{ dom: '#open-remap' }], to: 'settings', until: 'remap-open', name: 'settings-controls', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'settings', until: 'remap-closed', capture: false, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'title', capture: true, timeoutS: 10 },
  { acts: [{ click: 'act-credits' }], to: 'credits', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'title', capture: false, timeoutS: 10 },
  { acts: [{ click: 'act-play-online' }], to: 'error', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'title', capture: false, timeoutS: 10 },
  // Title Play opens the start screen; four ArrowDowns move bins -> palette -> Play, Enter runs the hub.
  { acts: [{ click: 'act-play' }], to: 'start', capture: true, timeoutS: 30 },
  { acts: [{ key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'Enter' }], to: 'hub', capture: true, timeoutS: 30 },
  { acts: [{ key: 'Escape' }], to: 'pause', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'hub', capture: false, timeoutS: 10 },
  // Enter queues: the offline lobby's show starts on its vote, which ShowMode fills in a moment later.
  { acts: [{ key: 'Enter' }], to: 'vote', capture: false, timeoutS: 30 },
  { acts: [{ waitMs: 1200 }, { key: 'ArrowRight' }, { key: 'Enter' }], to: 'vote', current: true, capture: true, timeoutS: 10 },
  { acts: [], to: 'countdown', capture: true, timeoutS: 120 },
  { acts: [], to: 'round', capture: true, timeoutS: 120 },
  { acts: [], to: 'result', capture: true, timeoutS: 180 },
  { acts: [], to: 'elimShow', capture: true, timeoutS: 60 },
  // The next vote is voted with the real pad path (d-pad right, then A); the idle player is out after
  // round 0, so the following round is spectated.
  { acts: [], to: 'vote', capture: false, timeoutS: 120 },
  { acts: [{ padVote: 20000 }], to: 'spectate', capture: true, timeoutS: 180 },
  // The remaining votes expire to their first candidate; the show ends on its podium and end screen.
  { acts: [], to: 'podium', capture: true, timeoutS: 300 },
  { acts: [], to: 'endScreen', capture: true, timeoutS: 60 },
  // Continue waits for the winner reveal, then leaves the finished show for the start menu.
  { acts: [{ waitMs: 4500 }, { key: 'Enter' }], to: 'start', capture: false, timeoutS: 60 },
]

export const TOUR_SCREENS: readonly string[] = TOUR.filter(leg => leg.capture).map(leg => leg.name ?? leg.to)

// The M7 flow captures the GPU card renders: every new show screen, all of them tour captures.
export const FLOW_TOUR_SCREENS: readonly string[] = ['start', 'vote', 'countdown', 'round', 'result', 'elimShow', 'endScreen']

const FRAME_MS = 16
// Game time per frame: real time on short screens, 3 ticks while game time must run (a round plays, a vote or
// the elimination show counts down, the podium hands over). Each is short enough that a screen of the show
// outlasts the 150 ms exit anim of the one before it.
const DT = 1 / 60
const FAST_DT = 3 / 60
const FAST: readonly string[] = ['round', 'spectate', 'vote', 'elimShow', 'podium']
const SETTLED_FRAMES = 2

// The longest enter anim of each screen (screen.enter and every widget's anim.enter), in ms.
interface DocAnim { duration?: number }
interface DocWidget { anim?: { enter?: DocAnim }; children?: DocWidget[] }
interface DocScreen { id: string; enter?: DocAnim; widgets: DocWidget[] }

function longestEnter(ws: readonly DocWidget[]): number {
  let ms = 0
  for (const w of ws) ms = Math.max(ms, w.anim?.enter?.duration ?? 0, longestEnter(w.children ?? []))
  return ms
}

const SETTLE_MS: ReadonlyMap<string, number> = new Map(
  (JSON.parse(uiDocText) as { screens: DocScreen[] }).screens.map(s => [s.id, Math.max(s.enter?.duration ?? 0, longestEnter(s.widgets))]),
)

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function validate(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('ops', 'uiTour.input', 'is not an object; pass {}')
  const extra = Object.keys(raw)
  if (extra.length > 0) refuse('ops', 'uiTour.input', `has unknown fields ${extra.join(', ')}; the tour takes no options, pass {}`)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// A key press on window, as GameInput reads it (KeyboardEvent.code).
function press(g: TourGame, key: TourKey): TourInput {
  const on = g.host.currentScreen()
  const init: KeyboardEventInit = { code: key, key, bubbles: true, cancelable: true }
  window.dispatchEvent(new KeyboardEvent('keydown', init))
  window.dispatchEvent(new KeyboardEvent('keyup', init))
  return { kind: 'key', key, on, events: ['keydown', 'keyup'] }
}

// A left click at the centre of the widget's rect, on canvas#ui; the events bubble to #screens (GameInput).
function click(g: TourGame, target: string): TourInput {
  const r = g.host.widgetRect(target)
  if (r === null) refuse('ops', `uiTour.click.${target}`, `widget '${target}' is hidden or not on screen '${g.host.currentScreen()}'; fix the tour leg or the ui doc`)
  const x = r.x + r.w / 2
  const y = r.y + r.h / 2
  const box = g.ui.getBoundingClientRect()
  return clickAt(g, g.ui, target, x, y, box.left + x, box.top + y)
}

function domClick(g: TourGame, selector: string): TourInput {
  const element = document.querySelector(selector)
  if (element === null) refuse('ops', `uiTour.dom.${selector}`, 'the DOM target is missing')
  const box = element.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  return clickAt(g, element, selector, x, y, x, y)
}

function clickAt(g: TourGame, element: Element, target: string, x: number, y: number, clientX: number, clientY: number): TourInput {
  const on = g.host.currentScreen()
  const at = { clientX, clientY, bubbles: true, cancelable: true, view: window }
  const pointer: PointerEventInit = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  const events: string[] = []
  const fire = (e: MouseEvent): void => {
    events.push(e.type)
    element.dispatchEvent(e)
  }
  fire(new PointerEvent('pointermove', { ...pointer, buttons: 0 }))
  fire(new PointerEvent('pointerdown', { ...pointer, button: 0, buttons: 1 }))
  fire(new MouseEvent('mousedown', { ...at, button: 0, buttons: 1 }))
  fire(new PointerEvent('pointerup', { ...pointer, button: 0, buttons: 0 }))
  fire(new MouseEvent('mouseup', { ...at, button: 0, buttons: 0 }))
  fire(new MouseEvent('click', { ...at, button: 0, buttons: 0, detail: 1 }))
  return { kind: 'click', target, x, y, on, events }
}

// The RAA views under canvas#ui, at canvas#ui's backing size, over the page background, as a PNG. Called in
// the task that rendered them, so the WebGPU canvases still hold this frame: each is snapshotted once, right
// away, with createImageBitmap, and each copy into the 2D canvas is flushed at once by a 1 px getImageData.
// Measured in Chrome: a 2D canvas defers its drawImage copies to the toBlob flush, and deferred copies of the
// WebGPU canvases or of their snapshots encoded the menu screens as a bare background.
async function capturePng(g: TourGame): Promise<{ blob: Blob | null; width: number; height: number }> {
  const ui = g.ui
  // canvas#ui first: on the menus the RAA views are idle (never drawn), and a read of an idle view was seen
  // to spoil the next WebGPU read in the same task.
  const uiShot = createImageBitmap(ui)
  const views = Array.from(g.views.querySelectorAll('canvas'), view => ({ rect: view.getBoundingClientRect(), shot: createImageBitmap(view) }))
  const overlays = ['canvas.rf-remap', 'canvas.rf-touch'].flatMap(selector =>
    Array.from(document.querySelectorAll<HTMLCanvasElement>(selector), canvas => ({ rect: canvas.getBoundingClientRect(), shot: createImageBitmap(canvas) })))
  const out = document.createElement('canvas')
  out.width = ui.width
  out.height = ui.height
  const ctx = out.getContext('2d')
  if (ctx === null) refuse('ops', 'uiTour.capture', 'no 2D canvas context to composite the capture; run the op in a browser with canvas 2D')
  const box = ui.getBoundingClientRect()
  const sx = ui.width / Math.max(1, box.width)
  const sy = ui.height / Math.max(1, box.height)
  const flush = (): void => void ctx.getImageData(0, 0, 1, 1)
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor
  ctx.fillRect(0, 0, out.width, out.height)
  for (const { rect: r, shot } of views) {
    const bitmap = await shot
    ctx.drawImage(bitmap, (r.left - box.left) * sx, (r.top - box.top) * sy, r.width * sx, r.height * sy)
    flush()
    bitmap.close()
  }
  const bitmap = await uiShot
  ctx.drawImage(bitmap, 0, 0)
  flush()
  bitmap.close()
  for (const { rect: r, shot } of overlays) {
    const overlay = await shot
    ctx.drawImage(overlay, (r.left - box.left) * sx, (r.top - box.top) * sy, r.width * sx, r.height * sy)
    flush()
    overlay.close()
  }
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  return { blob, width: out.width, height: out.height }
}

function describe(acts: readonly Act[]): string {
  if (acts.length === 0) return 'no input'
  return acts.map(a => {
    if ('key' in a) return `key ${a.key}`
    if ('click' in a) return `a click on ${a.click}`
    if ('dom' in a) return `a click on ${a.dom}`
    if ('pad' in a) return `a pad button ${a.pad} frame`
    if ('padVote' in a) return 'a pad vote (d-pad right, then A)'
    return `a ${a.waitMs} ms wait`
  }).join(', ')
}

class Tour {
  readonly transitions: TourTransition[] = []
  readonly captures: TourCapture[] = []
  readonly files: OpFile[] = []
  // performance.now() and of each transition, by index.
  private readonly at: number[] = []
  private readonly t0 = performance.now()
  // The real inputs since the previous capture.
  private inputs: TourInput[] = []
  // The inputs that reached the previous capture. A screen the game moves to by itself (the match screens
  // after the Enter that started the round) was reached by them, so its capture records them again.
  private reachedBy: TourInput[] = []
  // The synthetic standard pad the page polls; the flow's next vote is given through it.
  private readonly pad: Gamepad

  constructor(pad: Gamepad) {
    this.pad = pad
  }

  onScreen(e: UaaScreenChange): void {
    const now = performance.now()
    this.at.push(now)
    this.transitions.push({ t: Math.round(now - this.t0) / 1000, from: e.from, to: e.to })
  }

  // Inputs on the settled screen, then frames until the host enters leg.to, then its settled frames.
  async leg(g: TourGame, leg: Leg): Promise<void> {
    const seen = this.transitions.length
    for (const act of leg.acts) await this.act(g, act)
    // A current leg gives its inputs on the screen it names, which is already up (the first vote: its model
    // mounts after ShowMode has built its matches).
    if (leg.current === true) {
      await this.finish(g, leg, performance.now())
      return
    }
    const deadline = performance.now() + leg.timeoutS * 1000
    let entered = -1
    while (entered < 0) {
      if (performance.now() > deadline) this.timeout(g, leg, seen)
      await sleep(FRAME_MS)
      this.step(g, FAST.includes(g.host.currentScreen()) ? FAST_DT : DT)
      if (leg.until !== undefined) {
        const open = document.querySelector('canvas.rf-remap') !== null
        if (open === (leg.until === 'remap-open')) entered = performance.now()
        continue
      }
      const index = this.transitions.findIndex((t, i) => i >= seen && t.to === leg.to)
      if (index >= 0) entered = this.at[index]
    }
    await this.finish(g, leg, entered)
  }

  // Game time stands still while the enter anims (uaa time is performance.now) play out.
  private async finish(g: TourGame, leg: Leg, entered: number): Promise<void> {
    const settleMs = SETTLE_MS.get(leg.to) ?? 0
    let settled = 0
    for (;;) {
      await sleep(FRAME_MS)
      const now = performance.now()
      this.step(g, 0)
      if (now - entered >= settleMs && ++settled === SETTLED_FRAMES) break
    }
    const hostScreen = g.host.currentScreen()
    const screen = leg.name ?? hostScreen
    if (hostScreen !== leg.to) refuse('ops', `uiTour.${leg.to}`, `the host left '${leg.to}' for '${hostScreen}' before it settled; inspect the transitions`)
    if (!leg.capture) return
    const shot = await capturePng(g)
    const blob = shot.blob
    if (blob === null) refuse('ops', `uiTour.${screen}`, 'canvas.toBlob returned null; the capture could not be encoded')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const file = `${screen}.png`
    this.files.push({ name: file, blob })
    const inputs = this.inputs.length > 0 ? this.inputs : this.reachedBy
    if (inputs.length === 0) refuse('ops', `uiTour.${screen}`, 'no real input reached this capture; give the leg or an earlier one its keys or clicks')
    this.captures.push({ screen, file, inputs, width: shot.width, height: shot.height, sha256: await sha256Hex(bytes), bytes: bytes.length })
    this.reachedBy = inputs
    this.inputs = []
  }

  private async act(g: TourGame, act: Act): Promise<void> {
    if ('waitMs' in act) return this.wait(g, act.waitMs)
    if ('padVote' in act) return this.padVote(g, act.padVote)
    if ('pad' in act) return this.padFrame(g, act.pad)
    this.inputs.push('key' in act ? press(g, act.key) : 'dom' in act ? domClick(g, act.dom) : click(g, act.click))
  }

  // Advance this much game time in real-time steps: the wait reaches a screen's own timer (the vote, the end
  // reveal) without fast-forwarding it.
  private async wait(g: TourGame, ms: number): Promise<void> {
    let left = ms
    while (left > 0) {
      await sleep(FRAME_MS)
      this.step(g, DT)
      left -= DT * 1000
    }
  }

  // One pad button pressed for exactly one frame, then released for one frame: the page polls pads per frame.
  private padFrame(g: TourGame, button: number): void {
    const b = this.pad.buttons[button] as { pressed: boolean; touched: boolean; value: number }
    b.pressed = true
    b.touched = true
    b.value = 1
    this.step(g, DT)
    b.pressed = false
    b.touched = false
    b.value = 0
    this.step(g, DT)
  }

  // The vote model mounts one intermission after its screen, so keep giving the pad vote (d-pad right, then A)
  // until the vote screen leaves, by the vote or by its timer.
  private async padVote(g: TourGame, timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs
    while (g.host.currentScreen() === 'vote' && performance.now() < deadline) {
      this.padFrame(g, 15)
      this.padFrame(g, 0)
      for (let i = 0; i < 6; i++) {
        await sleep(FRAME_MS)
        this.step(g, FAST_DT)
      }
    }
  }

  private step(g: TourGame, dtS: number): void {
    g.step(dtS)
  }

  private timeout(g: TourGame, leg: Leg, seen: number): never {
    const went = this.transitions.slice(seen).map(t => `${t.from ?? '-'} -> ${t.to}`).join(', ') || 'none'
    return refuse('ops', `uiTour.${leg.to}`,
      `the host did not enter '${leg.to}' within ${leg.timeoutS} s after ${describe(leg.acts)}; transitions since: ${went}; it is on '${g.host.currentScreen()}'`)
  }
}

export async function uiTour(raw: unknown, deps: TourDeps): Promise<{ json: UiTourOutput; files: OpFile[] }> {
  validate(raw)
  return runTour(deps)
}

export async function tourScreens(names: readonly string[], deps: TourDeps): Promise<{ json: UiTourOutput; files: OpFile[] }> {
  if (names.length === 0 || names.some(name => !TOUR_SCREENS.includes(name)) || new Set(names).size !== names.length) {
    refuse('ops', 'tourScreens.names', 'pass unique tour capture screen names')
  }
  return runTour(deps, names)
}

async function runTour(deps: TourDeps, names?: readonly string[]): Promise<{ json: UiTourOutput; files: OpFile[] }> {
  const status = await raaStatus()
  if (!status.available) refuse('render', 'raa', status.reason)
  const adapter = await deps.adapter()
  if (adapter.software) {
    refuse('gpu', 'adapter', `'${adapter.vendor} ${adapter.architecture} ${adapter.description}' is a software or fallback adapter; a capture on it is evidence of nothing, run the op in the GPU client`)
  }
  const pad = {
    id: 'Tour Pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: null,
  } as unknown as Gamepad
  const tour = new Tour(pad)
  const own = Object.getOwnPropertyDescriptor(navigator, 'getGamepads')
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] })
  let game: TourGame | undefined
  try {
    game = await deps.boot(e => tour.onScreen(e))
    const last = names === undefined ? TOUR.length - 1 : Math.max(...names.map(name => TOUR.findIndex(leg => leg.capture && (leg.name ?? leg.to) === name)))
    for (const leg of TOUR.slice(0, last + 1)) {
      await tour.leg(game, { ...leg, capture: leg.capture && (names === undefined || names.includes(leg.name ?? leg.to)) })
    }
  } finally {
    try { game?.dispose() } finally {
      if (own) Object.defineProperty(navigator, 'getGamepads', own)
      else Reflect.deleteProperty(navigator, 'getGamepads')
    }
  }
  return {
    json: { renderer: 'raa', adapter, software: adapter.software, captures: tour.captures, transitions: tour.transitions },
    files: tour.files,
  }
}
