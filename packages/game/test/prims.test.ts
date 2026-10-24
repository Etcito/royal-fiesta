import assert from 'node:assert/strict'
import test from 'node:test'
import { fnv1a32 } from '@gamesaloon/rollback'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { PRIM_CAPS, assetHash, collidersOf, parseColliderJson, parsePrims, parsePublishedCollider, scaleColliders } from '../src/prims.ts'
import type { ColliderSpec } from '@royal-fiesta/sim/course'

const FILE = 'fixtures/assets/t.prims.json'
const MATERIALS = { m: { color: [1, 1, 1], roughness: 0.5, metallic: 0, emissive: [0, 0, 0] } }
const IDENTITY = { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }

function minimal(): Record<string, unknown> {
  return {
    format: 'raa.prims', version: 0, id: 't', name: 'Test',
    nodes: [{ id: 'n0', kind: 'box', params: { size: [1, 2, 3] }, material: 'm' }],
    materials: MATERIALS,
    collision: { mode: 'derived', colliders: [] },
  }
}

function refused(fn: () => unknown, pointer: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(isRefusal(e), 'expected a RefusalError')
    assert.ok(e.message.includes(pointer), `message ${JSON.stringify(e.message)} lacks ${pointer}`)
    assert.ok(e.message.includes('; '), 'message names the fix')
    return true
  })
}

function withPatch(patch: (a: any) => void): Record<string, unknown> {
  const a: any = minimal()
  patch(a)
  return a
}

test('minimal asset gets its defaults and the input is not mutated', () => {
  const input = minimal()
  const before = JSON.stringify(input)
  const a = parsePrims(input, FILE)
  assert.equal(JSON.stringify(input), before)
  assert.deepEqual(a, {
    format: 'raa.prims', version: 0, id: 't', name: 'Test',
    budget: { triangles: 1500, segments: 16 },
    nodes: [{ id: 'n0', kind: 'box', params: { size: [1, 2, 3] }, transform: IDENTITY, material: 'm', op: 'union' }],
    materials: { m: { color: [1, 1, 1], roughness: 0.5, metallic: 0, emissive: [0, 0, 0] } },
    anchors: {},
    collision: { mode: 'derived', colliders: [] },
  })
  assert.notEqual(a.nodes[0].params.size, (input.nodes as any)[0].params.size)
  assert.deepEqual(a.budget, PRIM_CAPS.defaultBudget)
})

test('the parsed asset is the published file: JSON round-trips to the same value', () => {
  const a = parsePrims(withPatch((a) => {
    a.nodes[0].children = [{ id: 'c', kind: 'sphere', params: { radius: 1 }, material: 'm' }]
    a.collision = { mode: 'override', colliders: [{ node: 'n0', shape: 'ball', params: { radius: 1 }, t: [0, 0, 0], r: [0, 0, 0, 1] }] }
  }), FILE)
  const text = JSON.stringify(a)
  assert.deepEqual(JSON.parse(text), a)
  assert.equal(text.includes('"children":[]'), false)
})

test('full asset keeps materials, anchors, collision and budget', () => {
  const a = parsePrims(withPatch((a) => {
    a.materials = { red: { color: [1, 0, 0], roughness: 0.5, metallic: 0, emissive: [0.1, 0, 0] } }
    a.nodes[0].material = 'red'
    a.nodes[0].transform = { t: [1, 2, 3] }
    a.anchors = { top: { t: [0, 1, 0] } }
    a.collision = { mode: 'override', colliders: [{ node: null, shape: 'ball', params: { radius: 1 }, t: [0, 0, 0], r: [0, 0, 0, 1] }] }
    a.budget = { triangles: 300, segments: 8 }
  }), FILE)
  assert.equal(a.nodes[0].material, 'red')
  assert.deepEqual(a.nodes[0].transform, { t: [1, 2, 3], r: [0, 0, 0, 1], s: [1, 1, 1] })
  assert.deepEqual(a.anchors.top, { t: [0, 1, 0], r: [0, 0, 0, 1] })
  assert.deepEqual(a.collision, { mode: 'override', colliders: [{ node: null, shape: 'ball', params: { radius: 1 }, t: [0, 0, 0], r: [0, 0, 0, 1] }] })
  assert.deepEqual(a.budget, { triangles: 300, segments: 8 })
  assert.deepEqual(a.materials.red.emissive, [0.1, 0, 0])
})

