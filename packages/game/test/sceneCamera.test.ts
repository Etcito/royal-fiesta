import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sceneCamera } from '../src/sceneCamera.ts'
import { loadCourseV1, podiumLayoutOf } from '../src/courseV1.ts'
import type { GameAssetResolver } from '../src/courseV1.ts'
import { startSceneOf } from '../src/startScene.ts'
const read = (id: string) => JSON.parse(readFileSync(new URL(`../../../courses/${id}.course.json`, import.meta.url), 'utf8'))
const assets: GameAssetResolver = { async resolve(id) { return { asset: { id, category: 'decor' }, source: { json: { collision: [] }, path: id } } as any } }
test('season 1 start loads its decor, penguin marker and authored camera without a sim', async () => {
  const c = await loadCourseV1(read('start-season1'), 'start-season1', assets)
  assert.equal(c.kind, 'start'); assert.equal(c.sim, null); assert.ok(c.decor.length > 0)
  assert.deepEqual(startSceneOf(c).spot.t, [0, 0, 0])
  assert.deepEqual(startSceneOf(c).camera.eye, [0, .7, 4.8])
})
test('podium resolves its authored SDF camera and platforms', async () => {
  const json = read('podium'); json.scene.nodes.podium_camera.params.fov = 42
  const c = await loadCourseV1(json, 'podium', assets)
  const layout = podiumLayoutOf(c, id => ({ id } as any))
  assert.equal(layout.camera.fovYDeg, 42); assert.equal(layout.spots.length, 3)
  assert.equal(layout.stage!.length, json.obstacles.length + json.decor.length)
})
test('camera transform and invalid camera refusal', () => {
  const json = read('start-season1').scene
  json.nodes.start_camera.transform.position = [10, 0, 0]
  assert.deepEqual(sceneCamera(json, 'start')!.eye, [10, .7, 4.8])
  json.nodes.start_camera.params.fov = 180
  assert.throws(() => sceneCamera(json, 'start'))
})
