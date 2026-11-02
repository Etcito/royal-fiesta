// vote (game.html?test=1): boots the App, walks start -> Play -> hub -> Enter to the first vote with real
// input, then plays three votes through the show: the first with the mouse (hover, then click), the second
// with the keyboard (ArrowRight, Enter), the third with the synthetic standard pad the uiTour polls (d-pad
// right, A). Each vote checks the model's chosen index (through the mark the renderer derives from it), that
// the show proceeds to the countdown, and that every visible card's thumbnail has loaded with its map's URL.
// It steps with fixed dt and waits on screen callbacks and presentation frames only; it never sleeps.
import { browserContentRoot } from '../../content/v1Data.ts'
import type { WidgetProps } from '../../ui/screenMap.ts'
import type { TourDeps, TourGame } from '../uiTour.ts'
import { checkBoot, loadingFrame, nextTask, yieldTask } from './boot.ts'

export const name = 'vote'

const DT = 1 / 60
const FAST_DT = 3 / 60
const FAST = new Set(['round', 'spectate', 'vote', 'elimShow', 'podium'])
// A whole test-mode show at 3 ticks per frame; the caps only guard against a stuck page.
const NAV_FRAMES = 3600
const VOTE_FRAMES = 120000
const VOTE_READY_FRAMES = 3600
const THUMB_FRAMES = 600
const SLOTS = [0, 1, 2] as const

type Device = 'mouse' | 'keyboard' | 'gamepad'
type Props = Record<string, WidgetProps>
interface Thumb { map: string; loaded: boolean }
interface ThumbState extends Thumb { slot: number; src: string; expected: string | null; naturalWidth: number }
interface VoteResult { device: Device; target: number; chosen: number | null; thumbs: Thumb[] }
interface VoteJson { ok: boolean; votes: VoteResult[]; failures: string[]; transitions: string[] }

async function step(game: TourGame, dt: number): Promise<void> {
  game.step(dt)
  await nextTask()
}

function press(key: string): void {
  const init: KeyboardEventInit = { code: key, key, bubbles: true, cancelable: true }
  window.dispatchEvent(new KeyboardEvent('keydown', init))
  window.dispatchEvent(new KeyboardEvent('keyup', init))
}

// A pointer/mouse sequence on canvas#ui like uiTour's, at the centre of the widget's widgetRect.
function pointer(game: TourGame, target: string, click: boolean): void {
  const rect = game.host.widgetRect(target)
  if (rect === null) throw new Error(`vote: widget '${target}' is missing on '${game.host.currentScreen()}'`)
  const box = game.ui.getBoundingClientRect()
  const at = { clientX: box.left + rect.x + rect.w / 2, clientY: box.top + rect.y + rect.h / 2,
    bubbles: true, cancelable: true, view: window }
  const move = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  game.ui.dispatchEvent(new PointerEvent('pointermove', { ...move, buttons: 0 }))
  if (!click) return
  const pointerAt = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  for (const event of [
    new PointerEvent('pointerdown', { ...pointerAt, button: 0, buttons: 1 }),
    new MouseEvent('mousedown', { ...at, button: 0, buttons: 1 }),
    new PointerEvent('pointerup', { ...pointerAt, button: 0, buttons: 0 }),
    new MouseEvent('mouseup', { ...at, button: 0, buttons: 0 }),
    new MouseEvent('click', { ...at, button: 0, buttons: 0, detail: 1 }),
  ]) game.ui.dispatchEvent(event)
}

function syntheticPad(): Gamepad {
  return {
    id: 'vote-pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: null,
  } as unknown as Gamepad
}

// One pad button pressed for exactly one polled frame, then released for one. Frozen game time keeps the
// vote window (1000 ms at ?test=1) open while the pad edges are delivered.
async function padFrame(game: TourGame, pad: Gamepad, button: number): Promise<void> {
  const b = pad.buttons[button] as { pressed: boolean; touched: boolean; value: number }
  b.pressed = true
  b.touched = true
  b.value = 1
  await step(game, 0)
  b.pressed = false
  b.touched = false
  b.value = 0
  await step(game, 0)
}

function watchHud(game: TourGame): () => Props {
  let latest: Props = {}
  const original = game.host.setHud
  game.host.setHud = (values: Props): void => {
    latest = values
    original.call(game.host, values)
  }
  return () => latest
}

function visibleSlots(props: Props): number[] {
  return SLOTS.filter(slot => props[`vote-card-${slot}`]?.visible === true)
}

function markSlot(props: Props, text: string): number {
  for (const slot of SLOTS) if (props[`vote-mark-${slot}`]?.text === text) return slot
  return -1
}

