import { SETTINGS_ROW_SLOTS, type SettingsPage } from '@royal-fiesta/game/screens/settingsPages'
import type { WidgetProps } from '../../ui/screenMap.ts'
import type { TourDeps, TourGame } from '../uiTour.ts'
import { yieldTask } from './boot.ts'
import { focusTab } from './settingsTabs.ts'
import { capture, pipelinesReady } from './wardrobe.ts'

export const name = 'settingsPages'

type Props = Record<string, WidgetProps>
type CheckFile = { name: string; blob: Blob }

function propText(props: Props, id: string): string {
  return String(props[id]?.text ?? '')
}

function click(game: TourGame, id: string): void {
  const rect = game.host.widgetRect(id)
  if (rect === null) throw new Error(`missing ${id} on ${game.host.currentScreen()}`)
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

async function viewportCapture(game: TourGame): Promise<Blob> {
  const uiBox = game.ui.getBoundingClientRect()
  const shots = [...game.views.querySelectorAll('canvas'), game.ui].map(canvas => ({
    rect: canvas.getBoundingClientRect(), bitmap: createImageBitmap(canvas),
  }))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(uiBox.width))
  out.height = Math.max(1, Math.round(uiBox.height))
  const ctx = out.getContext('2d')
  if (ctx === null) throw new Error('no 2D canvas for portrait capture')
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#000'
  ctx.fillRect(0, 0, out.width, out.height)
  for (const shot of shots) {
    const bitmap = await shot.bitmap
    ctx.drawImage(bitmap, shot.rect.left - uiBox.left, shot.rect.top - uiBox.top, shot.rect.width, shot.rect.height)
    bitmap.close()
  }
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('portrait capture could not be encoded')
  return blob
}

