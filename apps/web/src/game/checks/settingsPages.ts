import type { WidgetProps } from '../../ui/screenMap.ts'
import type { TourDeps, TourGame } from '../uiTour.ts'
import { yieldTask } from './boot.ts'
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

async function runSize(portrait: boolean, deps: TourDeps, files: CheckFile[], failures: string[]): Promise<void> {
  const prefix = portrait ? 'phone-' : ''
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const width = portrait ? 390 : 1280
  const height = portrait ? 844 : 720
  const style = document.createElement('style')
  style.textContent = `#screens, #views {width:${width}px;height:${height}px;right:auto;bottom:auto}`
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  document.head.append(style)
  let game: TourGame | undefined
  const fail = (label: string, condition: boolean): void => { if (!condition) failures.push(`${prefix}${label}`) }
  try {
    game = await deps.boot(() => {}, { plain: true, saved: {} })
    const live = game
    let props: Props = {}
    const setHud = live.host.setHud
    live.host.setHud = values => { props = values; setHud.call(live.host, values) }
    const step = async (): Promise<void> => { live.step(1 / 60); await yieldTask(live.host.currentScreen()) }
    const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
      const end = Date.now() + 120000
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
      const end = Date.now() + 120000
      while (!predicate()) {
        if (Date.now() >= end || live.host.currentScreen() === 'error') throw new Error(`${what}: ${live.host.focused()}`)
        await press(key)
      }
    }
    const take = async (file: string): Promise<void> => {
      await pipelinesReady(live, file)
      live.step(1 / 60)
      // The shared compositor is 16:9; retain the real viewport ratio for phone captures.
      const blob = portrait ? await viewportCapture(live) : (await capture(live)).composite
      files.push({ name: prefix + file + '.png', blob })
    }

    await waitFor(() => live.host.currentScreen() === 'start' && props['act-settings']?.visible === true, 'start screen')
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

    await focusUntil('ArrowUp', () => live.host.focused()?.startsWith('tab-') === true, 'audio tab focus')
    await press('ArrowRight')
    await waitFor(() => propText(props, 'title') === 'Graphics', 'Graphics page')
    fail('Graphics title', propText(props, 'title') === 'Graphics')
    const lod = Object.entries(props).find(([id, value]) => id.startsWith('row-') && value.text === 'LOD offset')
    fail('LOD offset unavailable row', lod?.[1].disabled === true)
    fail('LOD offset note', propText(props, 'line-0').includes('LOD offset'))
    await take('graphics')

    await press('ArrowRight')
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

    await focusUntil('ArrowUp', () => live.host.focused()?.startsWith('tab-') === true, 'controls tab focus')
    await press('ArrowRight')
    await waitFor(() => propText(props, 'title') === 'Gameplay & Accessibility', 'Gameplay page')
    fail('Gameplay credits button', props['act-credits']?.visible === true)
    await take('gameplay')

    await press('Escape')
    await waitFor(() => live.host.currentScreen() === 'start', 'return to start')
    if (!portrait) {
      // The start focus order is four wardrobe bins, palette, then Play (uiTour).
      for (let i = 0; i < 5; i++) await press('ArrowDown')
      await press('Enter')
      await waitFor(() => live.host.currentScreen() === 'hub', 'hub from start')
      await press('Escape')
      await waitFor(() => live.host.currentScreen() === 'pause', 'pause screen')
      click(live, 'act-settings')
      await waitFor(() => live.host.currentScreen() === 'settings' && !!props.title?.text, 'pause settings')
      click(live, 'tab-controls')
      await waitFor(() => propText(props, 'title') === 'Controls', 'pause Controls page')
      await take('pause-controls')
      await press('Escape')
      await waitFor(() => live.host.currentScreen() === 'pause', 'return to pause')
    }
  } finally {
    game?.dispose()
    style.remove()
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
    if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight)
  }
}

export async function run(_input: unknown, deps: TourDeps) {
  const files: CheckFile[] = []
  const failures: string[] = []
  for (const portrait of [false, true]) {
    try {
      await runSize(portrait, deps, files, failures)
    } catch (error) {
      failures.push(`${portrait ? 'phone' : 'landscape'}: ${String(error)}`)
    }
  }
  let adapter
  try { adapter = await deps.adapter() }
  catch (error) { failures.push(`adapter: ${String(error)}`); adapter = null }
  return { json: { ok: failures.length === 0, failures, captures: files.map(file => file.name), adapter }, files }
}
