import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { CameraPose } from '@royal-fiesta/game/render/port'

const asset: PrimsAsset = {
  format: 'raa.prims', version: 0, id: 'a', name: 'a', nodes: [], materials: {}, anchors: {}, collision: { mode: 'derived', colliders: [] }, budget: { triangles: 1500, segments: 16 }
}
const cam: CameraPose = { eye: [0, 1, 2], target: [0, 0, 0], fovYDeg: 60, near: 0.1, far: 500 }
const target = { canvas: null, width: 1920, height: 1080, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] }

async function ready(): Promise<NullRenderPort> {
  const p = new NullRenderPort()
  await p.init(target)
  return p
}

test('registerAsset is idempotent and counts calls', async () => {
  const p = await ready()
  const a = p.registerAsset('bean', asset)
  assert.equal(p.registerAsset('bean', asset), a)
  assert.notEqual(p.registerAsset('box', asset), a)
  assert.equal(p.calls.registerAsset, 3)
})

test('init refuses bad sizes and empty viewports', async () => {
  const p = new NullRenderPort()
  await assert.rejects(p.init({ ...target, width: 0 }), /\[render\] NullRenderPort\.init/)
  await assert.rejects(p.init({ ...target, height: 1.5 }), /integer/)
  await assert.rejects(p.init({ ...target, viewports: [] }), /viewports/)
})

test('refusals', async () => {
  const p = await ready()
  assert.throws(() => p.createInstance(7, null), /unknown asset handle 7; /)
  const a = p.registerAsset('bean', asset)
  assert.throws(() => p.createInstance(a, [1, NaN, 0]), /tint/)
  assert.throws(() => p.setTransform(3, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), /unknown or destroyed instance/)
  const i = p.createInstance(a, [1, 0, 0])
  assert.throws(() => p.setTransform(i, [0, NaN, 0], [0, 0, 0, 1], [1, 1, 1]), /pass finite numbers/)
  assert.throws(() => p.setVisible(99, true), /NullRenderPort\.setVisible/)
  assert.throws(() => p.destroyInstance(99), /NullRenderPort\.destroyInstance/)
  assert.throws(() => p.setCamera(1, cam), /viewport 1/)
  assert.throws(() => p.setCamera(0, { ...cam, eye: [0, Infinity, 0] }), /non-finite camera/)
  p.setCamera(0, cam)
})

test('render stats follow create, hide and destroy', async () => {
  const p = await ready()
  const a = p.registerAsset('bean', asset)
  const ids = [p.createInstance(a, null), p.createInstance(a, null), p.createInstance(a, null)]
  p.setTransform(ids[0], [1, 2, 3], [0, 0, 0, 1], [1, 1, 1])
  let s = p.render()
  assert.equal(s.instances, 3)
  assert.equal(s.visible, 3)
  p.setVisible(ids[1], false)
  s = p.render()
  assert.deepEqual([s.instances, s.visible, s.drawCalls, s.triangles], [3, 2, 0, 0])
  p.destroyInstance(ids[0])
  assert.throws(() => p.setTransform(ids[0], [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), /destroyed/)
  s = p.render()
  assert.deepEqual([s.instances, s.visible], [2, 1])
  assert.ok(s.frameMs >= 0)
  assert.equal(p.calls.render, 3)
  assert.equal(await p.capture(), null)
  p.dispose()
  assert.equal(p.render().instances, 0)
})
