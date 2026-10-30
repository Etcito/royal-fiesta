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
import { animationKind, trackPose } from '@royal-fiesta/sim/mechanisms/animation'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import { add3, pose, quatConj, quatMul, quatRotate, sub3 } from '@royal-fiesta/sim/vec'
import type { Vec3 } from '@royal-fiesta/sim/vec'

const TAU = Math.PI * 2
// A remote bean grows in when it arrives and shrinks out when it leaves, over this long.
const POP_MS = 350
// Spectators of the lobby are drawn smaller than its players.
const SPECTATOR_SCALE = 0.72
// Name tags sit this far above a bean's origin (its feet).
export const TAG_HEIGHT = 1.5
// Character modes (sim character/constants CharMode) the view poses.
const MODE_AIR = 1
const MODE_DIVE = 2
const MODE_DIVE_RECOVER = 3
const MODE_STUNNED = 4
// Emote ids from S9: 0 none, 1 wave, 2 dance, 3 cheer, 4 laugh.
const WAVE = 1
const DANCE = 2
const CHEER = 3
const LAUGH = 4

// One remote bean, keyed by its hub seat or lobby presence key. gone >= 0: leaving since then (shrinking out).
interface Slot {
  inst: number; colour: number; born: number; gone: number
  pos: Vec3; yaw: number; mode: number; emote: number; spectator: boolean; name: string
  speed: number; stride: number; seen: boolean
}

