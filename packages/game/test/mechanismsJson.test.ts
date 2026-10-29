import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { degToRad } from '@royal-fiesta/sim/vec'
import { canonicalJson } from '../src/course.ts'
import { parseGameAsset } from '../src/gameAsset.ts'
import { itemOf, parseAssetPhysics } from '../src/mechanismsJson.ts'

const PATH = 'assets/candy/candy.gate.asset.json'
const ZERO = { x: 0, y: 0, z: 0 }
const IDENT = { x: 0, y: 0, z: 0, w: 1 }
const ONE = { x: 1, y: 1, z: 1 }
const COLLISION: ColliderSpec[] = [
  { shape: 'cuboid', half: { x: 2, y: 0.25, z: 0.25 }, t: ZERO, r: IDENT },
  { shape: 'ball', radius: 0.5, t: ZERO, r: IDENT },
]

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plank', type: 'dynamic', colliders: [1], parts: ['plank'], t: [0, 0, 0], r: [0, 0, 0, 1],
    density: 400, friction: 0.6, restitution: 0, linearDamping: 0, angularDamping: 0.05,
    gravityScale: 1, ccd: false, surface: 'normal', ...over,
  }
}

function baseBody(): Record<string, unknown> {
  return body({ id: 'base', type: 'fixed', colliders: [0], parts: ['base'] })
}

function hinge(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pivot', kind: 'hinge', a: 'base', b: 'plank', anchorA: [0, 0.5, 0], anchorB: [0, 0, 0],
    axis: [1, 0, 0], limitsDeg: [-20, 20], stiffness: 0, damping: 0, lengthM: 0, motor: null, ...over,
  }
}

function physicsOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { bodies: [baseBody(), body()], joints: [hinge()], ...over }
}

function refusedAt(json: unknown, pointer: string, collision: readonly ColliderSpec[] = COLLISION): void {
  assert.throws(() => parseAssetPhysics(json, collision, PATH), (e: unknown) => {
    assert.ok(isRefusal(e), 'expected a RefusalError')
    assert.ok(e.message.startsWith(`[asset] ${PATH}#${pointer}: `), `message ${JSON.stringify(e.message)} lacks ${pointer}`)
    assert.ok(e.message.includes('; '), 'message names the fix')
    return true
  })
}

async function assetWith(block: Record<string, unknown> | undefined) {
  const document = { nodes: [{ kind: 'box', size: [4, 0.5, 0.5] }] }
  return parseGameAsset({
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta',
    id: 'candy.gate', name: 'Gate', category: 'obstacle', world: 'candy',
    mesher: { output: 'lowpoly' },
    document,
    collision: [{ shape: 'cuboid', half: [2, 0.25, 0.25] }, { shape: 'ball', radius: 0.5, t: [0, 1, 0], r: [0, 0, 0, 1] }],
    anchors: {},
    bounds: { min: [-2, -0.25, -0.25], max: [2, 1, 0.25] },
    ...(block ? { physics: block } : {}),
    hash: createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex'),
  }, PATH)
}

function near(actual: object, expected: object): void {
  const a = actual as Record<string, number>
  const e = expected as Record<string, number>
  for (const k of Object.keys(e)) assert.ok(Math.abs(a[k] - e[k]) < 1e-9, `${k}: ${a[k]} != ${e[k]}`)
}

const refusals: [string, Record<string, unknown>, string][] = [
  ['a duplicate body id', physicsOf({ bodies: [baseBody(), body({ id: 'base', colliders: [1] })] }), '/physics/bodies/1/id'],
  ['a body id that is not lowercase', physicsOf({ bodies: [baseBody(), body({ id: 'Plank' })] }), '/physics/bodies/1/id'],
  ['a collider index out of range', physicsOf({ bodies: [baseBody(), body({ colliders: [2] })] }), '/physics/bodies/1/colliders/0'],
  ['a collider in two bodies', physicsOf({ bodies: [body({ id: 'base', type: 'fixed', colliders: [0, 1] }), body({ colliders: [1] })] }), '/physics/bodies/1/colliders/0'],
  ['a collider in no body', physicsOf({ bodies: [baseBody()] }), '/physics/bodies'],
  ['a part that is not a string', physicsOf({ bodies: [baseBody(), body({ parts: [3] })] }), '/physics/bodies/1/parts/0'],
  ['a joint to a missing body', physicsOf({ joints: [hinge({ b: 'ghost' })] }), '/physics/joints/0/b'],
  ['a joint from a body to itself', physicsOf({ joints: [hinge({ b: 'base' })] }), '/physics/joints/0/b'],
  ['a hinge axis that is not unit', physicsOf({ joints: [hinge({ axis: [1, 1, 0] })] }), '/physics/joints/0/axis'],
  ['a hinge without an axis', physicsOf({ joints: [hinge({ axis: undefined })] }), '/physics/joints/0/axis'],
  ['misordered hinge limits', physicsOf({ joints: [hinge({ limitsDeg: [20, -20] })] }), '/physics/joints/0/limitsDeg'],
  ['a density that is not positive', physicsOf({ bodies: [baseBody(), body({ density: 0 })] }), '/physics/bodies/1/density'],
  ['a negative motor maxForce', physicsOf({ joints: [hinge({ motor: { mode: 'target', targetDeg: 90, stiffness: 1, damping: 0, maxForce: -1, enabled: true } })] }), '/physics/joints/0/motor/maxForce'],
  ['a linear speed on a hinge motor', physicsOf({ joints: [hinge({ motor: { mode: 'speed', speedMS: 1, stiffness: 0, damping: 0, maxForce: 10, enabled: true } })] }), '/physics/joints/0/motor/speedMS'],
  ['a non-finite anchor', physicsOf({ joints: [hinge({ anchorA: [NaN, 0, 0] })] }), '/physics/joints/0/anchorA/0'],
  ['an unknown joint kind', physicsOf({ joints: [hinge({ kind: 'weld' })] }), '/physics/joints/0/kind'],
  ['more than 16 bodies', physicsOf({ bodies: Array.from({ length: 17 }, (_, i) => body({ id: `b${i}`, colliders: [] })) }), '/physics/bodies'],
]

