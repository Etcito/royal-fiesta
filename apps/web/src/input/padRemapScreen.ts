import { DEFAULT_PAD_MAP } from '@royal-fiesta/game/client/padMap'
import type { PadMapStore } from '@royal-fiesta/game/client/padMap'
import { listenFor, pressed, remapRows, startRemap } from '@royal-fiesta/game/screens/padRemap'

const ACCENT = '#ff77c8'
const BUTTON_NAMES: Readonly<Record<number, string>> = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 9: 'Start' }
const PANEL_WIDTH = 680
const PANEL_HEIGHT = 540
const ROW_TOP = 146
const ROW_STEP = 64
const ROW_HEIGHT = 54

export function mountPadRemap(
  root: HTMLElement,
  store: PadMapStore,
  pads: () => readonly (Gamepad | null)[]
): { close(): void } {
  const canvas = root.ownerDocument.createElement('canvas')
  canvas.className = 'rf-remap'
  canvas.setAttribute('role', 'dialog')
  canvas.setAttribute('aria-label', 'Controller remapping')
  Object.assign(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'auto', touchAction: 'none', zIndex: '100'
  })
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Controller remapping requires a 2D canvas')
  const context = ctx
  root.appendChild(canvas)

  function firstPad(): Gamepad | null {
    return pads().find(pad => pad !== null && pad.connected) ?? null
  }

  let pad = firstPad()
  let state = startRemap(pad ? store.get(pad.id) : DEFAULT_PAD_MAP, pad?.id ?? '')
  let focus = 0
  let held: boolean[] = []
  let closed = false
  let width = 0
  let height = 0
  let dpr = 1
  let scale = 1
  let left = 0
  let top = 0

  function draw(): void {
    if (closed) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)
    context.fillStyle = 'rgba(27, 15, 46, 0.92)'
    context.fillRect(0, 0, width, height)
    context.translate(left, top)
    context.scale(scale, scale)
    context.textBaseline = 'middle'
    context.textAlign = 'left'
    context.fillStyle = '#ffffff'
    context.font = 'bold 40px system-ui'
    context.fillText('Controller', 20, 34)
    context.font = 'bold 17px system-ui'
    context.fillText(pad?.id ?? 'No controller connected - showing defaults', 20, 86, PANEL_WIDTH - 40)
    context.fillStyle = ACCENT
    context.fillRect(20, 114, PANEL_WIDTH - 40, 2)

    const rows = remapRows(state)
    for (let index = 0; index <= rows.length; index++) {
      const y = ROW_TOP + index * ROW_STEP
      const row = rows[index]
      if (index === focus) {
        context.fillStyle = 'rgba(255, 119, 200, 0.18)'
        context.fillRect(0, y, PANEL_WIDTH, ROW_HEIGHT)
        context.fillStyle = ACCENT
        context.fillRect(0, y, 4, ROW_HEIGHT)
      }
      context.font = 'bold 22px system-ui'
      context.fillStyle = row?.listening ? ACCENT : '#ffffff'
      if (row?.listening) {
        context.fillText(`Press a button for ${row.label}...`, 20, y + ROW_HEIGHT / 2)
      } else if (row) {
        context.fillText(row.label, 20, y + ROW_HEIGHT / 2)
        const name = BUTTON_NAMES[row.button]
        context.textAlign = 'right'
        context.fillText(`Button ${row.button}${name ? ` [${name}]` : ''}`, PANEL_WIDTH - 20, y + ROW_HEIGHT / 2)
        context.textAlign = 'left'
      } else {
        context.fillText('Reset to defaults', 20, y + ROW_HEIGHT / 2)
      }
    }
    context.fillStyle = '#ffffff'
    context.font = 'bold 17px system-ui'
    context.fillText('Enter: remap - R: reset - Esc: back', 20, 512)
  }

  function resize(): boolean {
    const rect = canvas.getBoundingClientRect()
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2)
    if (width === rect.width && height === rect.height && dpr === nextDpr) return false
    width = rect.width
    height = rect.height
    dpr = nextDpr
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    scale = Math.min(1, width / (PANEL_WIDTH + 32), height / (PANEL_HEIGHT + 32)) || 1
    left = (width - PANEL_WIDTH * scale) / 2
    top = (height - PANEL_HEIGHT * scale) / 2
    return true
  }

  function syncPad(): boolean {
    const next = firstPad()
    const changed = next?.id !== pad?.id || next?.index !== pad?.index
    pad = next
    if (!changed) return false
    state = startRemap(pad ? store.get(pad.id) : DEFAULT_PAD_MAP, pad?.id ?? '')
    held = []
    return true
  }

  function reset(): void {
    store.reset(state.pad)
    state = startRemap(DEFAULT_PAD_MAP, state.pad)
    held = []
  }

  function activate(): void {
    const row = remapRows(state)[focus]
    if (row) {
      state = listenFor(state, row.action)
      held = pad ? pad.buttons.map(button => button.pressed) : []
    } else {
      reset()
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    const key = event.code || event.key
    if (!['ArrowUp', 'ArrowDown', 'Enter', 'KeyR', 'r', 'R', 'Escape'].includes(key)) return
    event.stopPropagation()
    event.preventDefault()
    if (event.repeat && key !== 'ArrowUp' && key !== 'ArrowDown') return
    syncPad()
    const count = remapRows(state).length + 1
    if (key === 'ArrowUp') focus = (focus + count - 1) % count
    else if (key === 'ArrowDown') focus = (focus + 1) % count
    else if (key === 'Enter') activate()
    else if (key === 'Escape') {
      if (state.action !== null) state = startRemap(state.map, state.pad)
      else close()
    } else reset()
    draw()
  }

  function onClick(event: MouseEvent): void {
    event.stopPropagation()
    event.preventDefault()
    syncPad()
    resize()
    const rect = canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left - left) / scale
    const y = (event.clientY - rect.top - top) / scale - ROW_TOP
    const index = Math.floor(y / ROW_STEP)
    if (x >= 0 && x <= PANEL_WIDTH && y >= 0 && y % ROW_STEP <= ROW_HEIGHT && index <= remapRows(state).length) {
      focus = index
      activate()
    }
    draw()
  }

  function onResize(): void {
    resize()
    draw()
  }

  function poll(): void {
    if (closed) return
    const changed = syncPad()
    const resized = resize()
    let dirty = changed || resized
    if (state.action !== null && pad !== null) {
      const buttons = pad.buttons.map(button => button.pressed)
      // A button held when listening starts must be released before it can bind.
      const button = buttons.findIndex((down, index) => index < 32 && down && !held[index])
      held = buttons
      if (button !== -1) {
        state = pressed(state, button)
        store.set(state.pad, state.map)
        dirty = true
      }
    }
    if (dirty) draw()
  }

  function close(): void {
    if (closed) return
    closed = true
    window.clearInterval(interval)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('resize', onResize)
    canvas.removeEventListener('click', onClick)
    canvas.remove()
    root.dispatchEvent(new CustomEvent('rf-remap-close'))
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('resize', onResize)
  canvas.addEventListener('click', onClick)
  resize()
  draw()
  const interval = window.setInterval(poll, 16)
  return { close }
}