// The vote model's candidate index for a card slot (a single candidate sits in the middle card).
function indexOfSlot(slot: number, count: number): number {
  return count === 1 ? (slot === 1 ? 0 : -1) : slot
}

function slotOfIndex(index: number, count: number): number {
  return count === 1 ? 1 : index
}

// content/thumbs/<map>.avif under the same content root the meshes load from, as screens/vote.ts builds it.
function thumbUrl(map: string): string {
  const root = browserContentRoot().replace(/\/?$/, '/')
  return new URL(`thumbs/${encodeURIComponent(map)}.avif`, new URL(root, document.baseURI)).href
}

function thumbImage(game: TourGame, slot: number): HTMLImageElement | null {
  const rect = game.host.widgetRect(`vote-thumb-${slot}`)
  if (rect === null) return null
  let best: HTMLImageElement | null = null
  let bestDistance = Infinity
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-map]')) {
    const left = Number.parseFloat(img.style.left)
    const top = Number.parseFloat(img.style.top)
    if (!Number.isFinite(left) || !Number.isFinite(top)) continue
    const distance = Math.abs(left - rect.x) + Math.abs(top - rect.y)
    if (distance < bestDistance) { bestDistance = distance; best = img }
  }
  // Wide enough for a card still in its enter animation, far below the gap between two cards.
  return best !== null && bestDistance <= 8 ? best : null
}

function readThumbs(game: TourGame, slots: readonly number[]): ThumbState[] {
  return slots.map(slot => {
    const img = thumbImage(game, slot)
    if (img === null) return { slot, map: '', loaded: false, src: '', expected: null, naturalWidth: 0 }
    const map = img.dataset.map ?? ''
    return {
      slot, map,
      loaded: img.complete && img.naturalWidth > 0,
      src: img.src,
      expected: map === '' ? null : thumbUrl(map),
      naturalWidth: img.naturalWidth,
    }
  })
}

async function capture(game: TourGame): Promise<Blob> {
  const ui = game.ui
  const uiShot = createImageBitmap(ui)
  const views = Array.from(game.views.querySelectorAll('canvas'), view => ({
    rect: view.getBoundingClientRect(), shot: createImageBitmap(view),
  }))
  const out = document.createElement('canvas')
  out.width = ui.width
  out.height = ui.height
  const ctx = out.getContext('2d')
  if (ctx === null) throw new Error('vote: no 2D canvas context to composite the capture')
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
  // The thumbnails are DOM images over canvas#ui, so the UI canvas alone leaves their cards empty.
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-map]')) {
    if (!img.complete || img.naturalWidth === 0 || img.style.display === 'none') continue
    const r = img.getBoundingClientRect()
    ctx.drawImage(img, (r.left - box.left) * sx, (r.top - box.top) * sy, r.width * sx, r.height * sy)
  }
  flush()
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('vote: canvas.toBlob returned null; the capture could not be encoded')
  return blob
}

async function waitScreen(game: TourGame, current: () => string, target: string, frames: number): Promise<boolean> {
  for (let frame = 0; frame < frames; frame++) {
    if (current() === target) return true
    // A refusal ends the show; there is nothing left to wait for.
    if (current() === 'error') return false
    const stepped = current()
    game.step(FAST.has(stepped) ? FAST_DT : DT)
    await yieldTask(stepped)
    if (loadingFrame(stepped)) frame--
  }
  return current() === target
}

// The vote model mounts after its screen: nav enters 'vote' when the show starts, ShowMode fills the
// candidates a moment later. Frozen game time keeps its window open while we wait.
async function waitVoteReady(game: TourGame, read: () => Props, current: () => string): Promise<Props | null> {
  for (let frame = 0; frame < VOTE_READY_FRAMES; frame++) {
    if (current() !== 'vote') return null
    const props = read()
    if (visibleSlots(props).length > 0) return props
    await step(game, 0)
  }
  return null
}

async function waitThumbs(game: TourGame, slots: readonly number[]): Promise<ThumbState[]> {
  let thumbs = readThumbs(game, slots)
  for (let frame = 0; frame < THUMB_FRAMES && !thumbs.every(thumb => thumb.loaded); frame++) {
    await step(game, 0)
    thumbs = readThumbs(game, slots)
  }
  return thumbs
}

interface StartInventory { startView?: boolean }

