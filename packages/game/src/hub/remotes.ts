import type { Vec3 } from '@royal-fiesta/sim/vec'
import { stateToPose } from './protocol.ts'
import type { HubHello, HubState } from './protocol.ts'

// seat: the hub room seat, or the lobby presence key (shared hub). spectator: watching the lobby, not a player of its round.
export interface RemoteView { seat: number; name: string; colour: number; pos: Vec3; yaw: number; mode: number; emote: number; queued: boolean; inMatch: boolean; stale: boolean; spectator: boolean }

const RENDER_DELAY_MS = 300
const MAX_EXTRAP_MS = 200
const RING = 16
const TAU = Math.PI * 2

interface Entry { st: HubState; recvMs: number }
interface Seat { name: string; colour: number; ring: Entry[]; lastSeq: number; spectator: boolean }

type Pose = { pos: Vec3; yaw: number }

function pose(): Pose {
  return { pos: { x: 0, y: 0, z: 0 }, yaw: 0 }
}

function copy(a: Vec3, out: Vec3): void {
  out.x = a.x
  out.y = a.y
  out.z = a.z
}

// shortest signed arc from a to b, in (-PI, PI]
function arc(a: number, b: number): number {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  else if (d <= -Math.PI) d += TAU
  return d
}

export class RemoteBuffer {
  private seats = new Map<number, Seat>()
  private pa = pose()
  private pb = pose()

  private seat(seat: number): Seat {
    let s = this.seats.get(seat)
    if (!s) {
      s = { name: `Bean ${seat + 1}`, colour: seat % 8, ring: [], lastSeq: -1, spectator: false }
      this.seats.set(seat, s)
    }
    return s
  }

  /**
   * The shared hub's roster (the lobby's members, this client excluded): names, colours and roles come from
   * the lobby, and every other seat is removed (that member left the lobby).
   */
  roster(members: readonly { k: number; role: 'player' | 'spectator'; name: string; colour: number }[]): void {
    const keep = new Set<number>()
    for (const m of members) {
      keep.add(m.k)
      const s = this.seat(m.k)
      s.name = m.name
      s.colour = m.colour
      s.spectator = m.role === 'spectator'
    }
    for (const k of [...this.seats.keys()]) if (!keep.has(k)) this.seats.delete(k)
  }

  clear(): void {
    this.seats.clear()
  }

  has(seat: number): boolean {
    return this.seats.has(seat)
  }

  push(seat: number, msg: HubHello | HubState, recvMs: number): void {
    const s = this.seat(seat)
    if (msg.k === 'hi') {
      s.name = msg.name
      s.colour = msg.c
      return
    }
    // drops duplicates and out-of-order states
    if (msg.s <= s.lastSeq) return
    s.lastSeq = msg.s
    s.ring.push({ st: msg, recvMs })
    if (s.ring.length > RING) s.ring.shift()
  }

  remove(seat: number): void {
    this.seats.delete(seat)
  }

  sample(nowMs: number): RemoteView[] {
    const renderMs = nowMs - RENDER_DELAY_MS
    const seats = [...this.seats.keys()].sort((a, b) => a - b)
    const out: RemoteView[] = []
    for (const seat of seats) {
      const s = this.seats.get(seat)!
      const ring = s.ring
      if (ring.length === 0) continue
      const newest = ring[ring.length - 1]
      if (newest.st.x === 1) continue
      const v = this.view(ring, renderMs)
      out.push({ seat, name: s.name, colour: s.colour, spectator: s.spectator, ...v })
    }
    return out
  }

  private view(ring: Entry[], renderMs: number): Omit<RemoteView, 'seat' | 'name' | 'colour' | 'spectator'> {
    const n = ring.length
    const newest = ring[n - 1]
    let src = newest.st
    let stale = false
    const pos = { x: 0, y: 0, z: 0 }
    let yaw = 0
    if (renderMs <= ring[0].recvMs) {
      // older than the buffer: hold the oldest pose
      src = ring[0].st
      stateToPose(src, this.pa)
      copy(this.pa.pos, pos)
      yaw = this.pa.yaw
    } else if (renderMs <= newest.recvMs) {
      let i = 1
      while (ring[i].recvMs < renderMs) i++
      const a = ring[i - 1]
      const b = ring[i]
      src = b.st
      stateToPose(a.st, this.pa)
      stateToPose(b.st, this.pb)
      const span = b.recvMs - a.recvMs
      const t = span > 0 ? (renderMs - a.recvMs) / span : 1
      pos.x = this.pa.pos.x + (this.pb.pos.x - this.pa.pos.x) * t
      pos.y = this.pa.pos.y + (this.pb.pos.y - this.pa.pos.y) * t
      pos.z = this.pa.pos.z + (this.pb.pos.z - this.pa.pos.z) * t
      yaw = this.pa.yaw + arc(this.pa.yaw, this.pb.yaw) * t
    } else {
      const ahead = renderMs - newest.recvMs
      stale = ahead > MAX_EXTRAP_MS
      const dt = Math.min(ahead, MAX_EXTRAP_MS)
      stateToPose(newest.st, this.pb)
      copy(this.pb.pos, pos)
      yaw = this.pb.yaw
      if (n >= 2) {
        const prev = ring[n - 2]
        const span = newest.recvMs - prev.recvMs
        if (span > 0) {
          stateToPose(prev.st, this.pa)
          const k = dt / span
          pos.x += (this.pb.pos.x - this.pa.pos.x) * k
          pos.y += (this.pb.pos.y - this.pa.pos.y) * k
          pos.z += (this.pb.pos.z - this.pa.pos.z) * k
        }
      }
    }
    if (yaw < 0) yaw += TAU
    else if (yaw >= TAU) yaw -= TAU
    return { pos, yaw, mode: src.m, emote: src.e, queued: src.q === 1, inMatch: src.x === 1, stale }
  }
}
