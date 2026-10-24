import assert from 'node:assert/strict'
import test from 'node:test'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import { decodePng } from '../../apps/headless/src/gpuRecord.ts'
import { encodePng, materialBase, materialRoughness, mergeDocuments, projectPoint, stageOnBackdrop, viewCamera } from '../renderViews.ts'

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

test('projectPoint puts the camera target at the image centre', () => {
  const cam = viewCamera({ min: [-1, 0, -1], max: [1, 2, 1] }, 45)
  const [x, y] = projectPoint(cam, cam.target, 1024, 1024) ?? [NaN, NaN]
  assert.ok(Math.abs(x - 512) < 1e-6 && Math.abs(y - 512) < 1e-6)
  assert.equal(projectPoint(cam, [cam.position[0] * 2, cam.position[1], cam.position[2] * 2], 1024, 1024), null)
})

test('stageOnBackdrop replaces the flat clear colour and keeps the subject', () => {
  const w = 8
  const data = new Uint8Array(w * w * 4)
  for (let i = 0; i < w * w; i++) data.set([46, 48, 54, 255], i * 4)
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) data.set([47, 79, 208, 255], (y * w + x) * 4)
  data.set([46 + 0.5 * (47 - 46), 48 + 0.5 * (79 - 48), 54 + 0.5 * (208 - 54), 255], (3 * w + 1) * 4)
  const out = stageOnBackdrop({ width: w, height: w, data }, { cx: 4, cy: 7, rx: 3, ry: 1 })
  assert.ok(out.data[0] > 200, 'background is light')
  assert.deepEqual([...out.data.subarray((4 * w + 4) * 4, (4 * w + 4) * 4 + 4)], [47, 79, 208, 255])
  const edge = out.data.subarray((3 * w + 1) * 4, (3 * w + 1) * 4 + 3)
  assert.ok(edge[0] > 100, 'the half-covered edge blends towards the new background, not the dark clear colour')
  const png = decodePng(encodePng(out), w, w, 'test')
  assert.deepEqual([...png.data], [...out.data])
})

test('stageOnBackdrop leaves an image without a flat clear colour unchanged', () => {
  const data = new Uint8Array(4 * 4 * 4).map((_, i) => i)
  const img = { width: 4, height: 4, data }
  assert.equal(stageOnBackdrop(img, { cx: 2, cy: 3, rx: 1, ry: 1 }), img)
})

test('materialRoughness reads the roughness of every material output by material name', () => {
  const doc = {
    materials: {
      m1: { name: 'candy-pink', graph: { nodes: [{ id: 'out', type: 'material.output', params: { 'in.base_color': '#f0287f', 'in.roughness': 0.12 } }] } },
      m2: { name: 'candy-white', graph: { nodes: [{ id: 'out', type: 'material.output', params: { 'in.base_color': '#ffffff' } }] } },
    },
  }
  assert.deepEqual(materialRoughness(doc), { 'candy-pink': 0.12 })
  assert.deepEqual(materialRoughness({}), {})
})

test('materialBase reads the base colour of every material output by material name as 0..1', () => {
  const doc = {
    materials: {
      m1: { name: 'candy-pink', graph: { nodes: [{ id: 'out', type: 'material.output', params: { 'in.base_color': '#ff0000' } }] } },
      m2: { name: 'candy-white', graph: { nodes: [{ id: 'out', type: 'material.output', params: { 'in.base_color': { link: 'tex' } } }] } },
    },
  }
  assert.deepEqual(materialBase(doc), { 'candy-pink': [1, 0, 0] })
  assert.deepEqual(materialBase({}), {})
})
