// Real App, real HUD writes, fixed simulation steps. Async work gets task turns, never timed sleeps.
import type { TourDeps, TourGame } from '../uiTour.ts'
import type { WidgetProps } from '../../ui/screenMap.ts'
import { checkBoot } from './boot.ts'
import { ELIM_SHOW } from '../../../../../packages/game/src/flow/elimShow.ts'

export const name = 'countdowns'
const DT = 1 / 60
const MS = DT * 1000
const BUDGET = 240000
const TIMERS = new Set(['hub', 'vote', 'countdown', 'result', 'elimShow', 'podium', 'endScreen'])
type Props = Record<string, WidgetProps>
interface Sample { remaining: number | null; elapsedMs: number; hud: Props }
interface Row { screen: string; full: number; first: Sample; next: Sample[]; lifetimeMs?: number }

function key(code: string): void {
  for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }))
}
function click(game: TourGame, id: string): void {
  const rect = game.host.widgetRect(id)
  if (!rect) throw new Error(`countdowns: missing ${id}`)
  const box = game.ui.getBoundingClientRect()
  const at = { clientX: box.left + rect.x + rect.w / 2, clientY: box.top + rect.y + rect.h / 2,
    bubbles: true, cancelable: true, view: window }
  const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  game.ui.dispatchEvent(new PointerEvent('pointermove', pointer))
  game.ui.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, button: 0, buttons: 1 }))
  game.ui.dispatchEvent(new MouseEvent('mousedown', { ...at, button: 0, buttons: 1 }))
  game.ui.dispatchEvent(new PointerEvent('pointerup', { ...pointer, button: 0, buttons: 0 }))
  game.ui.dispatchEvent(new MouseEvent('mouseup', { ...at, button: 0, buttons: 0 }))
  game.ui.dispatchEvent(new MouseEvent('click', { ...at, button: 0, detail: 1 }))
}
function task(): Promise<void> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve() }
    channel.port2.postMessage(null)
  })
}

// The HUD exposes the entrant/qualifier counts, enough to derive the documented drop schedule.
function eliminationDuration(hud: Props): number {
  const counts = String(hud['elim-counter']?.text).match(/(\d+) to (\d+)/)
  if (!counts) throw new Error('elimShow: missing HUD counter')
  const lost = Number(counts[1]) - Number(counts[2])
  const interval = Math.min(1000, Math.max(40, (7000 - ELIM_SHOW.skipAfterMs) / Math.max(1, lost)))
  return Math.min(ELIM_SHOW.maxMs, Math.max(ELIM_SHOW.minMs, ELIM_SHOW.skipAfterMs + lost * interval + 600))
}

