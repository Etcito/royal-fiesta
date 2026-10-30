import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { canonicalJson } from '../src/course.ts'
import { GAME_ASSET_CAPS, assetFilePath, assetMeshPath, parseGameAsset } from '../src/gameAsset.ts'

const FILE = 'assets/candy/candy.spinner-bar.asset.json'

function sha256(doc: unknown): string {
  return createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex')
}

function valid(): Record<string, any> {
  const document = { nodes: [{ kind: 'box', size: [4, 0.5, 0.5] }], note: 'spinner bar' }
  return {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta',
    id: 'candy.spinner-bar', name: 'Spinner bar', category: 'obstacle', world: 'candy',
    mesher: { output: 'lowpoly' },
    document,
    collision: [{ shape: 'cuboid', half: [2, 0.25, 0.25] }, { shape: 'ball', radius: 0.5, t: [0, 1, 0], r: [0, 0, 0, 1] }],
    anchors: { top: { t: [0, 0.5, 0], r: [0, 0, 0, 1] } },
    bounds: { min: [-2, -0.25, -0.25], max: [2, 0.25, 0.25] },
    hash: sha256(document),
  }
}

// Rehash after a document patch so the refusal comes from the rule under test, not from the hash.
function patched(patch: (a: Record<string, any>) => void): Record<string, any> {
  const a = valid()
  patch(a)
  a.hash = sha256(a.document)
  return a
}

// Two bodies, one collider each (valid() has two colliders), one hinge.
function physicsBlock(over: Record<string, unknown> = {}): Record<string, any> {
  const body = { t: [0, 0, 0], r: [0, 0, 0, 1], density: 400, friction: 0.6, restitution: 0, linearDamping: 0, angularDamping: 0.05, gravityScale: 1, ccd: false, surface: 'normal' }
  return {
    bodies: [
      { ...body, id: 'base', type: 'fixed', colliders: [0], parts: ['base'] },
      { ...body, id: 'plank', type: 'dynamic', colliders: [1], parts: ['plank'] },
    ],
    joints: [
      { id: 'pivot', kind: 'hinge', a: 'base', b: 'plank', anchorA: [0, 0.5, 0], anchorB: [0, 0, 0], axis: [1, 0, 0], limitsDeg: [-20, 20], stiffness: 0, damping: 0, lengthM: 0, motor: null },
    ],
    ...over,
  }
}

async function refused(json: unknown, pointer: string, contains: string[] = []): Promise<void> {
  await assert.rejects(parseGameAsset(json, FILE), (e: unknown) => {
    assert.ok(isRefusal(e), 'expected a RefusalError')
    assert.ok(e.message.startsWith(`[asset] ${FILE}#/`), `message ${JSON.stringify(e.message)} lacks the [asset] file#/ prefix`)
    assert.ok(e.message.startsWith(`[asset] ${FILE}#${pointer}: `), `message ${JSON.stringify(e.message)} lacks ${pointer}`)
    assert.ok(e.message.includes('; '), 'message names the fix')
    for (const c of contains) assert.ok(e.message.includes(c), `message ${JSON.stringify(e.message)} lacks ${c}`)
    return true
  })
}

test('a valid asset parses, with collision mapped to ColliderSpec and defaults applied', async () => {
  const a = await parseGameAsset(valid(), FILE)
  assert.equal(a.id, 'candy.spinner-bar')
  assert.equal(a.world, 'candy')
  assert.deepEqual(a.mesher, { output: 'lowpoly' })
  assert.deepEqual(a.collision, [
    { shape: 'cuboid', half: { x: 2, y: 0.25, z: 0.25 }, t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } },
    { shape: 'ball', radius: 0.5, t: { x: 0, y: 1, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } },
  ])
  assert.deepEqual(a.anchors.top, { t: { x: 0, y: 0.5, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 } })
  assert.deepEqual(a.bounds.min, { x: -2, y: -0.25, z: -0.25 })
  assert.equal(a.hash, valid().hash)
})

test('an obstacle with an empty collision is valid content', async () => {
  const a = await parseGameAsset(patched(x => { x.collision = [] }), FILE)
  assert.deepEqual(a.collision, [])
})

test('assetFilePath is assets/<world>/<id>.asset.json', () => {
  assert.equal(assetFilePath('candy', 'candy.spinner-bar'), 'assets/candy/candy.spinner-bar.asset.json')
  assert.equal(assetFilePath('common', 'penguin.body'), 'assets/common/penguin.body.asset.json')
})

test('assetMeshPath is assets/<world>/<id>.mesh', () => {
  assert.equal(assetMeshPath('candy', 'candy.x'), 'assets/candy/candy.x.mesh')
})

test('an asset without physics has no physics key', async () => {
  const a = await parseGameAsset(valid(), FILE)
  assert.equal('physics' in a, false)
})

test('an asset with physics keeps the parsed physics block', async () => {
  const a = await parseGameAsset(patched(x => { x.physics = physicsBlock() }), FILE)
  assert.equal(a.physics?.bodies.length, 2)
  assert.equal(a.physics?.bodies[1].type, 'dynamic')
  assert.deepEqual(a.physics?.bodies[1].colliders, [1])
  assert.deepEqual(a.physics?.joints[0].limitsDeg, [-20, 20])
  assert.equal(a.physics?.joints[0].motor, null)
})

