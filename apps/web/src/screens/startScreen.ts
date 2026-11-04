import { cosmeticOf, cosmeticName, carouselWindow } from '@royal-fiesta/game/flow/startScreen'
// The caller owns input and advances this view once per frame with the latest wardrobe model.
import type { StartScreenModel } from '@royal-fiesta/game/flow/startScreen'
import type { StartScene, CourseDressing } from '@royal-fiesta/game/content'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { CameraPose, QuatT, RenderPort, Vec3T } from '@royal-fiesta/game/render/port'
import { SceneLayer } from '@royal-fiesta/game/render/sceneLayer'
import { restPoseSkin } from '@royal-fiesta/game/render/sceneView'
import type { SkinnedCharacter } from '@royal-fiesta/game/render/sceneView'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import type { WidgetProps } from '../ui/screenMap.ts'
import type { UaaHost } from '../ui/uaaHost.ts'

export interface FlowDeps {
  cue(id: string): void
  stage?: RenderPort
  character?: PrimsAsset
  names?: (seat: number) => string
  localSeat?: number
  // The CSS size of the page the stage canvas and canvas#ui both cover; the carousel cells are placed in it.
  viewSize?: () => { width: number; height: number }
}

// Prepared by game-web from its loaded content; this view never loads or meshes assets.
export interface StartArt {
  wallet?: { coins: number; tickets: number }
  scene?: StartScene
  dressing?: CourseDressing
  port: RenderPort
  character: PrimsAsset
  skinned?: SkinnedCharacter
  costume(id: string): PrimsAsset | null
  mounts: ReadonlyMap<string, Vec3T>
  // Each cosmetic's asset bounds in its own space (its .asset.json bounds): the carousel centres and fits it.
  bounds?: ReadonlyMap<string, { min: Vec3T; max: Vec3T }>
  environment: Readonly<Record<string, unknown>> | null
}

export interface StartScreenStep {
  action: Action
  effect: 'play' | 'shop' | 'wear' | null
}

export interface StartScreenView {
  update(model: StartScreenModel, step: StartScreenStep | null): void
  setVisible(visible: boolean): void
  unmount(): void
}

const HINT = 'Up/Down Slot   Left/Right Browse   A / Enter Wear'
const UNIT: Vec3T = [1, 1, 1]
const ORIGIN: Vec3T = [0, 0, 0]
const YAW_PER_MS = 0.0002
// The carousels draw each cosmetic as its own 3D asset in the start scene, with no card and no thumbnail
// (owner 2026-11-04): it stands on a plane at this fraction of the camera-to-penguin distance, centred on the
// upper part of its carousel cell (the lower part holds the WORN / SELECT label) and fitted to it.
const CAROUSEL_DEPTH = 0.55
const CAROUSEL_TOP = 0.72
const CAROUSEL_FILL = 0.78
const CAROUSEL_ACTIVE_FILL = 1
// A cosmetic without known bounds: centred on its origin, about a penguin's head wide.
const FALLBACK_BOUNDS = { min: [-0.6, -0.6, -0.6] as Vec3T, max: [0.6, 0.6, 0.6] as Vec3T }

function focused(label: string, focus: boolean): string {
  return focus ? `> ${label} <` : label
}


function present(host: UaaHost, model: StartScreenModel, wallet?: StartArt['wallet']): void {
  const menu: MenuModel = {
    screen: 'start', title: 'Royal Fiesta', lines: [], hint: HINT, overlay: false,
    buttons: [
      { label: focused('Play', model.focus === 'play'), cmd: { k: 'action', action: 'play' } },
      { label: focused('Shop', model.focus === 'shop'), cmd: { k: 'action', action: 'shop' } },
      { label: 'Inbox', cmd: { k: 'action', action: 'inbox' } },
      // The start screen is the root: where Back was, Settings opens the settings screen (owner 2026-11-04).
      { label: 'Settings', cmd: { k: 'action', action: 'settings' } },
    ],
  }
  host.present(menu)
  const props: Record<string, WidgetProps> = {
    'inbox-badge': { text: { count: String(model.badge) }, visible: model.badge > 0 },
    'palette-mark': { visible: false },
    hint: { visible: false },
    'wardrobe-subtitle': { text: 'DRESS UP. STAND OUT.', visible: !wallet },
    wallet: { visible: !!wallet },
    'wallet-coins': { text: String(wallet?.coins ?? '') },
    'wallet-tickets': { text: String(wallet?.tickets ?? '') },
  }
  model.bins.forEach((bin, index) => {
    props[`bin-${bin.slot}`] = { text: cosmeticName(bin.items[bin.selected]), visible: true }
    const cells = carouselWindow(bin.selected, bin.items.length)
    for (let j = 0; j < 4; j++) {
      const at = cells[j]
      const exists = at !== undefined
      const id = exists && at >= 0 ? bin.items[at] : undefined
      const active = model.focus === 'bins' && model.bin === index && at === bin.selected
      // The cell is an empty group: the cosmetic itself is drawn in 3D behind canvas#ui (mountStartScreen).
      props[`carousel-${index}-${j}`] = { visible: exists }
      props[`carousel-name-${index}-${j}`] = { text: exists ? cosmeticName(id) : '', visible: exists && !id }
      props[`carousel-worn-${index}-${j}`] = { text: at === bin.worn ? 'WORN' : active ? 'SELECT' : '', visible: exists }
    }
  })
  PALETTE.forEach((_, index) => {
    props[`palette-${index}`] = {
      visible: model.palette.includes(index), text: { count: model.colour === index ? '*' : '' },
    }
  })
  host.setHud(props)
}

