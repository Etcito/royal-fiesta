import assert from 'node:assert/strict'
import test from 'node:test'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { MAX_LOCAL_SEATS, SeatTable } from '../src/client/seats.ts'
import type { DeviceId } from '../src/client/seats.ts'

const devices: DeviceId[] = ['keyboard', 'pad:0', 'pad:1', 'touch']

test('SeatTable: four devices fill seats 0..3 with player and colour equal to the index', () => {
  const t = new SeatTable()
  for (let k = 0; k < devices.length; k++) {
    const seat = t.join(devices[k])
    assert.ok(seat, `join(${devices[k]}) returned null`)
    assert.equal(seat.index, k)
    assert.equal(seat.player, k)
    assert.equal(seat.colour, k)
    assert.equal(seat.device, devices[k])
    assert.equal(t.seatOf(devices[k]), k)
  }
  assert.equal(t.seats.length, MAX_LOCAL_SEATS)
  assert.deepEqual(t.seats.map(s => [s.index, s.player, s.colour]), [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])
})

test('SeatTable: a fifth join and a repeated join return null', () => {
  const t = new SeatTable()
  for (const d of devices) t.join(d)
  assert.equal(t.join('pad:2'), null)
  assert.equal(t.join('keyboard'), null)
  assert.equal(t.seats.length, MAX_LOCAL_SEATS)
})

test('SeatTable: leaving pad:0 compacts pad:1 and touch down', () => {
  const t = new SeatTable()
  for (const d of devices) t.join(d)
  t.leave('pad:0')
  assert.equal(t.seats.length, 3)
  assert.deepEqual(t.seats.map(s => [s.index, s.device, s.player, s.colour]), [
    [0, 'keyboard', 0, 0],
    [1, 'pad:1', 1, 1],
    [2, 'touch', 2, 2],
  ])
  assert.equal(t.seatOf('pad:1'), 1)
  assert.equal(t.seatOf('touch'), 2)
})

test('SeatTable: seatOf is -1 after a device leaves and leaving an unknown device does nothing', () => {
  const t = new SeatTable()
  for (const d of devices) t.join(d)
  t.leave('pad:0')
  assert.equal(t.seatOf('pad:0'), -1)
  const before = t.seats.length
  t.leave('pad:9')
  assert.equal(t.seats.length, before)
  assert.deepEqual(t.seats.map(s => s.device), ['keyboard', 'pad:1', 'touch'])
})

test('SeatTable(1) takes one seat only', () => {
  const t = new SeatTable(1)
  const only = t.join('keyboard')
  assert.ok(only)
  assert.equal(only.index, 0)
  assert.equal(t.join('pad:0'), null)
  assert.equal(t.seats.length, 1)
})

test('SeatTable: a max outside 1..4 is refused and the message names the fix', () => {
  for (const max of [0, 5, -1, 2.5, Number.NaN]) {
    let refusal: unknown = null
    try {
      new SeatTable(max)
    } catch (e) {
      refusal = e
    }
    assert.ok(isRefusal(refusal), `SeatTable(${max}) was not refused`)
    assert.equal(refusal.area, 'client')
    assert.equal(refusal.path, 'seats')
    assert.match(refusal.reason, /1\.\.4/)
    assert.match(refusal.reason, /pass a max between 1 and 4/i)
  }
  assert.equal(new SeatTable(4).join('keyboard')?.index, 0)
})
