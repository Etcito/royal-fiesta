// Binds the hub to a RenderPort: plaza obstacles, the local bean, pooled remote beans with emote poses, and the
// camera (the orbit camera on the player page, followCamera on proof pages).
// DOM-free (the Node proof runs it with NullRenderPort). View side only: emote offsets touch the drawn transform only.
import { NO_DRESSING } from '@royal-fiesta/game/content'
import type { CourseDressing } from '@royal-fiesta/game/content'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RemoteView } from '@royal-fiesta/game/hub/remotes'
import { followCamera } from '@royal-fiesta/game/render/camera'
import type { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import type { CameraPose, QuatT, RenderPort, Vec3T } from '@royal-fiesta/game/render/port'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import { pose } from '@royal-fiesta/sim/vec'
import type { Vec3 } from '@royal-fiesta/sim/vec'

const POOL = 4
const TAU = Math.PI * 2
// Emote ids from S9: 0 none, 1 wave, 2 dance, 3 cheer, 4 laugh.
const WAVE = 1
const DANCE = 2
const CHEER = 3
const LAUGH = 4

interface Slot { inst: number; colour: number }

export interface HubViewOptions {
  // The player page's orbit camera frames the local bean; without it, followCamera (proof pages).
  orbit?: OrbitCamera
  // The content's character asset (GameContent.character()); the bean when absent.
  character?: PrimsAsset
  // Hub decor and environment: entered while the hub is shown, left when it is hidden or disposed. Default NO_DRESSING.
  dressing?: CourseDressing
}

export class HubView {
  private readonly port: RenderPort
  private readonly viewport: number
  private readonly plaza: ResolvedCourse
  private readonly beanAsset: number
  private readonly orbit: OrbitCamera | null
  private readonly dressing: CourseDressing
  // True between dressing.enter and dressing.leave, so each leave pairs with exactly one enter.
  private dressed = false
  // registerAsset is idempotent, but the handle is cached so each name is registered once.
  private readonly handles = new Map<string, number>()
  // Last visibility sent per instance, so setVisible is called only on a change.
  private readonly shown = new Map<number, boolean>()
  private obstacles: number[] = []
  private localBean = -1
  private localColour = -1
  private slots: Slot[] = []
  private cam: CameraPose | null = null
  private visible = true
  private clock = 0
  private readonly pose = pose()

  constructor(port: RenderPort, viewport: number, assets: (n: string) => PrimsAsset, bean: PrimsAsset, plaza: ResolvedCourse, opts: HubViewOptions = {}) {
    this.port = port
    this.viewport = viewport
    this.plaza = plaza
    this.orbit = opts.orbit ?? null
    this.dressing = opts.dressing ?? NO_DRESSING
    const character = opts.character ?? bean
    this.beanAsset = this.asset(character.id, character)
    for (let i = 0; i < plaza.obstacles.length; i++) {
      const spec = plaza.obstacles[i]
      this.obstacles.push(this.create(this.asset(spec.asset, assets(spec.asset)), null, true))
    }
    for (let k = 0; k < POOL; k++) this.slots.push({ inst: this.create(this.beanAsset, PALETTE[k], false), colour: k })
    this.dress(true)
  }

  get camera(): CameraPose | null {
    return this.cam
  }

  // localEmote is optional: the local bean emotes too when the caller passes its emote id.
  update(local: CharState, localColour: number, remotes: RemoteView[], tick: number, dtS: number, localEmote = 0): void {
    const port = this.port
    this.clock += dtS

    const q = this.pose
    for (let i = 0; i < this.obstacles.length; i++) {
      const spec = this.plaza.obstacles[i]
      motionPose(spec, tick, 0, q)
      port.setTransform(this.obstacles[i], [q.t.x, q.t.y, q.t.z], [q.r.x, q.r.y, q.r.z, q.r.w], [spec.s.x, spec.s.y, spec.s.z])
    }

    const lc = localColour % 8
    if (this.localBean < 0 || lc !== this.localColour) {
      if (this.localBean >= 0) this.destroy(this.localBean)
      this.localBean = this.create(this.beanAsset, PALETTE[lc], true)
      this.localColour = lc
    }
    this.draw(this.localBean, local.pos, Math.atan2(local.facing.x, local.facing.z), localEmote)

    for (let k = 0; k < POOL; k++) {
      const slot = this.slots[k]
      if (k >= remotes.length) {
        this.show(slot.inst, false)
        continue
      }
      const r = remotes[k]
      const colour = r.colour % 8
      if (colour !== slot.colour) {
        // The port has no per-instance tint change: recreate the instance with the new tint.
        this.destroy(slot.inst)
        slot.inst = this.create(this.beanAsset, PALETTE[colour], false)
        slot.colour = colour
      }
      this.show(slot.inst, true)
      this.draw(slot.inst, r.pos, r.yaw, r.emote)
    }

    this.cam = this.orbit !== null ? this.orbit.pose(local.pos) : followCamera(this.cam, local.pos, local.facing, dtS)
    port.setCamera(this.viewport, this.cam)
  }

  // Hides every HubView instance while a match is shown in the same port; true restores them.
  // Hide before the match view's first update, so the hub dressing is left before the course's is entered.
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    for (const [inst, on] of this.shown) this.port.setVisible(inst, visible && on)
    this.dress(visible)
  }

  dispose(): void {
    this.dress(false)
    for (const inst of [...this.shown.keys()]) this.destroy(inst)
    this.obstacles = []
    this.slots = []
    this.localBean = -1
    this.localColour = -1
  }

  // Drawn transform = base pose (pos, yaw) plus the view-side emote offset.
  private draw(inst: number, pos: Vec3, yaw: number, emote: number): void {
    const t = this.clock
    let y = pos.y
    let a = yaw
    let roll = 0
    let s: Vec3T = [1, 1, 1]
    if (emote === WAVE) roll = 0.2 * Math.sin(TAU * 2 * t)
    else if (emote === DANCE) a += TAU * 2 * t
    else if (emote === CHEER) y += 0.4 * Math.abs(Math.sin(TAU * 3 * t))
    else if (emote === LAUGH) {
      const b = Math.sin(TAU * 4 * t)
      s = [1 - 0.08 * b, 1 + 0.15 * b, 1 - 0.08 * b]
    }
    // yaw about Y, then a local roll about the bean's forward (Z) axis.
    const hy = a / 2
    const hr = roll / 2
    const cy = Math.cos(hy)
    const sy = Math.sin(hy)
    const cr = Math.cos(hr)
    const sr = Math.sin(hr)
    const r: QuatT = [sy * sr, sy * cr, cy * sr, cy * cr]
    this.port.setTransform(inst, [pos.x, y, pos.z], r, s)
  }

  // Hub entry enters the plaza dressing; hub exit leaves it.
  private dress(on: boolean): void {
    if (on === this.dressed) return
    if (on) this.dressing.enter(this.port, this.plaza.id)
    else this.dressing.leave(this.port)
    this.dressed = on
  }

  private asset(name: string, a: PrimsAsset): number {
    let h = this.handles.get(name)
    if (h === undefined) {
      h = this.port.registerAsset(name, a)
      this.handles.set(name, h)
    }
    return h
  }

  private create(asset: number, tint: Vec3T | null, on: boolean): number {
    const inst = this.port.createInstance(asset, tint)
    this.shown.set(inst, on)
    if (!(this.visible && on)) this.port.setVisible(inst, false)
    return inst
  }

  private destroy(inst: number): void {
    this.port.destroyInstance(inst)
    this.shown.delete(inst)
  }

  private show(inst: number, on: boolean): void {
    if (this.shown.get(inst) === on) return
    this.shown.set(inst, on)
    if (this.visible) this.port.setVisible(inst, on)
  }
}