export async function run(_input: unknown, deps: TourDeps): Promise<{ json: { ok: boolean; screens: Row[]; failures: string[] }; files: [] }> {
  const screens: Row[] = []
  const failures: string[] = []
  let game: TourGame | null = null
  try {
    const boot = await checkBoot(deps)
    game = boot.game
    if (!boot.json.ok) throw new Error(`boot: ${boot.json.error ?? boot.json.screen}`)
    let hud: Props = {}
    const setHud = game.host.setHud
    game.host.setHud = values => { hud = { ...hud, ...values }; setHud.call(game!.host, values) }
    const present = game.host.present
    game.host.present = model => {
      hud.title = { text: model.title }
      // Lobby lines are supplied through menu props rather than setHud.
      for (let i = 0; i < model.lines.length; i++) hud[`line-${i}`] = { text: model.lines[i] }
      present.call(game!.host, model)
    }
    let active: Row | null = null
    let elapsed = 0
    let paused = false
    let returned = false
    const step = (): void => { game!.step(DT) }
    const sample = (screen: string): Sample => {
      let remaining: number | null = null
      if (screen === 'vote') remaining = Number(hud['vote-time-bar']?.value) * 5000
      if (screen === 'countdown') {
        const text = hud['countdown-number']?.text
        const digit = typeof text === 'object' && text !== null && 'count' in text ? String(text.count) : ''
        remaining = ({ '3': 4000, '2': 3000, '1': 2000, GO: 1000 } as Record<string, number>)[digit] ?? NaN
      }
      if (screen === 'hub') remaining = Number(String(hud['line-0']?.text).match(/Round starts in (\d+) s/)?.[1]) * 1000
      const ids = screen === 'vote' ? ['vote-time', 'vote-time-bar'] : screen === 'countdown' ? ['countdown-number']
        : screen === 'hub' ? ['line-0'] : screen === 'elimShow' ? ['elim-counter', 'elim-now']
        : screen === 'endScreen' ? ['end-winner', 'end-ticket'] : ['title', 'line-0', 'line-1', 'line-2']
      const props = Object.fromEntries(ids.filter(id => hud[id] !== undefined).map(id => [id, hud[id]]))
      return { remaining, elapsedMs: elapsed, hud: structuredClone(props) }
    }
    // Enter the local hub through the documented menus. The hidden prepared mode must not age.
    for (let i = 0; i < 90; i++) step()
    const reach = async (target: string, action: () => void): Promise<void> => {
      action()
      for (let i = 0; i < 600; i++) {
        step()
        if (game!.host.currentScreen() === target) return
        await task()
      }
      throw new Error(`countdowns: did not reach ${target}`)
    }
    await reach('title', () => key('Escape'))
    await reach('start', () => click(game!, 'act-play'))
    await reach('hub', () => {
      for (let i = 0; i < 4; i++) key('ArrowDown')
      key('Enter')
    })
    for (let frame = 0; frame < BUDGET; frame++) {
      const screen = game.host.currentScreen()
      if (screen === 'error') throw new Error('App reached error during show')
      if ((active as Row | null)?.screen !== screen) {
        if (active) {
          active.lifetimeMs = elapsed
          if (active.screen !== 'hub' && Math.abs(elapsed - active.full) > MS + 0.01) failures.push(`${active.screen}: lifetime ${elapsed}, expected ${active.full}`)
        }
        active = null
        elapsed = 0
        if (TIMERS.has(screen)) {
          const full: number = screen === 'hub' || screen === 'vote' ? 1000 : screen === 'countdown' || screen === 'result' ? 4000
            : screen === 'elimShow' ? eliminationDuration(hud) : screen === 'podium' ? 2500 : 6000
          active = { screen, full, first: sample(screen), next: [] }
          screens.push(active)
          if (active.first.remaining !== null && (!Number.isFinite(active.first.remaining) || Math.abs(active.first.remaining - full) > MS + 0.01)) {
            failures.push(`${screen}: first remaining ${active.first.remaining}, expected ${full}`)
          }
        }
      } else if (active && active.next.length < 3) {
        const next = sample(screen)
        const prev = active.next.at(-1) ?? active.first
        if (next.remaining !== null && prev.remaining !== null && next.remaining > prev.remaining) failures.push(`${screen}: timer increased`)
        if (screen === 'vote' && next.remaining !== null && prev.remaining !== null && Math.abs(prev.remaining - next.remaining - MS) > 0.01) failures.push('vote: HUD timer did not decrease by one step')
        active.next.push(next)
      }
      if (screen === 'podium' && active?.next.length === 3 && !paused) {
        key('Escape'); step()
        if (game.host.currentScreen() !== 'pause') throw new Error('podium did not pause')
        for (let i = 0; i < 60; i++) step()
        if (game.host.currentScreen() !== 'pause') failures.push('podium left pause without input')
        key('Escape'); game.step(0)
        if (game.host.currentScreen() !== 'podium') failures.push('podium expired while paused')
        // Its eventual lifetime must still be the entire hold in unpaused stepped frames.
        paused = true
      }
      if (screen === 'start') { returned = true; break }
      step()
      if (active) elapsed += MS
      // Yield often during loading; batch CPU simulation without tying it to real-time frames.
      if (screen === 'loading' || frame % 60 === 0) await task()
    }
    if (!returned) failures.push('show did not return to start')
    for (const screen of TIMERS) if (!screens.some(row => row.screen === screen && row.next.length === 3)) failures.push(`missing four displayed samples: ${screen}`)
    if (!paused) failures.push('podium pause was not exercised')
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  } finally { game?.dispose() }
  return { json: { ok: failures.length === 0, screens, failures }, files: [] }
}