const RULES: [string, unknown, string][] = [
  ['non-object input', [], '#/'],
  ['bad format', withPatch((a) => { a.format = 'raa.mesh' }), '#/format'],
  ['bad version', withPatch((a) => { a.version = 1 }), '#/version'],
  ['non-string id', withPatch((a) => { a.id = 3 }), '#/id'],
  ['id with capitals', withPatch((a) => { a.id = 'Bean' }), '#/id'],
  ['non-string name', withPatch((a) => { delete a.name }), '#/name'],
  ['unknown top-level field', withPatch((a) => { a.extra = 1 }), '#/extra'],
  ['nodes missing', withPatch((a) => { delete a.nodes }), '#/nodes'],
  ['no nodes', withPatch((a) => { a.nodes = [] }), '#/nodes'],
  ['unknown kind', withPatch((a) => { a.nodes[0].kind = 'teapot' }), '#/nodes/0/kind'],
  ['hyphen in node id', withPatch((a) => { a.nodes[0].id = 'eye-l' }), '#/nodes/0/id'],
  ['non-finite param', withPatch((a) => { a.nodes[0].params.radius = 'big' }), '#/nodes/0/params/radius'],
  ['non-finite param element', withPatch((a) => { a.nodes[0].params.size = [1, null, 3] }), '#/nodes/0/params/size/1'],
  ['missing material', withPatch((a) => { delete a.nodes[0].material }), '#/nodes/0/material'],
  ['unknown material', withPatch((a) => { a.nodes[0].material = 'gold' }), '#/nodes/0/material'],
  ['bad op', withPatch((a) => { a.nodes[0].op = 'xor' }), '#/nodes/0/op'],
  ['non-finite transform', withPatch((a) => { a.nodes[0].transform = { s: [1, 1, 'x'] } }), '#/nodes/0/transform/s/2'],
  ['bad material color', withPatch((a) => { a.materials = { m: { color: [1, 0], roughness: 0, metallic: 0, emissive: [0, 0, 0] } } }), '#/materials/m/color'],
  ['bad material roughness', withPatch((a) => { a.materials = { m: { color: [1, 0, 0], metallic: 0, emissive: [0, 0, 0] } } }), '#/materials/m/roughness'],
  ['scalar emissive', withPatch((a) => { a.materials = { m: { color: [1, 0, 0], roughness: 0, metallic: 0, emissive: 0 } } }), '#/materials/m/emissive'],
  ['bad anchor', withPatch((a) => { a.anchors = { top: { r: [0, 0, 1] } } }), '#/anchors/top/r'],
  ['anchor with scale', withPatch((a) => { a.anchors = { top: { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] } } }), '#/anchors/top/s'],
  ['bad collision', withPatch((a) => { a.collision = [] }), '#/collision'],
  ['collision without mode', withPatch((a) => { a.collision = { colliders: [] } }), '#/collision/mode'],
  ['bad collider node', withPatch((a) => { a.collision = { mode: 'override', colliders: [{ node: 'nope', shape: 'ball', params: { radius: 1 }, t: [0, 0, 0], r: [0, 0, 0, 1] }] } }), '#/collision/colliders/0/node'],
  ['numeric budget', withPatch((a) => { a.budget = 1.5 }), '#/budget'],
  ['budget with bad segments', withPatch((a) => { a.budget = { triangles: 1500, segments: 6 } }), '#/budget/segments'],
]

for (const [name, input, pointer] of RULES) {
  test(`refuses ${name}`, () => {
    refused(() => parsePrims(input, FILE), `${FILE}${pointer}`)
  })
}

