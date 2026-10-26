import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MeshBaker } from '../meshBake.ts'
import { contentDir } from '../content.ts'
import { decodeMesh } from '../../apps/web/src/sdf/meshWire.ts'

test('baker reuses persisted success and serialises overlapping scans', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-bake-'))
  try {
    mkdirSync(join(dir, 'assets/candy'), { recursive: true })
    mkdirSync(join(dir, 'courses'))
    copyFileSync(join(contentDir(), 'assets/candy/candy.cloud.asset.json'), join(dir, 'assets/candy/candy.cloud.asset.json'))
    const cache = join(dir, 'cache')
    const baker = new MeshBaker(dir, cache)
    const first = baker.scan()
    assert.equal(first, baker.scan())
    await first
    const files = readdirSync(cache)
    assert.equal(files.length, 1)
    assert.match(files[0], /^[a-f0-9]{64}\.mesh$/)
    const file = join(cache, files[0])
    const value = decodeMesh(readFileSync(file))
    assert.equal(value.assetId, 'candy.cloud')
    assert.ok(value.triangles > 0)
    const before = statSync(file).mtimeMs
    await new MeshBaker(dir, cache).scan()
    assert.equal(statSync(file).mtimeMs, before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('baker persists an asset timeout and never retries the failed key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-bake-'))
  const saved = process.env.RF_MESH_TIMEOUT_S
  try {
    process.env.RF_MESH_TIMEOUT_S = '0.001'
    mkdirSync(join(dir, 'assets/candy'), { recursive: true })
    mkdirSync(join(dir, 'courses'))
    copyFileSync(join(contentDir(), 'assets/candy/candy.cloud.asset.json'), join(dir, 'assets/candy/candy.cloud.asset.json'))
    const cache = join(dir, 'cache')
    await new MeshBaker(dir, cache).scan()
    const files = readdirSync(cache)
    assert.equal(files.length, 1)
    assert.match(files[0], /\.failed$/)
    const file = join(cache, files[0])
    assert.match(readFileSync(file, 'utf8'), /timed out/)
    const before = statSync(file).mtimeMs
    await new MeshBaker(dir, cache).scan()
    assert.equal(statSync(file).mtimeMs, before)
  } finally {
    if (saved === undefined) delete process.env.RF_MESH_TIMEOUT_S
    else process.env.RF_MESH_TIMEOUT_S = saved
    rmSync(dir, { recursive: true, force: true })
  }
})
