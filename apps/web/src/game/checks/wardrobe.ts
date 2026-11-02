// wardrobe (game.html?test=1): wears every catalog cosmetic through the start screen's real key input,
// captures the stage and UI composite, and proves each one reaches the stage port and changes the penguin.
// It steps the App with a fixed dt and waits only on presentation callbacks; it never sleeps in real time.
/// <reference types="vite/client" />
import type { WidgetProps } from '../../ui/screenMap.ts'
import type { TourDeps, TourGame } from '../uiTour.ts'
import { checkBoot, nextTask } from './boot.ts'
import economyDocText from '../../../../../economy/royal-fiesta.economy.json?raw'

export const name = 'wardrobe'

const DT = 1 / 60
const WIDTH = 640
const HEIGHT = 360
const SLOTS = ['head', 'body', 'bottom', 'special'] as const
type Slot = (typeof SLOTS)[number]
type Props = Record<string, WidgetProps>

interface CatalogItem { id: string; name: string; slot: Slot; asset: string }
interface Shot { composite: Blob; stage: Uint8ClampedArray }
interface ItemResult { id: string; slot: Slot; registered: boolean; instance: boolean; differs: boolean; diffPixels: number }
interface AppInventory {
  screen: string
  ports: { inventory: { assets: string[]; instances: number } | null }[]
}

// The catalog the App's offline economy serves (economy/royal-fiesta.economy.json, built from catalog.season1.json).
const CATALOG: readonly CatalogItem[] = (JSON.parse(economyDocText) as { catalog: { shop: { items: CatalogItem[] } } }).catalog.shop.items

