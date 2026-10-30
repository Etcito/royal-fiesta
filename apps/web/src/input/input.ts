// GameInput: real DOM events -> UI events, RawControls and look deltas. The scripted tour dispatches
// real KeyboardEvent/MouseEvent objects on the same targets, so screens are reached through here.
// No direction is computed here: moves go to controlsToInput (cameraBasis) and look x to the orbit
// camera's yawTurn, where > 0 turns right. Keys, left stick, mouse and right stick share that sign.
import { emptyControls } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import { padControls } from '@royal-fiesta/game/client/padMap'
import type { PadMapStore } from '@royal-fiesta/game/client/padMap'
import type { DeviceId } from '@royal-fiesta/game/client/seats'
import { PadMenu } from './padMenu.ts'
import { PointerLook } from './look.ts'

export type UiEvent =
  // pad: where a pad-made back came from (start = pause button, b = cancel button); keys carry none.
  | { k: 'back'; pad?: 'start' | 'b' }
  | { k: 'focus'; dir: -1 | 1 }
  | { k: 'adjust'; dir: -1 | 1 }
  | { k: 'select' }
  | { k: 'emote'; id: 1 | 2 | 3 | 4 }
  | { k: 'key'; code: string }
  | { k: 'click'; x: number; y: number }

export const STICK_DEADZONE = 0.15
export const PAD_JUMP = 0
export const PAD_DIVE = 1
export const PAD_GRAB = 2
export const PAD_START = 9

export const KEY_ACTIONS = ['forward', 'back', 'left', 'right', 'jump', 'dive', 'grab'] as const
export type KeyAction = typeof KEY_ACTIONS[number]
// The key part of the settings model (screens' Settings fits it structurally).
export interface KeyBindings { keys: Readonly<Record<KeyAction, string>> }
export const DEFAULT_BINDINGS: KeyBindings = {
  keys: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', dive: 'ShiftLeft', grab: 'KeyE' }
}

interface Pad {
  axes: readonly number[]
  buttons: readonly { pressed: boolean }[]
}

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
const EMOTES: Record<string, 1 | 2 | 3 | 4> = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4 }

export class GameInput {
  private readonly target: Window
  private readonly overlay: HTMLElement
  private readonly held = new Set<string>()
  private queue: UiEvent[] = []
  private readonly padMenu = new PadMenu()
  private readonly now: () => number
  private readonly onKeyDown: (e: KeyboardEvent) => void
  private readonly onKeyUp: (e: KeyboardEvent) => void
  private readonly onBlur: () => void
  private readonly onClick: (e: MouseEvent) => void
  private readonly onPointerMove: (e: PointerEvent) => void
  // Last pointer position in overlay backing pixels (hover feedback for the app).
  pointer: { x: number; y: number } | null = null
  // Pointer lock on the element the callback returns (the stage canvas); inert without one.
  readonly look: PointerLook

  constructor(eventTarget: Window, overlay: HTMLElement, lockTarget?: () => Element | null, now: () => number = () => performance.now()) {
    this.now = now
    this.target = eventTarget
    this.overlay = overlay
    this.look = new PointerLook(eventTarget, lockTarget ?? (() => null))
    this.onKeyDown = e => {
      this.held.add(e.code)
      if (PREVENT.has(e.code)) e.preventDefault()
      if (e.repeat) return
      const ev = keyEvent(e.code, e.shiftKey)
      if (ev !== null) this.queue.push(ev)
      this.queue.push({ k: 'key', code: e.code })
    }
    this.onKeyUp = e => { this.held.delete(e.code) }
    this.onBlur = () => { this.held.clear() }
    this.onClick = e => {
      const p = this.toOverlay(e)
      this.queue.push({ k: 'click', x: p.x, y: p.y })
    }
    this.onPointerMove = e => { this.pointer = this.toOverlay(e) }
    eventTarget.addEventListener('keydown', this.onKeyDown)
    eventTarget.addEventListener('keyup', this.onKeyUp)
    eventTarget.addEventListener('blur', this.onBlur)
    overlay.addEventListener('click', this.onClick)
    overlay.addEventListener('pointermove', this.onPointerMove)
  }

  takeEvents(): UiEvent[] {
    const out = this.queue
    this.queue = []
    return out
  }

