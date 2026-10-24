// MeshPool with fake workers: no MAMA, no real Worker. Each fake records what it was posted and is
// answered by the test, so ordering, crashes and refusals are driven exactly.
import assert from 'node:assert/strict'
import test from 'node:test'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { MeshedAsset, MeshRequest } from '../src/sdf/mamaApi.ts'
import { MeshPool, poolSize, type MeshJobMessage, type WorkerLike } from '../src/sdf/meshPool.ts'

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readonly posted: MeshJobMessage[] = []
  terminated = false
  postMessage(m: unknown): void { this.posted.push(m as MeshJobMessage) }
  terminate(): void { this.terminated = true }
  last(): MeshJobMessage { return this.posted[this.posted.length - 1] }
  ok(): void {
    const { id, req } = this.last()
    this.onmessage?.({ data: { id, ok: true, value: meshed(req) } })
  }
}

function req(assetId: string): MeshRequest {
  return { assetId, hash: 'h-' + assetId, mesher: { output: 'lowpoly' }, document: {} }
}

function meshed(r: MeshRequest): MeshedAsset {
  return { assetId: r.assetId, hash: r.hash, mesher: r.mesher.output, parts: 1, triangles: 12, data: null, transfer: [] }
}

function fakePool(size: number): { pool: MeshPool; workers: FakeWorker[] } {
  const workers: FakeWorker[] = []
  const pool = new MeshPool(size, () => { const w = new FakeWorker(); workers.push(w); return w })
  return { pool, workers }
}

test('requests go FIFO to idle workers (size 2, 5 requests)', async () => {
  const { pool, workers } = fakePool(2)
  const ids = ['candy.a', 'candy.b', 'candy.c', 'candy.d', 'candy.e']
  const done: string[] = []
  const all = ids.map((id) => pool.mesh(req(id)).then((m) => { done.push(m.assetId) }))
  assert.deepEqual(workers.map((w) => w.posted.map((p) => p.req.assetId)), [['candy.a'], ['candy.b']])
  workers[1].ok()
  assert.equal(workers[1].last().req.assetId, 'candy.c')
  workers[0].ok()
  assert.equal(workers[0].last().req.assetId, 'candy.d')
  workers[0].ok()
  assert.equal(workers[0].last().req.assetId, 'candy.e')
  workers[1].ok()
  workers[0].ok()
  await Promise.all(all)
  assert.deepEqual(done, ['candy.b', 'candy.a', 'candy.d', 'candy.c', 'candy.e'])
  assert.equal(workers.length, 2)
})

test('a crash rejects naming the asset, and the respawned worker serves the next request', async () => {
  const { pool, workers } = fakePool(1)
  const first = pool.mesh(req('candy.spinner-bar'))
  const second = pool.mesh(req('candy.queue-pad'))
  workers[0].onerror?.({ message: 'out of memory' })
  await assert.rejects(first, (e: unknown) => {
    assert.ok(e instanceof RefusalError)
    assert.equal(e.area, 'sdf')
    assert.equal(e.path, 'candy.spinner-bar')
    assert.match(e.reason, /^mesh worker crashed; /)
    return true
  })
  assert.equal(workers[0].terminated, true)
  assert.equal(workers.length, 2)
  assert.equal(workers[1].last().req.assetId, 'candy.queue-pad')
  workers[1].ok()
  assert.equal((await second).assetId, 'candy.queue-pad')
})

test('a typed mesher refusal passes through with its area and path', async () => {
  const { pool, workers } = fakePool(1)
  const p = pool.mesh(req('candy.hammer'))
  const { id } = workers[0].last()
  workers[0].onmessage?.({ data: { id, ok: false, area: 'mesher', path: 'candy.hammer#group:head', reason: 'quad cannot mesh this group; use dc' } })
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RefusalError)
    assert.equal(e.area, 'mesher')
    assert.equal(e.path, 'candy.hammer#group:head')
    assert.equal(e.message, '[mesher] candy.hammer#group:head: quad cannot mesh this group; use dc')
    return true
  })
  assert.equal(workers[0].terminated, false)
})

test('pending counts queued and in-flight requests; close rejects them', async () => {
  const { pool, workers } = fakePool(2)
  assert.equal(pool.pending, 0)
  const ps = ['candy.a', 'candy.b', 'candy.c'].map((id) => pool.mesh(req(id)))
  assert.equal(pool.pending, 3)
  workers[0].ok()
  await ps[0]
  assert.equal(pool.pending, 2)
  pool.close()
  assert.equal(pool.pending, 0)
  assert.ok(workers.every((w) => w.terminated))
  for (const p of ps.slice(1)) await assert.rejects(p, RefusalError)
  await assert.rejects(pool.mesh(req('candy.d')), RefusalError)
})

test('poolSize follows rule 1.6', () => {
  assert.deepEqual([0, 1, 2, 8, 32].map(poolSize), [1, 1, 1, 4, 4])
})
