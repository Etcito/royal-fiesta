// Menu navigation from every connected gamepad, seat or not (menus are used before any seat exists):
// d-pad (buttons 12-15), a hat axis (axes[9], non-standard pads) or the left stick move focus (up/down)
// and adjust (left/right) with auto-repeat while held; button 0 confirms, button 1 goes back, start
// (button 9) is back too. Pure: the caller passes the pads and the clock.
import type { UiEvent } from './input.ts'

export const MENU_STICK = 0.5
export const REPEAT_FIRST_MS = 400
export const REPEAT_MS = 120
const PAD_B = 1

export interface MenuPad {
  index: number
  connected?: boolean
  axes: readonly number[]
  buttons: readonly { pressed: boolean }[]
}

type Dir = 'up' | 'down' | 'left' | 'right'

interface State { dir: Dir | null; next: number; a: boolean; b: boolean; start: boolean }

// The 8-way hat on axis 9 reports -1, -0.71, -0.43, -0.14, 0.14, 0.43, 0.71, 1 clockwise from up, 3.29 at rest.
function hatDir(v: number): Dir | null {
  if (!Number.isFinite(v) || v > 1.01 || v < -1.01) return null
  const step = Math.round((v + 1) * 3.5)
  if (step === 7 || step === 0 || step === 1) return step === 1 ? 'right' : 'up'
  if (step === 2) return 'right'
  if (step === 3 || step === 4) return 'down'
  if (step === 5) return 'left'
  return step === 6 ? 'left' : null
}

export function padDirection(pad: MenuPad): Dir | null {
  const b = (i: number) => pad.buttons[i]?.pressed === true
  if (b(12)) return 'up'
  if (b(13)) return 'down'
  if (b(14)) return 'left'
  if (b(15)) return 'right'
  const hat = pad.axes.length > 9 ? hatDir(pad.axes[9]) : null
  if (hat !== null) return hat
  const x = Number.isFinite(pad.axes[0]) ? pad.axes[0] : 0
  const y = Number.isFinite(pad.axes[1]) ? pad.axes[1] : 0
  if (Math.max(Math.abs(x), Math.abs(y)) < MENU_STICK) return null
  return Math.abs(y) >= Math.abs(x) ? (y < 0 ? 'up' : 'down') : (x < 0 ? 'left' : 'right')
}

function dirEvent(d: Dir): UiEvent {
  switch (d) {
    case 'up': return { k: 'focus', dir: -1 }
    case 'down': return { k: 'focus', dir: 1 }
    case 'left': return { k: 'adjust', dir: -1 }
    default: return { k: 'adjust', dir: 1 }
  }
}

export class PadMenu {
  private readonly states = new Map<number, State>()

  // Edge state follows every pad every frame; events come out only when menu is true.
  update(pads: readonly (MenuPad | null)[], now: number, menu: boolean, out: UiEvent[]): void {
    const seen = new Set<number>()
    for (const pad of pads) {
      if (!pad || pad.connected === false) continue
      seen.add(pad.index)
      let s = this.states.get(pad.index)
      if (s === undefined) {
        s = { dir: null, next: 0, a: false, b: false, start: false }
        this.states.set(pad.index, s)
      }
      const down = (i: number) => pad.buttons[i]?.pressed === true
      const a = down(0)
      const b = down(PAD_B)
      const start = down(9)
      const dir = padDirection(pad)
      if (start && !s.start) out.push({ k: 'back', pad: 'start' })
      if (menu) {
        if (a && !s.a) out.push({ k: 'select' })
        if (b && !s.b) out.push({ k: 'back', pad: 'b' })
        if (dir !== null && dir !== s.dir) out.push(dirEvent(dir))
        else if (dir !== null && now >= s.next) {
          out.push(dirEvent(dir))
          s.next = now + REPEAT_MS
        }
      }
      // A held direction waits the first delay from its press, in a menu or not.
      if (dir !== s.dir) s.next = now + REPEAT_FIRST_MS
      s.dir = dir
      s.a = a
      s.b = b
      s.start = start
    }
    for (const index of this.states.keys()) if (!seen.has(index)) this.states.delete(index)
  }
}