  // Held keys through the bindings, merged with the first gamepad. On menus, pad button 0
  // also selects; start (9) always means back. Both are edges.
  controls(bindings: KeyBindings = DEFAULT_BINDINGS, menu = false): RawControls {
    const c = controlsFromKeys(this.held, bindings)
    // Every connected pad drives the menus, seated or not (no seat exists before the first press).
    this.padMenu.update(allPads(), this.now(), menu, this.queue)
    const pad = firstPad()
    if (pad !== null) padMove(pad, c)
    return c
  }

  // Camera look this frame: mouse delta (pixels, locked only) plus the first pad's right stick.
  // Both x values are passed on unchanged: > 0 turns the view right (yawTurn).
  takeLook(): { dx: number; dy: number; rx: number; ry: number } {
    const m = this.look.takeDelta()
    const pad = firstPad()
    const r = pad === null ? { x: 0, y: 0 } : padLook(pad)
    return { dx: m.dx, dy: m.dy, rx: r.x, ry: r.y }
  }

  dispose(): void {
    this.look.dispose()
    this.target.removeEventListener('keydown', this.onKeyDown)
    this.target.removeEventListener('keyup', this.onKeyUp)
    this.target.removeEventListener('blur', this.onBlur)
    this.overlay.removeEventListener('click', this.onClick)
    this.overlay.removeEventListener('pointermove', this.onPointerMove)
    this.held.clear()
    this.queue = []
  }

  // CSS pixels in the overlay -> its canvas backing pixels (devicePixelRatio).
  private toOverlay(e: MouseEvent): { x: number; y: number } {
    const r = this.overlay.getBoundingClientRect()
    const dpr = this.target.devicePixelRatio || 1
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr }
  }
}

// One polled device per frame. controls is reused in place once out has grown; the
// join/pause flags are press edges (true for exactly one poll after the press).
export interface DevicePoll {
  device: DeviceId
  controls: RawControls
  joinPressed: boolean
  pausePressed: boolean
}

interface Edges {
  join: boolean
  pause: boolean
}

// Per-device polling for local split screen. Keyboard keys are held by this class, pads
// read their stored map, and touch delegates to the virtual controls. Edge state is kept
// per device id; a pad that leaves pads() loses its state.
export class InputDevices {
  bindings: KeyBindings = DEFAULT_BINDINGS
  private readonly target: HTMLElement
  private readonly pads: () => readonly (Gamepad | null)[]
  private readonly maps: PadMapStore
  private readonly touch: { active: boolean; read(out: RawControls): void } | null
  private readonly held = new Set<string>()
  private readonly edges = new Map<string, Edges>()
  private joinQueued = false
  private pauseQueued = false
  private readonly onKeyDown: (e: KeyboardEvent) => void
  private readonly onKeyUp: (e: KeyboardEvent) => void
  private readonly onBlur: () => void

  constructor(
    target: HTMLElement,
    pads: () => readonly (Gamepad | null)[],
    maps: PadMapStore,
    touch: { active: boolean; read(out: RawControls): void } | null
  ) {
    this.target = target
    this.pads = pads
    this.maps = maps
    this.touch = touch
    this.onKeyDown = e => {
      if (!this.held.has(e.code)) {
        if (e.code === 'Enter' || e.code === 'NumpadEnter') this.joinQueued = true
        if (e.code === 'Escape') this.pauseQueued = true
      }
      this.held.add(e.code)
    }
    this.onKeyUp = e => { this.held.delete(e.code) }
    this.onBlur = () => { this.held.clear() }
    target.addEventListener('keydown', this.onKeyDown)
    target.addEventListener('keyup', this.onKeyUp)
    target.addEventListener('blur', this.onBlur)
  }