test('65 nodes in total are refused, 64 pass', () => {
  const leaf = (i: number) => ({ id: `c${i}`, kind: 'sphere', params: { radius: 1 }, material: 'm' })
  const make = (total: number) => withPatch((a) => {
    a.nodes = [{ id: 'root', kind: 'box', params: { size: [1, 1, 1] }, material: 'm', children: [] }]
    for (let i = 1; i < total; i++) a.nodes[0].children.push(leaf(i))
  })
  parsePrims(make(64), FILE)
  refused(() => parsePrims(make(65), FILE), `${FILE}#/nodes/0/children/63`)
})

test('depth 9 is refused, depth 8 passes', () => {
  const make = (depth: number) => withPatch((a) => {
    const node: any = { id: 'd1', kind: 'sphere', params: { radius: 1 }, material: 'm' }
    a.nodes = [node]
    let cur = node
    for (let d = 2; d <= depth; d++) {
      const child = { id: `d${d}`, kind: 'sphere', params: { radius: 1 }, material: 'm' }
      cur.children = [child]
      cur = child
    }
  })
  parsePrims(make(8), FILE)
  refused(() => parsePrims(make(9), FILE), `${FILE}#/nodes/0${'/children/0'.repeat(8)}`)
})

test('parsePublishedCollider maps the published shapes to sim colliders', () => {
  const id = { x: 0, y: 0, z: 0, w: 1 }
  const zero = { x: 0, y: 0, z: 0 }
  const p = `${FILE}#/collision/colliders/0`
  assert.deepEqual(parsePublishedCollider({ node: null, shape: 'cuboid', params: { halfExtents: [1, 2, 3] }, t: [0, 0, 0], r: [0, 0, 0, 1] }, p),
    { shape: 'cuboid', half: { x: 1, y: 2, z: 3 }, t: zero, r: id })
  assert.deepEqual(parsePublishedCollider({ node: null, shape: 'roundCuboid', params: { halfExtents: [1, 2, 3], borderRadius: 0.1 }, t: [1, 0, 0], r: [0, 0, 0, 1] }, p),
    { shape: 'roundCuboid', half: { x: 1, y: 2, z: 3 }, border: 0.1, t: { x: 1, y: 0, z: 0 }, r: id })
  assert.deepEqual(parsePublishedCollider({ node: null, shape: 'ball', params: { radius: 0.5 }, t: [0, 0, 0], r: [0, 1, 0, 0] }, p),
    { shape: 'ball', radius: 0.5, t: zero, r: { x: 0, y: 1, z: 0, w: 0 } })
  for (const shape of ['capsule', 'cylinder', 'cone'] as const) {
    assert.deepEqual(parsePublishedCollider({ node: null, shape, params: { halfHeight: 2, radius: 0.5 }, t: [0, 0, 0], r: [0, 0, 0, 1] }, p),
      { shape, halfHeight: 2, radius: 0.5, t: zero, r: id })
  }
})

test('parsePublishedCollider refusals', () => {
  const p = `${FILE}#/collision/colliders/2`
  const ok = { node: null, t: [0, 0, 0], r: [0, 0, 0, 1] }
  assert.throws(() => parsePublishedCollider({ ...ok, shape: 'trimesh', params: {} }, p), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.equal(e.path, `${p}/shape`)
    assert.ok(e.message.includes('primitive colliders only'))
    return true
  })
  refused(() => parsePublishedCollider({ ...ok, shape: 'blob', params: {} }, p), `${p}/shape`)
  refused(() => parsePublishedCollider({ ...ok, shape: 'ball', params: { radius: 0 } }, p), `${p}/params/radius`)
  refused(() => parsePublishedCollider({ ...ok, shape: 'cuboid', params: { halfExtents: [1, -1, 1] } }, p), `${p}/params/halfExtents/1`)
  refused(() => parsePublishedCollider({ ...ok, shape: 'cuboid', params: { half: [1, 1, 1] } }, p), `${p}/params/half`)
  refused(() => parsePublishedCollider({ ...ok, shape: 'cone', params: { halfHeight: 1, radius: Infinity } }, p), `${p}/params/radius`)
  refused(() => parsePublishedCollider({ ...ok, shape: 'ball', params: { radius: 1 }, r: [0, 0, 0, 0.9] }, p), `${p}/r`)
  refused(() => parsePublishedCollider({ ...ok, shape: 'ball', params: { radius: 1 }, radious: 2 }, p), `${p}/radious`)
})

