// The start screen model: the wardrobe bins of owned costumes, the colour palette and the Play/Shop buttons.
// Pure: the caller supplies the owned ids and the saved wardrobe, and the model names what the renderer draws.
import { PALETTE } from '../render/palette.ts'
import type { Action } from '../screens/nav.ts'

export interface OwnedSource {
  owned(): Promise<string[]>
}

export interface InboxBadgeSource {
  unread(): Promise<number>
}

type BinSlot = 'head' | 'body' | 'bottom'

export interface StartScreenModel {
  bins: { slot: BinSlot; items: string[]; selected: number }[]
  palette: number[]
  colour: number
  focus: 'bins' | 'palette' | 'play' | 'shop'
  // The bin the vertical focus is on while focus is 'bins'.
  bin: number
  badge: number
  background: 'candy'
}

export const LOCAL_COSMETICS: readonly { id: string; slot: BinSlot }[] = Object.freeze([
  { id: 'costume.propeller-hat', slot: 'head' },
  { id: 'costume.pineapple-suit', slot: 'body' },
  { id: 'costume.fish-scarf', slot: 'bottom' },
])

// The offline default until M9 wires OwnedSource to the economy.
export const LOCAL_OWNED: OwnedSource = Object.freeze({
  owned: (): Promise<string[]> => Promise.resolve(LOCAL_COSMETICS.map(item => item.id)),
})

const BIN_SLOTS: readonly BinSlot[] = Object.freeze(['head', 'body', 'bottom'])

function clampColour(value: number, palette: readonly number[]): number {
  const lo = palette[0] ?? 0
  const hi = palette[palette.length - 1] ?? 0
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, Math.trunc(value)))
}

export function startScreen(
  owned: readonly string[],
  cosmetics: readonly { id: string; slot: string }[],
  badge: number,
  saved: { colour: number; worn: Record<string, string> },
): StartScreenModel {
  const ownedSet = new Set(owned)
  const bins = BIN_SLOTS.map((slot) => {
    const items = cosmetics
      .filter(item => item.slot === slot && ownedSet.has(item.id))
      .map(item => item.id)
    const worn = saved.worn[slot]
    const selected = worn === undefined ? -1 : items.indexOf(worn)
    return { slot, items, selected }
  })
  const palette = PALETTE.map((_, index) => index)
  return {
    bins,
    palette,
    colour: clampColour(saved.colour, palette),
    focus: 'bins',
    bin: 0,
    badge,
    background: 'candy',
  }
}

function focusPosition(m: StartScreenModel): number {
  const n = m.bins.length
  switch (m.focus) {
    case 'bins':
      return Math.min(Math.max(m.bin, 0), Math.max(0, n - 1))
    case 'palette':
      return n
    case 'play':
      return n + 1
    case 'shop':
      return n + 2
  }
}

function atPosition(m: StartScreenModel, position: number): StartScreenModel {
  const n = m.bins.length
  if (position < n) return { ...m, focus: 'bins', bin: position }
  const focus = (['palette', 'play', 'shop'] as const)[position - n]
  return { ...m, focus }
}

function moveFocus(m: StartScreenModel, delta: -1 | 1): StartScreenModel {
  const count = m.bins.length + 3
  const next = ((focusPosition(m) + delta) % count + count) % count
  return atPosition(m, next)
}

// Cycle the selection over -1 (nothing worn) and the item indices, wrapping at both ends.
function cycleSelected(selected: number, count: number, delta: -1 | 1): number {
  const shifted = selected + 1
  return ((shifted + delta) % (count + 1) + (count + 1)) % (count + 1) - 1
}

function stepBin(m: StartScreenModel, delta: -1 | 1): StartScreenModel {
  const index = Math.min(Math.max(m.bin, 0), Math.max(0, m.bins.length - 1))
  const bin = m.bins[index]
  if (bin === undefined) return m
  const selected = cycleSelected(bin.selected, bin.items.length, delta)
  const bins = m.bins.map((entry, i) => (i === index ? { ...entry, selected } : entry))
  return { ...m, bins }
}

function stepPalette(m: StartScreenModel, delta: -1 | 1): StartScreenModel {
  const size = m.palette.length
  if (size === 0) return m
  const at = m.palette.indexOf(m.colour)
  const from = at < 0 ? 0 : at
  return { ...m, colour: m.palette[(from + delta + size) % size] }
}

export function startStep(
  m: StartScreenModel,
  action: Action,
): { model: StartScreenModel; effect: 'play' | 'shop' | 'wear' | null } {
  switch (action) {
    case 'up':
    case 'down':
      return { model: moveFocus(m, action === 'down' ? 1 : -1), effect: null }
    case 'left':
    case 'right': {
      const delta = action === 'right' ? 1 : -1
      if (m.focus === 'bins') return { model: stepBin(m, delta), effect: 'wear' }
      if (m.focus === 'palette') return { model: stepPalette(m, delta), effect: 'wear' }
      return { model: { ...m, focus: m.focus === 'play' ? 'shop' : 'play' }, effect: null }
    }
    case 'confirm':
      if (m.focus === 'play') return { model: m, effect: 'play' }
      if (m.focus === 'shop') return { model: m, effect: 'shop' }
      return { model: m, effect: null }
    default:
      return { model: m, effect: null }
  }
}