function itemName(id: string): string {
  const name = id.slice(id.lastIndexOf('.') + 1).replace(/-/g, ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function fileOf(id: string): string {
  return `${id.replace(/[^a-z0-9._-]/gi, '-')}.png`
}

function wanted(input: unknown): Set<string> | null {
  const ids = (input as { items?: unknown } | null)?.items
  return Array.isArray(ids) ? new Set(ids.filter((id): id is string => typeof id === 'string')) : null
}

function watchHud(game: TourGame): () => Props {
  let latest: Props = {}
  const original = game.host.setHud
  game.host.setHud = (values: Props): void => {
    latest = values
    original.call(game.host, values)
  }
  return () => latest
}

// The renderer writes '< Propeller hat >', focused as '> < Propeller hat > <'.
function binLabel(props: Props, slot: Slot): string {
  const text = props[`bin-${slot}`]?.text
  if (typeof text !== 'string') return ''
  let label = text.trim()
  if (label.startsWith('> ')) label = label.slice(2)
  if (label.endsWith(' <')) label = label.slice(0, -2)
  const angle = /^<\s*(.*?)\s*>$/.exec(label.trim())
  return (angle?.[1] ?? label).trim()
}

async function step(game: TourGame): Promise<void> {
  game.step(DT)
  await nextTask()
}

async function settle(game: TourGame, frames = 2): Promise<void> {
  for (let i = 0; i < frames; i++) await step(game)
}

async function press(game: TourGame, key: string): Promise<void> {
  const init: KeyboardEventInit = { code: key, key, bubbles: true, cancelable: true }
  window.dispatchEvent(new KeyboardEvent('keydown', init))
  window.dispatchEvent(new KeyboardEvent('keyup', init))
  await settle(game)
}

interface Focus { bin: number }

// The focused bin wears '> ... <' around its label; -1 until the start screen has drawn its bins.
function focusedBin(props: Props): number {
  return SLOTS.findIndex(slot => {
    const text = props[`bin-${slot}`]?.text
    return typeof text === 'string' && text.startsWith('> ')
  })
}

async function focusBin(game: TourGame, focus: Focus, read: () => Props, target: number): Promise<void> {
  const seen = focusedBin(read())
  if (seen >= 0) focus.bin = seen
  while (focus.bin < target) { await press(game, 'ArrowDown'); focus.bin++ }
  while (focus.bin > target) { await press(game, 'ArrowUp'); focus.bin-- }
  const now = focusedBin(read())
  if (now >= 0 && now !== target) throw new Error(`the focus is on bin ${now} (${SLOTS[now]}), not on ${SLOTS[target]}`)
}

const MAX_CYCLES = 8

async function ensureNone(game: TourGame, focus: Focus, read: () => Props, slot: Slot, index: number): Promise<void> {
  await focusBin(game, focus, read, index)
  for (let tries = 0; tries <= MAX_CYCLES; tries++) {
    if (binLabel(read(), slot) === 'None') return
    await press(game, 'ArrowRight')
  }
  throw new Error(`bin-${slot}: the label never reached None`)
}

async function select(game: TourGame, focus: Focus, read: () => Props, slot: Slot, index: number, item: CatalogItem): Promise<boolean> {
  await focusBin(game, focus, read, index)
  const want = itemName(item.id)
  for (let tries = 0; tries <= MAX_CYCLES; tries++) {
    if (binLabel(read(), slot) === want) return true
    await press(game, 'ArrowRight')
  }
  return binLabel(read(), slot) === want
}

function stageInventory(game: TourGame): { assets: Set<string>; instances: number } {
  const inventory = game.inventory() as AppInventory
  const port = inventory.ports[0]?.inventory ?? null
  return { assets: new Set(port?.assets ?? []), instances: port?.instances ?? 0 }
}

function stageCanvas(game: TourGame): HTMLCanvasElement {
  const canvas = game.views.querySelector('canvas')
  if (canvas === null) throw new Error('wardrobe: the stage canvas is missing')
  return canvas
}

interface Box { x0: number; y0: number; x1: number; y1: number }

// The start screen's camera (screens/startScreen.ts) projected around the penguin at the origin.
function characterBox(stage: HTMLCanvasElement, uiBox: DOMRect): Box {
  const aspect = stage.width / Math.max(1, stage.height)
  const eye = [0, 0.7, 4.8]
  const target = [0, 0.3, 0]
  const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const unit = (a: number[]): number[] => { const n = Math.sqrt(dot(a, a)); return [a[0] / n, a[1] / n, a[2] / n] }
  const forward = unit(sub(target, eye))
  const right = unit(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const tanHalf = Math.tan((38 * Math.PI) / 360)
  const rect = stage.getBoundingClientRect()
  const sx = WIDTH / Math.max(1, uiBox.width)
  const sy = HEIGHT / Math.max(1, uiBox.height)
  const left = (rect.left - uiBox.left) * sx
  const top = (rect.top - uiBox.top) * sy
  const width = rect.width * sx
  const height = rect.height * sy
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const x of [-1, 1]) for (const y of [-0.3, 2.2]) for (const z of [-1, 1]) {
    const rel = sub([x, y, z], eye)
    const depth = dot(rel, forward)
    const px = (dot(rel, right) / (depth * tanHalf * aspect) + 1) / 2
    const py = (1 - dot(rel, up) / (depth * tanHalf)) / 2
    x0 = Math.min(x0, left + px * width)
    x1 = Math.max(x1, left + px * width)
    y0 = Math.min(y0, top + py * height)
    y1 = Math.max(y1, top + py * height)
  }
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  return {
    x0: clamp(Math.floor(x0) - 2, 0, WIDTH - 1), y0: clamp(Math.floor(y0) - 2, 0, HEIGHT - 1),
    x1: clamp(Math.ceil(x1) + 2, 0, WIDTH - 1), y1: clamp(Math.ceil(y1) + 2, 0, HEIGHT - 1),
  }
}

function diffPixels(a: Uint8ClampedArray, b: Uint8ClampedArray, box: Box): number {
  let count = 0
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const i = (y * WIDTH + x) * 4
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++
    }
  }
  return count
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('wardrobe: no 2D canvas context to composite the capture')
  return ctx
}

