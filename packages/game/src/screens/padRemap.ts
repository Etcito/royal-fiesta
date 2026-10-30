import type { PadAction, PadMap } from '../client/padMap.ts'

export interface RemapState {
  pad: string
  action: PadAction | null
  map: PadMap
}

export interface RemapRow {
  action: PadAction
  label: string
  button: number
  listening: boolean
}

const ROWS: readonly { action: PadAction; label: string }[] = [
  { action: 'jump', label: 'Jump' },
  { action: 'dive', label: 'Dive' },
  { action: 'grab', label: 'Grab' },
  { action: 'pause', label: 'Pause' }
]

const SWAPPABLE: readonly PadAction[] = ['jump', 'dive', 'grab']

function copy(map: PadMap): PadMap {
  return {
    v: 1,
    buttons: {
      jump: map.buttons.jump,
      dive: map.buttons.dive,
      grab: map.buttons.grab,
      pause: map.buttons.pause,
      join: map.buttons.join
    },
    axes: { x: map.axes.x, y: map.axes.y },
    invertY: map.invertY,
    dead: map.dead
  }
}

export function startRemap(map: PadMap, pad: string): RemapState {
  return { pad, action: null, map: copy(map) }
}

export function listenFor(s: RemapState, action: PadAction): RemapState {
  return { pad: s.pad, action, map: copy(s.map) }
}

export function pressed(s: RemapState, button: number): RemapState {
  const next: RemapState = { pad: s.pad, action: null, map: copy(s.map) }
  const action = s.action
  if (action === null) return next
  const previous = next.map.buttons[action]
  if (SWAPPABLE.includes(action)) {
    for (const other of SWAPPABLE) {
      if (other !== action && next.map.buttons[other] === button) {
        next.map.buttons[other] = previous
        break
      }
    }
  }
  next.map.buttons[action] = button
  return next
}

export function remapRows(s: RemapState): RemapRow[] {
  return ROWS.map((row) => ({
    action: row.action,
    label: row.label,
    button: s.map.buttons[row.action],
    listening: s.action === row.action
  }))
}
