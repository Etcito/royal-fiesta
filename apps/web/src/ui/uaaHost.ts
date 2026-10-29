/// <reference types="vite/client" />
// The game's uaa UI layer: a transparent premultiplied WebGPU canvas stacked above the RAA canvas.
// It loads every ui/*.ui.json, ui/screens.ui-doc.json and the ui/fonts.json fonts, then drives a
// uaa Ui from menuModel results through screenMap. There is no fallback: a GPU, asset or font
// failure rejects with the uaa error, and there is no DOM or Canvas2D substitute.
// Every import.meta.glob sits in a function body, so Node tests can import this module.
import { installShaderCache } from '../render/shaderCache.ts'
import {
  createFontRegistry, createUi, loadUiDoc, parseUiAssetText, UaaError,
  type FontEntry, type Rect, type Ui, type UiAsset, type UiDoc, type UiInputEvent, type UiRenderer, type Viewport,
} from '@etcito/uaa'
import { createWebGpuRenderer, type WebGpuRendererOptions } from '@etcito/uaa/webgpu'
import type { MenuCmd, MenuModel } from '@royal-fiesta/game/screens/menuModel'
import { actionToCmd, screenProps, type WidgetProps } from './screenMap.ts'
import { withLogo, type LogoDevice } from './logoRenderer.ts'
import logo from '../../../../ui/logo.json' with { type: 'json' }
import { withCapsuleButtons } from './buttonMapping.ts'

export interface UaaCommand {
  cmd: MenuCmd
  screen: string
  // The widget that fired it; null for a back event.
  widget: string | null
}

export interface UaaScreenChange {
  from: string | null
  to: string
}

export interface UaaHostOptions {
  canvas: HTMLCanvasElement
  // The initial size: CSS px and devicePixelRatio, as in resize().
  width: number
  height: number
  dpr: number
  safeArea?: Viewport['safeArea']
  onCommand?: (c: UaaCommand) => void
  onScreen?: (e: UaaScreenChange) => void
}

export interface UaaHost {
  // Shows the model's screen (with its exit/enter anims) and sets its widget props.
  present(model: MenuModel): void
  // Round HUD props by widget id (screenMap.hudProps).
  setHud(values: Record<string, WidgetProps>): void
  setLoading(fraction: number, label: string): void
  // nav, activate, back and pointer; pointer x and y are canvas backing px (GameInput's overlay coordinates).
  input(e: UiInputEvent): void
  // Advances the uaa time and renders one frame.
  frame(nowMs: number): void
  // width and height in CSS px; the canvas backing store becomes width * dpr by height * dpr.
  resize(width: number, height: number, dpr: number): void
  // The widget's rect in CSS px relative to the canvas; null when hidden or not on the current screen.
  widgetRect(id: string): Rect | null
  currentScreen(): string
  destroy(): void
}

const NO_INSETS: Viewport['safeArea'] = { top: 0, right: 0, bottom: 0, left: 0 }

// ui/*.ui.json raw texts keyed by file name (logo.crown.ui.json ...), bundled by Vite.
function uiAssetTexts(): Record<string, string> {
  const files = import.meta.glob<string>('../../../../ui/*.ui.json', { query: '?raw', import: 'default', eager: true })
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text]))
}

function uiDocText(): string {
  const files = import.meta.glob<string>('../../../../ui/screens.ui-doc.json', { query: '?raw', import: 'default', eager: true })
  const text = Object.values(files)[0]
  if (text === undefined) throw new UaaError('UI_DOC_SCHEMA', '', 'ui/screens.ui-doc.json was not bundled')
  return text
}

function uiFontsText(): string {
  const files = import.meta.glob<string>('../../../../ui/fonts.json', { query: '?raw', import: 'default', eager: true })
  const text = Object.values(files)[0]
  if (text === undefined) throw new UaaError('FONT_LOAD', '', 'ui/fonts.json was not bundled')
  return text
}

// The uaa error, naming the file it came from.
function inFile(file: string, e: unknown): unknown {
  if (e instanceof UaaError) e.message = `${file}: ${e.message}`
  return e
}

export function loadAssets(texts: Record<string, string>): Map<string, UiAsset> {
  const assets = new Map<string, UiAsset>()
  for (const name of Object.keys(texts).sort()) {
    const file = `ui/${name}`
    let asset: UiAsset
    try {
      asset = parseUiAssetText(texts[name])
    } catch (e) {
      throw inFile(file, e)
    }
    if (`${asset.id}.ui.json` !== name) throw new UaaError('UI_ASSET_SCHEMA', 'id', `${file}: asset id '${asset.id}' does not match the file name`)
    assets.set(asset.id, asset)
  }
  return assets
}

// ui/fonts.json {fonts: [{family, weight, sha256, ...}]} -> the uaa registry entries. The page loads the
// build's decoded copy, fonts/<sha256>.ttf next to it (npm run ui:fonts decodes the WOFF2 because the GPU
// client's Chrome has no Brotli DecompressionStream): the GPU page has no network,
// so the store URL in ui/fonts.json is the provenance, not the fetch target.
export function fontEntries(text: string, baseUri: string): FontEntry[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    throw new UaaError('FONT_LOAD', '', `ui/fonts.json: ${(e as Error).message}`)
  }
  const fonts = (json as { fonts?: unknown } | null)?.fonts
  if (!Array.isArray(fonts) || fonts.length === 0) throw new UaaError('FONT_LOAD', 'fonts', 'ui/fonts.json: needs a non-empty fonts array')
  return fonts.map((f: unknown, i): FontEntry => {
    const { family, weight, sha256 } = (f ?? {}) as Record<string, unknown>
    if (typeof family !== 'string' || typeof weight !== 'number' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new UaaError('FONT_LOAD', `fonts[${i}]`, 'ui/fonts.json: a font needs family (string), weight (number) and sha256 (64 lowercase hex)')
    }
    return { family, weight, url: new URL(`fonts/${sha256}.ttf`, baseUri).href }
  })
}

