import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { SeatState, orderedSeatIndices } from '../src/features/seatState.ts'

const seats = (ids: number[]) => ({ count: ids.length, seat: (i: number) => ids[i] })
const write = (w: SnapWriter, row: { timer: number }) => w.i32(row.timer)
const read = (r: SnapReader) => ({ timer: r.i32() })

test('seat state restores by room identity, sizes to current seats and initializes new seats', () => {
  const state = new SeatState(() => ({ timer: -1 }))
  const ids = Array.from({ length: 60 }, (_, i) => i)
  state.sync(seats(ids))
  state.rows.forEach((row, i) => { row.timer = i * 7 })
  const w = new SnapWriter()
  state.snapshot(w, write)
  for (const n of [0, 8, 20, 60]) {
    const peer = new SeatState(() => ({ timer: -1 }))
    peer.sync(seats(ids.slice(0, n)))
    const reader = new SnapReader(w.bytes())
    peer.restore(reader, seats(ids), read)
    assert.equal(reader.remaining, 0)
    const restored = new SnapWriter()
    peer.snapshot(restored, write)
    assert.deepEqual(restored.bytes(), w.bytes())
    peer.restore(new SnapReader(w.bytes()), seats([59, 52, 60]), read)
    assert.deepEqual(peer.rows, [{ timer: 413 }, { timer: 364 }, { timer: -1 }])
    peer.sync(seats([60, 59, 52]))
    assert.deepEqual(peer.rows, [{ timer: -1 }, { timer: 413 }, { timer: 364 }])
    peer.sync(seats([60, 59, 0]))
    assert.deepEqual(peer.rows, [{ timer: -1 }, { timer: 413 }, { timer: -1 }])
  }
  assert.deepEqual(orderedSeatIndices(seats([59, 0, 32])), [1, 2, 0])
})
