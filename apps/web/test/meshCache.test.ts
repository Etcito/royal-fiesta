// MeshCache with fake stores: no browser, no IndexedDB. A node:crypto sha256 stands in for
// crypto.subtle, the same injected hash the page passes to meshCacheKey.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalJson } from '@royal-fiesta/game/course'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import type { MeshedAsset } from '../src/sdf/mamaApi.ts'
import { MeshCache, idbStore, memoryStore, meshCacheKey, type MeshStore } from '../src/sdf/meshCache.ts'

function sha256Hex(b: Uint8Array): Promise<string> {
  return Promise.resolve(createHash('sha256').update(b).digest('hex'))
}

function asset(over: Partial<GameAsset> = {}): GameAsset {
  return {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta', id: 'candy.spinner-bar',
    name: 'Spinner bar', category: 'obstacle', world: 'candy',
    mesher: { output: 'lowpoly' }, document: {}, collision: [], anchors: {},
    bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    hash: 'a'.repeat(64),
    ...over,
  }
}

function meshed(assetId: string, hash = `h-${assetId}`, transfer: ArrayBuffer[] = [new ArrayBuffer(8)]): MeshedAsset {
  return { assetId, hash, mesher: 'lowpoly', parts: 1, triangles: 12, data: { material: 'candy' }, transfer }
}

class FakeStore implements MeshStore {
  readonly map = new Map<string, MeshedAsset>()
  gets = 0
  puts = 0
  deletes = 0
  async get(key: string): Promise<MeshedAsset | null> { this.gets++; return this.map.get(key) ?? null }
  async put(key: string, v: MeshedAsset): Promise<void> { this.puts++; this.map.set(key, v) }
  async delete(key: string): Promise<void> { this.deletes++; this.map.delete(key) }
}

test('the key is sha256 of hash|canonical mesher|mamaVersion|raaSdfmVersion', async () => {
  const a = asset()
  const key = await meshCacheKey(a, 'mama-1', 'raa-sdfm-2', sha256Hex)
  const material = `${a.hash}|${canonicalJson(a.mesher)}|mama-1|raa-sdfm-2`
  assert.equal(key, createHash('sha256').update(material, 'utf8').digest('hex'))
})

test('the key changes with hash, mesher output, mesher params and either version, and is stable otherwise', async () => {
  const base = await meshCacheKey(asset(), 'mama-1', 'raa-sdfm-2', sha256Hex)
  const stable = await meshCacheKey(
    asset({ name: 'Another name', id: 'candy.other', document: { nodes: [] } }),
    'mama-1', 'raa-sdfm-2', sha256Hex,
  )
  assert.equal(stable, base, 'name, id and document are covered by hash, not by the key')
  const reordered = await meshCacheKey(
    asset({ mesher: { output: 'lowpoly', params: { b: 2, a: 1 } } }),
    'mama-1', 'raa-sdfm-2', sha256Hex,
  )
  const ordered = await meshCacheKey(
    asset({ mesher: { output: 'lowpoly', params: { a: 1, b: 2 } } }),
    'mama-1', 'raa-sdfm-2', sha256Hex,
  )
  assert.equal(reordered, ordered, 'canonicalJson sorts the params keys')
  const variants = [
    await meshCacheKey(asset({ hash: 'b'.repeat(64) }), 'mama-1', 'raa-sdfm-2', sha256Hex),
    await meshCacheKey(asset({ mesher: { output: 'quad' } }), 'mama-1', 'raa-sdfm-2', sha256Hex),
    await meshCacheKey(asset({ mesher: { output: 'lowpoly', params: { resolution: 64 } } }), 'mama-1', 'raa-sdfm-2', sha256Hex),
    await meshCacheKey(asset(), 'mama-3', 'raa-sdfm-2', sha256Hex),
    await meshCacheKey(asset(), 'mama-1', 'raa-sdfm-4', sha256Hex),
  ]
  assert.equal(new Set([base, ...variants]).size, variants.length + 1)
})

test('memoryStore is a Map: put, get and delete', async () => {
  const store = memoryStore()
  const v = meshed('candy.a')
  assert.equal(await store.get('k'), null)
  await store.put('k', v)
  assert.equal(await store.get('k'), v)
  await store.delete('k')
  assert.equal(await store.get('k'), null)
})

test('idbStore refuses without an IndexedDB factory', () => {
  assert.throws(() => idbStore(null as unknown as IDBFactory), (e: unknown) => e instanceof Error && e.message.includes('indexedDB is not available'))
})