test('parseColliderJson (course colliders) round-trips all 6 shapes', () => {
  const id = { x: 0, y: 0, z: 0, w: 1 }
  const zero = { x: 0, y: 0, z: 0 }
  const p = `${FILE}#/collision/colliders/0`
  assert.deepEqual(parseColliderJson({ shape: 'cuboid', half: [1, 2, 3] }, p), { shape: 'cuboid', half: { x: 1, y: 2, z: 3 }, t: zero, r: id })
  assert.deepEqual(parseColliderJson({ shape: 'roundCuboid', half: [1, 2, 3], border: 0.1, t: [1, 0, 0] }, p),
    { shape: 'roundCuboid', half: { x: 1, y: 2, z: 3 }, border: 0.1, t: { x: 1, y: 0, z: 0 }, r: id })
  assert.deepEqual(parseColliderJson({ shape: 'ball', radius: 0.5, r: [0, 1, 0, 0] }, p), { shape: 'ball', radius: 0.5, t: zero, r: { x: 0, y: 1, z: 0, w: 0 } })
  for (const shape of ['capsule', 'cylinder', 'cone'] as const) {
    assert.deepEqual(parseColliderJson({ shape, halfHeight: 2, radius: 0.5 }, p), { shape, halfHeight: 2, radius: 0.5, t: zero, r: id })
  }
})

test('parseColliderJson (course colliders) refusals', () => {
  const p = `${FILE}#/collision/colliders/2`
  assert.throws(() => parseColliderJson({ shape: 'trimesh', vertices: [] }, p), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.equal(e.path, `${p}/shape`)
    assert.ok(e.message.includes('primitive colliders only'))
    return true
  })
  refused(() => parseColliderJson({ shape: 'blob' }, p), `${p}/shape`)
  refused(() => parseColliderJson({ shape: 'ball', radius: 0 }, p), `${p}/radius`)
  refused(() => parseColliderJson({ shape: 'cuboid', half: [1, -1, 1] }, p), `${p}/half/1`)
  refused(() => parseColliderJson({ shape: 'cone', halfHeight: 1, radius: Infinity }, p), `${p}/radius`)
  refused(() => parseColliderJson({ shape: 'ball', radius: 1, r: [0, 0, 0, 0.9] }, p), `${p}/r`)
  refused(() => parseColliderJson({ shape: 'ball', radius: 1, radious: 2 }, p), `${p}/radious`)
})

test('parseColliderJson reads the SDF Modeler spelling halfExtents/borderRadius as half/border', () => {
  const p = `${FILE}#/collision/0`
  assert.deepEqual(parseColliderJson({ shape: 'cuboid', t: [0, 1, 0], r: [0, 0, 0, 1], halfExtents: [1, 2, 3] }, p),
    parseColliderJson({ shape: 'cuboid', half: [1, 2, 3], t: [0, 1, 0], r: [0, 0, 0, 1] }, p))
  assert.deepEqual(parseColliderJson({ shape: 'roundCuboid', halfExtents: [1, 2, 3], borderRadius: 0.1 }, p),
    parseColliderJson({ shape: 'roundCuboid', half: [1, 2, 3], border: 0.1 }, p))
})

test('parseColliderJson refuses mixed spellings and names the spelling used', () => {
  const p = `${FILE}#/collision/0`
  assert.throws(() => parseColliderJson({ shape: 'cuboid', half: [1, 1, 1], halfExtents: [1, 1, 1] }, p), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.equal(e.path, `${p}/halfExtents`)
    assert.ok(e.message.includes('use one spelling: half/border or halfExtents/borderRadius'))
    return true
  })
  refused(() => parseColliderJson({ shape: 'roundCuboid', halfExtents: [1, 1, 1], borderRadius: 0.1, border: 0.1 }, p), `${p}/border`)
  refused(() => parseColliderJson({ shape: 'cuboid', halfExtents: [1, -1, 1] }, p), `${p}/halfExtents/1`)
  refused(() => parseColliderJson({ shape: 'roundCuboid', halfExtents: [1, 1, 1], borderRadius: 0 }, p), `${p}/borderRadius`)
})

