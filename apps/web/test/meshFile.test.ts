// S24 saved mesh: the shared wire vector (also read by mama's mesh-file test) and fetchMeshFile's answers.
// In the vector JSON a typed array is {"type":"Float32Array","values":[...]} on its own buffer, and a
// transfer entry {"type":"ArrayBuffer","bufferOf":"<dotted path>"} is the buffer of the typed array at that path.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { fetchMeshFile, meshFileStats } from '../src/sdf/meshFile.ts'
import { meshCacheKey } from '../src/sdf/meshCache.ts'
import { decodeMesh, encodeMesh } from '../src/sdf/meshWire.ts'
import type { KeyedMeshedAsset } from '../src/sdf/meshWire.ts'

const VECTOR_URL = new URL('../../../fixtures/golden/mesh-wire-vector.json', import.meta.url)
const REGENERATE = 'env RF_WRITE_GOLDEN=1 node --experimental-strip-types --test apps/web/test/meshFile.test.ts'
const TYPES = { Float32Array, Float64Array, Uint32Array, Uint16Array, Uint8Array, Int32Array, Int16Array, Int8Array }

interface Vector { format: string; version: number; regenerate: string; value: unknown; hex: string }

function sha256Hex(b: Uint8Array): Promise<string> {
  return Promise.resolve(createHash('sha256').update(b).digest('hex'))
}

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')
}

function testAsset(id: string, hash: string): GameAsset {
  return {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta', id, name: 'Wire vector', category: 'prop', world: 'candy',
    mesher: { output: 'lowpoly' }, document: {}, collision: [], anchors: {},
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } }, hash,
  }
}

// The vector's MeshedAsset: one group, one part, one 3-vertex triangle, in the MAMA worker's payload layout.
async function vectorValue(): Promise<KeyedMeshedAsset> {
  const hash = await sha256Hex(new TextEncoder().encode('royal-fiesta.mesh-wire-vector'))
  const key = await meshCacheKey(testAsset('candy.wire-vector', hash), 'mama-vector', 'raa-sdfm-vector', sha256Hex)
  const frame = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  const mesh = {
    material: 'candy',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  }
  return {
    assetId: 'candy.wire-vector', hash, mesher: 'lowpoly', parts: 1, triangles: 1, key,
    data: { groups: [{ group: 'g1', parts: [{ partId: 'p1', name: 'triangle', frame, meshes: [mesh] }] }], materials: [] },
    transfer: [frame.buffer, mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer],
  }
}