  poll(out: DevicePoll[]): number {
    let n = 0
    const keyboard = slot(out, n++)
    keyboard.device = 'keyboard'
    controlsFromKeys(this.held, this.bindings, keyboard.controls)
    keyboard.joinPressed = this.joinQueued
    keyboard.pausePressed = this.pauseQueued
    this.joinQueued = false
    this.pauseQueued = false

    const present = new Set<string>()
    for (const pad of this.pads()) {
      if (pad === null || pad.connected === false) continue
      const device: DeviceId = `pad:${pad.index}`
      present.add(device)
      const map = this.maps.get(pad.id)
      const entry = slot(out, n++)
      entry.device = device
      padControls(pad, map, entry.controls)
      const edges = this.edges.get(device) ?? { join: false, pause: false }
      const join = pad.buttons[map.buttons.join]?.pressed === true
      const pause = pad.buttons[map.buttons.pause]?.pressed === true
      entry.joinPressed = join && !edges.join
      entry.pausePressed = pause && !edges.pause
      edges.join = join
      edges.pause = pause
      this.edges.set(device, edges)
    }
    for (const device of this.edges.keys()) {
      if (!present.has(device)) this.edges.delete(device)
    }

    if (this.touch !== null && this.touch.active) {
      const entry = slot(out, n++)
      entry.device = 'touch'
      this.touch.read(entry.controls)
      entry.joinPressed = false
      entry.pausePressed = false
    }
    return n
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown)
    this.target.removeEventListener('keyup', this.onKeyUp)
    this.target.removeEventListener('blur', this.onBlur)
    this.held.clear()
    this.edges.clear()
    this.joinQueued = false
    this.pauseQueued = false
  }
}

function slot(out: DevicePoll[], index: number): DevicePoll {
  let entry = out[index]
  if (entry === undefined) {
    entry = { device: 'keyboard', controls: emptyControls(), joinPressed: false, pausePressed: false }
    out[index] = entry
  }
  return entry
}

function keyEvent(code: string, shift: boolean): UiEvent | null {
  switch (code) {
    case 'Escape': return { k: 'back' }
    case 'ArrowUp': return { k: 'focus', dir: -1 }
    case 'ArrowDown': return { k: 'focus', dir: 1 }
    case 'Tab': return { k: 'focus', dir: shift ? -1 : 1 }
    case 'ArrowLeft': return { k: 'adjust', dir: -1 }
    case 'ArrowRight': return { k: 'adjust', dir: 1 }
    case 'Enter':
    case 'NumpadEnter': return { k: 'select' }
  }
  const id = EMOTES[code]
  return id === undefined ? null : { k: 'emote', id }
}

// Held keys through the bindings. Arrows always work; ZQSD's Z and Q work unless rebound elsewhere.
// out lets InputDevices reuse one controls object across polls.
function controlsFromKeys(held: ReadonlySet<string>, b: KeyBindings, out: RawControls = emptyControls()): RawControls {
  const c = out
  const alternate = (code: string, action: KeyAction): boolean =>
    held.has(code) && !KEY_ACTIONS.some(other => other !== action && b.keys[other] === code)
  c.forward = held.has(b.keys.forward) || held.has('ArrowUp') || alternate('KeyZ', 'forward')
  c.back = held.has(b.keys.back) || held.has('ArrowDown')
  c.left = held.has(b.keys.left) || held.has('ArrowLeft') || alternate('KeyQ', 'left')
  c.right = held.has(b.keys.right) || held.has('ArrowRight')
  c.jump = held.has(b.keys.jump)
  c.dive = held.has(b.keys.dive)
  c.grab = held.has(b.keys.grab)
  c.stickX = 0
  c.stickY = 0
  return c
}

function axis(pad: Pad, index: number): number {
  const value = pad.axes[index] ?? 0
  return Number.isFinite(value) ? value : 0
}

// Standard mapping, left stick: stickX = axes[0], stickY = -axes[1] (the pad reports up as negative).
// A centred stick leaves keyboard movement in effect.
function padMove(pad: Pad, out: RawControls): void {
  const x = axis(pad, 0)
  const y = axis(pad, 1)
  if (Math.abs(x) > STICK_DEADZONE || Math.abs(y) > STICK_DEADZONE) {
    out.stickX = x
    out.stickY = -y
  }
  out.jump ||= pad.buttons[PAD_JUMP]?.pressed === true
  out.dive ||= pad.buttons[PAD_DIVE]?.pressed === true
  out.grab ||= pad.buttons[PAD_GRAB]?.pressed === true
}

// Right stick: x = axes[2], y = axes[3], unflipped (y < 0 looks up).
function padLook(pad: Pad): { x: number; y: number } {
  const x = axis(pad, 2)
  const y = axis(pad, 3)
  return {
    x: Math.abs(x) > STICK_DEADZONE ? x : 0,
    y: Math.abs(y) > STICK_DEADZONE ? y : 0
  }
}

function allPads(): readonly (Gamepad | null)[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return []
  return navigator.getGamepads()
}

function firstPad(): Gamepad | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null
  for (const pad of navigator.getGamepads()) if (pad) return pad
  return null
}
