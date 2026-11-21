import type { ViewBuffer } from '@etcito/game-engine'
import { CAPSULE } from '@royal-fiesta/sim/character/capsule'
import { seatTint } from '../render/palette.ts'

const HEADER = 2
const INPUT_STRIDE = 60
const VIEW_HEADER = 8
const VIEW_STRIDE = 60
const FIRST_SEAT_ZONE = 1
const LAST_SEAT_ZONE = 60

interface FarPose {
  readonly pos: readonly [number, number, number]
  readonly rot: readonly [number, number, number, number]
}

interface Snapshot {
  tick: number
  seats: Map<number, FarPose>
  bytes: Uint8Array
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Decodes complete G7 far snapshots into stable room-seat RenderBridge records. */
export class EngineFarView {
  private readonly domains = new Map<number, Snapshot>()
  private readonly owners = new Map<number, { domain: number; tick: number; pose: FarPose }>()

  /**
   * Handoff: G7-PAGE presentation: complete the round and confirmed podium calls EngineFarView.accept with each
   * live domain's copied snapshot and actual tick; this method atomically replaces that domain's retained seats.
   */
  accept(domain: number, tick: number, bytes: Uint8Array): void {
    if (!Number.isSafeInteger(domain) || domain < 0) throw new Error('EngineFarView domain must be a nonnegative integer')
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('EngineFarView tick must be a nonnegative integer')
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER) throw new Error('EngineFarView snapshot is missing its count')

    const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = input.getUint16(0, true)
    if (bytes.byteLength !== HEADER + count * INPUT_STRIDE) throw new Error('EngineFarView snapshot has a malformed length')

    const seats = new Map<number, FarPose>()
    let previousZone = -1
    for (let i = 0; i < count; i++) {
      const offset = HEADER + i * INPUT_STRIDE
      const zone = input.getUint32(offset, true)
      if (zone <= previousZone) throw new Error('EngineFarView zones must be unique and ascending')
      previousZone = zone
      const values = Array.from({ length: 7 }, (_, n) => input.getFloat64(offset + 4 + n * 8, true))
      if (!values.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) {
        throw new Error(`EngineFarView zone ${zone} has a nonfinite pose`)
      }
      if (zone >= FIRST_SEAT_ZONE && zone <= LAST_SEAT_ZONE) {
        const [x, y, z, qx, qy, qz, qw] = values
        seats.set(zone - FIRST_SEAT_ZONE, { pos: [x, y, z], rot: [qx, qy, qz, qw] })
      }
    }

    const prior = this.domains.get(domain)
    if (prior !== undefined && tick < prior.tick) return
    if (prior !== undefined && tick === prior.tick) {
      if (sameBytes(prior.bytes, bytes)) return
      throw new Error(`EngineFarView conflicting snapshot for domain ${domain} at tick ${tick}`)
    }

    for (const [seat] of seats) {
      const owner = this.owners.get(seat)
      if (owner !== undefined && owner.tick === tick && owner.domain !== domain) {
        throw new Error(`EngineFarView seat ${seat} has conflicting owners at tick ${tick}`)
      }
    }
    for (const seat of prior?.seats.keys() ?? []) {
      const owner = this.owners.get(seat)
      if (owner?.domain === domain) this.owners.delete(seat)
    }
    for (const [seat, pose] of seats) {
      const owner = this.owners.get(seat)
      if (owner === undefined || tick > owner.tick || owner.domain === domain) {
        this.owners.set(seat, { domain, tick, pose })
      }
    }
    this.domains.set(domain, { tick, seats, bytes: bytes.slice() })
  }

  /** Return a valid engine ViewBuffer, omitting every stable seat selected for near rendering. */
  read(near: ReadonlySet<number>): ViewBuffer {
    const selected = [...this.owners.entries()]
      .filter(([seat]) => !near.has(seat))
      .sort(([a], [b]) => a - b)
    const bytes = new Uint8Array(VIEW_HEADER + selected.length * VIEW_STRIDE)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, selected.length, true)
    view.setUint32(4, VIEW_STRIDE, true)
    for (let i = 0; i < selected.length; i++) {
      const [seat, { pose }] = selected[i]
      const offset = VIEW_HEADER + i * VIEW_STRIDE
      view.setUint32(offset, seat, true)
      view.setUint32(offset + 4, 1, true)
      view.setUint32(offset + 8, 3, true)
      const [r, g, b] = seatTint(seat)
      view.setUint32(offset + 12, (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255), true)
      for (let n = 0; n < 3; n++) view.setFloat32(offset + 16 + n * 4, pose.pos[n], true)
      for (let n = 0; n < 4; n++) view.setFloat32(offset + 28 + n * 4, pose.rot[n], true)
      view.setFloat32(offset + 44, CAPSULE.radius, true)
      view.setFloat32(offset + 48, CAPSULE.halfHeight, true)
    }
    return { count: selected.length, stride: VIEW_STRIDE, bytes }
  }

  /** Remove all retained domains and seats, including the empty-snapshot ownership history. */
  clear(): void {
    this.domains.clear()
    this.owners.clear()
  }
}
