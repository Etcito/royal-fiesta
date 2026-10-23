// GameInput: real DOM events -> UI events, RawControls and look deltas. The scripted tour dispatches
// real KeyboardEvent/MouseEvent objects on the same targets, so screens are reached through here.
// No direction is computed here: moves go to controlsToInput (cameraBasis) and look x to the orbit
// camera's yawTurn, where > 0 turns right. Keys, left stick, mouse and right stick share that sign.
import { emptyControls } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import { PointerLook } from './look.ts'

export type UiEvent =
  | { k: 'back' }
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
  private padStart = false
  private padSelect = false
  private readonly onKeyDown: (e: KeyboardEvent) => void
  private readonly onKeyUp: (e: KeyboardEvent) => void
  private readonly onBlur: () => void
  private readonly onClick: (e: MouseEvent) => void
  private readonly onPointerMove: (e: PointerEvent) => void
  // Last pointer position in overlay backing pixels (hover feedback for the app).
  pointer: { x: number; y: number } | null = null
  // Pointer lock on the element the callback returns (the stage canvas); inert without one.
  readonly look: PointerLook

  constructor(eventTarget: Window, overlay: HTMLElement, lockTarget?: () => Element | null) {
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
    const pad = firstPad()
    if (pad === null) {
      this.padStart = false
      this.padSelect = false
      return c
    }
    padMove(pad, c)
    const b = (i: number) => pad.buttons[i]?.pressed === true
    const start = b(PAD_START)
    if (start && !this.padStart) this.queue.push({ k: 'back' })
    this.padStart = start
    const select = b(PAD_JUMP)
    if (menu && select && !this.padSelect) this.queue.push({ k: 'select' })
    this.padSelect = select
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
function controlsFromKeys(held: ReadonlySet<string>, b: KeyBindings): RawControls {
  const c = emptyControls()
  const alternate = (code: string, action: KeyAction): boolean =>
    held.has(code) && !KEY_ACTIONS.some(other => other !== action && b.keys[other] === code)
  c.forward = held.has(b.keys.forward) || held.has('ArrowUp') || alternate('KeyZ', 'forward')
  c.back = held.has(b.keys.back) || held.has('ArrowDown')
  c.left = held.has(b.keys.left) || held.has('ArrowLeft') || alternate('KeyQ', 'left')
  c.right = held.has(b.keys.right) || held.has('ArrowRight')
  c.jump = held.has(b.keys.jump)
  c.dive = held.has(b.keys.dive)
  c.grab = held.has(b.keys.grab)
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

function firstPad(): Gamepad | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null
  for (const pad of navigator.getGamepads()) if (pad) return pad
  return null
}
