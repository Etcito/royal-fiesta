// lobbyUnload: prove (or disprove) that leaving the lobby for a level releases it. The page runs with
// ?test=1, so every show timer is at its minimum; this op steps fixed dt and waits only on the App's
// screen callbacks. It never sleeps in real time.
import type { TourDeps, TourGame } from '../uiTour.ts'
import { checkBoot } from './boot.ts'

export const name = 'lobbyUnload'

const DT = 1 / 60
const FAST_DT = 3 / 60
const FAST = new Set(['round', 'spectate', 'vote', 'elimShow', 'podium'])
// A whole test-mode show at 3 ticks per frame; the cap only guards against a stuck page.
const SHOW_FRAMES = 240000
const NAV_FRAMES = 600

interface PortInventory { assets: string[]; instances: number; meshes: number; textures: number; skinned: number }
interface AppInventory {
  mode: string | null
  screen: string
  hub: { alive: boolean; assets: string[]; instances: number }
  ports: { inventory: PortInventory | null; inDom: boolean; displayed: boolean }[]
  startView: boolean
  sound: { loops: string[]; emitters: string[]; music: string | null; ambience: string | null; bed: boolean }
  listeners: number
}

// Loading is asynchronous (fetches, workers, pipelines); give it a presentation callback to breathe.
function yieldTask(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

function press(key: string): void {
  const init: KeyboardEventInit = { code: key, key, bubbles: true, cancelable: true }
  window.dispatchEvent(new KeyboardEvent('keydown', init))
  window.dispatchEvent(new KeyboardEvent('keyup', init))
}

function click(game: TourGame, target: string): void {
  const rect = game.host.widgetRect(target)
  if (rect === null) throw new Error(`lobbyUnload: widget '${target}' is missing on '${game.host.currentScreen()}'`)
  const box = game.ui.getBoundingClientRect()
  const at = { clientX: box.left + rect.x + rect.w / 2, clientY: box.top + rect.y + rect.h / 2,
    bubbles: true, cancelable: true, view: window }
  const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  for (const event of [
    new PointerEvent('pointermove', { ...pointer, buttons: 0 }),
    new PointerEvent('pointerdown', { ...pointer, button: 0, buttons: 1 }),
    new MouseEvent('mousedown', { ...at, button: 0, buttons: 1 }),
    new PointerEvent('pointerup', { ...pointer, button: 0, buttons: 0 }),
    new MouseEvent('mouseup', { ...at, button: 0, buttons: 0 }),
    new MouseEvent('click', { ...at, button: 0, buttons: 0, detail: 1 }),
  ]) game.ui.dispatchEvent(event)
}

function inventory(game: TourGame): AppInventory {
  return game.inventory() as AppInventory
}

function assetsOf(view: AppInventory): string[] {
  return view.ports.flatMap(port => port.inventory?.assets ?? [])
}

function instancesOf(view: AppInventory): number {
  return view.ports.reduce((n, port) => n + (port.inventory?.instances ?? 0), 0)
}

// Steps fixed game time until the screen callback names `target`; `acts` run first, on the settled screen.
async function waitFor(game: TourGame, current: () => string, target: string, acts: () => void, frames = NAV_FRAMES): Promise<void> {
  acts()
  for (let frame = 0; frame < frames; frame++) {
    if (current() === target) return
    game.step(FAST.has(current()) ? FAST_DT : DT)
    await yieldTask()
  }
  throw new Error(`lobbyUnload: screen '${target}' did not arrive within ${frames} frames (on '${current()}')`)
}

// start -> title -> start -> hub, the route docs/screens.md gives Play through the menus.
async function toHub(game: TourGame, current: () => string): Promise<void> {
  await waitFor(game, current, 'title', () => press('Escape'))
  await waitFor(game, current, 'start', () => click(game, 'act-play'))
  await waitFor(game, current, 'hub', () => {
    // Five ArrowDowns walk the 4 bins -> palette -> Play, then Enter runs the hub.
    for (let i = 0; i < 5; i++) press('ArrowDown')
    press('Enter')
  })
}

export async function run(_input: unknown, deps: TourDeps): Promise<{
  json: { ok: boolean; A: AppInventory | null; B: AppInventory | null; C: AppInventory | null; failures: string[] }
  files: []
}> {
  let screen = ''
  const boot: TourDeps['boot'] = onScreen => deps.boot(change => { screen = change.to; onScreen(change) })
  let game: TourGame | null = null
  try {
    const result = await checkBoot({ ...deps, boot })
    game = result.game
    if (!result.json.ok) {
      return { json: { ok: false, A: null, B: null, C: null, failures: [`boot failed: ${result.json.error ?? result.json.screen}`] }, files: [] }
    }
    const current = (): string => screen
    const base = inventory(game)
    // start -> Play -> hub: the lobby.
    await toHub(game, current)
    for (let i = 0; i < 2; i++) { game.step(DT); await yieldTask() }
    const A = inventory(game)
    // Enter queues; the offline show opens on its vote, then round 0's countdown once its world loaded.
    await waitFor(game, current, 'vote', () => press('Enter'), 1800)
    for (let i = 0; i < 8; i++) { game.step(DT); await yieldTask() }
    if (current() === 'vote') {
      press('ArrowRight')
      press('Enter')
    }
    await waitFor(game, current, 'countdown', () => {}, 3600)
    const B = inventory(game)
    // The test-mode show runs itself to the end screen and back to start (votes expire at 0 ms).
    let showFrame = 0
    while (current() !== 'start' && showFrame++ < SHOW_FRAMES) {
      game.step(FAST.has(current()) ? FAST_DT : DT)
      await yieldTask()
    }
    if (current() !== 'start') {
      return { json: { ok: false, A, B, C: null, failures: ['the show did not return to start'] }, files: [] }
    }
    // Play -> hub again: the lobby comes back with its assets and instances.
    await toHub(game, current)
    for (let i = 0; i < 2; i++) { game.step(DT); await yieldTask() }
    const C = inventory(game)

    const failures: string[] = []
    const bAssets = new Set(assetsOf(B))
    const lobbyAssets = A.hub.assets.filter(asset => bAssets.has(asset))
    if (B.startView) failures.push('level 1 still has the start view mounted')
    if (B.hub.alive) failures.push('level 1 still has a live HubWorld/HubView')
    if (lobbyAssets.length > 0) failures.push(`level 1 still holds lobby assets: ${lobbyAssets.join(', ')}`)
    if (instancesOf(B) > 0) failures.push(`level 1 still holds ${instancesOf(B)} lobby instances`)
    const bLoops = new Set(B.sound.loops)
    const lobbyLoops = A.sound.loops.filter(id => bLoops.has(id))
    if (lobbyLoops.length > 0) failures.push(`level 1 still plays lobby loops: ${lobbyLoops.join(', ')}`)
    if (B.listeners > base.listeners) failures.push(`level 1 still holds ${B.listeners - base.listeners} lobby listeners`)
    const cAssets = new Set(assetsOf(C))
    const missing = A.hub.assets.filter(asset => !cAssets.has(asset))
    if (missing.length > 0) failures.push(`the hub lacks assets it had: ${missing.join(', ')}`)
    if (instancesOf(C) < A.hub.instances) failures.push(`the hub has ${instancesOf(C)} instances, fewer than the ${A.hub.instances} it had`)
    if (!C.hub.alive) failures.push('the hub did not come back alive')
    return { json: { ok: failures.length === 0, A, B, C, failures }, files: [] }
  } catch (error) {
    return { json: { ok: false, A: null, B: null, C: null, failures: [error instanceof Error ? error.message : String(error)] }, files: [] }
  } finally {
    game?.dispose()
  }
}
