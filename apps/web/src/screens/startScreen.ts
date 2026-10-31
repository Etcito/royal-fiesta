// The caller owns input and advances this view once per frame with the latest wardrobe model.
import type { StartScreenModel } from '@royal-fiesta/game/flow/startScreen'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { QuatT, RenderPort, Vec3T } from '@royal-fiesta/game/render/port'
import { SceneLayer } from '@royal-fiesta/game/render/sceneLayer'
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
}

// Prepared by game-web from its loaded content; this view never loads or meshes assets.
export interface StartArt {
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

const HINT = '↑/↓ choose · ←/→ change · Enter select'
const UNIT: Vec3T = [1, 1, 1]
const ORIGIN: Vec3T = [0, 0, 0]
const YAW_PER_MS = 0.0002

function focused(label: string, focus: boolean): string {
  return focus ? `▶ ${label} ◀` : label
}

function itemName(id: string | undefined): string {
  if (id === undefined) return 'None'
  const name = id.slice(id.lastIndexOf('.') + 1).replace(/-/g, ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function present(host: UaaHost, model: StartScreenModel): void {
  const menu: MenuModel = {
    screen: 'start', title: 'Royal Fiesta', lines: [], hint: HINT, overlay: false,
    buttons: [
      { label: focused('Play', model.focus === 'play'), cmd: { k: 'action', action: 'play' } },
      { label: focused('Shop', model.focus === 'shop'), cmd: { k: 'action', action: 'shop' } },
      { label: 'Back', cmd: { k: 'back' } },
    ],
  }
  host.present(menu)
  const props: Record<string, WidgetProps> = {
    'inbox-badge': { text: { count: String(model.badge) }, visible: model.badge > 0 },
    'palette-mark': { visible: false },
  }
  model.bins.forEach((bin, index) => {
    const label = `< ${itemName(bin.items[bin.selected])} >`
    props[`bin-${bin.slot}`] = {
      text: focused(label, model.focus === 'bins' && model.bin === index), visible: true,
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
  const worn = new Map<StartScreenModel['bins'][number]['slot'], { id: string; instance: number; mount: Vec3T }>()
  let penguin = port.createInstance(character, PALETTE[model.colour])
  let colour = model.colour
  let current = model
  let mounted = true
  let visible = true
  const started = performance.now()
  port.setEnvironment(art.environment)

  function draw(next: StartScreenModel): void {
    if (next.colour !== colour) {
      port.destroyInstance(penguin)
      penguin = port.createInstance(character, PALETTE[next.colour])
      colour = next.colour
    }
    const selected = new Map(next.bins.map(bin => [bin.slot, bin.selected >= 0 ? bin.items[bin.selected] : undefined]))
    for (const [slot, item] of worn) {
      if (selected.get(slot) === item.id) continue
      port.destroyInstance(item.instance)
      worn.delete(slot)
    }
    for (const [slot, id] of selected) {
      if (id === undefined || worn.has(slot)) continue
      const mount = art.mounts.get(id)
      if (mount === undefined) continue
      let asset = assets.get(id)
      if (asset === undefined) {
        const costume = art.costume(id)
        if (costume === null) continue
        asset = port.registerAsset(id, costume)
        assets.set(id, asset)
      }
      worn.set(slot, { id, instance: port.createInstance(asset, null), mount })
    }
    // Unposed skin draws at rest. Rotate the root and each mount offset together.
    const yaw = (performance.now() - started) * YAW_PER_MS
    const rotation: QuatT = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
    port.setTransform(penguin, ORIGIN, rotation, UNIT)
    for (const { instance, mount: [x, y, z] } of worn.values()) {
      port.setTransform(instance, [Math.cos(yaw) * x + Math.sin(yaw) * z, y, -Math.sin(yaw) * x + Math.cos(yaw) * z], rotation, UNIT)
    }
    if (visible) port.setCamera(0, { eye: [0, 0.7, 4.8], target: [0, 0.3, 0], fovYDeg: 38, near: 0.1, far: 500 })
  }

  draw(model)
  present(host, model)
  return {
    update(next, step) {
      if (!mounted) return
      current = next
      if (step?.effect === 'play' || step?.effect === 'shop') deps.cue('ui.click')
      else if (step?.action === 'up' || step?.action === 'down' || step?.effect === 'wear') deps.cue('ui.hover')
      draw(next)
      if (visible) present(host, next)
    },
    setVisible(shown) {
      if (!mounted) return
      visible = shown
      layer.setVisible(shown)
      if (shown) {
        draw(current)
        present(host, current)
      }
    },
    unmount() {
      if (!mounted) return
      mounted = false
      layer.setVisible(false)
      port.destroyInstance(penguin)
      for (const item of worn.values()) port.destroyInstance(item.instance)
      worn.clear()
    },
  }
}
