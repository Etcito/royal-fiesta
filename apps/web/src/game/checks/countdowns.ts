// Real App, real HUD writes, fixed simulation steps. Async work gets task turns, never timed sleeps.
// The show screens step faster than real time: 3 ticks per frame is the fixed-step rate the uiTour and the
// vote check already use, so a whole show finishes inside one GPU job. Each timed screen is sampled from
// the frame it is first displayed, which is entered with dt 0.
import type { TourDeps, TourGame } from '../uiTour.ts'
import type { WidgetProps } from '../../ui/screenMap.ts'
import { checkBoot, nextTask, publishPhase, yieldTask } from './boot.ts'
import { ELIM_SHOW } from '../../../../../packages/game/src/flow/elimShow.ts'

export const name = 'countdowns'
const DT = 1 / 60
const STEP = 3 / 60
const MS = DT * 1000
const BUDGET = 60000
const NAV_FRAMES = 3600
const PAUSE_FRAMES = 300
const TIMERS = new Set(['hub', 'vote', 'countdown', 'result', 'elimShow', 'podium', 'endScreen'])
// Four displayed samples are the minimum; the timed screens keep sampling across their whole count.
const NEXT_SAMPLES: Readonly<Record<string, number>> = {
  hub: 25, vote: 3, countdown: 45, result: 3, elimShow: 3, podium: 3, endScreen: 3,
}
const DIGITS: Readonly<Record<string, number>> = { '3': 4000, '2': 3000, '1': 2000, GO: 1000 }
type Props = Record<string, WidgetProps>
interface Sample { remaining: number | null; elapsedMs: number; hud: Props }
interface Row { screen: string; full: number; first: Sample; next: Sample[]; lifetimeMs?: number }
interface StartInventory { startView?: boolean }

function key(code: string): void {
  for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }))
}

async function step(game: TourGame, dt: number): Promise<void> {
  game.step(dt)
  await nextTask()
}

