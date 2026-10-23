import assert from 'node:assert/strict'
import test from 'node:test'
import type { GameAsset } from '../../packages/game/src/gameAsset.ts'
import type { ColliderSpec } from '../../packages/sim/src/course.ts'
import { isRefusal } from '../../packages/sim/src/refusal.ts'
import {
  colliderAabb, loadAssetFile, materialColours, mountedBounds, proceduralProblems, rigidGroups,
  visualFitsCollision, type AuthoredAsset,
} from '../contentProbe.ts'

const V = (x: number, y: number, z: number) => ({ x, y, z })
const ID = { x: 0, y: 0, z: 0, w: 1 }

function fake(over: Partial<GameAsset>, json: Record<string, unknown> = {}): AuthoredAsset {
  const asset = {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta', id: 'test.thing', name: 't',
    category: 'prop', world: 'common', mesher: { output: 'quad' }, document: {}, collision: [],
    anchors: {}, bounds: { min: V(-1, -1, -1), max: V(1, 1, 1) }, hash: '', ...over,
  } as GameAsset
  return { rel: 'assets/common/test.thing.asset.json', asset, json }
}

const node = (id: string, kind: string, pos: number[], extra: Record<string, unknown> = {}) =>
  ({ id, name: id, kind, transform: { position: pos }, pivot: [0, 0, 0], children: [], ...extra })

test('loadAssetFile parses the committed penguin body', async () => {
  const a = await loadAssetFile('assets/common/penguin.body.asset.json')
  assert.equal(a.asset.id, 'penguin.body')
  assert.equal(a.asset.collision[0].shape, 'capsule')
  assert.equal(a.json.id, 'penguin.body')
  await assert.rejects(loadAssetFile('assets/common/nope.asset.json'), (e) => isRefusal(e) && e.area === 'content')
})

test('rigidGroups composes the pivot with ancestor positions', () => {
  const a = fake({ document: { root: ['root'], nodes: {
    root: node('root', 'group', [0, 1, 0], { children: ['arm'] }),
    arm: node('arm', 'group', [0.5, 0, 0], { rigid: true, mesher: { output: 'quad' }, pivot: [0, 0.1, 0.2], children: ['s'] }),
    s: node('s', 'sphere', [9, 9, 9]),
  } } })
  assert.deepEqual(rigidGroups(a), [{ name: 'arm', pivot: [0.5, 1.1, 0.2], mesher: { output: 'quad' } }])
})

test('materialColours lower-cases and refuses a graph without output', () => {
  const ok = fake({ document: { materials: { p: { name: 'penguin-plush', graph: { nodes: [{ id: 'o', type: 'material.output', params: { 'in.base_color': '#2F4FD0' } }] } } } } })
  assert.deepEqual(materialColours(ok), [{ name: 'penguin-plush', hex: '#2f4fd0' }])
  const bad = fake({ document: { materials: { p: { name: 'x', graph: { nodes: [] } } } } })
  assert.throws(() => materialColours(bad), (e) => isRefusal(e) && e.area === 'content')
})

test('colliderAabb of a rotated cuboid, and null for none', () => {
  const s = Math.SQRT1_2
  const c: ColliderSpec = { shape: 'cuboid', half: V(2, 1, 0.5), t: V(1, 0, 0), r: { x: 0, y: s, z: 0, w: s } }
  const box = colliderAabb(fake({ collision: [c] }))
  assert.ok(box)
  const want = { min: [0.5, -1, -2], max: [1.5, 1, 2] }
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(box.min[i] - want.min[i]) < 1e-9)
    assert.ok(Math.abs(box.max[i] - want.max[i]) < 1e-9)
  }
  assert.equal(colliderAabb(fake({})), null)
})

test('visualFitsCollision passes and fails', () => {
  const c: ColliderSpec = { shape: 'cuboid', half: V(1, 1, 1), t: V(0, 0, 0), r: ID }
  assert.equal(visualFitsCollision(fake({ collision: [c] })), null)
  const big = fake({ collision: [c], bounds: { min: V(-1, -1, -1), max: V(1, 3, 1) } })
  assert.match(visualFitsCollision(big) ?? '', / y: /)
  const small = fake({ collision: [c], bounds: { min: V(-0.5, -1, -1), max: V(1, 1, 1) } })
  assert.match(visualFitsCollision(small) ?? '', / x: /)
})

test('mountedBounds translates onto the body anchor and refuses 0 or 2 anchors', () => {
  const body = fake({ anchors: { head: { t: V(0, 0.8, 0), r: ID } } })
  const hat = fake({ anchors: { head: { t: V(0, -0.1, 0), r: ID } }, bounds: { min: V(-0.3, 0, -0.3), max: V(0.3, 0.4, 0.3) } })
  assert.deepEqual(mountedBounds(hat, body), { min: [-0.3, 0.9, -0.3], max: [0.3, 1.3, 0.3] })
  assert.throws(() => mountedBounds(fake({}), body), isRefusal)
  const two = fake({ anchors: { head: { t: V(0, 0, 0), r: ID }, neck: { t: V(0, 0, 0), r: ID } } })
  assert.throws(() => mountedBounds(two, body), isRefusal)
})

test('proceduralProblems flags images, data URLs and oversize files', () => {
  const a = fake({}, { document: { nodes: { n: { tex: 'tex.PNG' } }, list: ['data:abc'] } })
  const p = proceduralProblems(a, 600000)
  assert.equal(p.length, 3)
  assert.ok(p[0].includes('#/document/nodes/n/tex'))
  assert.ok(p[1].includes('#/document/list/0'))
  assert.ok(p[2].includes('600000'))
  assert.deepEqual(proceduralProblems(fake({}, { a: 'ok' }), 10), [])
})
