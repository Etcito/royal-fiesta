import assert from 'node:assert/strict'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { mergeDocuments, viewCamera } from '../renderViews.ts'

test('viewCamera frames the bounds as 1.14 says', () => {
  const b = { min: [-1, 0, -1] as [number, number, number], max: [1, 2, 1] as [number, number, number] }
  const dist = 1.1 * Math.sqrt(12) / (2 * Math.tan(Math.PI / 12))
  const front = viewCamera(b, 0)
  assert.deepEqual(front.target, [0, 1, 0])
  assert.equal(front.fovYDeg, 30)
  assert.ok(Math.abs(front.position[0]) < 1e-12)
  assert.equal(front.position[1], 1.5)
  assert.ok(Math.abs(front.position[2] - dist) < 1e-9)
  const back = viewCamera(b, 180)
  assert.ok(Math.abs(back.position[2] + dist) < 1e-9)
  const tq = viewCamera(b, 45)
  assert.ok(tq.position[0] > 0 && Math.abs(tq.position[0] - tq.position[2]) < 1e-9)
})

test('mergeDocuments adds the costume roots and shifts them by the mount offset', () => {
  const body = { format: 'sdfm', version: 2, name: 'p', root: ['p'], nodes: { p: { id: 'p' } }, materials: { m1: {} } }
  const hat = { root: ['h'], nodes: { h: { id: 'h', transform: { position: [0, 1, 0] } } }, materials: { m2: {} } }
  const doc = mergeDocuments(body, [{ document: hat, offset: [0, 0.5, 0], rel: 'hat' }])
  assert.deepEqual(doc.root, ['p', 'h'])
  assert.deepEqual(Object.keys(doc.materials as object), ['m1', 'm2'])
  assert.deepEqual((doc.nodes as Record<string, { transform: unknown }>).h.transform, { position: [0, 1.5, 0] })
  assert.equal(body.root.length, 1)
})

test('mergeDocuments refuses a node id shared with the penguin', () => {
  const body = { root: ['p'], nodes: { p: {} }, materials: {} }
  const bad = { root: ['p'], nodes: { p: {} }, materials: {} }
  assert.throws(() => mergeDocuments(body, [{ document: bad, offset: [0, 0, 0], rel: 'bad' }]), (e) => isRefusal(e) && /nodes\/p/.test(e.message))
})
