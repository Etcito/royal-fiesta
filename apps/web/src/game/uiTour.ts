// GPU op uiTour (game.html): boots the real game App, as the page does, and walks the 'Reached by' column
// of docs/screens.md with real input only: KeyboardEvents on window and pointer/mouse clicks on canvas#ui at
// the centre of host.widgetRect(id). It never calls nav or App methods; it only steps the App's frames (the
// GPU client's requestAnimationFrame is unreliable) and waits for the host's screen callback. Each screen is
// captured after two settled frames, as the RAA views and canvas#ui composited in the task that drew them.
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
// One real input as the player gives it, with the DOM events it dispatched in order.
// x and y: the click point in canvas#ui CSS px (host.widgetRect's space).
export type TourInput =
  | { kind: 'key'; key: TourKey; events: string[] }
  | { kind: 'click'; target: string; x: number; y: number; events: string[] }
export interface TourCapture { screen: string; file: string; inputs: TourInput[]; width: number; height: number; sha256: string; bytes: number }
export interface TourTransition { t: number; from: string | null; to: string }
export interface UiTourOutput {
  renderer: 'raa'; adapter: AdapterInfo; software: boolean; captures: TourCapture[]; transitions: TourTransition[]
}
interface OpFile { name: string; blob: Blob }

type Act = { key: TourKey } | { click: string }
// A leg gives its inputs on the settled previous screen and waits for the host to enter `to`.
// holdS: once settled, `to` must hold for this much game time with no transition.
// queuedS: `to` must come at least this much game time after the last leg's inputs (the Enter that queued).
interface Leg { acts: Act[]; to: string; capture: boolean; timeoutS: number; holdS?: number; queuedS?: number }

// LocalMode's QUEUE_S (main.ts): the offline queue's game time before the match starts.
const QUEUE_S = 3

// docs/screens.md 'Reached by': the load lands on title; menus by their buttons; Escape goes back; Play goes to
// the hub, Escape pauses it, Enter queues. The queue is captured within its QUEUE_S window, then checked:
// Escape cancels it back to the hub, where no match starts; Enter queues again and the match starts only after
// QUEUE_S. The offline sprint match then runs by itself to its podium (round 0 is a race the idle player cannot
// qualify in, so round 1 is spectated).
const TOUR: readonly Leg[] = [
  { acts: [], to: 'loading', capture: true, timeoutS: 20 },
  { acts: [], to: 'title', capture: false, timeoutS: 120 },
  { acts: [{ click: 'act-settings' }], to: 'settings', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'title', capture: true, timeoutS: 10 },
  { acts: [{ click: 'act-credits' }], to: 'credits', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'title', capture: false, timeoutS: 10 },
  { acts: [{ click: 'act-play-online' }], to: 'error', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'title', capture: false, timeoutS: 10 },
  { acts: [{ click: 'act-play' }], to: 'hub', capture: true, timeoutS: 30 },
  { acts: [{ key: 'Escape' }], to: 'pause', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'hub', capture: false, timeoutS: 10 },
  { acts: [{ key: 'Enter' }], to: 'queue', capture: true, timeoutS: 10 },
  { acts: [{ key: 'Escape' }], to: 'hub', capture: false, timeoutS: 10, holdS: QUEUE_S + 1 },
  { acts: [{ key: 'Enter' }], to: 'queue', capture: false, timeoutS: 10 },
  { acts: [], to: 'countdown', capture: true, timeoutS: 30, queuedS: QUEUE_S },
  { acts: [], to: 'round', capture: true, timeoutS: 15 },
  { acts: [], to: 'result', capture: true, timeoutS: 60 },
  { acts: [], to: 'spectate', capture: true, timeoutS: 60 },
  { acts: [], to: 'podium', capture: true, timeoutS: 120 },
]

