import assert from 'node:assert/strict'
import test from 'node:test'
import { RenderBridge } from '@etcito/game-engine/render'
import { CAPSULE } from '@royal-fiesta/sim/character/capsule'
import { EngineFarView } from '../src/ege/showFar.ts'

function snapshot(records: readonly { zone: number; pose: readonly number[] }[]): Uint8Array {
  const bytes = new Uint8Array(2 + records.length * 60)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, records.length, true)
  records.forEach(({ zone, pose }, index) => {
    const offset = 2 + index * 60
    view.setUint32(offset, zone, true)
    pose.forEach((value, n) => view.setFloat64(offset + 4 + n * 8, value, true))
  })
  return bytes
}

const poseA = [1.25, 2.5, -3.75, 0, 0.5, 0, Math.sqrt(0.75)]
const poseB = [-4, 0.125, 8, 0.25, 0, 0.5, 0.75]

function record(viewBytes: Uint8Array, index: number) {
  const view = new DataView(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength)
  const offset = 8 + index * 60
  return {
    entity: view.getUint32(offset, true),
    visible: view.getUint32(offset + 4, true),
    shape: view.getUint32(offset + 8, true),
    color: view.getUint32(offset + 12, true),
    pos: [16, 20, 24].map(n => view.getFloat32(offset + n, true)),
    rot: [28, 32, 36, 40].map(n => view.getFloat32(offset + n, true)),
    params: [44, 48].map(n => view.getFloat32(offset + n, true)),
  }
}

test('decodes stable room-seat records and excludes the exact near membership', () => {
  const far = new EngineFarView()
  far.accept(7, 12, snapshot([
    { zone: 1, pose: poseA },
    { zone: 5, pose: poseB },
    { zone: 999, pose: poseA },
  ]))
  const result = far.read(new Set([0]))
  assert.equal(result.count, 1)
  assert.equal(result.stride, 60)
  assert.equal(new DataView(result.bytes.buffer).getUint32(0, true), 1)
  const decoded = record(result.bytes, 0)
  assert.deepEqual(decoded, {
    entity: 4,
    visible: 1,
    shape: 3,
    color: 0xb380ff,
    pos: poseB.slice(0, 3),
    rot: poseB.slice(3),
    params: decoded.params,
  })
  assert.ok(Math.abs(decoded.params[0] - CAPSULE.radius) < 1e-6)
  assert.ok(Math.abs(decoded.params[1] - CAPSULE.halfHeight) < 1e-6)
  assert.equal(far.read(new Set([0, 4])).count, 0)
})

test('empty snapshots replace seats and clear returns an empty valid buffer', () => {
  const far = new EngineFarView()
  far.accept(1, 1, snapshot([{ zone: 60, pose: poseA }]))
  far.accept(1, 2, snapshot([]))
  assert.equal(far.read(new Set()).count, 0)
  far.accept(1, 3, snapshot([{ zone: 60, pose: poseA }]))
  assert.equal(record(far.read(new Set()).bytes, 0).entity, 59)
  far.clear()
  const empty = far.read(new Set())
  assert.deepEqual({ count: empty.count, stride: empty.stride, length: empty.bytes.length }, { count: 0, stride: 60, length: 8 })
})

test('rejects malformed and nonfinite input atomically', () => {
  const far = new EngineFarView()
  far.accept(1, 1, snapshot([{ zone: 2, pose: poseA }]))
  assert.throws(() => far.accept(1, 2, new Uint8Array([1])), /missing its count/)
  assert.throws(() => far.accept(1, 2, snapshot([{ zone: 2, pose: [NaN, ...poseA.slice(1)] }])), /nonfinite/)
  assert.throws(() => far.accept(1, 2, snapshot([{ zone: 3, pose: poseA }, { zone: 3, pose: poseA }])), /unique and ascending/)
  assert.equal(record(far.read(new Set()).bytes, 0).entity, 1)
  assert.throws(() => far.accept(1, 2, snapshot([{ zone: 2, pose: poseA }]).slice(0, 61)), /malformed length/)
})

test('ignores older snapshots, accepts identical duplicates and refuses conflicts', () => {
  const far = new EngineFarView()
  const first = snapshot([{ zone: 3, pose: poseA }])
  far.accept(4, 9, first)
  far.accept(4, 9, first.slice())
  far.accept(4, 8, snapshot([{ zone: 3, pose: poseB }]))
  assert.deepEqual(record(far.read(new Set()).bytes, 0).pos, poseA.slice(0, 3))
  assert.throws(() => far.accept(4, 9, snapshot([{ zone: 3, pose: poseB }])), /conflicting snapshot/)
  assert.throws(() => far.accept(5, 9, first), /conflicting owners/)
  far.accept(5, 10, snapshot([{ zone: 3, pose: poseB }]))
  assert.deepEqual(record(far.read(new Set()).bytes, 0).pos, poseB.slice(0, 3))
})

test('feeds the decoded buffer through RenderBridge and removes departed seats', () => {
  const calls: { name: string; values: unknown[] }[] = []
  const raa = {
    primitiveMesh: (...args: unknown[]) => (calls.push({ name: 'primitiveMesh', values: args }), 10),
    addMaterial: (...args: unknown[]) => (calls.push({ name: 'addMaterial', values: args }), 11),
    addNode: (...args: unknown[]) => (calls.push({ name: 'addNode', values: args }), 12),
    addInstance: (...args: unknown[]) => (calls.push({ name: 'addInstance', values: args }), 13),
    setTransforms: (...args: unknown[]) => calls.push({ name: 'setTransforms', values: args }),
    setVisible: (...args: unknown[]) => calls.push({ name: 'setVisible', values: args }),
    removeNode: (...args: unknown[]) => calls.push({ name: 'removeNode', values: args }),
  }
  const far = new EngineFarView()
  const bridge = new RenderBridge(raa)
  far.accept(8, 1, snapshot([{ zone: 2, pose: poseA }, { zone: 7, pose: poseB }]))
  const shown = far.read(new Set([1]))
  bridge.sync(shown)
  assert.equal(bridge.instances, 1)
  assert.equal(calls.filter(call => call.name === 'addInstance').length, 1)
  assert.deepEqual(calls.find(call => call.name === 'setTransforms')?.values[0], new Uint32Array([12]))
  far.accept(8, 2, snapshot([]))
  bridge.sync(far.read(new Set()))
  assert.equal(bridge.instances, 0)
  assert.equal(calls.filter(call => call.name === 'removeNode').length, 1)
  bridge.dispose()
})
