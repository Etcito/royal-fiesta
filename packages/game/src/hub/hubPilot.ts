import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'

const FULL_HOLD_MS = 3000
const LAP_MS = 6000
const RADIUS = 2.5

export class HubPilot {
  private readonly plaza: ResolvedCourse
  private readonly seat: number
  private readonly need: number
  private fullSince = -1
  private wasFull = false
  private waveDue = false
  private wavedOnce = false
  private lastAllowed = true
  private cheerDue = false

  constructor(plaza: ResolvedCourse, seat: number, partySize: number) {
    this.plaza = plaza
    this.seat = seat
    this.need = partySize - 1
  }

  sample(nowMs: number, x: number, z: number, othersInHub: number, queueAllowed: boolean, out: PlayerInput): PlayerInput {
    out.jump = false
    out.dive = false
    out.grab = false
    out.moveX = 0
    out.moveZ = 0
    const full = othersInHub >= this.need
    if (!full) this.fullSince = -1
    else if (this.fullSince < 0) this.fullSince = nowMs
    if (full && !this.wasFull && !this.wavedOnce) {
      this.waveDue = true
      this.wavedOnce = true
    }
    this.wasFull = full
    if (this.lastAllowed && !queueAllowed) this.cheerDue = true
    this.lastAllowed = queueAllowed

    const go = queueAllowed && this.fullSince >= 0 && nowMs - this.fullSince >= FULL_HOLD_MS
    let tx: number
    let tz: number
    let len: number
    const pad = this.plaza.queuePad
    if (go && pad) {
      if (Math.abs(x - pad.center.x) <= pad.half.x - 0.3 && Math.abs(z - pad.center.z) <= pad.half.z - 0.3) return out
      tx = pad.center.x
      tz = pad.center.z
      len = 1
    } else {
      const sp = this.plaza.spawns[this.seat % this.plaza.spawns.length].t
      const a = ((nowMs % LAP_MS) / LAP_MS) * Math.PI * 2
      tx = sp.x + Math.cos(a) * RADIUS
      tz = sp.z + Math.sin(a) * RADIUS
      len = 0.8
    }
    const dx = tx - x
    const dz = tz - z
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < 1e-6) return out
    out.moveX = (dx / d) * len
    out.moveZ = (dz / d) * len
    return out
  }

  takeEmote(_nowMs: number): number {
    if (this.waveDue) {
      this.waveDue = false
      return 1
    }
    if (this.cheerDue) {
      this.cheerDue = false
      return 3
    }
    return 0
  }
}