const FRAME_MS = 16
// Game time per frame: real time on short screens, 3 ticks while a round plays (up to its 20 s sprint cap).
// Each is short enough that a screen of the match outlasts the 150 ms exit anim of the one before it.
const DT = 1 / 60
const FAST_DT = 3 / 60
const FAST: readonly string[] = ['round', 'spectate']
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
function press(key: TourKey): TourInput {
  const init: KeyboardEventInit = { code: key, key, bubbles: true, cancelable: true }
  window.dispatchEvent(new KeyboardEvent('keydown', init))
  window.dispatchEvent(new KeyboardEvent('keyup', init))
  return { kind: 'key', key, events: ['keydown', 'keyup'] }
}

// A left click at the centre of the widget's rect, on canvas#ui; the events bubble to #screens (GameInput).
function click(g: TourGame, target: string): TourInput {
  const r = g.host.widgetRect(target)
  if (r === null) refuse('ops', `uiTour.click.${target}`, `widget '${target}' is hidden or not on screen '${g.host.currentScreen()}'; fix the tour leg or the ui doc`)
  const x = r.x + r.w / 2
  const y = r.y + r.h / 2
  const box = g.ui.getBoundingClientRect()
  const at = { clientX: box.left + x, clientY: box.top + y, bubbles: true, cancelable: true, view: window }
  const pointer: PointerEventInit = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  const events: string[] = []
  const fire = (e: MouseEvent): void => {
    events.push(e.type)
    g.ui.dispatchEvent(e)
  }
  fire(new PointerEvent('pointermove', { ...pointer, buttons: 0 }))
  fire(new PointerEvent('pointerdown', { ...pointer, button: 0, buttons: 1 }))
  fire(new MouseEvent('mousedown', { ...at, button: 0, buttons: 1 }))
  fire(new PointerEvent('pointerup', { ...pointer, button: 0, buttons: 0 }))
  fire(new MouseEvent('mouseup', { ...at, button: 0, buttons: 0 }))
  fire(new MouseEvent('click', { ...at, button: 0, buttons: 0, detail: 1 }))
  return { kind: 'click', target, x, y, events }
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
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  return { blob, width: out.width, height: out.height }
}

function describe(acts: readonly Act[]): string {
  if (acts.length === 0) return 'no input'
  return acts.map(a => ('key' in a ? `key ${a.key}` : `a click on ${a.click}`)).join(', ')
}

class Tour {
  readonly transitions: TourTransition[] = []
  readonly captures: TourCapture[] = []
  readonly files: OpFile[] = []
  // performance.now() and the stepped game time of each transition, by index.
  private readonly at: number[] = []
  private readonly gameAt: number[] = []
  private gameS = 0
  // The game time when the last leg with inputs gave them.
  private actedS = 0
  private readonly t0 = performance.now()
  // The real inputs since the previous capture.
  private inputs: TourInput[] = []

  onScreen(e: UaaScreenChange): void {
    const now = performance.now()
    this.at.push(now)
    this.gameAt.push(this.gameS)
    this.transitions.push({ t: Math.round(now - this.t0) / 1000, from: e.from, to: e.to })
  }

  // Inputs on the settled screen, then frames until the host enters leg.to, then its settled frames.
  async leg(g: TourGame, leg: Leg): Promise<void> {
    const seen = this.transitions.length
    if (leg.acts.length > 0) this.actedS = this.gameS
    for (const act of leg.acts) this.inputs.push('key' in act ? press(act.key) : click(g, act.click))
    const deadline = performance.now() + leg.timeoutS * 1000
    let entered = -1
    let index = -1
    while (entered < 0) {
      if (performance.now() > deadline) this.timeout(g, leg, seen)
      await sleep(FRAME_MS)
      this.step(g, FAST.includes(g.host.currentScreen()) ? FAST_DT : DT)
      index = this.transitions.findIndex((t, i) => i >= seen && t.to === leg.to)
      if (index >= 0) entered = this.at[index]
    }
    if (leg.queuedS !== undefined) this.checkQueued(leg, leg.queuedS, index)
    // Game time stands still while the enter anims (uaa time is performance.now) play out.
    const settleMs = SETTLE_MS.get(leg.to) ?? 0
    let settled = 0
    for (;;) {
      await sleep(FRAME_MS)
      const now = performance.now()
      this.step(g, 0)
      if (now - entered >= settleMs && ++settled === SETTLED_FRAMES) break
    }
    const screen = g.host.currentScreen()
    if (screen !== leg.to) refuse('ops', `uiTour.${leg.to}`, `the host left '${leg.to}' for '${screen}' before it settled; inspect the transitions`)
    if (leg.holdS !== undefined) await this.hold(g, leg, leg.holdS)
    if (!leg.capture) return
    const shot = await capturePng(g)
    const blob = shot.blob
    if (blob === null) refuse('ops', `uiTour.${screen}`, 'canvas.toBlob returned null; the capture could not be encoded')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const file = `${screen}.png`
    this.files.push({ name: file, blob })
    this.captures.push({ screen, file, inputs: this.inputs, width: shot.width, height: shot.height, sha256: await sha256Hex(bytes), bytes: bytes.length })
    this.inputs = []
  }