type V3 = [number, number, number]
const sub = (a: Vec3T, b: Vec3T): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3T, b: Vec3T): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3T): V3 => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n] }

// For a page pixel (CSS px, top-left origin), the world point at CAROUSEL_DEPTH of the camera-to-target distance
// on the camera ray through it, and the world size of one pixel at that depth (perspective, square pixels).
export function cameraRay(camera: CameraPose, size: { width: number; height: number }): (x: number, y: number) => { point: V3; worldPerPx: number } {
  const offset = sub(camera.target, camera.eye)
  const depth = CAROUSEL_DEPTH * Math.hypot(offset[0], offset[1], offset[2])
  const forward = unit(offset)
  const right = unit(cross(forward, camera.up ?? [0, 1, 0]))
  const up = cross(right, forward)
  const tanY = Math.tan(camera.fovYDeg * Math.PI / 360)
  const aspect = size.width / size.height
  return (x, y) => {
    const nx = (2 * x / size.width - 1) * tanY * aspect
    const ny = (1 - 2 * y / size.height) * tanY
    const point = [0, 1, 2].map(i => camera.eye[i] + depth * (forward[i] + right[i] * nx + up[i] * ny)) as V3
    return { point, worldPerPx: 2 * depth * tanY / size.height }
  }
}