export async function run(_input: unknown, deps: TourDeps): Promise<{ json: VoteJson; files: { name: string; blob: Blob }[] }> {
  const failures: string[] = []
  const votes: VoteResult[] = []
  const files: { name: string; blob: Blob }[] = []
  const transitions: string[] = []
  const pad = syntheticPad()
  const own = Object.getOwnPropertyDescriptor(navigator, 'getGamepads')
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] })
  let game: TourGame | null = null
  try {
    let screen = ''
    const boot: TourDeps['boot'] = onScreen => deps.boot(change => {
      screen = change.to
      transitions.push(change.to)
      onScreen(change)
    })
    const booted = await checkBoot({ ...deps, boot })
    game = booted.game
    if (!booted.json.ok) {
      failures.push(`boot failed: ${booted.json.error ?? booted.json.screen}`)
      return { json: { ok: false, votes, failures, transitions }, files }
    }
    const live = game
    const current = (): string => screen
    const read = watchHud(live)
    // The boot lands on the start screen before its penguin art (meshes, cosmetics) mounts; keys only
    // reach startStep once that view exists.
    let mounted = false
    for (let frame = 0; frame < NAV_FRAMES && !mounted; frame++) {
      mounted = (live.inventory() as StartInventory).startView === true
      if (!mounted) await step(live, DT)
    }
    if (!mounted) throw new Error('vote: the start screen view never mounted')
    await step(live, DT)
    // start -> Play -> hub: five ArrowDowns walk the 4 bins -> palette -> Play, then Enter runs the hub.
    for (let i = 0; i < 5; i++) press('ArrowDown')
    press('Enter')
    if (!(await waitScreen(live, current, 'hub', NAV_FRAMES))) {
      throw new Error(`vote: the hub did not arrive (on '${current()}')`)
    }
    // Enter in the hub queues; the offline show opens on its first vote.
    press('Enter')
    for (let frame = 0; frame < NAV_FRAMES && current() !== 'vote'; frame++) await step(live, DT)
    if (current() !== 'vote') throw new Error(`vote: the first vote did not arrive (on '${current()}')`)

    const devices: readonly Device[] = ['mouse', 'keyboard', 'gamepad']
    for (const [index, device] of devices.entries()) {
      const props = await waitVoteReady(live, read, current)
      if (props === null) {
        failures.push(`${device}: the vote model never appeared`)
        break
      }
      const slots = visibleSlots(props)
      const count = slots.length
      const target = device === 'mouse' ? Math.min(2, count - 1) : Math.min(1, count - 1)
      const targetSlot = slotOfIndex(target, count)
      // Load the thumbnails before voting, with game time frozen so the vote window stays open.
      const thumbs = await waitThumbs(live, slots)
      for (const thumb of thumbs) {
        const at = `card ${thumb.slot}`
        if (thumb.map === '') failures.push(`${device}: ${at} has no thumbnail image`)
        else if (!thumb.loaded) failures.push(`${device}: thumbnail ${thumb.map} has not loaded (naturalWidth ${thumb.naturalWidth})`)
        else if (thumb.expected !== null && thumb.src !== thumb.expected) {
          failures.push(`${device}: thumbnail ${thumb.map} URL is ${thumb.src}, expected ${thumb.expected}`)
        }
      }
      let focusSlot = -1
      if (device === 'mouse') {
        pointer(live, `vote-card-${targetSlot}`, false)
        await step(live, 0)
        focusSlot = markSlot(read(), 'v')
        pointer(live, `vote-card-${targetSlot}`, true)
        await step(live, 0)
      } else if (device === 'keyboard') {
        press('ArrowRight')
        await step(live, 0)
        focusSlot = markSlot(read(), 'v')
        press('Enter')
        await step(live, 0)
      } else {
        await padFrame(live, pad, 15)
        focusSlot = markSlot(read(), 'v')
        await padFrame(live, pad, 0)
      }
      const chosenSlot = markSlot(read(), 'Your vote')
      const chosen = chosenSlot < 0 ? null : indexOfSlot(chosenSlot, count)
      if (focusSlot !== targetSlot) failures.push(`${device}: focused card ${focusSlot}, expected ${targetSlot}`)
      if (chosen !== target) failures.push(`${device}: the model chose ${chosen ?? 'nothing'}, expected ${target}`)
      votes.push({ device, target, chosen, thumbs: thumbs.map(thumb => ({ map: thumb.map, loaded: thumb.loaded })) })
      files.push({ name: `vote-${device}.png`, blob: await capture(live) })
      if (!(await waitScreen(live, current, 'countdown', VOTE_FRAMES))) {
        failures.push(`${device}: the show did not proceed to the countdown (on '${current()}')`)
        break
      }
      if (index < devices.length - 1 && !(await waitScreen(live, current, 'vote', VOTE_FRAMES))) {
        failures.push(`${device}: the next vote did not arrive (on '${current()}')`)
        break
      }
    }
    return { json: { ok: failures.length === 0, votes, failures, transitions }, files }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    return { json: { ok: false, votes, failures, transitions }, files }
  } finally {
    game?.dispose()
    if (own) Object.defineProperty(navigator, 'getGamepads', own)
    else Reflect.deleteProperty(navigator, 'getGamepads')
  }
}
