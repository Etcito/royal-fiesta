import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assetHash, collidersOf, parsePrims } from '../src/prims.ts'
import { fixtureResolver, objectUrl, parseManifest, storeResolver } from '../src/assets.ts'
import { RefusalError } from '@royal-fiesta/sim/refusal'

const assetJson = (id: string) => JSON.stringify({
  format: 'raa.prims', version: 0, id, name: id,
  nodes: [{ id: 'body', kind: 'box', params: { size: [2, 2, 2] }, material: null }],
  materials: {}, collision: { colliders: [{ shape: 'cuboid', half: [1, 1, 1] }] },
})
const bytes = (s: string) => new TextEncoder().encode(s)
const sha = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const mustRefuse = async (p: Promise<unknown>) => assert.rejects(p, RefusalError)

test('fixture resolver parses, caches and refuses bad or missing names', async () => {
  const text = assetJson('tile')
  let reads = 0
  const resolver = fixtureResolver(async path => {
    reads++
    if (path.endsWith('/tile.prims.json')) return text
    throw new Error('ENOENT')
  })
  const one = await resolver.resolve('tile')
  const two = await resolver.resolve('tile')
  assert.equal(one.origin, 'fixtures')
  assert.equal(one.hash, assetHash(text))
  assert.equal(one.asset.id, 'tile')
  assert.equal(two, one)
  assert.equal(reads, 1)
  assert.throws(() => resolver.resolve('Bad_name'), e => e instanceof RefusalError && e.path === 'fixtures/assets/Bad_name.prims.json')
  await assert.rejects(resolver.resolve('missing'), e => e instanceof RefusalError && e.path === 'fixtures/assets/missing.prims.json' && e.message.includes('cannot read asset'))
  await assert.rejects(fixtureResolver(async () => '{').resolve('broken'), e => e instanceof RefusalError && e.path === 'fixtures/assets/broken.prims.json' && e.message.includes('invalid JSON'))
})

test('manifest validation and object URL format', () => {
  const hash = 'a'.repeat(64)
  assert.equal(objectUrl(hash), `https://assets.etcito.com/objects/aa/${hash}`)
  assert.equal(objectUrl(hash, 'https://example.test'), `https://example.test/objects/aa/${hash}`)
  assert.throws(() => objectUrl('nope'), RefusalError)
  assert.deepEqual(parseManifest({ format: 'raa.manifest', version: 0, entries: { tile: { sha256: hash, size: 0, type: 'x', version: 0 } } }, 'm'), {
    format: 'raa.manifest', version: 0, entries: { tile: { sha256: hash, size: 0, type: 'x', version: 0 } },
  })
  assert.throws(() => parseManifest({ format: 'raa.manifest', version: 0, entries: { tile: { sha256: 'bad', size: 0, type: 'x', version: 0 } } }, 'm'), e => e instanceof RefusalError && e.path === 'm#/entries/tile/sha256')
})

test('store resolver loads manifest once, parses objects and verifies hashes and sizes', async () => {
  const objectA = bytes(assetJson('tile'))
  const objectB = bytes(assetJson('wall'))
  const objectHashA = await sha(objectA)
  const objectHashB = await sha(objectB)
  const manifestText = JSON.stringify({ format: 'raa.manifest', version: 0, entries: {
    tile: { sha256: objectHashA, size: objectA.byteLength, type: 'application/vnd.raa.prims+json', version: 0 },
    wall: { sha256: objectHashB, size: objectB.byteLength, type: 'application/vnd.raa.prims+json', version: 0 },
  } })
  const manifestBytes = bytes(manifestText)
  const manifestHash = await sha(manifestBytes)
  const base = 'https://store.test'
  const data = new Map([[objectUrl(manifestHash, base), manifestBytes], [objectUrl(objectHashA, base), objectA], [objectUrl(objectHashB, base), objectB]])
  const calls = new Map<string, number>()
  const fetch = async (url: string) => {
    calls.set(url, (calls.get(url) ?? 0) + 1)
    const found = data.get(url)
    if (!found) throw new Error(`missing ${url}`)
    return found
  }
  const resolver = storeResolver(manifestHash, fetch, sha, base)
  const [tile, wall] = await Promise.all([resolver.resolve('tile'), resolver.resolve('wall')])
  assert.equal(tile.origin, 'store')
  assert.equal(tile.asset.id, 'tile')
  assert.equal(wall.asset.id, 'wall')
  assert.equal(calls.get(objectUrl(manifestHash, base)), 1)
  assert.equal((await resolver.resolve('tile')), tile)
  assert.equal(tile.hash, assetHash(new TextDecoder().decode(objectA)))

  const mismatchResolver = storeResolver('f'.repeat(64), async () => manifestBytes, sha, base)
  await assert.rejects(mismatchResolver.resolve('tile'), e => e instanceof RefusalError && e.message.includes('f'.repeat(64)) && e.message.includes(manifestHash))
  const badObject = bytes(assetJson('other'))
  const badManifest = bytes(JSON.stringify({ format: 'raa.manifest', version: 0, entries: { bad: { sha256: objectHashA, size: badObject.length, type: 'x', version: 0 } } }))
  const badManifestHash = await sha(badManifest)
  const badResolver = storeResolver(badManifestHash, async url => url === objectUrl(badManifestHash, base) ? badManifest : badObject, sha, base)
  await assert.rejects(badResolver.resolve('bad'), e => e instanceof RefusalError && e.message.includes(objectHashA) && e.message.includes(awaitSha(badObject)))
  await mustRefuse(resolver.resolve('unknown'))
  const sizeManifest = bytes(JSON.stringify({ format: 'raa.manifest', version: 0, entries: { tile: { sha256: objectHashA, size: objectA.length + 1, type: 'x', version: 0 } } }))
  const sizeManifestHash = await sha(sizeManifest)
  const sizeResolver = storeResolver(sizeManifestHash, async url => url === objectUrl(sizeManifestHash, base) ? sizeManifest : objectA, sha, base)
  await assert.rejects(sizeResolver.resolve('tile'), e => e instanceof RefusalError && e.message.includes(`expected ${objectA.length + 1}, got ${objectA.length}`))
})

function awaitSha(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex')
}

test('present asset fixtures stay small, collidable and material-valid', () => {
  let files: string[] = []
  try { files = readdirSync(join(process.cwd(), 'fixtures/assets')).filter(f => f.endsWith('.prims.json')) } catch {}
  for (const file of files) {
    const text = readFileSync(join(process.cwd(), 'fixtures/assets', file), 'utf8')
    assert.ok(Buffer.byteLength(text) <= 8192, `${file} exceeds 8192 bytes`)
    const stem = file.slice(0, -'.prims.json'.length)
    const asset = parsePrims(JSON.parse(text), `fixtures/assets/${file}`)
    assert.equal(asset.id, stem)
    assert.ok(asset.collision)
    assert.ok(collidersOf(asset, `fixtures/assets/${file}`).length >= 1)
    assert.ok(collidersOf(asset, `fixtures/assets/${file}`).length <= 8)
    for (const node of asset.nodes) assert.ok(node.material === null || Object.hasOwn(asset.materials, node.material))
  }
})