// Steps fixed game time until the screen changes; the action runs on the settled previous screen.
async function waitScreen(game: TourGame, current: () => string, target: string, act: () => void, frames = NAV_FRAMES): Promise<void> {
  act()
  for (let frame = 0; frame < frames; frame++) {
    publishPhase(`countdowns: waiting for '${target}', frame ${frame} on '${current()}'`)
    if (current() === target) return
    if (current() === 'error') throw new Error(`countdowns: the App reached its error screen while waiting for '${target}'`)
    const stepped = current()
    game.step(DT)
    await yieldTask(stepped)
  }
  throw new Error(`countdowns: screen '${target}' did not arrive within ${frames} frames (on '${current()}')`)
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
  const startedAt = performance.now()
  try {
    const boot = await checkBoot(deps)
    game = boot.game
    if (!boot.json.ok) throw new Error(`boot: ${boot.json.error ?? boot.json.screen}`)
    const live = game
    // The uaa host shows the screen it last presented; the App's nav screen changes a beat earlier
    // (startShow dispatches 'vote' outside a frame), so the show loop reads nav to freeze before a step.
    const shown = (): string => live.host.currentScreen()
    const current = (): string => (live.inventory() as { screen: string }).screen
    let hud: Props = {}
    let menu: Props = {}
    const setHud = live.host.setHud
    live.host.setHud = values => { hud = values; setHud.call(live.host, values) }
    const present = live.host.present
    live.host.present = model => {
      const next: Props = { title: { text: model.title } }
      for (let i = 0; i < model.lines.length; i++) next[`line-${i}`] = { text: model.lines[i] }
      menu = next
      present.call(live.host, model)
    }
    const prop = (id: string): WidgetProps | undefined => menu[id] ?? hud[id]
    let elapsed = 0
    const sample = (screen: string): Sample => {
      let remaining: number | null = null
      if (screen === 'vote') {
        const value = hud['vote-time-bar']?.value
        if (typeof value === 'number' && Number.isFinite(value)) remaining = value * 5000
      } else if (screen === 'countdown') {
        const text = hud['countdown-number']?.text
        const digit = typeof text === 'object' && text !== null && 'count' in text ? String(text.count) : ''
        remaining = DIGITS[digit] ?? null
      } else if (screen === 'hub') {
        const match = String(menu['line-0']?.text ?? '').match(/Round starts in (\d+) s/)
        if (match) remaining = Number(match[1]) * 1000
      }
      const ids = screen === 'vote' ? ['vote-time', 'vote-time-bar'] : screen === 'countdown' ? ['countdown-number']
        : screen === 'hub' ? ['line-0'] : screen === 'elimShow' ? ['elim-counter', 'elim-now']
        : screen === 'endScreen' ? ['end-winner', 'end-ticket'] : ['title', 'line-0', 'line-1', 'line-2']
      const props = Object.fromEntries(ids.filter(id => prop(id) !== undefined).map(id => [id, prop(id)!]))
      return { remaining, elapsedMs: elapsed, hud: structuredClone(props) }
    }
    const ready = (screen: string): boolean => {
      if (screen === 'hub') return /Round starts in \d+ s/.test(String(menu['line-0']?.text ?? ''))
      if (screen === 'vote') return typeof hud['vote-time-bar']?.value === 'number'
      if (screen === 'countdown') return hud['countdown-number'] !== undefined
      if (screen === 'elimShow') return hud['elim-counter'] !== undefined
      return true
    }
    const fullOf = (screen: string): number => screen === 'hub' || screen === 'vote' ? 1000
      : screen === 'countdown' || screen === 'result' ? 4000
      : screen === 'elimShow' ? eliminationDuration(hud) : screen === 'podium' ? 2500 : 6000
    // The boot lands on the start screen before its penguin art mounts; keys only reach startStep after it.
    let mounted = false
    for (let frame = 0; frame < NAV_FRAMES && !mounted; frame++) {
      mounted = (live.inventory() as StartInventory).startView === true
      if (!mounted) await step(live, DT)
    }
    if (!mounted) throw new Error('countdowns: the start screen view never mounted')
    await step(live, DT)
    await waitScreen(live, shown, 'hub', () => {
      // Five ArrowDowns walk the 4 bins -> palette -> Play, then Enter runs the hub.
      for (let i = 0; i < 5; i++) key('ArrowDown')
      key('Enter')
    })
    let previous = ''
    let active: Row | null = null
    let lastDt = 0
    let paused = false
    let returned = false
    const finish = (): void => {
      if (active === null) return
      active.lifetimeMs = elapsed
      if (active.screen !== 'hub' && Math.abs(elapsed - active.full) > lastDt * 1000 + 0.01) {
        failures.push(`${active.screen}: lifetime ${Math.round(elapsed)} ms, expected ${active.full}`)
      }
      active = null
    }
    const stepDt = (screen: string): number =>
      (screen === 'vote' || screen === 'podium') && active !== null && active.next.length < 3 ? DT : STEP
    for (let frame = 0; frame < BUDGET; frame++) {
      if (performance.now() - startedAt > 240_000) { failures.push('the show did not finish within 240 s'); break }
      const screen = current()
      publishPhase(`countdowns: frame ${frame} on '${screen}', elapsed ${Math.round(elapsed)} ms`)
      if (screen === 'error') throw new Error('countdowns: the App reached error during the show')
      if (screen !== previous) {
        finish()
        previous = screen
        elapsed = 0
        lastDt = 0
        hud = {}
        menu = {}
        if (screen === 'start') { returned = true; break }
        await step(live, 0)
        continue
      }
      if (TIMERS.has(screen)) {
        if (active === null) {
          // A pending vote also reports countdown until the network offers its candidates.
          // Keep the protocol clock moving while no timer is displayed; dt 0 deadlocks
          // that handoff (notably the final round). The director starts a ready timer at 0.
          if (!ready(screen)) { await step(live, DT); continue }
          const first = sample(screen)
          active = { screen, full: fullOf(screen), first, next: [] }
          screens.push(active)
          if (first.remaining === null && (screen === 'hub' || screen === 'vote' || screen === 'countdown')) {
            failures.push(`${screen}: no displayed timer on its first frame`)
          } else if (first.remaining !== null && (!Number.isFinite(first.remaining) || Math.abs(first.remaining - active.full) > 0.01)) {
            failures.push(`${screen}: first remaining ${first.remaining}, expected ${active.full}`)
          }
        } else if (active.next.length < (NEXT_SAMPLES[screen] ?? 3)) {
          const next = sample(screen)
          const prev = active.next.at(-1) ?? active.first
          if (next.remaining !== null && prev.remaining !== null && next.remaining > prev.remaining) failures.push(`${screen}: timer increased`)
          if (screen === 'vote' && next.remaining !== null && prev.remaining !== null && Math.abs(prev.remaining - next.remaining - MS) > 0.01) failures.push('vote: HUD timer did not decrease by one step')
          active.next.push(next)
        }
        // Pause a held screen and keep it paused past its hold: if its clock advanced it leaves on resume.
        if (screen === 'result' && active.next.length >= 3 && !paused) {
          key('Escape')
          await step(live, 0)
          if (current() !== 'pause') throw new Error('result did not pause')
          const before = elapsed
          for (let i = 0; i < PAUSE_FRAMES; i++) await step(live, DT)
          if (current() !== 'pause') failures.push('result left pause without input')
          key('Escape')
          await step(live, 0)
          if (current() !== 'result') failures.push('result expired while paused')
          if (elapsed !== before) failures.push('result lifetime advanced while paused')
          paused = true
        }
      }
      const dt = stepDt(screen)
      await step(live, dt)
      if (active !== null && dt > 0) { elapsed += dt * 1000; lastDt = dt }
    }
    if (!returned) failures.push(`show did not return to start: it stopped on '${current()}' after ${Math.round(performance.now() - startedAt)} ms, last screen change to '${previous}'`)
    for (const screen of TIMERS) if (!screens.some(row => row.screen === screen && row.next.length >= 3)) failures.push(`missing displayed samples: ${screen}`)
    if (!paused) failures.push('the held-screen pause was not exercised')
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  } finally { game?.dispose() }
  return { json: { ok: failures.length === 0, screens, failures }, files: [] }
}
