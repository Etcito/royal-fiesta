import type { FarReader, FarSink } from '@gamesaloon/rollback/zones'
import { decodeFar } from '@royal-fiesta/sim/zones/farState'
import type { FarEntity } from '@royal-fiesta/sim/zones/farState'

interface Sample extends FarEntity {
  tick: number
}

interface SeatEntry {
  domain: number
  stride: number
  active: boolean
  previous: Sample
  newest: Sample
  shown: FarEntity
}

const TIMEOUT_STRIDES = 4

function sample(entity: FarEntity, tick: number): Sample {
  return { ...entity, tick }
}

function copy(out: FarEntity, source: FarEntity): void {
  out.seat = source.seat
  out.x = source.x
  out.y = source.y
  out.z = source.z
  out.yaw = source.yaw
  out.mode = source.mode
  out.status = source.status
}

/** Display state only. No reference to a domain simulation or its step inputs. */
export class FarFeed implements FarSink {
  private readonly decoded: FarEntity[] = []
  private readonly bySeat: (SeatEntry | undefined)[] = []
  private readonly seats: SeatEntry[] = []
  private readonly shown: FarEntity[] = []

  far(domain: number, tick: number, stride: number, n: number, entries: FarReader): void {
    const count = decodeFar(entries, n, this.decoded)
    if (!(stride > 0)) return
    for (let i = 0; i < count; i++) {
      const entity = this.decoded[i]
      let entry = this.bySeat[entity.seat]
      if (entry === undefined) {
        entry = {
          domain, stride, active: true,
          previous: sample(entity, tick),
          newest: sample(entity, tick),
          shown: { ...entity },
        }
        this.bySeat[entity.seat] = entry
        this.seats.push(entry)
        continue
      }
      if (tick <= entry.newest.tick) continue
      if (!entry.active || entry.domain !== domain || tick - entry.newest.tick >= TIMEOUT_STRIDES * entry.stride) {
        copy(entry.previous, entity)
        entry.previous.tick = tick
      } else {
        copy(entry.previous, entry.newest)
        entry.previous.tick = entry.newest.tick
      }
      copy(entry.newest, entity)
      entry.newest.tick = tick
      entry.domain = domain
      entry.stride = stride
      entry.active = true
    }
  }

  /** All seat poses, awake or asleep, arrive through FAR. Body poses are opaque. */
  sleep(_domain: number, _id: number, _tick: number, _asleep: boolean, _pose: Uint8Array): void {}

  /**
   * Reused results, valid until the next read. Local seats stay dropped until fresh FAR.
   * Interpolate between sample ticks and hold the newest pose until expiry.
   */
  read(displayTick: number, holdsLocalSeat: (seat: number) => boolean): readonly FarEntity[] {
    this.shown.length = 0
    for (let i = 0; i < this.seats.length; i++) {
      const entry = this.seats[i]
      if (!entry.active) continue
      const newest = entry.newest
      if (holdsLocalSeat(newest.seat) || displayTick - newest.tick >= TIMEOUT_STRIDES * entry.stride) {
        entry.active = false
        continue
      }
      const previous = entry.previous
      const span = newest.tick - previous.tick
      const tick = Math.max(previous.tick, Math.min(displayTick, newest.tick))
      const alpha = span > 0 ? (tick - previous.tick) / span : 0
      const out = entry.shown
      copy(out, newest)
      out.x = previous.x + (newest.x - previous.x) * alpha
      out.y = previous.y + (newest.y - previous.y) * alpha
      out.z = previous.z + (newest.z - previous.z) * alpha
      const turn = Math.PI * 2
      let yawDelta = (newest.yaw - previous.yaw) % turn
      if (yawDelta > Math.PI) yawDelta -= turn
      if (yawDelta < -Math.PI) yawDelta += turn
      out.yaw = ((previous.yaw + yawDelta * alpha) % turn + turn) % turn
      this.shown.push(out)
    }
    return this.shown
  }
}