// The composite, as uiTour captures it (canvas#ui first, then the views, each copy flushed by a 1 px read), at
// 640x360. The stage pixels alone drive the pixel-difference proof, so the moving bin labels never count as
// the worn costume. Call it in the task that stepped the frame: the WebGPU canvases are snapshotted
// synchronously, before the first await.
async function capture(game: TourGame): Promise<Shot> {
  const ui = game.ui
  const uiBox = ui.getBoundingClientRect()
  const sx = WIDTH / Math.max(1, uiBox.width)
  const sy = HEIGHT / Math.max(1, uiBox.height)
  const uiShot = createImageBitmap(ui)
  const views = Array.from(game.views.querySelectorAll('canvas'), view => ({
    rect: view.getBoundingClientRect(), shot: createImageBitmap(view),
  }))
  const out = document.createElement('canvas')
  out.width = WIDTH
  out.height = HEIGHT
  const ctx = context(out)
  const stage = document.createElement('canvas')
  stage.width = WIDTH
  stage.height = HEIGHT
  const stageCtx = context(stage)
  const background = getComputedStyle(document.body).backgroundColor || '#000'
  for (const target of [ctx, stageCtx]) {
    target.fillStyle = background
    target.fillRect(0, 0, WIDTH, HEIGHT)
  }
  const flush = (): void => { ctx.getImageData(0, 0, 1, 1); stageCtx.getImageData(0, 0, 1, 1) }
  for (const { rect, shot } of views) {
    const bitmap = await shot
    const at = [(rect.left - uiBox.left) * sx, (rect.top - uiBox.top) * sy, rect.width * sx, rect.height * sy] as const
    ctx.drawImage(bitmap, ...at)
    stageCtx.drawImage(bitmap, ...at)
    flush()
    bitmap.close()
  }
  const bitmap = await uiShot
  ctx.drawImage(bitmap, 0, 0, WIDTH, HEIGHT)
  flush()
  bitmap.close()
  const pixels = stageCtx.getImageData(0, 0, WIDTH, HEIGHT).data
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('wardrobe: canvas.toBlob returned null; the capture could not be encoded')
  return { composite: blob, stage: pixels }
}

// The start screen's turntable yaw reads performance.now() on every draw, so two captures at different
// real times never show the same penguin. Hold the clock still for the whole walk (after one jump that lets
// the uaa enter animations finish), so the only difference between captures is what is worn.
const ENTER_JUMP_MS = 3000

async function holdClock(game: TourGame): Promise<() => void> {
  const real = performance.now.bind(performance)
  const now = real() + ENTER_JUMP_MS
  performance.now = () => now
  await settle(game, 2)
  return () => { performance.now = real }
}

// One settled frame awaited, then the last one stepped and captured in the same task.
async function shoot(game: TourGame): Promise<{ shot: Promise<Shot>; inventory: ReturnType<typeof stageInventory> }> {
  await settle(game, 1)
  game.step(DT)
  return { inventory: stageInventory(game), shot: capture(game) }
}

interface Recorded { item: CatalogItem; shot: Shot }