test('assetHash is fnv1a32 of the UTF-8 bytes', () => {
  assert.equal(assetHash('abc'), fnv1a32(new Uint8Array([0x61, 0x62, 0x63])) >>> 0)
  assert.equal(assetHash('é'), fnv1a32(new Uint8Array([0xc3, 0xa9])) >>> 0)
})

function asset(nodes: unknown[], collision: unknown = { mode: 'derived', colliders: [] }): ReturnType<typeof parsePrims> {
  return parsePrims({ format: 'raa.prims', version: 0, id: 't', name: 'Test', nodes, materials: MATERIALS, collision }, FILE)
}

const I = { x: 0, y: 0, z: 0, w: 1 }

test('collidersOf composes a nested box under a translated, rotated, scaled parent', () => {
  const a = asset([{
    id: 'p', kind: 'sphere', params: { radius: 0.5 }, material: 'm',
    transform: { t: [1, 2, 3], r: [0, 1, 0, 0], s: [2, 2, 2] },
    children: [{ id: 'c', kind: 'box', params: { size: [2, 4, 6] }, material: 'm', transform: { t: [1, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] } }],
  }])
  assert.deepEqual(collidersOf(a, FILE), [
    { shape: 'ball', radius: 1, t: { x: 1, y: 2, z: 3 }, r: { x: 0, y: 1, z: 0, w: 0 } },
    { shape: 'cuboid', half: { x: 2, y: 4, z: 6 }, t: { x: -1, y: 2, z: 3 }, r: { x: 0, y: 1, z: 0, w: 0 } },
  ])
})

test('collidersOf maps roundBox, capsule and an apex-up cone', () => {
  const a = asset([
    { id: 'rb', kind: 'roundBox', params: { size: [2, 4, 6], radius: 0.25 }, material: 'm' },
    { id: 'cap', kind: 'capsule', params: { radius: 0.5, height: 4 }, material: 'm', transform: { t: [0, 0, 0], r: [0, 0, 0, 1], s: [3, 3, 3] } },
    { id: 'cone', kind: 'cone', params: { height: 2, radiusBottom: 1, radiusTop: 0 }, material: 'm' },
  ])
  assert.deepEqual(collidersOf(a, FILE), [
    { shape: 'roundCuboid', half: { x: 0.75, y: 1.75, z: 2.75 }, border: 0.25, t: { x: 0, y: 0, z: 0 }, r: I },
    { shape: 'capsule', halfHeight: 6, radius: 1.5, t: { x: 0, y: 0, z: 0 }, r: I },
    { shape: 'cone', halfHeight: 1, radius: 1, t: { x: 0, y: 0, z: 0 }, r: I },
  ])
})

test('collidersOf ignores subtract subtrees', () => {
  const a = asset([
    { id: 'b', kind: 'box', params: { size: [2, 2, 2] }, material: 'm' },
    { id: 's', kind: 'sphere', params: { radius: 1 }, material: 'm', op: 'subtract',
      children: [{ id: 'sc', kind: 'box', params: { size: [1, 1, 1] }, material: 'm' }] },
  ])
  const cs = collidersOf(a, FILE)
  assert.equal(cs.length, 1)
  assert.equal(cs[0].shape, 'cuboid')
})