test('an idb hit fills memory, so the second get answers memory', async () => {
  const memory = new FakeStore()
  const persistent = new FakeStore()
  const cache = new MeshCache({ memory, persistent })
  const value = meshed('candy.a')
  const source = new Uint8Array([1, 2, 3, 4])
  value.transfer = [source.buffer]
  await persistent.put('k1', value)

  const first = await cache.get('k1')
  assert.equal(first?.from, 'idb')
  assert.equal(first?.value, value)
  assert.deepEqual(new Uint8Array(first?.value.transfer[0] as ArrayBuffer), source, 'the bytes reach the caller unchanged')
  assert.equal(memory.map.get('k1'), value, 'the idb hit is copied into memory')

  const second = await cache.get('k1')
  assert.equal(second?.from, 'memory')
  assert.equal(second?.value, value)
  assert.equal(persistent.gets, 1, 'the second get never touches the persistent layer')
  assert.deepEqual(cache.stats, { memory: 1, idb: 1, miss: 0, evictedCorrupt: 0 })
})

test('put writes both layers and get counts memory hits, idb hits and misses', async () => {
  const memory = new FakeStore()
  const persistent = new FakeStore()
  const cache = new MeshCache({ memory, persistent })
  const a = meshed('candy.a')
  const b = meshed('candy.b')

  await cache.put('a', a)
  await cache.put('b', b)
  assert.equal(memory.map.get('a'), a)
  assert.equal(persistent.map.get('a'), a)
  assert.equal(memory.map.get('b'), b)
  assert.equal(persistent.map.get('b'), b)

  assert.equal((await cache.get('a'))?.from, 'memory')
  persistent.map.delete('b')
  await persistent.put('b', b)
  memory.map.delete('b')
  assert.equal((await cache.get('b'))?.from, 'idb')
  assert.equal(await cache.get('missing'), null)
  assert.deepEqual(cache.stats, { memory: 1, idb: 1, miss: 1, evictedCorrupt: 0 })
})

test('a corrupt memory entry is evicted and counted, then answers null', async () => {
  const memory = new FakeStore()
  const persistent = new FakeStore()
  const cache = new MeshCache({ memory, persistent })
  memory.map.set('bad', { ...meshed('candy.a'), parts: 'one' } as unknown as MeshedAsset)

  assert.equal(await cache.get('bad'), null)
  assert.equal(memory.map.has('bad'), false)
  assert.equal(memory.deletes, 1)
  assert.deepEqual(cache.stats, { memory: 0, idb: 0, miss: 1, evictedCorrupt: 1 })
  assert.equal(await cache.get('bad'), null, 'the next get is a plain miss')
  assert.deepEqual(cache.stats, { memory: 0, idb: 0, miss: 2, evictedCorrupt: 1 })
})

test('a corrupt idb entry is evicted and counted, and a corrupt memory entry lets a good idb entry answer', async () => {
  const memory = new FakeStore()
  const persistent = new FakeStore()
  const cache = new MeshCache({ memory, persistent })
  persistent.map.set('bad', { ...meshed('candy.a'), transfer: null } as unknown as MeshedAsset)

  assert.equal(await cache.get('bad'), null)
  assert.equal(persistent.map.has('bad'), false)
  assert.equal(persistent.deletes, 1)
  assert.deepEqual(cache.stats, { memory: 0, idb: 0, miss: 1, evictedCorrupt: 1 })

  memory.map.set('shared', { ...meshed('candy.b'), assetId: 7 } as unknown as MeshedAsset)
  const good = meshed('candy.b')
  persistent.map.set('shared', good)
  const hit = await cache.get('shared')
  assert.equal(hit?.from, 'idb')
  assert.equal(hit?.value, good)
  assert.equal(memory.map.get('shared'), good)
  assert.deepEqual(cache.stats, { memory: 0, idb: 1, miss: 1, evictedCorrupt: 2 })
})

test('without a persistent layer the cache still serves memory and counts misses', async () => {
  const memory = new FakeStore()
  const cache = new MeshCache({ memory, persistent: null })
  await cache.put('a', meshed('candy.a'))
  assert.equal((await cache.get('a'))?.from, 'memory')
  assert.equal(await cache.get('b'), null)
  assert.deepEqual(cache.stats, { memory: 1, idb: 0, miss: 1, evictedCorrupt: 0 })
})
