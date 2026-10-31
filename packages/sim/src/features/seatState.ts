import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { FeatureSeats } from './feature.ts'

type Seats = Pick<FeatureSeats, 'count' | 'seat'>

/** Feature state belongs to room seats, never to transient domain slots. */
export class SeatState<T> {
  ids: number[] = []
  rows: T[] = []
  readonly #create: () => T

  constructor(create: () => T) { this.#create = create }

  sync(seats: Seats): void {
    if (this.ids.length === seats.count && this.ids.every((id, i) => id === seats.seat(i))) return
    const previous = new Map(this.ids.map((id, i) => [id, this.rows[i]]))
    this.ids = Array.from({ length: seats.count }, (_, i) => seats.seat(i))
    this.rows = this.ids.map(id => previous.get(id) ?? this.#create())
  }

  snapshot(w: SnapWriter, write: (w: SnapWriter, row: T) => void): void {
    w.u16(this.ids.length)
    for (let i = 0; i < this.ids.length; i++) {
      w.u16(this.ids[i])
      write(w, this.rows[i])
    }
  }

  restore(r: SnapReader, seats: Seats, read: (r: SnapReader) => T): void {
    const n = r.u16()
    this.ids = []
    this.rows = []
    for (let i = 0; i < n; i++) {
      this.ids.push(r.u16())
      this.rows.push(read(r))
    }
    this.sync(seats)
  }
}

/** Contested feature interactions use ascending room seat, independent of slot order. */
export function orderedSeatIndices(seats: Seats): number[] {
  return Array.from({ length: seats.count }, (_, i) => i).sort((a, b) => seats.seat(a) - seats.seat(b))
}
