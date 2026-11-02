import type { TourDeps, TourGame } from '../uiTour.ts'

export const name = 'checkBoot'
export const BOOT_FRAMES = 600
export const BOOT_DT = 1 / 60
export const BOOT_REFUSAL = 'uiTour: the boot load is refused so the tour reaches loading with Retry'

// One task between stepped frames, never requestAnimationFrame: the GPU client runs the page in a sandboxed
// iframe placed off-screen, where rAF fires rarely or never, so a check that waited on it hung until the job
// timeout. A MessageChannel task is not throttled there and lets fetches, workers and pipelines resolve.
export function nextTask(): Promise<void> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve() }
    channel.port2.postMessage(null)
  })
}

// The GPU client bridge names window.__nmcGpuProgress when a job times out, so a stuck check says where.
export function publishPhase(text: string): void {
  if (typeof window !== 'undefined') (window as Window & { __nmcGpuProgress?: string }).__nmcGpuProgress = text
}

// Loading is asynchronous (fetches, workers and pipeline compilation), not simulated time.
// Observe the App's visible progress rather than spending its frame budget polling those jobs.
// Outside loading, yield one task; simulation still receives only BOOT_DT.
function yieldTask(screen: string): Promise<void> {
  const progress = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('#round-loading')
  if (screen === 'loading' && progress && !progress.hidden) {
    return new Promise(resolve => {
      const observer = new MutationObserver(() => { observer.disconnect(); resolve() })
      observer.observe(progress, { attributes: true, childList: true, subtree: true, characterData: true })
    })
  }
  return nextTask()
}

function retry(game: TourGame): void {
  const rect = game.host.widgetRect('act-retry')
  if (!rect) throw new Error('Retry is missing from the error screen')
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

// Leaves a successful App alive for subsequent checks; the caller owns dispose().
export async function checkBoot(deps: TourDeps): Promise<{
  game: TourGame; json: { ok: boolean; screen: string; transitions: string[]; error?: string }
}> {
  const transitions: string[] = []
  let screen = ''
  let error: string | undefined
  let retried = false
  let game: TourGame | undefined
  const logError = console.error
  // App.fail logs exactly the message it presents. Observe it even during deps.boot().
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[error-screen] ')) error = args[0].slice(15)
    logError.apply(console, args)
  }
  try {
    game = await deps.boot(e => { screen = e.to; transitions.push(e.to) })
    for (let frame = 0; frame < BOOT_FRAMES; frame++) {
      publishPhase(`boot: frame ${frame} on '${screen}'`)
      if (screen === 'start') return { game, json: { ok: true, screen, transitions } }
      if (screen === 'error') {
        if (error !== BOOT_REFUSAL || (retried && transitions.includes('loading'))) return { game, json: { ok: false, screen, transitions, error: error ?? 'Unknown boot error' } }
        if (!retried) { retry(game); retried = true }
      }
      game.step(BOOT_DT)
      await yieldTask(screen)
    }
    return { game, json: { ok: false, screen, transitions, error: `Boot did not reach start within ${BOOT_FRAMES} frames` } }
  } catch (error) {
    game?.dispose()
    throw error
  } finally { console.error = logError }
}

export async function run(_input: unknown, deps: TourDeps): Promise<{ json: Awaited<ReturnType<typeof checkBoot>>['json']; files: [] }> {
  const { game, json } = await checkBoot(deps)
  try { return { json, files: [] } } finally { game.dispose() }
}