// One labelled tile per cosmetic, 4 per row.
async function sheet(recorded: readonly Recorded[]): Promise<Blob> {
  const columns = 4
  const tileW = 320
  const tileH = 180
  const labelH = 28
  const rows = Math.max(1, Math.ceil(recorded.length / columns))
  const out = document.createElement('canvas')
  out.width = columns * tileW
  out.height = rows * (tileH + labelH)
  const ctx = context(out)
  ctx.fillStyle = '#172033'
  ctx.fillRect(0, 0, out.width, out.height)
  for (const [i, { item, shot }] of recorded.entries()) {
    const left = (i % columns) * tileW
    const top = Math.floor(i / columns) * (tileH + labelH)
    const bitmap = await createImageBitmap(shot.composite)
    ctx.drawImage(bitmap, left, top, tileW, tileH)
    bitmap.close()
    ctx.fillStyle = '#172033'
    ctx.fillRect(left, top + tileH, tileW, labelH)
    ctx.fillStyle = '#ffffff'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${item.id} (${item.slot})`, left + tileW / 2, top + tileH + labelH / 2)
  }
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('wardrobe: the sheet could not be encoded')
  return blob
}

interface WardrobeJson {
  ok: boolean
  items: ItemResult[]
  failures: string[]
  bare: { file: string; assets: string[]; instances: number; controlPixels: number } | null
  screen: string
  transitions: string[]
}

export async function run(input: unknown, deps: TourDeps): Promise<{
  json: WardrobeJson
  files: { name: string; blob: Blob }[]
}> {
  const only = wanted(input)
  let game: TourGame | null = null
  const failures: string[] = []
  const items: ItemResult[] = []
  const recorded: Recorded[] = []
  let bare: WardrobeJson['bare'] = null
  let transitions: string[] = []
  let release: (() => void) | null = null
  try {
    const boot = await checkBoot(deps)
    game = boot.game
    transitions = boot.json.transitions
    if (!boot.json.ok) {
      return {
        json: { ok: false, items, failures: [`boot failed: ${boot.json.error ?? boot.json.screen}`], bare, screen: boot.json.screen, transitions },
        files: [],
      }
    }
    const live = game
    const read = watchHud(live)
    await settle(live, 2)
    release = await holdClock(live)
    const focus: Focus = { bin: 0 }
    const bins = SLOTS.map(slot => ({
      slot,
      items: CATALOG.filter(item => item.slot === slot && (only === null || only.has(item.id))),
    }))
    if (bins.every(bin => bin.items.length === 0)) {
      failures.push('the economy catalog has no head, body, bottom or special cosmetics to wear')
      return { json: { ok: false, items, failures, bare, screen: live.host.currentScreen(), transitions }, files: [] }
    }
    for (const [index, slot] of SLOTS.entries()) await ensureNone(live, focus, read, slot, index)
    const bareTake = await shoot(live)
    const bareInventory = bareTake.inventory
    const bareShot = await bareTake.shot
    const box = characterBox(stageCanvas(live), live.ui.getBoundingClientRect())
    bare = { file: 'bare.png', assets: [...bareInventory.assets].sort(), instances: bareInventory.instances, controlPixels: 0 }
    const files: { name: string; blob: Blob }[] = [{ name: 'bare.png', blob: bareShot.composite }]
    for (const [index, bin] of bins.entries()) {
      for (const item of bin.items) {
        for (const [other, otherBin] of bins.entries()) await ensureNone(live, focus, read, otherBin.slot, other)
        const named = await select(live, focus, read, bin.slot, index, item)
        const take = await shoot(live)
        const inventory = take.inventory
        const shot = await take.shot
        const registered = inventory.assets.has(item.id) || inventory.assets.has(item.asset)
        const instance = inventory.instances > bareInventory.instances
        const changed = diffPixels(bareShot.stage, shot.stage, box)
        const differ = changed > 0
        items.push({ id: item.id, slot: item.slot, registered, instance, differs: differ, diffPixels: changed })
        recorded.push({ item, shot })
        files.push({ name: fileOf(item.id), blob: shot.composite })
        if (!named) failures.push(`${item.id}: bin-${bin.slot} never named ${itemName(item.id)}`)
        if (!registered) failures.push(`${item.id}: the stage port does not report ${item.asset} as a registered asset`)
        if (!instance) failures.push(`${item.id}: no instance was created (${inventory.instances} live, bare ${bareInventory.instances})`)
        if (!differ) failures.push(`${item.id}: the capture shows no pixel difference from the bare penguin inside the character rect`)
        await ensureNone(live, focus, read, bin.slot, index)
      }
    }
    // Control: the bare penguin again. Pixels that change with nothing worn are background motion, not a costume.
    for (const [other, otherBin] of bins.entries()) await ensureNone(live, focus, read, otherBin.slot, other)
    const controlTake = await shoot(live)
    bare.controlPixels = diffPixels(bareShot.stage, (await controlTake.shot).stage, box)
    files.push({ name: 'sheet.png', blob: await sheet(recorded) })
    return {
      json: { ok: failures.length === 0, items, failures, bare, screen: live.host.currentScreen(), transitions },
      files,
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    return { json: { ok: false, items, failures, bare, screen: '', transitions }, files: [] }
  } finally {
    release?.()
    game?.dispose()
  }
}