// One App for both sizes. The second boot (dispose, then a new App and a new uaa GPU device on the same page)
// froze the GPU client's page in requestDevice ("awaiting: UI GPU device", runs 12341 and 12345). The App
// follows a #screens/#views size change on its next frame, as on a phone rotation, so the op only resizes.
function setSize(portrait: boolean): () => void {
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const width = portrait ? 390 : 1280
  const height = portrait ? 844 : 720
  const style = document.createElement('style')
  style.textContent = `#screens, #views {width:${width}px;height:${height}px;right:auto;bottom:auto}`
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  document.head.append(style)
  return () => {
    style.remove()
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
    if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

async function runSize(live: TourGame, portrait: boolean, files: CheckFile[], report: (failure: string) => void): Promise<void> {
  const prefix = portrait ? 'phone-' : ''
  const fail = (label: string, condition: boolean): void => { if (!condition) report(`${prefix}${label}`) }
  // A missed state is reported and the next section still runs, so one pass lists every failure.
  const section = async (label: string, work: () => Promise<void>): Promise<void> => {
    try { await work() } catch (error) { report(`${prefix}${label}: ${errorText(error)}`) }
  }
  // present() sets the screen's title, lines and buttons (act-settings on start and pause); setHud() only the
  // settings rows and tabs. Read what the host last set for each widget, whichever call set it.
  const props = new Proxy({} as Props, {
    get: (_, id) => typeof id === 'string' ? live.host.widget(id) ?? undefined : undefined,
  })
  const step = async (): Promise<void> => { live.step(1 / 60); await yieldTask(live.host.currentScreen()) }
  // A UI state follows its key within a few frames. A short deadline per wait keeps one missed state from eating
  // the page's whole render budget (run 12350: one 120 s miss, then the page timed out before the op returned its
  // failures); only the first wait also covers the start scene's load.
  const waitFor = async (predicate: () => boolean, what: string, ms = 15000): Promise<void> => {
    const end = Date.now() + ms
    while (!predicate()) {
      if (live.host.currentScreen() === 'error' || Date.now() >= end) {
        throw new Error(`${what}: ${live.host.currentScreen()}`)
      }
      await step()
    }
  }
  const press = async (key: string): Promise<void> => {
    const init: KeyboardEventInit = { code: key, key, bubbles: true, cancelable: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
    window.dispatchEvent(new KeyboardEvent('keyup', init))
    await step()
    await step()
  }
  const focusUntil = async (key: string, predicate: () => boolean, what: string): Promise<void> => {
    for (let presses = 0; !predicate(); presses++) {
      if (presses >= 32 || live.host.currentScreen() === 'error') throw new Error(`${what}: ${live.host.focused()}`)
      await press(key)
    }
  }
  const openPage = (page: SettingsPage): Promise<void> => focusTab(page, () => live.host.focused(), press)
  const take = async (file: string): Promise<void> => {
    await pipelinesReady(live, file)
    live.step(1 / 60)
    // The shared compositor is 16:9; retain the real viewport ratio for phone captures.
    const blob = portrait ? await viewportCapture(live) : (await capture(live)).composite
    files.push({ name: prefix + file + '.png', blob })
  }

  await section('Audio page', async () => {
    await waitFor(() => live.host.currentScreen() === 'start' && props['act-settings']?.visible === true
      && live.host.widgetRect('act-settings') !== null, 'start screen', 120000)
    click(live, 'act-settings')
    await waitFor(() => live.host.currentScreen() === 'settings' && !!props.title?.text, 'settings screen')
    fail('Audio title', propText(props, 'title') === 'Audio')
    fail('Master volume row', propText(props, 'row-0') === 'Master volume')
    fail('Master volume value 80%', propText(props, 'value-0') === '80%')
    await press('ArrowLeft')
    await waitFor(() => propText(props, 'value-0') === '70%', 'master volume 70%')
    fail('master volume left adjustment', propText(props, 'value-0') === '70%')
    await press('ArrowRight')
    await waitFor(() => propText(props, 'value-0') === '80%', 'master volume 80%')
    fail('master volume right adjustment', propText(props, 'value-0') === '80%')
    await take('audio')
  })

  await section('Graphics page', async () => {
    await openPage('graphics')
    await waitFor(() => propText(props, 'title') === 'Graphics', 'Graphics page')
    fail('Graphics title', propText(props, 'title') === 'Graphics')
    const lod = Array.from({ length: SETTINGS_ROW_SLOTS }, (_, i) => props[`row-${i}`])
      .find(value => value?.visible === true && value.text === 'LOD offset')
    fail('LOD offset unavailable row', lod?.disabled === true)
    fail('LOD offset note', propText(props, 'line-0').includes('LOD offset'))
    await take('graphics')
  })

  await section('Controls page', async () => {
    await openPage('controls')
    await waitFor(() => propText(props, 'title') === 'Controls', 'Controls page')
    fail('Controls title', propText(props, 'title') === 'Controls')
    await focusUntil('ArrowDown', () => live.host.focused() === 'row-0', 'Forward row focus')
    fail('Forward row', propText(props, 'row-0') === 'Forward')
    await press('Enter')
    await waitFor(() => propText(props, 'value-0') === '[ Press a key... ]', 'rebind prompt')
    fail('rebind prompt', propText(props, 'value-0') === '[ Press a key... ]')
    await press('KeyK')
    await waitFor(() => propText(props, 'value-0') === '[ K ]', 'KeyK rebind')
    fail('KeyK binding', propText(props, 'value-0') === '[ K ]')
    await press('Enter')
    await waitFor(() => propText(props, 'value-0') === '[ Press a key... ]', 'restore rebind prompt')
    await press('KeyW')
    await waitFor(() => propText(props, 'value-0') === '[ W ]', 'KeyW restore')
    fail('KeyW restored', propText(props, 'value-0') === '[ W ]')
    await take('controls')
  })

  await section('Gameplay page', async () => {
    await openPage('gameplay')
    await waitFor(() => propText(props, 'title') === 'Gameplay & Accessibility', 'Gameplay page')
    fail('Gameplay credits button', props['act-credits']?.visible === true)
    await take('gameplay')
  })

  await section('Back to start', async () => {
    await press('Escape')
    await waitFor(() => live.host.currentScreen() === 'start', 'return to start')
  })
  if (portrait) return

  await section('Pause Controls page', async () => {
    // The start focus order is four wardrobe bins, palette, then Play (uiTour).
    for (let i = 0; i < 5; i++) await press('ArrowDown')
    await press('Enter')
    await waitFor(() => live.host.currentScreen() === 'hub', 'hub from start', 120000)
    await press('Escape')
    await waitFor(() => live.host.currentScreen() === 'pause' && props['act-settings']?.visible === true
      && live.host.widgetRect('act-settings') !== null, 'pause screen')
    click(live, 'act-settings')
    await waitFor(() => live.host.currentScreen() === 'settings' && !!props.title?.text, 'pause settings')
    click(live, 'tab-controls')
    await waitFor(() => propText(props, 'title') === 'Controls', 'pause Controls page')
    await take('pause-controls')
    await press('Escape')
    await waitFor(() => live.host.currentScreen() === 'pause', 'return to pause')
  })
}

// The phone pass first: it returns to start, where the landscape pass begins and goes on to the hub and pause.
export async function run(_input: unknown, deps: TourDeps) {
  const files: CheckFile[] = []
  const failures: string[] = []
  // Every failure is also a console.error: the GPU page reports its first error in each heartbeat, so a page
  // that freezes later still names what had already failed.
  const report = (failure: string): void => {
    failures.push(failure)
    console.error(`[settingsPages] ${failure}`)
  }
  let restore = setSize(true)
  let game: TourGame | undefined
  try {
    game = await deps.boot(() => {}, { plain: true, saved: {} })
    await runSize(game, true, files, report)
    restore()
    restore = setSize(false)
    await runSize(game, false, files, report)
  } catch (error) {
    report(`boot: ${errorText(error)}`)
  } finally {
    game?.dispose()
    restore()
  }
  let adapter
  try { adapter = await deps.adapter() }
  catch (error) { report(`adapter: ${errorText(error)}`); adapter = null }
  return { json: { ok: failures.length === 0, failures, captures: files.map(file => file.name), adapter }, files }
}
