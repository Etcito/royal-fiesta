import type { CameraPose, QuatT, RenderPort, Vec3T } from '@royal-fiesta/game/render/port'
import type { Rect } from '@royal-fiesta/game/screens/menuModel'
import penguin from '../../../../assets/common/penguin.body.asset.json' with { type: 'json' }

type V3 = [number, number, number]
type Player = { t: Vec3T; r: QuatT; s: Vec3T; visible: boolean }
export interface SettingsSceneFrame { player: number; bounds: Rect; camera: CameraPose }
const dot = (a: Vec3T, b: Vec3T): number => a.reduce((n, v, i) => n + v * b[i], 0)
const sub = (a: Vec3T, b: Vec3T): V3 => a.map((v, i) => v - b[i]) as V3
const unit = (v: Vec3T): V3 => v.map(x => x / Math.hypot(...v)) as V3
const cross = (a: Vec3T, b: Vec3T): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

function corners(p: Player): V3[] {
  const result: V3[] = []
  for (const x of [penguin.bounds.min[0], penguin.bounds.max[0]]) {
    for (const y of [penguin.bounds.min[1], penguin.bounds.max[1]]) {
      for (const z of [penguin.bounds.min[2], penguin.bounds.max[2]]) {
        const v: V3 = [x * p.s[0], y * p.s[1], z * p.s[2]]
        const q: V3 = [p.r[0], p.r[1], p.r[2]]
        const uv = cross(q, v), uuv = cross(q, uv)
        result.push(v.map((n, i) => p.t[i] + n + 2 * (p.r[3] * uv[i] + uuv[i])) as V3)
      }
    }
  }
  return result
}

export function projectPlayer(points: readonly Vec3T[], camera: CameraPose, width: number, height: number): Rect {
  const forward = unit(sub(camera.target, camera.eye))
  const right = unit(cross(forward, camera.up ?? [0, 1, 0]))
  const up = cross(right, forward)
  const focal = height / (2 * Math.tan(camera.fovYDeg * Math.PI / 360))
  const projected = points.map(point => {
    const v = sub(point, camera.eye), depth = dot(v, forward)
    if (depth <= camera.near || depth >= camera.far) throw new Error('Settings player outside camera depth')
    return [width / 2 + dot(v, right) * focal / depth, height / 2 - dot(v, up) * focal / depth]
  })
  const x = Math.min(...projected.map(p => p[0])), y = Math.min(...projected.map(p => p[1]))
  return { x, y, w: Math.max(...projected.map(p => p[0])) - x, h: Math.max(...projected.map(p => p[1])) - y }
}

// Fit the actual character bounds into the scene space beside/below the content-sized panel.
export function settingsCamera(points: readonly Vec3T[], previous: CameraPose, panel: Rect, width: number, height: number): CameraPose {
  const portrait = height > width
  const gap = Math.min(width, height) * 0.025
  const free = portrait ? { x: 0, y: panel.y + panel.h + gap, w: width, h: height - panel.y - panel.h - gap }
    : { x: 0, y: 0, w: panel.x - gap, h: height }
  if (free.w <= 0 || free.h <= 0) throw new Error('Settings panel leaves no room for the player')
  const centre = [0, 1, 2].map(i => (Math.min(...points.map(p => p[i])) + Math.max(...points.map(p => p[i]))) / 2) as V3
  const radius = Math.max(...points.map(p => Math.hypot(...sub(p, centre))))
  const forward = unit(sub(previous.target, previous.eye))
  const right = unit(cross(forward, previous.up ?? [0, 1, 0])), up = cross(right, forward)
  const tan = Math.tan(previous.fovYDeg * Math.PI / 360)
  const distance = radius + radius * height / (2 * tan * Math.min(free.w, free.h) * 0.4)
  const nx = (free.x + free.w / 2) * 2 / width - 1
  const ny = 1 - (free.y + free.h / 2) * 2 / height
  const target = centre.map((n, i) => n - right[i] * nx * distance * tan * width / height - up[i] * ny * distance * tan) as V3
  return { ...previous, target, eye: target.map((n, i) => n - forward[i] * distance) as V3 }
}

// Observe the same transforms/visibility/camera that reach the real port; the GPU op reads the submitted bounds.
export class SettingsScene {
  private readonly players = new Map<number, Player>()
  private readonly assets = new Set<number>()
  private camera: CameraPose | null = null
  frame: SettingsSceneFrame | null = null

  wrap(port: RenderPort, character: string, layout: () => { panel: Rect; width: number; height: number } | null): RenderPort {
    return new Proxy(port, {
      get: (target, key) => {
        if (key === 'registerAsset' || key === 'registerSkinned') {
          const register = target[key]
          if (!register) return undefined
          return (...args: unknown[]) => {
            const handle = (register as (...args: unknown[]) => number).apply(target, args)
            if (args[0] === character) this.assets.add(handle)
            return handle
          }
        }
        if (key === 'createInstance') return (...args: Parameters<RenderPort['createInstance']>) => {
          const id = target.createInstance(...args)
          if (this.assets.has(args[0])) this.players.set(id, { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1], visible: true })
          return id
        }
        if (key === 'setTransform') return (...args: Parameters<RenderPort['setTransform']>) => {
          const p = this.players.get(args[0])
          if (p) { p.t = [...args[1]]; p.r = [...args[2]]; p.s = [...args[3]] }
          target.setTransform(...args)
        }
        if (key === 'setVisible') return (id: number, visible: boolean) => {
          const p = this.players.get(id)
          if (p) p.visible = visible
          target.setVisible(id, visible)
        }
        if (key === 'destroyInstance') return (id: number) => { this.players.delete(id); target.destroyInstance(id) }
        if (key === 'setCamera') return (viewport: number, camera: CameraPose) => {
          if (viewport === 0) this.camera = camera
          target.setCamera(viewport, camera)
        }
        if (key === 'render') return () => {
          const box = layout()
          const player = [...this.players].find(([, p]) => p.visible)
          this.frame = null
          if (box && player && this.camera) {
            const points = corners(player[1])
            const camera = settingsCamera(points, this.camera, box.panel, box.width, box.height)
            target.setCamera(0, camera)
            this.frame = { player: player[0], bounds: projectPlayer(points, camera, box.width, box.height), camera }
          }
          return target.render()
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
}