export function mountStartScreen(
  host: UaaHost, model: StartScreenModel, deps: FlowDeps, art: StartArt,
): StartScreenView {
  const layer = new SceneLayer(art.port)
  const port = layer.port
  const character = art.skinned !== undefined && port.registerSkinned !== undefined
    ? port.registerSkinned(art.skinned.assetId, art.skinned.skin)
    : port.registerAsset(art.character.id, art.character)
  const assets = new Map<string, number>()
  const worn = new Map<StartScreenModel['bins'][number]['slot'], { id: string; instance: number; mount: Vec3T; skinned: boolean }>()
  // The carousel cells' 3D cosmetics, per cell `<bin>-<column>`.
  const carousel = new Map<string, { id: string; instance: number }>()
  let penguin = port.createInstance(character, PALETTE[model.colour])
  let colour = model.colour
  let current = model
  let mounted = true
  let visible = true
  const started = performance.now()
  if (art.scene && art.dressing) art.dressing.enter(port, art.scene.courseId)
  else port.setEnvironment(art.environment)
  port.setEnvironment({ ...art.environment, sky: 'day', fog: 'clear', post: 'candy', menu: 'candy' })
  const origin = art.scene?.spot.t ?? ORIGIN

  function draw(next: StartScreenModel): void {
    if (next.colour !== colour) {
      port.destroyInstance(penguin)
      penguin = port.createInstance(character, PALETTE[next.colour])
      colour = next.colour
    }
    const selected = new Map(next.bins.map(bin => [bin.slot, bin.worn >= 0 ? bin.items[bin.worn] : undefined]))
    for (const [slot, item] of worn) {
      if (selected.get(slot) === item.id) continue
      port.destroyInstance(item.instance)
      worn.delete(slot)
    }
    for (const [slot, id] of selected) {
      if (id === undefined || worn.has(slot)) continue
      const mount = art.mounts.get(id)
      if (mount === undefined) continue
      const asset = assetOf(id)
      if (asset === null) continue
      const assetId = cosmeticOf(id)?.asset ?? id
      worn.set(slot, { id, instance: port.createInstance(asset, cosmeticOf(id)?.tint ?? null), mount, skinned: !!port.skinOf?.(assetId) && !!port.setPose && !!port.registerSkinned })
    }
    // The wardrobe has no simulation clock. Advance the shared penguin idle cycle on its view clock.
    if (art.skinned !== undefined && port.setPose !== undefined && port.registerSkinned !== undefined) {
      const matrices = restPoseSkin(art.skinned.skin.rig as unknown as Parameters<typeof restPoseSkin>[0],
        Math.floor((performance.now() - started) * 60 / 1000))
      port.setPose(penguin, matrices)
      for (const item of worn.values()) if (item.skinned) port.setPose(item.instance, matrices)
    }
    // Rotate the root and each mount offset together.
    const yaw = (art.scene?.spot.yawDeg ?? 0) * Math.PI / 180 + (performance.now() - started) * YAW_PER_MS
    const rotation: QuatT = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
    port.setTransform(penguin, origin, rotation, UNIT)
    for (const { instance, mount: [x, y, z], skinned } of worn.values()) {
      if (skinned) { port.setTransform(instance, origin, rotation, UNIT); continue }
      port.setTransform(instance, [origin[0] + Math.cos(yaw) * x + Math.sin(yaw) * z, origin[1] + y, origin[2] - Math.sin(yaw) * x + Math.cos(yaw) * z], rotation, UNIT)
    }
    const size = viewSize()
    const portrait = size !== null && size.height > size.width
    const camera: CameraPose = { ...art.scene?.camera, eye: [origin[0], origin[1] + 0.7, origin[2] + (portrait ? 12 : 6.2)], target: [origin[0], origin[1] + (portrait ? 0.3 : 0.1), origin[2]], fovYDeg: 38, near: 0.1, far: 500 }
    if (visible) port.setCamera(0, camera)
    drawCarousels(next, camera, size, yaw)
  }

  function viewSize(): { width: number; height: number } | null {
    if (deps.viewSize !== undefined) return deps.viewSize()
    return typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight }
  }

  // The registered (shared) asset handle of a cosmetic, its colour variants included; null when missing.
  function assetOf(id: string): number | null {
    const assetId = cosmeticOf(id)?.asset ?? id
    let asset = assets.get(assetId)
    if (asset === undefined) {
      const costume = art.costume(id)
      if (costume === null) return null
      const skin = port.skinOf?.(assetId)
      asset = skin && port.registerSkinned && port.setPose ? port.registerSkinned(assetId, skin) : port.registerAsset(assetId, costume)
      assets.set(assetId, asset)
    }
    return asset
  }

  // Each visible carousel cell holding a cosmetic shows that cosmetic's 3D asset, turning with the penguin,
  // on the camera ray through the cell (canvas#ui and the stage canvas cover the same page). The selected
  // cell of the focused bin is drawn larger. A cell without a laid-out rect (first frame) draws nothing.
  function drawCarousels(next: StartScreenModel, camera: CameraPose, size: { width: number; height: number } | null, yaw: number): void {
    const keep = new Set<string>()
    if (size !== null && size.width > 0 && size.height > 0) {
      const ray = cameraRay(camera, size)
      next.bins.forEach((bin, index) => {
        const cells = carouselWindow(bin.selected, bin.items.length)
        for (let j = 0; j < cells.length; j++) {
          const at = cells[j]
          const id = at >= 0 ? bin.items[at] : undefined
          if (id === undefined) continue
          const rect = host.widgetRect(`carousel-${index}-${j}`)
          if (rect === null || rect.w <= 0 || rect.h <= 0) continue
          const key = `${index}-${j}`
          let cell = carousel.get(key)
          if (cell !== undefined && cell.id !== id) {
            port.destroyInstance(cell.instance)
            carousel.delete(key)
            cell = undefined
          }
          if (cell === undefined) {
            const asset = assetOf(id)
            if (asset === null) continue
            cell = { id, instance: port.createInstance(asset, cosmeticOf(id)?.tint ?? null) }
            carousel.set(key, cell)
          }
          keep.add(key)
          const active = next.focus === 'bins' && next.bin === index && at === bin.selected
          const top = rect.h * CAROUSEL_TOP
          const { point, worldPerPx } = ray(rect.x + rect.w / 2, rect.y + top / 2)
          const b = art.bounds?.get(id) ?? FALLBACK_BOUNDS
          const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1e-3)
          const scale = Math.min(rect.w, top) * worldPerPx * (active ? CAROUSEL_ACTIVE_FILL : CAROUSEL_FILL) / extent
          const [cx, cy, cz] = [0, 1, 2].map(axis => (b.min[axis] + b.max[axis]) / 2 * scale)
          const rotation: QuatT = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
          port.setTransform(cell.instance, [
            point[0] - (Math.cos(yaw) * cx + Math.sin(yaw) * cz),
            point[1] - cy,
            point[2] - (-Math.sin(yaw) * cx + Math.cos(yaw) * cz),
          ], rotation, [scale, scale, scale])
        }
      })
    }
    for (const [key, cell] of carousel) {
      if (keep.has(key)) continue
      port.destroyInstance(cell.instance)
      carousel.delete(key)
    }
  }

  draw(model)
  present(host, model, art.wallet)
  return {
    update(next, step) {
      if (!mounted) return
      current = next
      if (step?.effect === 'play' || step?.effect === 'shop') deps.cue('ui.click')
      else if (step?.action === 'up' || step?.action === 'down' || ((step?.action === 'left' || step?.action === 'right') && next.focus === 'bins') || step?.effect === 'wear') deps.cue('ui.hover')
      draw(next)
      if (visible) present(host, next, art.wallet)
    },
    setVisible(shown) {
      if (!mounted) return
      visible = shown
      layer.setVisible(shown)
      if (shown) {
        draw(current)
        present(host, current, art.wallet)
      }
    },
    unmount() {
      if (!mounted) return
      mounted = false
      layer.setVisible(false)
      if (art.scene && art.dressing) art.dressing.leave(port)
      port.destroyInstance(penguin)
      for (const item of worn.values()) port.destroyInstance(item.instance)
      worn.clear()
      for (const cell of carousel.values()) port.destroyInstance(cell.instance)
      carousel.clear()
    },
  }
}