test('collidersOf refusals', () => {
  const torus = asset([{ id: 'b', kind: 'box', params: { size: [1, 1, 1] }, material: 'm',
    children: [{ id: 't', kind: 'torus', params: { majorRadius: 1, minorRadius: 0.2 }, material: 'm' }] }])
  assert.throws(() => collidersOf(torus, FILE), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.ok(e.message.includes(`${FILE}#/nodes/0/children/0`))
    assert.ok(e.message.includes('no Rapier primitive for torus: add collision.colliders'))
    return true
  })
  refused(() => collidersOf(asset([{ id: 's', kind: 'sphere', params: { radius: 1 }, material: 'm', transform: { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 2, 1] } }]), FILE),
    '#/nodes/0/transform/s')
  refused(() => collidersOf(asset([{ id: 'b', kind: 'box', params: { size: [1, 1] }, material: 'm' }]), FILE), '#/nodes/0/params/size')
  refused(() => collidersOf(asset([{ id: 'c', kind: 'cone', params: { height: 1, radiusBottom: 1, radiusTop: 0.5 }, material: 'm' }]), FILE),
    '#/nodes/0/params/radiusTop')
  refused(() => collidersOf(asset([{ id: 'r', kind: 'roundBox', params: { size: [1, 1, 1], radius: 0.5 }, material: 'm' }]), FILE),
    '#/nodes/0/params/radius')
  refused(() => collidersOf(asset([{ id: 'b', kind: 'box', params: { size: [1, 1, 1] }, material: 'm', op: 'subtract' }]), FILE),
    '#/collision')
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, kind: 'box', params: { size: [1, 1, 1] }, material: 'm' }))
  refused(() => collidersOf(asset(nine), FILE), '#/collision')
})

test('override collision wins over nodes', () => {
  const a = asset([{ id: 't', kind: 'torus', params: { majorRadius: 1, minorRadius: 0.2 }, material: 'm' }],
    { mode: 'override', colliders: [{ node: null, shape: 'ball', params: { radius: 2 }, t: [0, 1, 0], r: [0, 0, 0, 1] }] })
  assert.deepEqual(collidersOf(a, FILE), [{ shape: 'ball', radius: 2, t: { x: 0, y: 1, z: 0 }, r: I }])
  assert.throws(() => asset([{ id: 't', kind: 'box', params: { size: [1, 1, 1] }, material: 'm' }], { mode: 'override', colliders: [{ node: null, shape: 'trimesh', params: {}, t: [0, 0, 0], r: [0, 0, 0, 1] }] }), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.equal(e.path, `${FILE}#/collision/colliders/0/shape`)
    return true
  })
})

test('scaleColliders: uniform ball, non-uniform cuboid', () => {
  const ball: ColliderSpec = { shape: 'ball', radius: 0.5, t: { x: 1, y: 2, z: 3 }, r: I }
  assert.deepEqual(scaleColliders([ball], { x: 2, y: 2, z: 2 }, FILE),
    [{ shape: 'ball', radius: 1, t: { x: 2, y: 4, z: 6 }, r: I }])
  assert.equal(ball.radius, 0.5)
  const box: ColliderSpec = { shape: 'roundCuboid', half: { x: 1, y: 1, z: 1 }, border: 0.5, t: { x: 1, y: 1, z: 1 }, r: I }
  const cub: ColliderSpec = { shape: 'cuboid', half: { x: 1, y: 2, z: 3 }, t: { x: 1, y: 1, z: 1 }, r: I }
  assert.deepEqual(scaleColliders([cub, box], { x: 2, y: 3, z: 0.5 }, FILE), [
    { shape: 'cuboid', half: { x: 2, y: 6, z: 1.5 }, t: { x: 2, y: 3, z: 0.5 }, r: I },
    { shape: 'roundCuboid', half: { x: 2, y: 3, z: 0.5 }, border: 0.25, t: { x: 2, y: 3, z: 0.5 }, r: I },
  ])
})

test('scaleColliders refusals', () => {
  const cap: ColliderSpec = { shape: 'capsule', halfHeight: 1, radius: 0.5, t: { x: 0, y: 0, z: 0 }, r: I }
  assert.throws(() => scaleColliders([cap], { x: 1, y: 2, z: 1 }, `${FILE}#/obstacles/0/s`), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.ok(e.message.includes('#/obstacles/0/s'))
    assert.ok(e.message.includes('non-uniform scale is allowed only for cuboid/roundCuboid colliders'))
    return true
  })
  const rotated: ColliderSpec = { shape: 'cuboid', half: { x: 1, y: 1, z: 1 }, t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 1, z: 0, w: 0 } }
  refused(() => scaleColliders([rotated], { x: 1, y: 2, z: 1 }, `${FILE}#/obstacles/1/s`), '#/obstacles/1/s')
  refused(() => scaleColliders([cap], { x: 0, y: 0, z: 0 }, `${FILE}#/obstacles/2/s`), '#/obstacles/2/s')
})
