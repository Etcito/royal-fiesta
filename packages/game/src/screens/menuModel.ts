// What each screen shows and which buttons it has, plus a DOM-free layout and
// hit test, so browser clicks, keys and the scripted tour share one code path.
import type { LoadProgress } from '../content.ts'
import type { Action, Screen } from './nav.ts'
import { SETTINGS_ROWS, describeRow, type KeyAction, type Settings } from './settings.ts'

export type MenuCmd =
  | { k: 'action', action: Action }
  | { k: 'row', row: number }
  | { k: 'back' }

export interface MenuButton {
  label: string
  cmd: MenuCmd
}

export interface MenuModel {
  screen: Screen
  title: string
  lines: string[]
  buttons: MenuButton[]
  hint: string
  // The HUD is drawn instead of a panel.
  overlay: boolean
}

export interface MenuCtx {
  settings: Settings
  // The action waiting for a key on the settings screen.
  rebinding: KeyAction | null
  // A settings/rebind refusal, or the error screen's message.
  error: string | null
  // Lines the app computes: queue count, result rows, podium names.
  info: readonly string[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const CREDITS: readonly string[] = Object.freeze([
  'Royal Fiesta, MIT license',
  'Built on GameSaloon (relay)',
  'gamesaloon-rollback (rollback netcode)',
  'Rapier (physics, deterministic build)',
  'RAA (renderer)',
  'Made by the Royal Fiesta contributors',
])

export const HINTS = Object.freeze({
  menu: 'Up/Down choose - Enter select - Esc back',
  hub: 'WASD/ZQSD move - mouse or right stick: camera - 1-4 emote - the round starts by itself - Esc menu',
  hud: 'Esc pause',
} as const)

const LABELS: Readonly<Record<Action, string>> = Object.freeze({
  play: 'Play',
  playOnline: 'Play online',
  settings: 'Settings',
  credits: 'Credits',
  queue: 'Find a match',
  toHub: 'Back to hub',
  resume: 'Resume',
  leave: 'Leave',
  retry: 'Retry',
  join: 'Join this lobby',
  spectate: 'Spectate',
  newLobby: 'New lobby',
  shop: 'Shop',
  up: '\u2191',
  down: '\u2193',
  left: '\u2190',
  right: '\u2192',
  confirm: 'Continue',
})

const TITLES: Readonly<Record<Screen, string>> = Object.freeze({
  title: 'Royal Fiesta',
  hub: 'Hub',
  queue: 'Finding players',
  countdown: 'Get ready',
  round: 'Round',
  spectate: 'Spectating',
  result: 'Round result',
  podium: 'Podium',
  pause: 'Paused',
  settings: 'Settings',
  credits: 'Credits',
  error: 'Disconnected / error',
  loading: 'Loading',
  lobbyChoice: 'A lobby is open',
  lobbyLive: 'A round is on',
  start: 'Royal Fiesta',
  vote: 'Vote for the next round',
  elimShow: 'Eliminated',
  endScreen: 'Champion',
})

// vote and elimShow are HUD-like (no back button; back pauses the match).
const OVERLAY: readonly Screen[] = ['hub', 'countdown', 'round', 'spectate', 'vote', 'elimShow']
// Screens without a final 'Back' button (title is the root, the rest are HUDs).
// Loading has none either: it ends only when the load succeeds or fails.
// The lobby choice neither: unanswered (or on back) it takes its default by itself.
// The end screen offers Continue; back still leaves the game to the start menu.
const NO_BACK: readonly Screen[] = ['title', 'loading', 'lobbyChoice', 'lobbyLive', 'endScreen', ...OVERLAY]

function label(screen: Screen, a: Action): string {
  // On the error screen, leave returns to the title.
  if (screen === 'error' && a === 'leave') return 'Back to title'
  return LABELS[a]
}

export function controlLines(settings: Settings): string[] {
  const keys = settings.keys
  const movement = (action: 'forward' | 'left', alternate: string): string => {
    const boundElsewhere = Object.entries(keys).some(([other, code]) => other !== action && code === alternate)
    return keys[action] === alternate || boundElsewhere ? keys[action] : `${keys[action]}/${alternate}`
  }
  return [
    `Move: ${movement('forward', 'KeyZ')} ${movement('left', 'KeyQ')} ${keys.back} ${keys.right} or arrows or left stick`,
    'Camera: mouse (click the game to capture, Esc releases) or right stick',
    `Jump: ${keys.jump} / pad button 0`,
    `Dive: ${keys.dive} / pad button 1`,
    `Grab: ${keys.grab} / pad button 2`,
    'Emotes: 1-4',
    'Pause: Esc / pad Start',
  ]
}

// The loading screen's line: phase, count and what is being loaded.
export function progressLine(p: LoadProgress | null): string {
  if (p === null) return 'Starting...'
  return `${p.phase} ${p.done}/${p.total} ${p.label}`
}

export function menuModel(screen: Screen, actions: readonly Action[], ctx: MenuCtx): MenuModel {
  const title = TITLES[screen]
  if (OVERLAY.includes(screen)) {
    const hint = screen === 'hub' ? HINTS.hub : HINTS.hud
    return { screen, title, lines: [...ctx.info], buttons: [], hint, overlay: true }
  }
  const lines: string[] = []
  const buttons: MenuButton[] = actions.map((action) => ({
    label: label(screen, action), cmd: { k: 'action', action },
  }))
  switch (screen) {
    case 'pause':
      lines.push(...controlLines(ctx.settings))
      break
    case 'settings':
      SETTINGS_ROWS.forEach((row, i) => {
        buttons.push({ label: describeRow(row, ctx.settings), cmd: { k: 'row', row: i } })
      })
      if (ctx.rebinding !== null) lines.push(`Press a key for ${ctx.rebinding} - Esc cancels`)
      if (ctx.error !== null) lines.push(ctx.error)
      break
    case 'error':
      lines.push(ctx.error ?? 'Unknown error')
      break
    case 'credits':
      lines.push(...CREDITS)
      break
    case 'start':
    case 'endScreen':
    case 'loading':
    case 'queue':
    case 'lobbyChoice':
    case 'lobbyLive':
    case 'result':
    case 'podium':
      lines.push(...ctx.info)
      break
  }
  if (!NO_BACK.includes(screen)) buttons.push({ label: 'Back', cmd: { k: 'back' } })
  return { screen, title, lines, buttons, hint: HINTS.menu, overlay: false }
}

// Sizes in pixels at the 1080-line base; everything scales with height/1080.
export const MENU_METRICS = Object.freeze({
  base: 1080,
  titleH: 72,
  lineH: 36,
  gapAfterText: 24,
  buttonW: 520,
  buttonH: 64,
  buttonGap: 16,
})

export interface MenuLayout {
  scale: number
  // Baseline-free tops: the renderer draws text from these y values.
  titleY: number
  lineYs: number[]
  buttons: Rect[]
}

// A centred column: title, lines, then buttons, vertically centred in the frame.
export function layoutMenu(model: MenuModel, width: number, height: number): MenuLayout {
  const m = MENU_METRICS
  const s = height / m.base
  const n = model.buttons.length
  const textH = m.titleH + model.lines.length * m.lineH + m.gapAfterText
  const buttonsH = n > 0 ? n * m.buttonH + (n - 1) * m.buttonGap : 0
  // Keep every settings row reachable as the list grows.
  const buttonScale = buttonsH > 0 ? Math.min(1, (m.base - textH) / buttonsH) : 1
  const top = Math.max(0, (m.base - textH - buttonsH * buttonScale) / 2) * s
  const lineYs = model.lines.map((_, i) => top + (m.titleH + i * m.lineH) * s)
  const w = m.buttonW * s
  const x = (width - w) / 2
  const y0 = top + textH * s
  const buttons: Rect[] = []
  for (let i = 0; i < n; i++) {
    buttons.push({ x, y: y0 + i * (m.buttonH + m.buttonGap) * buttonScale * s, w, h: m.buttonH * buttonScale * s })
  }
  return { scale: s, titleY: top, lineYs, buttons }
}

export function layoutButtons(model: MenuModel, width: number, height: number): Rect[] {
  return layoutMenu(model, width, height).buttons
}

export function hitTest(rects: readonly Rect[], x: number, y: number): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i
  }
  return -1
}

// The next focused index, wrapping both ways; -1 when there is no button.
export function moveFocus(index: number, dir: number, count: number): number {
  if (count <= 0) return -1
  const next = (index + Math.sign(dir)) % count
  return next < 0 ? next + count : next
}