// Minimal WebGPU shapes: the repo lib list has no @webgpu/types.
interface GpuDeviceLike { destroy(): void }
interface GpuAdapterLike { requestDevice(): Promise<GpuDeviceLike> }
interface GpuLike { requestAdapter(opts?: { powerPreference?: string }): Promise<GpuAdapterLike | null> }

async function requestDevice(): Promise<GpuDeviceLike> {
  installShaderCache()
  const gpu = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (gpu === undefined) throw new UaaError('GPU_UNAVAILABLE', '', 'WebGPU is not available: this browser exposes no navigator.gpu.')
  let adapter: GpuAdapterLike | null
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  } catch (e) {
    throw new UaaError('GPU_UNAVAILABLE', '', `WebGPU is not available: requestAdapter failed (${(e as Error).message}).`)
  }
  if (adapter === null) throw new UaaError('GPU_UNAVAILABLE', '', 'WebGPU is not available: no GPU adapter was returned.')
  try {
    return await adapter.requestDevice()
  } catch (e) {
    throw new UaaError('GPU_UNAVAILABLE', '', `WebGPU is not available: the GPU device could not be created (${(e as Error).message}).`)
  }
}

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): void {
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
}

// Creates the uaa layer on the canvas. Rejects with the UaaError of the first GPU, asset, document
// or font failure; whatever was created before it is released first.
export async function createUaaHost(o: UaaHostOptions): Promise<UaaHost> {
  const { canvas } = o
  // RAA shows through; input arrives only through input(), so the canvas never takes the pointer.
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', background: 'transparent', pointerEvents: 'none' })
  sizeCanvas(canvas, o.width, o.height, o.dpr)
  const device = await requestDevice()
  let renderer: UiRenderer | null = null
  let doc: UiDoc
  let ui: Ui
  try {
    renderer = await createWebGpuRenderer(canvas, { device: device as NonNullable<WebGpuRendererOptions['device']> })
    renderer = withCapsuleButtons(renderer)
    renderer = await withLogo(renderer, canvas, device as unknown as LogoDevice, { ...logo, format: logo.format as 'png' | 'svg' }, document.baseURI)
    const assets = loadAssets(uiAssetTexts())
    try {
      doc = loadUiDoc(JSON.parse(uiDocText()), assets)
    } catch (e) {
      if (e instanceof SyntaxError) throw new UaaError('UI_DOC_SCHEMA', '', `ui/screens.ui-doc.json: ${e.message}`)
      throw inFile('ui/screens.ui-doc.json', e)
    }
    const fonts = createFontRegistry(fontEntries(uiFontsText(), document.baseURI))
    await fonts.loadAll()
    const viewport: Viewport = { width: o.width, height: o.height, pixelRatio: o.dpr, safeArea: o.safeArea ?? NO_INSETS }
    ui = createUi({ doc, assets, fonts, renderer, viewport, nowMs: performance.now() })
  } catch (e) {
    renderer?.destroy()
    device.destroy()
    throw e
  }

  let dpr = o.dpr
  const safeArea = o.safeArea ?? NO_INSETS
  let destroyed = false
  // The last props set per widget id: present() runs every page frame and uaa re-lays out on each set.
  const last = new Map<string, string>()
  const set = (id: string, props: WidgetProps): void => {
    const key = JSON.stringify(props)
    if (last.get(id) === key) return
    ui.set(id, props)
    last.set(id, key)
  }

  const offs = [
    ui.on('action', (e) => o.onCommand?.({ cmd: actionToCmd(e.action, e.widget), screen: e.screen, widget: e.widget })),
    ui.on('back', (e) => o.onCommand?.({ cmd: actionToCmd('back'), screen: e.screen, widget: null })),
    ui.on('screen', (e) => o.onScreen?.({ from: e.from, to: e.to })),
  ]

  return {
    present(model) {
      const { screen, props } = screenProps(doc, model)
      for (const [id, p] of Object.entries(props)) set(id, p)
      ui.show(screen)
    },
    setHud(values) {
      for (const [id, p] of Object.entries(values)) set(id, p)
    },
    setLoading(fraction, label) {
      set('loading-bar', { value: Math.min(1, Math.max(0, fraction)) })
      set('loading-label', { text: label })
    },
    input(e) {
      ui.input(e.kind === 'pointer' ? { ...e, x: e.x / dpr, y: e.y / dpr } : e)
    },
    frame(nowMs) {
      if (destroyed) return
      ui.update(nowMs)
      ui.render()
    },
    resize(width, height, ratio) {
      dpr = ratio
      sizeCanvas(canvas, width, height, ratio)
      ui.resize({ width, height, pixelRatio: ratio, safeArea })
    },
    widgetRect: (id) => ui.rectOf(id),
    currentScreen: () => ui.screen(),
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const off of offs) off()
      // ui.destroy releases the renderer; the device is ours.
      ui.destroy()
      device.destroy()
    },
  }
}
