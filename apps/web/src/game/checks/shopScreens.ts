import type { TourDeps, TourGame } from '../uiTour.ts'
import type { WidgetProps } from '../../ui/screenMap.ts'
import { yieldTask, nextTask } from './boot.ts'
import { pipelinesReady } from './wardrobe.ts'
export const name = 'shopScreens'
async function captureCase(portrait: boolean, deps: TourDeps) {
  const files: { name: string; blob: Blob }[] = []
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  let style: HTMLStyleElement | undefined
  {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: portrait ? 390 : 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: portrait ? 844 : 720 })
    style = document.createElement('style')
    style.textContent = `#screens, #views {width:${portrait ? 390 : 1280}px;height:${portrait ? 844 : 720}px;right:auto;bottom:auto}`
    document.head.append(style)
  }
  let game: TourGame | undefined
  try {
    game = await deps.boot(() => {}, { plain: true })
    const live = game
    let props: Record<string, WidgetProps> = {}
    const original = live.host.setHud
    live.host.setHud = values => { props = values; original.call(live.host, values) }
    const step = async () => { live.step(1 / 60); await yieldTask(live.host.currentScreen()) }
    const until = async (test: () => boolean, what: string) => {
      const end = Date.now() + 150000
      while (!test()) { if (Date.now() > end || live.host.currentScreen() === 'error') throw new Error(what + ': ' + live.host.currentScreen()); await step() }
    }
    const press = async (key: string) => {
      for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true }))
      await step(); await step()
    }
    const capture = async (name: string) => {
      await pipelinesReady(live, name); live.step(2); live.step(0)
      const uiBox = live.ui.getBoundingClientRect()
      // Snapshot every GPU canvas before yielding this task.
      const shots = [...live.views.querySelectorAll('canvas'), live.ui].map(c => ({ rect: c.getBoundingClientRect(), bitmap: createImageBitmap(c) }))
      const out = document.createElement('canvas'); out.width = Math.round(uiBox.width); out.height = Math.round(uiBox.height)
      const ctx = out.getContext('2d')!; ctx.fillStyle = '#4bc7df'; ctx.fillRect(0, 0, out.width, out.height)
      for (const shot of shots) { const bitmap = await shot.bitmap; ctx.drawImage(bitmap, shot.rect.left-uiBox.left, shot.rect.top-uiBox.top, shot.rect.width, shot.rect.height); bitmap.close() }
      const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Capture failed')
      files.push({ name: (portrait ? 'phone-' : '') + name + '.png', blob })
    }
    await until(() => live.host.currentScreen() === 'start' && !!props['bin-head'], 'start mount')
    await nextTask(); await step()
    await capture('start-carousels')
    // Selecting a carousel cell with real pointer input wears it.
    const click = async (id: string) => {
      const r = live.host.widgetRect(id); if (!r) throw new Error('Missing target ' + id)
      const box = live.ui.getBoundingClientRect()
      const at = { clientX: box.left+r.x+r.w/2, clientY: box.top+r.y+r.h/2, bubbles: true, cancelable: true }
      live.ui.dispatchEvent(new MouseEvent('click', at)); await step(); await step()
    }
    await click('carousel-0-2')
    await capture('start-selected')
    for (let i = 0; i < 6; i++) await press('ArrowDown')
    await press('Enter')
    await until(() => live.host.currentScreen() === 'shop' && String(props['line-0']?.text).includes('Coins'), 'shop load')
    for (let i = 0; i < 4; i++) { await capture('shop-' + ['hat','outfit','extra','special'][i]); await press('ArrowRight') }
    await press('ArrowDown'); await press('ArrowRight'); await press('Enter')
    if (!(await live.inspect!()).shop?.confirm) throw new Error('Missing buy confirmation')
    await capture('shop-confirm')
    await press('Escape')
    if ((await live.inspect!()).shop?.confirm) throw new Error('Cancel did not close confirmation')
    if (live.host.currentScreen() !== 'shop') throw new Error('Cancel left shop')
    return { json: { ok: true, screenshots: files.map(f=>f.name), adapter: await deps.adapter() }, files }
  } finally {
    game?.dispose(); style?.remove()
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
    if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight)
  }
}

export async function run(_input: unknown, deps: TourDeps) {
  const desktop = await captureCase(false, deps)
  const phone = await captureCase(true, deps)
  return { json: { ok: true, desktop: desktop.json, phone: phone.json }, files: [...desktop.files, ...phone.files] }
}
