// Name tags over the hub canvas: every bean in the shared hub carries its player's name (HubView.tags()).
// projectPoint is pure (tested in Node); NameTags is the DOM layer, one absolutely placed label per tag,
// pointer-transparent, so pad, touch and keyboard play are untouched.
import type { CameraPose } from '@royal-fiesta/game/render/port'
import type { Vec3 } from '@royal-fiesta/sim/vec'
import type { HubTag } from './hubView.ts'

export interface ScreenPoint { x: number; y: number; depth: number }

/**
 * Where a world point lands on a w x h viewport seen by `cam` (look-at, +Y up, vertical fov), in CSS pixels
 * from the top left; null behind the camera or nearer than its near plane.
 */
export function projectPoint(cam: CameraPose, p: Vec3, w: number, h: number): ScreenPoint | null {
  const fx = cam.target[0] - cam.eye[0], fy = cam.target[1] - cam.eye[1], fz = cam.target[2] - cam.eye[2]
  const fl = Math.hypot(fx, fy, fz)
  if (!(fl > 0) || !(w > 0) || !(h > 0)) return null
  const f = [fx / fl, fy / fl, fz / fl]
  // right = forward x up(0,1,0); a camera looking straight down has none: no tags rather than wrong ones.
  let rx = -f[2], rz = f[0]
  const rl = Math.hypot(rx, rz)
  if (rl < 1e-6) return null
  rx /= rl
  rz /= rl
  // up = right x forward
  const ux = -rz * f[1], uy = rz * f[0] - rx * f[2], uz = rx * f[1]
  const vx = p.x - cam.eye[0], vy = p.y - cam.eye[1], vz = p.z - cam.eye[2]
  const depth = vx * f[0] + vy * f[1] + vz * f[2]
  if (depth < Math.max(cam.near, 1e-3)) return null
  const t = Math.tan((cam.fovYDeg * Math.PI) / 360)
  const ndcX = (vx * rx + vz * rz) / (depth * t * (w / h))
  const ndcY = (vx * ux + vy * uy + vz * uz) / (depth * t)
  return { x: ((ndcX + 1) / 2) * w, y: ((1 - ndcY) / 2) * h, depth }
}

/** The tag text: a spectator says so. */
export function tagText(tag: HubTag): string {
  return tag.spectator ? `${tag.name} (watching)` : tag.name
}

const STYLE = 'position:absolute;left:0;top:0;transform:translate(-50%,-100%);white-space:nowrap;pointer-events:none;'
  + 'font:700 15px system-ui,sans-serif;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000,0 1px 2px #000;'
  + 'padding:1px 7px;border-radius:9px;background:rgba(20,24,40,.45);will-change:transform;'

export class NameTags {
  private readonly layer: HTMLDivElement
  private readonly labels = new Map<number, HTMLDivElement>()
  private readonly canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const layer = document.createElement('div')
    layer.dataset.rfNameTags = ''
    layer.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none;z-index:2;'
    canvas.parentElement?.appendChild(layer)
    this.layer = layer
  }

  /** Places one label per tag (cam null or no tags: none shown). */
  update(cam: CameraPose | null, tags: readonly HubTag[]): void {
    const c = this.canvas
    const w = c.clientWidth, h = c.clientHeight
    const st = this.layer.style
    st.left = `${c.offsetLeft}px`
    st.top = `${c.offsetTop}px`
    st.width = `${w}px`
    st.height = `${h}px`
    const live = new Set<number>()
    if (cam !== null) {
      for (const tag of tags) {
        const sp = projectPoint(cam, tag.pos, w, h)
        if (sp === null || tag.scale < 0.2 || sp.x < -100 || sp.x > w + 100 || sp.y < -40 || sp.y > h + 40) continue
        live.add(tag.key)
        let el = this.labels.get(tag.key)
        if (el === undefined) {
          el = document.createElement('div')
          el.style.cssText = STYLE
          this.layer.appendChild(el)
          this.labels.set(tag.key, el)
        }
        const text = tagText(tag)
        if (el.textContent !== text) el.textContent = text
        el.style.color = tag.own ? '#ffe36b' : tag.spectator ? '#c9d2e6' : '#fff'
        el.style.fontStyle = tag.spectator ? 'italic' : 'normal'
        // Nearer beans get bigger tags, within reason; arriving and leaving ones fade with their bean.
        const k = Math.max(0.6, Math.min(1.3, 12 / sp.depth)) * Math.min(1, tag.scale)
        el.style.opacity = String(Math.min(1, tag.scale))
        el.style.transform = `translate(${sp.x.toFixed(1)}px,${sp.y.toFixed(1)}px) translate(-50%,-100%) scale(${k.toFixed(3)})`
      }
    }
    for (const [key, el] of this.labels) {
      if (live.has(key)) continue
      el.remove()
      this.labels.delete(key)
    }
  }

  dispose(): void {
    this.layer.remove()
    this.labels.clear()
  }
}
