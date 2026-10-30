import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapWriter } from '@gamesaloon/rollback'
import { FarReader } from '@gamesaloon/rollback/zones'
import type { FarSink } from '@gamesaloon/rollback/zones'
import { encodeFar } from '@royal-fiesta/sim/zones/farState'
import { FarFeed } from '../src/net/farFeed.ts'

const remote = () => false
const turn = Math.PI * 2

function entity(seat: number, x: number, yaw = 0, mode = 0, status = 0) {
  return {
    seat, pos: { x, y: x * 2, z: -x },
    facing: { x: Math.sin(yaw), z: Math.cos(yaw) }, mode, status,
  }
}

function feed(sink: FarSink, tick: number, entities: ReturnType<typeof entity>[], stride = 6, domain = 1) {
  const writer = new SnapWriter()
  encodeFar(writer, entities)
  const reader = new FarReader().bind(writer.bytes())
  const n = reader.u16()
  // The session passes the entry count separately, after promoting it into the header.
  sink.far(domain, tick, stride, n, reader)
  assert.equal(reader.remaining, 0)
}

function close(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)
}

test('interpolates positions at mid-stride and uses newest mode and status', () => {
  const sink = new FarFeed()
  assert.deepEqual(sink.read(0, remote), [])
  feed(sink, 12, [entity(4, 0)])
  assert.equal(sink.read(15, remote)[0].x, 0)
  feed(sink, 18, [entity(4, 6, 0, 2, 1)])
  const [shown] = sink.read(15, remote)
  assert.deepEqual(shown, { seat: 4, x: 3, y: 6, z: -3, yaw: 0, mode: 2, status: 1 })
  assert.equal(sink.read(12, remote)[0].x, 0)
  assert.equal(sink.read(18, remote)[0].x, 6)
})

test('yaw crosses the full-turn seam along the shortest arc in both directions', () => {
  for (const direction of [-1, 1]) {
    const sink = new FarFeed()
    feed(sink, 12, [entity(4, 0, -direction * turn / 16)])
    feed(sink, 18, [entity(4, 0, direction * turn / 16)])
    const yaw = sink.read(15, remote)[0].yaw
    close(Math.min(yaw, turn - yaw), 0, turn / (1 << 16))
  }
})

test('holds the newest pose without extrapolating and never precedes oldest', () => {
  const sink = new FarFeed()
  feed(sink, 12, [entity(4, 0)])
  feed(sink, 18, [entity(4, 6)])
  assert.equal(sink.read(-1000, remote)[0].x, 0)
  assert.equal(sink.read(21, remote)[0].x, 6)
  assert.equal(sink.read(24, remote)[0].x, 6)
  assert.equal(sink.read(41, remote)[0].x, 6)
})

test('missing packets use elapsed sample ticks and the newest stride for expiry', () => {
  const sink = new FarFeed()
  feed(sink, 12, [entity(4, 0)])
  feed(sink, 24, [entity(4, 12)], 2)
  assert.equal(sink.read(18, remote)[0].x, 6)
  assert.equal(sink.read(31, remote)[0].x, 12)
  assert.deepEqual(sink.read(32, remote), [])
})

test('drops locally held seats until fresh FAR, then starts with a single sample', () => {
  const sink = new FarFeed()
  feed(sink, 12, [entity(1, 0), entity(4, 0)])
  feed(sink, 18, [entity(1, 6), entity(4, 6)])
  assert.deepEqual(sink.read(15, seat => seat === 1).map(e => e.seat), [4])
  assert.deepEqual(sink.read(18, remote).map(e => e.seat), [4])
  feed(sink, 24, [entity(1, 20)])
  const shown = sink.read(21, remote).find(e => e.seat === 1)!
  assert.equal(shown.x, 20)
})

test('late and repeated FAR do not replace the last two samples', () => {
  const sink = new FarFeed()
  feed(sink, 12, [entity(4, 0)])
  feed(sink, 18, [entity(4, 6)])
  feed(sink, 15, [entity(4, 99)])
  feed(sink, 18, [entity(4, 99)])
  assert.equal(sink.read(15, remote)[0].x, 3)
})

test('a domain change starts a new trajectory', () => {
  const sink = new FarFeed()
  feed(sink, 12, [entity(4, 0)])
  feed(sink, 18, [entity(4, 100)], 6, 2)
  assert.equal(sink.read(15, remote)[0].x, 100)
})

test('warm entries survive smaller and empty packets and reuse display records', () => {
  const sink = new FarFeed()
  feed(sink, 12, [entity(1, 0), entity(4, 0)])
  const results = sink.read(12, remote)
  const first = results[0]
  const second = results[1]
  feed(sink, 18, [entity(4, 6)])
  feed(sink, 24, [])
  feed(sink, 30, [entity(1, 18), entity(4, 18)])
  assert.equal(sink.read(30, remote), results)
  assert.equal(results[0], first)
  assert.equal(results[1], second)
  assert.equal(first.x, 18)
  assert.equal(second.x, 18)
})

test('drops each seat after four of its last stride ticks without an entry', () => {
  const sink = new FarFeed()
  feed(sink, 12, [entity(1, 0), entity(4, 0)])
  feed(sink, 18, [entity(4, 6)])
  feed(sink, 30, [])
  assert.deepEqual(sink.read(35, remote).map(e => e.seat), [1, 4])
  assert.deepEqual(sink.read(36, remote).map(e => e.seat), [4])
  assert.deepEqual(sink.read(42, remote), [])
  assert.deepEqual(sink.read(12, remote), [])
  feed(sink, 48, [entity(1, 20)])
  assert.equal(sink.read(45, remote)[0].x, 20)
})

test('a short packet is ignored completely without renewing existing entries', () => {
  const sink = new FarFeed()
  feed(sink, 12, [entity(4, 0)])
  feed(sink, 18, [entity(4, 6)])
  const writer = new SnapWriter()
  encodeFar(writer, [entity(4, 99), entity(5, 100)])
  const reader = new FarReader().bind(writer.bytes().subarray(0, writer.bytes().length - 1))
  const n = reader.u16()
  assert.doesNotThrow(() => sink.far(1, 24, 6, n, reader))
  assert.equal(sink.read(15, remote)[0].x, 3)
  assert.deepEqual(sink.read(41, remote).map(e => e.seat), [4])
  assert.deepEqual(sink.read(42, remote), [])
})

test('sleep and wake ignore every body id and arbitrary pose bytes', () => {
  const sink = new FarFeed()
  const pose = new Uint8Array([1, 2, 3])
  sink.sleep(1, 4, 12, true, pose)
  assert.deepEqual(sink.read(12, remote), [])
  feed(sink, 12, [entity(4, 0)])
  feed(sink, 18, [entity(4, 6)])
  for (const id of [4, 42, 0xffffffff]) {
    sink.sleep(1, id, 24, true, pose)
    sink.sleep(2, id, 25, true, new Uint8Array(0))
    sink.sleep(1, id, 26, false, new Uint8Array(0))
  }
  pose.fill(0)
  assert.deepEqual(sink.read(15, remote), [
    { seat: 4, x: 3, y: 6, z: -3, yaw: 0, mode: 0, status: 0 },
  ])
  assert.deepEqual(sink.read(42, remote), [])
})