function toJsonValue(value: KeyedMeshedAsset): unknown {
  const paths = new Map<ArrayBufferLike, string>()
  const walk = (v: unknown, path: string): unknown => {
    if (ArrayBuffer.isView(v)) {
      paths.set(v.buffer, path)
      return { type: v.constructor.name, values: Array.from(v as unknown as ArrayLike<number>) }
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}.${i}`))
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path === '' ? k : `${path}.${k}`)]))
    return v
  }
  const { transfer, ...rest } = value
  const json = walk(rest, '') as Record<string, unknown>
  return { ...json, transfer: transfer.map((b) => ({ type: 'ArrayBuffer', bufferOf: paths.get(b) })) }
}

function fromJsonValue(json: unknown): KeyedMeshedAsset {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v === null || typeof v !== 'object') return v
    const o = v as Record<string, unknown>
    if (typeof o.type === 'string' && o.type in TYPES && Array.isArray(o.values)) return new TYPES[o.type as keyof typeof TYPES](o.values as number[])
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]))
  }
  const { transfer, ...rest } = json as { transfer: { type: string; bufferOf: string }[] }
  const value = walk(rest) as Record<string, unknown>
  const at = (path: string): ArrayBufferLike => {
    const found = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], value)
    assert.ok(ArrayBuffer.isView(found), `transfer bufferOf ${path} names a typed array`)
    return found.buffer
  }
  return { ...value, transfer: transfer.map(t => at(t.bufferOf)) } as unknown as KeyedMeshedAsset
}

if (process.env.RF_WRITE_GOLDEN === '1') {
  const value = await vectorValue()
  const vector: Vector = { format: 'royal-fiesta.mesh-wire-vector', version: 0, regenerate: REGENERATE, value: toJsonValue(value), hex: hexOf(encodeMesh(value)) }
  writeFileSync(VECTOR_URL, JSON.stringify(vector, null, 2) + '\n')
}

const vectorText = readFileSync(VECTOR_URL, 'utf8')
const vector = JSON.parse(vectorText) as Vector
const vectorBytes = (): Uint8Array => new Uint8Array(Buffer.from(vector.hex, 'hex'))

test('the mesh wire vector file is the shared S24 shape, under 64 KiB', async () => {
  assert.equal(vector.format, 'royal-fiesta.mesh-wire-vector')
  assert.equal(vector.version, 0)
  assert.equal(vector.regenerate, REGENERATE)
  assert.ok(Buffer.byteLength(vectorText) < 64 * 1024, `${Buffer.byteLength(vectorText)} bytes`)
  assert.deepEqual(fromJsonValue(vector.value), await vectorValue(), 'the vector is what the generator writes; regenerate it')
})

test('encodeMesh of the vector value gives its hex bytes and decodeMesh of the hex gives the value', () => {
  const value = fromJsonValue(vector.value)
  assert.equal(hexOf(encodeMesh(value)), vector.hex)
  const bytes = vectorBytes()
  assert.equal(bytes[0], 1)
  const decoded = decodeMesh(bytes)
  assert.deepEqual(decoded, value)
  assert.equal(typeof decoded.key, 'string')
  const part = (decoded.data as { groups: { parts: { frame: Float64Array; meshes: { indices: Uint32Array }[] }[] }[] }).groups[0].parts[0]
  assert.equal(part.frame.buffer, decoded.transfer[0], 'decoded arrays share the transfer buffers')
  assert.equal(part.meshes[0].indices.buffer, decoded.transfer[4])
})

function serve(status: number, body: Uint8Array | null, calls: { url: string; cache: RequestCache | undefined }[] = []): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), cache: init?.cache })
    return new Response(body as BodyInit | null, { status })
  }
}

test('fetchMeshFile returns null for a 404 or a network error', async () => {
  const value = fromJsonValue(vector.value)
  const asset = testAsset(value.assetId, value.hash)
  const calls: { url: string; cache: RequestCache | undefined }[] = []
  assert.equal(await fetchMeshFile('content/assets/candy/candy.wire-vector.mesh', value.key!, asset, serve(404, null, calls)), null)
  assert.deepEqual(calls, [{ url: 'content/assets/candy/candy.wire-vector.mesh', cache: 'no-cache' }])
  const offline: typeof fetch = async () => { throw new TypeError('fetch failed') }
  assert.equal(await fetchMeshFile('x.mesh', value.key!, asset, offline), null)
})

test('fetchMeshFile returns null and counts stale for another key, asset or hash', async () => {
  const value = fromJsonValue(vector.value)
  const before = meshFileStats.stale
  assert.equal(await fetchMeshFile('x.mesh', 'f'.repeat(64), testAsset(value.assetId, value.hash), serve(200, vectorBytes())), null)
  assert.equal(await fetchMeshFile('x.mesh', value.key!, testAsset('candy.other', value.hash), serve(200, vectorBytes())), null)
  assert.equal(await fetchMeshFile('x.mesh', value.key!, testAsset(value.assetId, '0'.repeat(64)), serve(200, vectorBytes())), null)
  assert.equal(meshFileStats.stale, before + 3)
})

test('fetchMeshFile returns the value of a matching file and counts a hit', async () => {
  const value = fromJsonValue(vector.value)
  const hits = meshFileStats.hits
  assert.deepEqual(await fetchMeshFile('x.mesh', value.key!, testAsset(value.assetId, value.hash), serve(200, vectorBytes())), value)
  assert.equal(meshFileStats.hits, hits + 1)
})

test('fetchMeshFile refuses a matching file that breaks the mesh rules or cannot be decoded', async () => {
  const value = fromJsonValue(vector.value)
  const asset = testAsset(value.assetId, value.hash)
  const mesh = (value.data as { groups: { parts: { meshes: { normals: Float32Array }[] }[] }[] }).groups[0].parts[0].meshes[0]
  mesh.normals.fill(0)
  const url = 'content/assets/candy/candy.wire-vector.mesh'
  const isSdfRefusal = (reason: RegExp) => (e: unknown): boolean => e instanceof RefusalError && e.area === 'sdf' && e.path === url && reason.test(e.message)
  await assert.rejects(fetchMeshFile(url, value.key!, asset, serve(200, encodeMesh(value))), isSdfRefusal(/mesh\.invalid_normal/))
  const shapeless = { ...value, parts: 'one' } as unknown as KeyedMeshedAsset
  await assert.rejects(fetchMeshFile(url, value.key!, asset, serve(200, encodeMesh(shapeless))), isSdfRefusal(/not a meshed asset/))
  await assert.rejects(fetchMeshFile(url, value.key!, asset, serve(200, vectorBytes().slice(0, -1))), isSdfRefusal(/cannot be decoded/))
})
