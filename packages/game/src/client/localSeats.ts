import type { PlayerInput } from '@royal-fiesta/sim/input'
import { refuse } from '@royal-fiesta/sim/refusal'
import { controlsToInput, emptyControls } from './inputMap.ts'
import type { RawControls } from './inputMap.ts'

export type KeyScheme = 'all' | 'left' | 'right'
export interface SeatDevices { keyboard: KeyScheme | null; pad: number | null }

export function assignPads(seats: number, pads: readonly number[]): SeatDevices[] {
  if (!Number.isInteger(seats) || seats < 1 || seats > 4) {
    refuse('client', 'assignPads', `${seats} is outside 1..4; pass a local seat count from 1 to 4`)
  }
  const assigned = Array.from({ length: seats }, (_, i): SeatDevices => ({ keyboard: null, pad: pads[i] ?? null }))
  const withoutPad = assigned.filter(seat => seat.pad === null)
  if (withoutPad.length === 0) assigned[0].keyboard = 'all'
  else if (withoutPad.length === 1) withoutPad[0].keyboard = 'all'
  else {
    withoutPad[0].keyboard = 'left'
    withoutPad[1].keyboard = 'right'
  }
  return assigned
}

type Action = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'dive' | 'grab'
const ACTIONS: readonly Action[] = ['forward', 'back', 'left', 'right', 'jump', 'dive', 'grab']
const KEYS: Record<KeyScheme, Record<Action, readonly string[]>> = {
  all: {
    forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    jump: ['Space'], dive: ['ShiftLeft', 'ShiftRight'], grab: ['KeyE'],
  },
  left: {
    forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
    jump: ['Space'], dive: ['ShiftLeft'], grab: ['KeyE'],
  },
  right: {
    forward: ['ArrowUp'], back: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    jump: ['Enter', 'NumpadEnter'], dive: ['ShiftRight'], grab: ['ControlRight'],
  },
}

// Standard gamepad mapping, copied from apps/web/src/input/input.ts.
const PAD_JUMP = 0
const PAD_DIVE = 1
const PAD_GRAB = 2
interface PadSnapshot {
  axes: readonly number[]
  buttons: readonly { pressed: boolean }[]
}

function axis(pad: PadSnapshot, i: number): number {
  const value = pad.axes[i] ?? 0
  return Number.isFinite(value) ? value : 0
}

// DOM-free: callers provide key transitions and gamepad snapshots (null clears a pad).
export class LocalSeats {
  readonly devices: readonly SeatDevices[]
  private readonly held = new Set<string>()
  private readonly seats: {
    controls: RawControls
    buttons: { jump: boolean; dive: boolean; grab: boolean }
    look: { x: number; y: number }
  }[]

  constructor(devices: readonly SeatDevices[]) {
    this.devices = devices.map(device => ({ ...device }))
    this.seats = devices.map(() => ({
      controls: emptyControls(), buttons: { jump: false, dive: false, grab: false }, look: { x: 0, y: 0 },
    }))
  }

  key(code: string, pressed: boolean): void {
    if (pressed) this.held.add(code)
    else this.held.delete(code)
    for (let i = 0; i < this.devices.length; i++) {
      const scheme = this.devices[i].keyboard
      if (scheme !== null && ACTIONS.some(action => KEYS[scheme][action].includes(code))) this.merge(i)
    }
  }

  pad(index: number, pad: PadSnapshot | null): void {
    for (let i = 0; i < this.devices.length; i++) {
      if (this.devices[i].pad !== index) continue
      const seat = this.seats[i]
      seat.controls.stickX = pad === null ? 0 : axis(pad, 0)
      seat.controls.stickY = pad === null ? 0 : -axis(pad, 1)
      seat.buttons.jump = pad?.buttons[PAD_JUMP]?.pressed === true
      seat.buttons.dive = pad?.buttons[PAD_DIVE]?.pressed === true
      seat.buttons.grab = pad?.buttons[PAD_GRAB]?.pressed === true
      seat.look.x = pad === null ? 0 : axis(pad, 2)
      seat.look.y = pad === null ? 0 : axis(pad, 3)
      this.merge(i)
    }
  }

  controls(i: number): RawControls { return this.seats[i].controls }

  look(i: number): { x: number; y: number } { return this.seats[i].look }

  sample(i: number, cameraFacing: { x: number; z: number }, out: PlayerInput): PlayerInput {
    return controlsToInput(this.controls(i), cameraFacing, out)
  }

  hasDevice(i: number): boolean {
    const device = this.devices[i]
    return device.keyboard !== null || device.pad !== null
  }

  private merge(i: number): void {
    const seat = this.seats[i]
    const scheme = this.devices[i].keyboard
    for (const action of ACTIONS) {
      const keyboard = scheme !== null && KEYS[scheme][action].some(code => this.held.has(code))
      const button = (action === 'jump' || action === 'dive' || action === 'grab') && seat.buttons[action]
      seat.controls[action] = keyboard || button
    }
  }
}