for (const [name, json, pointer] of refusals) {
  test(`refuses ${name} with its physics pointer`, () => refusedAt(json, pointer))
}

test('parseAssetPhysics is null without physics', () => {
  assert.equal(parseAssetPhysics(undefined, COLLISION, PATH), null)
})

test('parseAssetPhysics keeps bodies and joints as written', () => {
  const p = parseAssetPhysics(physicsOf(), COLLISION, PATH)
  assert.equal(p?.bodies[1].density, 400)
  assert.deepEqual(p?.joints[0].limitsDeg, [-20, 20])
  assert.deepEqual(p?.joints[0].axis, [1, 0, 0])
})

test('the hinge 20 degree limit becomes degToRad(20)', async () => {
  const asset = await assetWith(physicsOf())
  const item = itemOf({ id: 'gate', asset: 'candy.gate', t: ZERO, r: IDENT, s: ONE }, asset, PATH)
  assert.equal(item.joints[0].kind, 'hinge')
  assert.deepEqual(item.joints[0].limits, [degToRad(-20), degToRad(20)])
})

test('a body rest pose is rotated by the item yaw and translated by the item', async () => {
  const asset = await assetWith(physicsOf({ bodies: [baseBody(), body({ t: [1, 0, 0] })] }))
  const yaw90 = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
  const item = itemOf({ id: 'gate', asset: 'candy.gate', t: { x: 10, y: 0, z: 0 }, r: yaw90, s: ONE }, asset, PATH)
  const plank = item.bodies.find(b => b.id === 'plank')
  assert.ok(plank)
  near(plank.rest.t, { x: 10, y: 0, z: -1 })
  near(plank.rest.r, yaw90)
})

test('body density stays in kg/m3', async () => {
  const asset = await assetWith(physicsOf())
  const item = itemOf({ id: 'gate', asset: 'candy.gate', t: ZERO, r: IDENT, s: ONE }, asset, PATH)
  assert.equal(item.bodies.find(b => b.id === 'plank')?.density, 400)
})

test('a spring rests at its anchor distance and a rope takes lengthM, scaled by the item', async () => {
  const spring = { id: 'spring', kind: 'spring', a: 'base', b: 'plank', anchorA: [1, 0, 0], anchorB: [0, 0, 0], stiffness: 100, damping: 1 }
  const rope = { id: 'rope', kind: 'rope', a: 'base', b: 'plank', anchorA: [1, 0, 0], anchorB: [0, 0, 0], lengthM: 2.5 }
  const asset = await assetWith(physicsOf({ bodies: [baseBody(), body({ t: [4, 0, 0] })], joints: [spring, rope] }))
  const at = itemOf({ id: 'gate', asset: 'candy.gate', t: { x: 10, y: 0, z: 0 }, r: IDENT, s: ONE }, asset, PATH)
  assert.equal(at.joints.find(j => j.id === 'spring')?.length, 3)
  assert.equal(at.joints.find(j => j.id === 'rope')?.length, 2.5)
  const doubled = itemOf({ id: 'gate', asset: 'candy.gate', t: ZERO, r: IDENT, s: { x: 2, y: 2, z: 2 } }, asset, PATH)
  assert.equal(doubled.joints.find(j => j.id === 'spring')?.length, 6)
})

test('bodies and joints are sorted by id and joint refs become body indices', async () => {
  const asset = await assetWith(physicsOf({
    bodies: [body({ id: 'plank', colliders: [1] }), baseBody()],
    joints: [hinge({ a: 'plank', b: 'base' })],
  }))
  const item = itemOf({ id: 'gate', asset: 'candy.gate', t: ZERO, r: IDENT, s: ONE }, asset, PATH)
  assert.deepEqual(item.bodies.map(b => b.id), ['base', 'plank'])
  assert.deepEqual(item.joints[0].a, { item: 0, body: 1 })
  assert.deepEqual(item.joints[0].b, { item: 0, body: 0 })
})

test('a hinge speed motor converts degrees per second to radians per second', async () => {
  const asset = await assetWith(physicsOf({
    joints: [hinge({ motor: { mode: 'speed', speedDegS: 90, stiffness: 0, damping: 0, maxForce: 50, enabled: true } })],
  }))
  const item = itemOf({ id: 'gate', asset: 'candy.gate', t: ZERO, r: IDENT, s: ONE }, asset, PATH)
  assert.deepEqual(item.joints[0].motor, { mode: 'speed', speed: degToRad(90), target: 0, stiffness: 0, damping: 0, maxForce: 50, enabled: true })
})

test('an asset without physics is one fixed body of all its colliders', async () => {
  const asset = await assetWith(undefined)
  const item = itemOf({ id: 'gate', asset: 'candy.gate', t: ZERO, r: IDENT, s: ONE }, asset, PATH)
  assert.equal(item.bodies.length, 1)
  assert.equal(item.bodies[0].type, 'fixed')
  assert.equal(item.bodies[0].colliders.length, 2)
  assert.deepEqual(item.joints, [])
})
