import { refuse } from '@royal-fiesta/sim/refusal'

// Local seats for split screen (ARCHITECTURE 1.6 / S26). DOM-free: the web shell owns
// device discovery and only tags each device with one of these ids.
export type DeviceId = 'keyboard' | 'touch' | `pad:${number}`

export interface Seat {
  index: number
  device: DeviceId
  player: number
  colour: number
}

export const MAX_LOCAL_SEATS = 4

const refuseMax = (max: number): never =>
  refuse('client', 'seats', `${max} is outside 1..${MAX_LOCAL_SEATS}; pass a max between 1 and ${MAX_LOCAL_SEATS}`)

export class SeatTable {
  private readonly table: Seat[] = []
  private readonly max: number

  constructor(max: number = MAX_LOCAL_SEATS) {
    if (!Number.isInteger(max) || max < 1 || max > MAX_LOCAL_SEATS) refuseMax(max)
    this.max = max
  }

  // Read-only view in index order. Seat k is always player k with colour k.
  get seats(): readonly Seat[] {
    return this.table
  }

  join(device: DeviceId): Seat | null {
    if (this.seatOf(device) !== -1) return null
    if (this.table.length >= this.max) return null
    const index = this.table.length
    const seat: Seat = { index, device, player: index, colour: index }
    this.table.push(seat)
    return seat
  }

  leave(device: DeviceId): void {
    const at = this.seatOf(device)
    if (at === -1) return
    this.table.splice(at, 1)
    for (let k = at; k < this.table.length; k++) {
      const seat = this.table[k]
      seat.index = k
      seat.player = k
      seat.colour = k
    }
  }

  seatOf(device: DeviceId): number {
    for (let k = 0; k < this.table.length; k++) {
      if (this.table[k].device === device) return k
    }
    return -1
  }
}