/** A name tag the page draws over the canvas: world point above the bean, its text and role. */
export interface HubTag { key: number; name: string; spectator: boolean; own: boolean; pos: Vec3; scale: number }

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
  private mechanisms: number[] = []
  private localBean = -1
  private localColour = -1
  private slots = new Map<number, Slot>()
  private readonly localPrev = { x: 0, z: 0, set: false }
  private localSpeed = 0
  private localStride = 0
  private localPos: Vec3 = { x: 0, y: 0, z: 0 }
  private cam: CameraPose | null = null
  private visible = true
  private clock = 0
  private readonly pose = pose()
  private readonly rest = pose()

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
    for (const item of plaza.mechanisms?.items ?? []) {
      this.mechanisms.push(this.create(this.asset(item.asset, assets(item.asset)), null, true))
    }
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
    const m = this.plaza.mechanisms
    if (m != null) for (let i = 0; i < this.mechanisms.length; i++) {
      const item = m.items[i]
      // Course v1 items keep identity t/r with world body rests; `place` is where their asset draws.
      const place = item.place ?? item
      let t = place.t
      let r = place.r
      for (let a = 0; a < m.animations.length; a++) {
        const anim = m.animations[a]
        if (anim.target.item !== i || animationKind(m, a) !== 'tick') continue
        const body = item.bodies[anim.target.body]
        const rest = this.rest
        quatRotate(item.r, body.rest.t, rest.t)
        add3(item.t, rest.t, rest.t)
        quatMul(item.r, body.rest.r, rest.r)
        // Tick-owned body world pose; the hub loads at tick 0.
        trackPose(anim, tick, q)
        add3(rest.t, q.t, q.t)
        quatMul(q.r, rest.r, q.r)
        // The motion since the world rest (body world pose * inverse world rest) moves the placement.
        sub3(place.t, rest.t, rest.t)
        quatConj(rest.r, rest.r)
        quatMul(q.r, rest.r, q.r)
        quatRotate(q.r, rest.t, rest.t)
        add3(q.t, rest.t, q.t)
        quatMul(q.r, place.r, q.r)
        t = q.t
        r = q.r
        break
      }
      port.setTransform(this.mechanisms[i], [t.x, t.y, t.z], [r.x, r.y, r.z, r.w], [item.s.x, item.s.y, item.s.z])
    }

    const lc = localColour % 8
    if (this.localBean < 0 || lc !== this.localColour) {
      if (this.localBean >= 0) this.destroy(this.localBean)
      this.localBean = this.create(this.beanAsset, PALETTE[lc], true)
      this.localColour = lc
    }
    const ms = this.clock * 1000
    if (this.localPrev.set && dtS > 0) this.localSpeed = Math.hypot(local.pos.x - this.localPrev.x, local.pos.z - this.localPrev.z) / dtS
    this.localPrev.x = local.pos.x
    this.localPrev.z = local.pos.z
    this.localPrev.set = true
    this.localStride += this.localSpeed * dtS
    this.localPos = local.pos
    this.draw(this.localBean, local.pos, Math.atan2(local.facing.x, local.facing.z), localEmote, local.mode, this.localSpeed, this.localStride, 1)

    // Every remote has its own bean, as many as the lobby holds; a new one grows in, a leaver shrinks out.
    for (const slot of this.slots.values()) slot.seen = false
    for (const r of remotes) {
      const colour = r.colour % 8
      let slot = this.slots.get(r.seat)
      if (slot !== undefined && slot.gone >= 0) {
        // Back before it finished leaving: grow from where it is.
        slot.born = ms - POP_MS * this.popOf(slot, ms)
        slot.gone = -1
      }
      if (slot === undefined) {
        slot = {
          inst: this.create(this.beanAsset, PALETTE[colour], true), colour, born: ms, gone: -1,
          pos: { x: r.pos.x, y: r.pos.y, z: r.pos.z }, yaw: r.yaw, mode: r.mode, emote: r.emote, spectator: r.spectator, name: r.name,
          speed: 0, stride: 0, seen: true,
        }
        this.slots.set(r.seat, slot)
      } else if (colour !== slot.colour) {
        // The port has no per-instance tint change: recreate the instance with the new tint.
        this.destroy(slot.inst)
        slot.inst = this.create(this.beanAsset, PALETTE[colour], true)
        slot.colour = colour
      }
      if (dtS > 0) slot.speed = slot.speed * 0.7 + 0.3 * Math.hypot(r.pos.x - slot.pos.x, r.pos.z - slot.pos.z) / dtS
      slot.stride += slot.speed * dtS
      slot.pos.x = r.pos.x
      slot.pos.y = r.pos.y
      slot.pos.z = r.pos.z
      slot.yaw = r.yaw
      slot.mode = r.mode
      slot.emote = r.emote
      slot.spectator = r.spectator
      slot.name = r.name
      slot.seen = true
    }
    for (const [key, slot] of this.slots) {
      if (!slot.seen && slot.gone < 0) slot.gone = ms
      const pop = this.popOf(slot, ms)
      if (slot.gone >= 0 && pop <= 0) {
        this.destroy(slot.inst)
        this.slots.delete(key)
        continue
      }
      this.show(slot.inst, true)
      const scale = pop * (slot.spectator ? SPECTATOR_SCALE : 1)
      this.draw(slot.inst, slot.pos, slot.yaw, slot.emote, slot.mode, slot.speed, slot.stride, scale)
    }

    this.cam = this.orbit !== null ? this.orbit.pose(local.pos) : followCamera(this.cam, local.pos, local.facing, dtS)
    port.setCamera(this.viewport, this.cam)
  }

  /**
   * Name tags for the beans drawn now: the local one (localName) and every remote, at TAG_HEIGHT above the
   * feet. The page projects them with `camera` and draws them over the canvas.
   */
  tags(localName: string | null): HubTag[] {
    const out: HubTag[] = []
    if (!this.visible) return out
    const ms = this.clock * 1000
    if (localName !== null && this.localBean >= 0) {
      out.push({ key: -1, name: localName, spectator: false, own: true, pos: { x: this.localPos.x, y: this.localPos.y + TAG_HEIGHT, z: this.localPos.z }, scale: 1 })
    }
    for (const [key, slot] of this.slots) {
      const scale = this.popOf(slot, ms) * (slot.spectator ? SPECTATOR_SCALE : 1)
      out.push({ key, name: slot.name, spectator: slot.spectator, own: false, pos: { x: slot.pos.x, y: slot.pos.y + TAG_HEIGHT * scale, z: slot.pos.z }, scale })
    }
    return out
  }

  /** Remote beans currently drawn (arriving and leaving ones included). */
  get remoteCount(): number { return this.slots.size }

  // 0..1: how far a remote has grown in (or, leaving, how much is left), eased.
  private popOf(slot: Slot, ms: number): number {
    const t = slot.gone >= 0 ? 1 - (ms - slot.gone) / POP_MS : (ms - slot.born) / POP_MS
    if (t <= 0) return 0
    if (t >= 1) return 1
    // easeOutBack while growing (a small overshoot), plain ease while leaving.
    if (slot.gone >= 0) return t * t * (3 - 2 * t)
    const c = 1.70158
    const u = t - 1
    return 1 + (c + 1) * u * u * u + c * u * u
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
    this.mechanisms = []
    this.slots.clear()
    this.localBean = -1
    this.localColour = -1
  }

  // Drawn transform = base pose (pos, yaw) plus the view-side motion: a walk bob and lean from the planar
  // speed, the dive (lying forward) and its recovery, a stretch in the air, a stun wobble, the emote offset,
  // all scaled by `scale` (arrival, departure, spectator).
  private draw(inst: number, pos: Vec3, yaw: number, emote: number, mode = 0, speed = 0, stride = 0, scale = 1): void {
    const t = this.clock
    let y = pos.y
    let a = yaw
    let roll = 0
    let pitch = 0
    let s: Vec3T = [1, 1, 1]
    const walk = Math.min(1, speed / 6)
    if (mode === MODE_DIVE) pitch = 1.25
    else if (mode === MODE_DIVE_RECOVER) pitch = 0.6
    else if (mode === MODE_AIR) s = [0.94, 1.1, 0.94]
    else if (mode === MODE_STUNNED) roll = 0.35 * Math.sin(TAU * 3 * t)
    else if (walk > 0.05) {
      // Two bobs per stride metre-ish: a hop and a sway, leaning into the walk.
      y += 0.08 * walk * Math.abs(Math.sin(stride * 2.2))
      roll = 0.09 * walk * Math.sin(stride * 2.2)
      pitch = 0.16 * walk
    }
    if (emote === WAVE) roll += 0.2 * Math.sin(TAU * 2 * t)
    else if (emote === DANCE) a += TAU * 2 * t
    else if (emote === CHEER) y += 0.4 * Math.abs(Math.sin(TAU * 3 * t))
    else if (emote === LAUGH) {
      const b = Math.sin(TAU * 4 * t)
      s = [1 - 0.08 * b, 1 + 0.15 * b, 1 - 0.08 * b]
    }
    // yaw about Y, then a local pitch about the bean's right (X) axis (positive leans forward), then a roll about Z.
    const qy: QuatT = [0, Math.sin(a / 2), 0, Math.cos(a / 2)]
    const qp: QuatT = [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)]
    const qr: QuatT = [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)]
    const r = mulQ(mulQ(qy, qp), qr)
    this.port.setTransform(inst, [pos.x, y, pos.z], r, [s[0] * scale, s[1] * scale, s[2] * scale])
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

function mulQ(a: QuatT, b: QuatT): QuatT {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}