test('a physics refusal names its pointer in the asset file', async () => {
  await refused(patched(x => { x.physics = physicsBlock({ joints: [{ ...physicsBlock().joints[0], axis: [1, 1, 0] }] }) }), '/physics/joints/0/axis', ['must be 1 within 1e-6'])
})

test('unknown top-level key', async () => {
  await refused(patched(a => { a.extra = 1 }), '/extra')
})

test('bad id', async () => {
  await refused(patched(a => { a.id = 'Spinner_Bar' }), '/id')
})

test('bad hash names both values', async () => {
  const a = valid()
  const wrong = '0'.repeat(64)
  const right = a.hash
  a.hash = wrong
  await refused(a, '/hash', [wrong, right])
})

test('a hash of the SDF Modeler document text is accepted', async () => {
  const a = valid()
  a.document = { format: 'sdfm', version: 2, nodes: [{ kind: 'box', t: [0, 1.5, -2], tags: [] }], meta: { tags: ['a', 1] } }
  // Written by hand in SDF Modeler's serializeDocument layout.
  const text = [
    '{',
    '  "format": "sdfm",',
    '  "version": 2,',
    '  "nodes": [',
    '    {',
    '      "kind": "box",',
    '      "t": [0, 1.5, -2],',
    '      "tags": []',
    '    }',
    '  ],',
    '  "meta": {',
    '    "tags": [',
    '      "a",',
    '      1',
    '    ]',
    '  }',
    '}',
    '',
  ].join('\n')
  a.hash = createHash('sha256').update(text, 'utf8').digest('hex')
  const parsed = await parseGameAsset(a, FILE)
  assert.equal(parsed.hash, a.hash)
})

test('a rigged node hashes with its rig in plain JSON.stringify layout', async () => {
  const a = valid()
  const rig = { name: 'r', bones: [{ name: 'root', t: [0, 1] }] }
  a.document = { nodes: [{ id: 'g', kind: 'group', rig }] }
  // SDF Modeler writes a node's rig (and clips) with JSON.stringify(v, null, 2), re-indented.
  const text = [
    '{',
    '  "nodes": [',
    '    {',
    '      "id": "g",',
    '      "kind": "group",',
    '      "rig": {',
    '        "name": "r",',
    '        "bones": [',
    '          {',
    '            "name": "root",',
    '            "t": [',
    '              0,',
    '              1',
    '            ]',
    '          }',
    '        ]',
    '      }',
    '    }',
    '  ]',
    '}',
    '',
  ].join('\n')
  a.hash = createHash('sha256').update(text, 'utf8').digest('hex')
  const parsed = await parseGameAsset(a, FILE)
  assert.equal(parsed.hash, a.hash)
})

test('a hash matching neither form is refused with both digests', async () => {
  const a = valid()
  const right = a.hash
  a.hash = 'f'.repeat(64)
  await refused(a, '/hash', ['f'.repeat(64), right, 'SDF Modeler document text'])
})

test('unknown collider shape keeps the pointer suffix under area asset', async () => {
  await refused(patched(a => { a.collision = [{ shape: 'trimesh', vertices: [] }] }), '/collision/0/shape')
})

test('more than 8 colliders', async () => {
  await refused(patched(a => { a.collision = Array.from({ length: 9 }, () => ({ shape: 'ball', radius: 1 })) }), '/collision')
})

test('a <script string in the document', async () => {
  await refused(patched(a => { a.document.nodes[0].label = 'x<SCRIPT>alert(1)</script>' }), '/document/nodes/0/label')
})

test('a __proto__ key in the document', async () => {
  await refused(patched(a => { a.document.meta = JSON.parse('{"__proto__": {"x": 1}}') }), '/document/meta/__proto__')
})

test('a non-finite number in the document', async () => {
  await refused(patched(a => { a.document.nodes[0].size[1] = Number.POSITIVE_INFINITY }), '/document/nodes/0/size/1')
})

test('an oversize document', async () => {
  await refused(patched(a => { a.document = { pad: 'x'.repeat(GAME_ASSET_CAPS.maxDocumentBytes) } }), '/document')
  assert.equal(GAME_ASSET_CAPS.maxDocumentBytes, 2097152)
})

test('every invalid fixture refuses with file#pointer and a fix', async () => {
  const dir = 'fixtures/game-assets/invalid'
  const expected: Record<string, string> = {
    'bad-hash.asset.json': '/hash',
    'bad-id.asset.json': '/id',
    'script-string.asset.json': '/document',
    'unknown-key.asset.json': '/extra',
    'unknown-shape.asset.json': '/collision/0/shape',
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  assert.deepEqual(files, Object.keys(expected).sort())
  for (const f of files) {
    const path = `${dir}/${f}`
    await assert.rejects(parseGameAsset(JSON.parse(readFileSync(path, 'utf8')), path), (e: unknown) => {
      assert.ok(isRefusal(e), 'expected a RefusalError')
      assert.ok(e.message.startsWith(`[asset] ${path}#/`), e.message)
      assert.ok(e.message.startsWith(`[asset] ${path}#${expected[f]}`), e.message)
      assert.ok(e.message.includes('; '), e.message)
      return true
    })
  }
})
