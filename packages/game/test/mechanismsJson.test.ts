import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import type { BodyType, JointKind, MechItem } from '@royal-fiesta/sim/mechanismSpec'
import { degToRad, quatAxisAngle, quatMul, v3 } from '@royal-fiesta/sim/vec'
import { canonicalJson } from '../src/course.ts'
import { parseGameAsset } from '../src/gameAsset.ts'
import { MECHANISM_PRESETS, PRESET_COLLIDERS, itemOf, parseAssetPhysics, parseCourseMechanisms, parseCourseSounds, presetFromMotion, presetPhysics } from '../src/mechanismsJson.ts'

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

test('itemOf gives each BodySpec the parts of its asset body', async () => {
  const asset = await assetWith(physicsOf())
  const item = itemOf({ id: 'gate', asset: 'candy.gate', t: ZERO, r: IDENT, s: ONE }, asset, PATH)
  assert.deepEqual(item.bodies.find(b => b.id === 'base')?.parts, ['base'])
  assert.deepEqual(item.bodies.find(b => b.id === 'plank')?.parts, ['plank'])
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

// ---- S13 course mechanisms and sounds ----

const COURSE = 'courses/candy-gate.course.json'

function mechItem(id: string, bodies: [string, BodyType][], joints: [string, JointKind, number, number][] = []): MechItem {
  return {
    id, asset: 'candy.gate', t: ZERO, r: IDENT, s: ONE,
    bodies: bodies.map(([bid, type]) => ({
      id: bid, type, colliders: [], rest: { t: ZERO, r: IDENT }, density: 400, friction: 0.6, restitution: 0,
      linearDamping: 0, angularDamping: 0, gravityScale: 1, ccd: false, surface: 'normal',
    })),
    joints: joints.map(([jid, kind, a, b]) => ({
      id: jid, kind, a: { item: 0, body: a }, b: { item: 0, body: b }, anchorA: ZERO, anchorB: ZERO, axis: { x: 1, y: 0, z: 0 },
      limits: null, stiffness: 0, damping: 0, length: 0, motor: null,
    })),
  }
}

const ITEMS: MechItem[] = [
  mechItem('door-1', [['frame', 'fixed'], ['panel', 'dynamic']], [['hinge', 'hinge', 0, 1]]),
  mechItem('plate-1', [['base', 'fixed'], ['top', 'dynamic']], [['rail', 'slider', 0, 1]]),
  mechItem('lift-1', [['deck', 'kinematic'], ['crate', 'dynamic']]),
]

function validBlock(): Record<string, unknown> {
  return {
    joints: [{ id: 'tether', kind: 'rope', a: { item: null }, b: { item: 'lift-1', body: 'crate' }, anchorA: [0, 5, 0], anchorB: [0, 0, 0], lengthM: 3, motor: null }],
    switches: [
      { id: 'plate-b', plate: { item: 'plate-1', body: 'top' }, mode: 'weight', onKg: 50, offKg: 30 },
      { id: 'plate-a', plate: { item: 'plate-1', body: 'top' }, mode: 'travel', joint: 'rail', onM: 0.1, offM: 0.05 },
    ],
    levers: [{ id: 'lever', handle: { item: 'door-1', body: 'panel' }, joint: 'hinge', onDeg: 30, offDeg: 10, grabRangeM: 1 }],
    logic: [
      { id: 'z-and', op: 'and', inputs: ['plate-a', 'lever'] },
      { id: 'a-not', op: 'not', inputs: ['z-and'] },
      { id: 'm-timer', op: 'timer', inputs: ['plate-b'], seconds: 1.5 },
    ],
    animations: [{ id: 'lift', target: { item: 'lift-1', body: 'deck' }, keys: [{ atS: 0, t: [0, 0, 0], rDeg: [0, 0, 0] }, { atS: 2, t: [0, 3, 0], rDeg: [90, 0, 90] }], easing: 'smooth', loop: 'pingpong', autostart: false }],
    links: [
      { id: 'open', from: 'a-not', to: { kind: 'door', joint: 'door-1/hinge', openDeg: 90, closedDeg: 0 } },
      { id: 'go', from: 'm-timer', to: { kind: 'animation', animation: 'lift', on: 'play', off: 'reverse' } },
    ],
    budget: { dynamicBodies: 24, joints: 32 },
  }
}

function courseRefusedAt(fn: () => unknown, pointer: string, includes = '; '): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(isRefusal(e), 'expected a RefusalError')
    assert.ok(e.message.startsWith(`[course] ${COURSE}#${pointer}: `), `message ${JSON.stringify(e.message)} lacks ${pointer}`)
    assert.ok(e.message.includes(includes), `message ${JSON.stringify(e.message)} lacks ${JSON.stringify(includes)}`)
    return true
  })
}