  private step(g: TourGame, dtS: number): void {
    this.gameS += dtS
    g.step(dtS)
  }

  // No transition at all while `to` holds for holdS of game time (after Escape on 'queue': no match starts).
  private async hold(g: TourGame, leg: Leg, holdS: number): Promise<void> {
    const seen = this.transitions.length
    const until = this.gameS + holdS
    while (this.gameS < until) {
      await sleep(FRAME_MS)
      this.step(g, DT)
      if (this.transitions.length > seen) {
        const went = this.transitions.slice(seen).map(t => `${t.from ?? '-'} -> ${t.to}`).join(', ')
        refuse('ops', `uiTour.${leg.to}.hold`, `'${leg.to}' after ${describe(leg.acts)} did not hold for ${holdS} s of game time: ${went}`)
      }
    }
  }

  // The host enters a screen once the previous one's exit anim is done, so transition index comes at or after
  // the mode's change: the game time from the Enter that queued to it bounds the queue's time from above. A
  // match that started early (without the queue) shows as less than queuedS.
  private checkQueued(leg: Leg, queuedS: number, index: number): void {
    if (!this.transitions.slice(0, index).some(t => t.to === 'queue')) refuse('ops', `uiTour.${leg.to}.queue`, `the host entered '${leg.to}' without passing through 'queue'`)
    const s = this.gameAt[index] - this.actedS
    if (s < queuedS - 1e-6) {
      refuse('ops', `uiTour.${leg.to}.queue`, `'${leg.to}' came ${s.toFixed(3)} s of game time after the Enter that queued, before the ${queuedS} s queue`)
    }
  }

  private timeout(g: TourGame, leg: Leg, seen: number): never {
    const went = this.transitions.slice(seen).map(t => `${t.from ?? '-'} -> ${t.to}`).join(', ') || 'none'
    return refuse('ops', `uiTour.${leg.to}`,
      `the host did not enter '${leg.to}' within ${leg.timeoutS} s after ${describe(leg.acts)}; transitions since: ${went}; it is on '${g.host.currentScreen()}'`)
  }
}

export async function uiTour(raw: unknown, deps: TourDeps): Promise<{ json: UiTourOutput; files: OpFile[] }> {
  validate(raw)
  const status = await raaStatus()
  if (!status.available) refuse('render', 'raa', status.reason)
  const adapter = await deps.adapter()
  if (adapter.software) {
    refuse('gpu', 'adapter', `'${adapter.vendor} ${adapter.architecture} ${adapter.description}' is a software or fallback adapter; a capture on it is evidence of nothing, run the op in the GPU client`)
  }
  const tour = new Tour()
  const game = await deps.boot(e => tour.onScreen(e))
  try {
    for (const leg of TOUR) await tour.leg(game, leg)
  } finally {
    game.dispose()
  }
  return {
    json: { renderer: 'raa', adapter, software: adapter.software, captures: tour.captures, transitions: tour.transitions },
    files: tour.files,
  }
}
