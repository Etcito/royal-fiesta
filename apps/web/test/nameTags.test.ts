// Shared hub name tags (apps/web/src/play/nameTags.ts): the projection that places a tag over its bean.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectPoint, tagText } from '../src/play/nameTags.ts'

const cam = { eye: [0, 0, -10] as [number, number, number], target: [0, 0, 0] as [number, number, number], fovYDeg: 90, near: 0.1, far: 100 }

test('projectPoint: the target is the centre, +x is right, +y is up, behind the camera is hidden', () => {
  assert.deepEqual(projectPoint(cam, { x: 0, y: 0, z: 0 }, 800, 400), { x: 400, y: 200, depth: 10 })
  // fov 90: at depth 10 the half height is 10 units; aspect 2 doubles the half width.
  const right = projectPoint(cam, { x: 10, y: 0, z: 0 }, 800, 400)!
  assert.ok(Math.abs(right.y - 200) < 1e-9)
  // Looking along +z with +y up, +x is to the camera's left (right-handed): a tag must follow the renderer's look-at.
  assert.ok(Math.abs(Math.abs(right.x - 400) - 200) < 1e-9)
  const up = projectPoint(cam, { x: 0, y: 10, z: 0 }, 800, 400)!
  assert.ok(Math.abs(up.y - 0) < 1e-9, 'one half height up is the top edge')
  assert.equal(projectPoint(cam, { x: 0, y: 0, z: -20 }, 800, 400), null)
  assert.equal(projectPoint({ ...cam, eye: [0, 10, 0], target: [0, 0, 0] }, { x: 0, y: 0, z: 0 }, 800, 400), null, 'straight down: no tags')
  assert.equal(projectPoint(cam, { x: 0, y: 0, z: 0 }, 0, 400), null)
})

test('tagText: a spectator says so', () => {
  const base = { key: 1, name: 'Ann', spectator: false, own: false, pos: { x: 0, y: 0, z: 0 }, scale: 1 }
  assert.equal(tagText(base), 'Ann')
  assert.equal(tagText({ ...base, spectator: true }), 'Ann (watching)')
})