test('a valid mechanisms block resolves the signal order and every reference to an index', () => {
  const m = parseCourseMechanisms(validBlock(), ITEMS, COURSE)
  assert.deepEqual(m.signals, ['plate-a', 'plate-b', 'lever', 'a-not', 'm-timer', 'z-and'])
  assert.deepEqual(m.switches.map(s => [s.id, s.mode, s.joint]), [['plate-a', 'travel', 1], ['plate-b', 'weight', -1]])
  assert.deepEqual(m.levers[0], { id: 'lever', handle: { item: 0, body: 1 }, joint: 0, onAngle: degToRad(30), offAngle: degToRad(10), grabRange: 1 })
  assert.deepEqual(m.logic.map(l => [l.id, l.inputs, l.ticks]), [['a-not', [5], 0], ['m-timer', [1], 90], ['z-and', [0, 2], 0]])
  assert.deepEqual(m.joints.map(j => [j.id, j.a, j.b, j.length]), [['tether', { item: -1, body: -1 }, { item: 2, body: 1 }, 3]])
  assert.deepEqual(m.links.map(l => [l.id, l.from]), [['go', 4], ['open', 3]])
  assert.deepEqual(m.links[1].to, { kind: 'door', joint: 0, openAngle: degToRad(90), closedAngle: 0 })
  assert.deepEqual(m.links[0].to, { kind: 'animation', animation: 0, on: 'play', off: 'reverse' })
  assert.deepEqual(m.animations[0].target, { item: 2, body: 0 })
  assert.deepEqual(m.animations[0].keys.map(k => k.tick), [0, 120])
  assert.equal(m.items.length, 3)
})

test('animation rDeg applies X, then Y, then Z', () => {
  const m = parseCourseMechanisms(validBlock(), ITEMS, COURSE)
  const qx = quatAxisAngle(v3(1, 0, 0), degToRad(90), { x: 0, y: 0, z: 0, w: 1 })
  const qz = quatAxisAngle(v3(0, 0, 1), degToRad(90), { x: 0, y: 0, z: 0, w: 1 })
  near(m.animations[0].keys[1].r, quatMul(qz, qx, { x: 0, y: 0, z: 0, w: 1 }))
})

test('a null mechanisms block is empty with the items', () => {
  const m = parseCourseMechanisms(null, ITEMS, COURSE)
  assert.equal(m.items.length, 3)
  assert.deepEqual([m.joints, m.switches, m.levers, m.logic, m.links, m.animations, m.signals], [[], [], [], [], [], [], []])
  assert.deepEqual(m.budget, { dynamicBodies: 24, joints: 32 })
})

test('refuses an unknown body', () => {
  const block = validBlock()
  ;(block.joints as Record<string, unknown>[])[0].b = { item: 'lift-1', body: 'ghost' }
  courseRefusedAt(() => parseCourseMechanisms(block, ITEMS, COURSE), '/mechanisms/joints/0/b/body')
})

test('refuses a logic cycle without a toggle or delay', () => {
  const block = { ...validBlock(), logic: [{ id: 'x', op: 'or', inputs: ['y'] }, { id: 'y', op: 'and', inputs: ['x', 'lever'] }], links: [] }
  courseRefusedAt(() => parseCourseMechanisms(block, ITEMS, COURSE), '/mechanisms/logic/1/inputs', 'no toggle or delay')
})

test('accepts a logic cycle broken by a delay', () => {
  const block = { ...validBlock(), logic: [{ id: 'x', op: 'or', inputs: ['y'] }, { id: 'y', op: 'delay', inputs: ['x'], seconds: 0.5 }], links: [] }
  const m = parseCourseMechanisms(block, ITEMS, COURSE)
  assert.deepEqual(m.logic.map(l => [l.id, l.inputs, l.ticks]), [['x', [4], 0], ['y', [3], 30]])
})

test('refuses a dynamic animation target', () => {
  const block = validBlock()
  ;(block.animations as Record<string, unknown>[])[0].target = { item: 'lift-1', body: 'crate' }
  courseRefusedAt(() => parseCourseMechanisms(block, ITEMS, COURSE), '/mechanisms/animations/0/target', 'kinematic')
})

test('refuses a budget overflow', () => {
  const block = { ...validBlock(), budget: { dynamicBodies: 2, joints: 32 } }
  courseRefusedAt(() => parseCourseMechanisms(block, ITEMS, COURSE), '/mechanisms/budget', '3 dynamic bodies')
})

test('refuses a duplicate signal id across groups', () => {
  const block = { ...validBlock(), levers: [{ id: 'plate-a', handle: { item: 'door-1', body: 'panel' }, joint: 'hinge', onDeg: 30, offDeg: 10, grabRangeM: 1 }] }
  courseRefusedAt(() => parseCourseMechanisms(block, ITEMS, COURSE), '/mechanisms/levers/0/id')
})

