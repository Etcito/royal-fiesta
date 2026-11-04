import { cosmeticOf, cosmeticName, carouselWindow } from '@royal-fiesta/game/flow/startScreen'
// The caller owns input and advances this view once per frame with the latest wardrobe model.
import type { StartScreenModel } from '@royal-fiesta/game/flow/startScreen'
import type { StartScene, CourseDressing } from '@royal-fiesta/game/content'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { QuatT, RenderPort, Vec3T } from '@royal-fiesta/game/render/port'
import { SceneLayer } from '@royal-fiesta/game/render/sceneLayer'
import { restPoseSkin } from '@royal-fiesta/game/render/sceneView'
import type { SkinnedCharacter } from '@royal-fiesta/game/render/sceneView'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import { thumbnailUrl } from '../ui/cosmeticThumbnails.ts'
import type { WidgetProps } from '../ui/screenMap.ts'
import type { UaaHost } from '../ui/uaaHost.ts'

export interface FlowDeps {
  cue(id: string): void
  stage?: RenderPort
  character?: PrimsAsset
  names?: (seat: number) => string
  localSeat?: number
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
      props[`carousel-${index}-${j}`] = { visible: exists }
      props[`carousel-focus-${index}-${j}`] = { visible: exists && (active || at === bin.worn) }
      props[`thumb-start-${index}-${j}`] = { thumbnail: id ?? '', visible: !!id && !!thumbnailUrl(id) }
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
      const cosmetic = cosmeticOf(id)
      const assetId = cosmetic?.asset ?? id
      let asset = assets.get(assetId)
      if (asset === undefined) {
        const costume = art.costume(id)
        if (costume === null) continue
        const skin = port.skinOf?.(assetId)
        asset = skin && port.registerSkinned && port.setPose ? port.registerSkinned(assetId, skin) : port.registerAsset(assetId, costume)
        assets.set(assetId, asset)
      }
      worn.set(slot, { id, instance: port.createInstance(asset, cosmetic?.tint ?? null), mount, skinned: !!port.skinOf?.(assetId) && !!port.setPose && !!port.registerSkinned })
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
    if (visible) {
      const portrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth
      port.setCamera(0, { ...art.scene?.camera, eye: [origin[0], origin[1] + 0.7, origin[2] + (portrait ? 12 : 6.2)], target: [origin[0], origin[1] + (portrait ? 0.3 : 0.1), origin[2]], fovYDeg: 38, near: 0.1, far: 500 })
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
    },
  }
}
