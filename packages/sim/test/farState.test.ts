import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapWriter } from '@gamesaloon/rollback'
import { FarReader } from '@gamesaloon/rollback/zones'
import { CharMode } from '../src/character/constants.ts'
import { datan2, dcos, dsin, TAU } from '../src/detmath.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { decodeFar, encodeFar } from '../src/zones/farState.ts'
import type { FarEntity } from '../src/zones/farState.ts'

function entity(seat: number, yaw: number) {
  return {
    seat,
    pos: { x: seat + 1 / 3, y: -seat - 0.25, z: seat / 7 },
    facing: { x: dsin(yaw), z: dcos(yaw) },
    mode: CharMode.dive,
    status: PlayerStatus.qualified,
  }
}

for (const n of [0, 1, 8]) {
  test(`FAR round-trip for ${n} entities`, () => {
    const entities = Array.from({ length: n }, (_, i) => entity(0xffff - i, i * TAU / 7))
    const original = entities.slice()
    const writer = new SnapWriter()
    encodeFar(writer, entities)
    const bytes = writer.bytes()
    assert.equal(bytes.length, 2 + n * 18)
    // The session promotes the count into the header; the sink sees entries only.
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true)
    assert.equal(count, n)
    const reader = new FarReader().bind(bytes.subarray(2))
    const out: FarEntity[] = []
    assert.equal(decodeFar(reader, count, out), n)
    assert.equal(reader.remaining, 0)
    assert.deepEqual(entities, original)
    for (let i = 0; i < n; i++) {
      const source = entities[n - i - 1]
      const decoded = out[i]
      assert.equal(decoded.seat, source.seat)
      assert.equal(decoded.x, Math.fround(source.pos.x))
      assert.equal(decoded.y, Math.fround(source.pos.y))
      assert.equal(decoded.z, Math.fround(source.pos.z))
      assert.equal(decoded.mode, source.mode)
      assert.equal(decoded.status, source.status)
      const yaw = datan2(source.facing.x, source.facing.z)
      const error = Math.abs(datan2(dsin(decoded.yaw - yaw), dcos(decoded.yaw - yaw)))
      assert.ok(error < TAU / (1 << 16))
    }
  })
}

test('yaw stays within one u16 step through quadrants and the full-turn seam', () => {
  const writer = new SnapWriter()
  const reader = new FarReader()
  const out: FarEntity[] = []
  const step = TAU / (1 << 16)
  for (const yaw of [0, -0, step / 4, -step / 4, TAU - step / 4, -TAU, ...Array.from({ length: 256 }, (_, i) => (i - 128) * TAU / 255)]) {
    writer.reset()
    encodeFar(writer, [entity(0, yaw)])
    assert.equal(decodeFar(reader.bind(writer.bytes().subarray(2)), 1, out), 1)
    assert.ok(out[0].yaw >= 0 && out[0].yaw < TAU)
    const delta = out[0].yaw - yaw
    assert.ok(Math.abs(datan2(dsin(delta), dcos(delta))) < step)
  }
})

test('decode reuses caller entries across repeated, smaller and empty packets', () => {
  const writer = new SnapWriter()
  const reader = new FarReader()
  const out: FarEntity[] = []
  const entities = Array.from({ length: 8 }, (_, i) => entity(i, i))
  encodeFar(writer, entities)
  decodeFar(reader.bind(writer.bytes().subarray(2)), entities.length, out)
  const references = out.slice()
  for (const n of [8, 1, 0, 8]) {
    writer.reset()
    for (const source of entities) source.pos.x++
    encodeFar(writer, entities.slice(0, n))
    assert.equal(decodeFar(reader.bind(writer.bytes().subarray(2)), n, out), n)
    assert.equal(out.length, references.length)
    for (let i = 0; i < out.length; i++) assert.equal(out[i], references[i])
    for (let i = 0; i < n; i++) assert.equal(out[i].x, Math.fround(entities[i].pos.x))
  }
})

test('decode rejects short entries without throwing or changing caller entries', () => {
  const writer = new SnapWriter()
  encodeFar(writer, [entity(0, 0)])
  const reader = new FarReader().bind(writer.bytes().subarray(2, -1))
  const out: FarEntity[] = []
  assert.equal(decodeFar(reader, 1, out), 0)
  assert.deepEqual(out, [])
  assert.equal(reader.remaining, 17)
})