function sound(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'creak', patch: 'door-creak', item: 'door-1', t: [0, 1, 0], event: 'leverOn', signal: null, ...over }
}

test('sounds resolve items and signals and take the 1.6 defaults', () => {
  const m = parseCourseMechanisms(validBlock(), ITEMS, COURSE)
  const s = parseCourseSounds([sound(), sound({ id: 'hum', item: null, event: null, signal: 'z-and', gain: 0.5, refM: 4, maxM: 20, loop: true })], m, ['door-1', 'wall'], COURSE)
  assert.deepEqual(s[0], { id: 'creak', patch: 'door-creak', item: 0, t: { x: 0, y: 1, z: 0 }, event: 'leverOn', signal: -1, gain: 1, ref: 2, max: 60, loop: false })
  assert.deepEqual([s[1].item, s[1].signal, s[1].gain, s[1].ref, s[1].max, s[1].loop], [-1, 5, 0.5, 4, 20, true])
  assert.deepEqual(parseCourseSounds(undefined, m, [], COURSE), [])
})

test('refuses a sound on an obstacle that is not a mechanism item', () => {
  const m = parseCourseMechanisms(validBlock(), ITEMS, COURSE)
  courseRefusedAt(() => parseCourseSounds([sound({ item: 'wall' })], m, ['door-1', 'wall'], COURSE), '/sounds/0/item', 'use item null and a world t')
})

test('refuses a sound with maxM <= refM', () => {
  const m = parseCourseMechanisms(validBlock(), ITEMS, COURSE)
  courseRefusedAt(() => parseCourseSounds([sound({ refM: 10, maxM: 10 })], m, ['door-1'], COURSE), '/sounds/0/maxM')
})

test('every preset parses as S12 physics with its documented collider count', () => {
  for (const p of MECHANISM_PRESETS) {
    const collision: ColliderSpec[] = Array.from({ length: PRESET_COLLIDERS[p] }, () => COLLISION[0])
    const phys = parseAssetPhysics(JSON.parse(JSON.stringify(presetPhysics(p))), collision, PATH)
    assert.ok(phys, p)
    assert.deepEqual(phys.bodies[0].colliders, [0], p)
    assert.equal(phys.bodies[0].type, 'fixed', p)
  }
  assert.deepEqual(presetPhysics('seesaw').joints[0].limitsDeg, [-20, 20])
  assert.deepEqual(presetPhysics('lever').joints[0].limitsDeg, [-40, 40])
  const door = presetPhysics('door').joints[0].motor
  assert.equal(door?.mode, 'target')
  assert.ok((door?.maxForce ?? 0) > 0)
})

test('presetFromMotion rewrites spinner, movingPlatform and seesaw, and skips conveyor', () => {
  const one: ColliderSpec[] = [COLLISION[0]]
  const spin = presetFromMotion({ id: 'spin-1', motion: { kind: 'spinner', axis: [0, 1, 0], speedDegS: 120, phaseDeg: 0 } })
  assert.ok(spin)
  assert.equal(spin.animation, null)
  assert.equal(spin.physics.joints[0].kind, 'hinge')
  assert.equal(spin.physics.joints[0].motor?.mode, 'speed')
  assert.equal(spin.physics.joints[0].motor?.speedDegS, 120)
  assert.ok(parseAssetPhysics(spin.physics, one, PATH))

  const plat = presetFromMotion({ id: 'plat-1', motion: { kind: 'movingPlatform', offset: [4, 0, 0], periodS: 4, phaseDeg: 0, wave: 'pingpong' } })
  assert.ok(plat?.animation)
  assert.equal(plat.physics.bodies[1].type, 'kinematic')
  assert.deepEqual(plat.animation, {
    id: 'plat-1-anim', target: { item: 'plat-1', body: 'platform' },
    keys: [{ atS: 0, t: [0, 0, 0], rDeg: [0, 0, 0] }, { atS: 2, t: [4, 0, 0], rDeg: [0, 0, 0] }],
    easing: 'linear', loop: 'pingpong', autostart: true,
  })
  assert.ok(parseAssetPhysics(plat.physics, one, PATH))

  const saw = presetFromMotion({ id: 'saw-1', motion: { kind: 'seesaw', axis: [1, 0, 0], maxDeg: 15, spring: 800, damping: 300, inertia: 900 } })
  assert.ok(saw)
  assert.equal(saw.physics.bodies[1].type, 'dynamic')
  assert.deepEqual(saw.physics.joints[0].limitsDeg, [-15, 15])
  assert.ok(parseAssetPhysics(saw.physics, one, PATH))

  assert.equal(presetFromMotion({ id: 'belt', motion: { kind: 'conveyor', velocity: [0, 0, -3] } }), null)
})
