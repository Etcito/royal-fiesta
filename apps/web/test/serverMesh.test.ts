import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { encodeMesh, decodeMesh } from '../src/sdf/meshWire.ts'
import { fetchServerMesh } from '../src/sdf/serverMesh.ts'
import type { MeshedAsset } from '../src/sdf/mamaApi.ts'

function mesh(): MeshedAsset {
  const buffer = new ArrayBuffer(48)
  const positions = new Float32Array(buffer, 4, 3)
  positions.set([1.25, -2, 3])
  return { assetId: 'candy.cloud', hash: 'hash', mesher: 'poly', parts: 1, triangles: 1,
    data: { positions, frame: new Float64Array([1, 2]), indices: new Uint32Array([0, 1, 2]), uvs: null }, transfer: [buffer] }
}
test('mesh wire preserves bytes, typed arrays, offsets and shared buffers', () => {
  const value = mesh()
  const decoded = decodeMesh(encodeMesh(value))
  assert.deepEqual(decoded, value)
  assert.equal((decoded.data as { positions: Float32Array }).positions.buffer, decoded.transfer[0])
  assert.throws(() => decodeMesh(new Uint8Array([2])))
  assert.throws(() => decodeMesh(encodeMesh(value).slice(0, -1)))
})
test('server mesh waits for 202 then decodes a success', async () => {
  let calls = 0, waits = 0
  const fetcher: typeof fetch = async url => {
    assert.equal(url, 'content/meshes/key')
    return ++calls === 1 ? new Response('', { status: 202 }) : new Response(encodeMesh(mesh()) as BodyInit)
  }
  assert.deepEqual(await fetchServerMesh('content', 'key', () => { waits++ }, fetcher), mesh())
  assert.equal(calls, 2)
  assert.equal(waits, 1)
})
test('a gzipped packed mesh decodes like a raw one', async () => {
  const fetcher: typeof fetch = async () => new Response(gzipSync(encodeMesh(mesh())) as BodyInit)
  assert.deepEqual(await fetchServerMesh('content', 'key', () => {}, fetcher), mesh())
})
test('missing service falls back, explicit server refusal does not', async () => {
  const missing: typeof fetch = async () => new Response('', { status: 404 })
  assert.equal(await fetchServerMesh('/', 'key', () => {}, missing), null)
  const offline: typeof fetch = async () => { throw new Error('offline') }
  assert.equal(await fetchServerMesh('/', 'key', () => {}, offline), null)
  const refused: typeof fetch = async () => new Response('bad geometry', { status: 422 })
  await assert.rejects(fetchServerMesh('/', 'key', () => {}, refused), /bad geometry/)
})
test('a refusal published on a static host is a refusal, not a local mesh', async () => {
  const published: typeof fetch = async url => String(url).endsWith('.failed')
    ? new Response('NotManifold', { status: 200 }) : new Response('', { status: 404 })
  await assert.rejects(fetchServerMesh('content', 'key', () => {}, published), /NotManifold/)
})
test('server wait has a deadline', async () => {
  const busy: typeof fetch = async () => new Response('', { status: 202 })
  await assert.rejects(fetchServerMesh('/', 'key', () => {}, busy, 1), /timed out/)
})
