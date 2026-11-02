import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LOCAL_COSMETICS } from '@royal-fiesta/game/flow/startScreen'
import { buildContentIndex, contentDir, contentPath, packContent, profileAssetIds, validateContent } from '../content.ts'

test('index lists sorted stems and worlds, preserves document hashes and packs every byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-content-'))
  try {
    mkdirSync(join(dir, 'assets/common'), { recursive: true })
    mkdirSync(join(dir, 'courses'))
    writeFileSync(join(dir, 'assets/common/z.asset.json'), '{"hash":"saved-hash"}\n')
    writeFileSync(join(dir, 'assets/common/a.asset.json'), '{"hash":"other-hash"}')
    writeFileSync(join(dir, 'assets/common/ignored.txt'), 'ignored')
    writeFileSync(join(dir, 'courses/demo.course.json'), '{}\n')
    const index = buildContentIndex(dir)
    assert.deepEqual(index, {
      assets: [
        { id: 'a', world: 'common', path: 'assets/common/a.asset.json', hash: 'other-hash' },
        { id: 'z', world: 'common', path: 'assets/common/z.asset.json', hash: 'saved-hash' },
      ],
      courses: [{ id: 'demo', path: 'courses/demo.course.json' }],
      audio: [],
      thumbs: [],
    })
    const out = join(dir, 'pack')
    assert.deepEqual(packContent(out, dir), index)
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')), index)
    for (const { path } of [...index.assets, ...index.courses]) {
      assert.deepEqual(readFileSync(join(out, path)), readFileSync(join(dir, path)))
    }
    writeFileSync(join(dir, 'assets/common/z.asset.json'), '{"hash":"edited"}')
    assert.equal(buildContentIndex(dir).assets[1].hash, 'edited')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('RF_CONTENT_DIR is shared by content paths while fixtures stay in the game', () => {
  const before = process.env.RF_CONTENT_DIR
  try {
    process.env.RF_CONTENT_DIR = join(tmpdir(), 'content-checkout')
    assert.equal(contentDir(), process.env.RF_CONTENT_DIR)
    assert.equal(contentPath('courses/demo.course.json'), join(contentDir(), 'courses/demo.course.json'))
    assert.equal(contentPath('fixtures/a.json', '/game'), '/game/fixtures/a.json')
  } finally {
    if (before === undefined) delete process.env.RF_CONTENT_DIR
    else process.env.RF_CONTENT_DIR = before
  }
})

test('index and pack carry saved meshes, audio patches and level thumbnails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-packed-mesh-'))
  try {
    mkdirSync(join(dir, 'assets/candy'), { recursive: true })
    mkdirSync(join(dir, 'courses'))
    mkdirSync(join(dir, 'audio'))
    mkdirSync(join(dir, 'thumbs'))
    writeFileSync(join(dir, 'assets/candy/candy.a.asset.json'), '{"hash":"x"}')
    writeFileSync(join(dir, 'assets/candy/candy.a.mesh'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(dir, 'assets/candy/candy.a.thumb.avif'), new Uint8Array([3, 2, 1]))
    writeFileSync(join(dir, 'assets/candy/candy.b.asset.json'), '{"hash":"y"}')
    writeFileSync(join(dir, 'assets/candy/costume.hat.rose.thumb.avif'), new Uint8Array([6, 5, 4]))
    writeFileSync(join(dir, 'audio/bell.haa.json'), '{"haa":1,"id":"bell"}')
    writeFileSync(join(dir, 'audio/notes.txt'), 'ignored')
    writeFileSync(join(dir, 'courses/season.json'), readFileSync(new URL('../../courses/season.json', import.meta.url)))
    writeFileSync(join(dir, 'courses/s1-b-butterfly-freeway.thumb.avif'), new Uint8Array([9, 8, 7]))
    writeFileSync(join(dir, 'thumbs/B.avif'), 'stale legacy thumbnail')
    writeFileSync(join(dir, 'thumbs/cache.json'), '{}')
    const index = packContent(join(dir, 'out'), dir)
    assert.equal(index.assets[0].mesh, 'assets/candy/candy.a.mesh')
    assert.equal('mesh' in index.assets[1], false)
    assert.deepEqual(index.audio, [{ id: 'bell', path: 'audio/bell.haa.json' }])
    assert.deepEqual(index.thumbs, [{ map: 'B', path: 'courses/s1-b-butterfly-freeway.thumb.avif' }, { map: 'candy.a', path: 'assets/candy/candy.a.thumb.avif' }, { map: 'costume.hat.rose', path: 'assets/candy/costume.hat.rose.thumb.avif' }])
    assert.deepEqual(readFileSync(join(dir, 'out/assets/candy/costume.hat.rose.thumb.avif')), Buffer.from([6, 5, 4]))
    assert.deepEqual(readFileSync(join(dir, 'out/assets/candy/candy.a.thumb.avif')), Buffer.from([3, 2, 1]))
    assert.deepEqual(readFileSync(join(dir, 'out/assets/candy/candy.a.mesh')), Buffer.from([1, 2, 3]))
    assert.equal(readFileSync(join(dir, 'out/audio/bell.haa.json'), 'utf8'), '{"haa":1,"id":"bell"}')
    assert.deepEqual(readFileSync(join(dir, 'out/courses/s1-b-butterfly-freeway.thumb.avif')), Buffer.from([9, 8, 7]))
    assert.equal(existsSync(join(dir, 'out/thumbs/cache.json')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('strict validation refuses a bad haa header and accepts the shipped content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-validate-'))
  try {
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, 'courses'))
    mkdirSync(join(dir, 'audio'))
    writeFileSync(join(dir, 'audio/bell.haa.json'), '{"haa":1,"id":"gong"}')
    await assert.rejects(validateContent(buildContentIndex(dir), dir), /audio\/bell\.haa\.json: a haa patch needs the header/)
    writeFileSync(join(dir, 'audio/bell.haa.json'), '{"haa":1,"id":"bell"}')
    await validateContent(buildContentIndex(dir), dir)
    const started = Date.now()
    await validateContent(buildContentIndex())
    assert.ok(Date.now() - started < 60000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the sprint load set is what the page meshes: playlist, hub, podium and character, not every asset', async () => {
  const ids = await profileAssetIds('sprint')
  assert.ok(ids.includes('penguin.body') && ids.includes('candy.checkpoint-gate'))
  for (const { id, asset } of LOCAL_COSMETICS) {
    assert.ok(ids.includes(asset), `${id} shares ${asset} in the wardrobe load set`)
    if (id !== asset) assert.ok(!ids.includes(id), `${id} never requests a separate mesh`)
  }
  assert.deepEqual(ids, [...ids].sort())
})

test('a pack with a load set replaces the meshes it finds in out: orphans of an earlier pack are removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-pack-orphans-'))
  const before = process.env.RF_MESH_CACHE_DIR
  try {
    for (const d of ['assets', 'courses', 'audio', 'thumbs', 'cache']) mkdirSync(join(dir, d))
    const keep = 'a'.repeat(64)
    const orphan = 'b'.repeat(64)
    writeFileSync(join(dir, 'cache', `${keep}.mesh`), new Uint8Array([1, 2, 3]))
    writeFileSync(join(dir, 'cache', `${orphan}.mesh`), new Uint8Array([4, 5, 6]))
    process.env.RF_MESH_CACHE_DIR = join(dir, 'cache')
    const out = join(dir, 'out')
    mkdirSync(join(out, 'meshes'), { recursive: true })
    writeFileSync(join(out, 'meshes', orphan), 'old pack of another MAMA pin')
    writeFileSync(join(out, 'meshes', `${'c'.repeat(64)}.failed`), 'old refusal')
    packContent(out, dir, new Set([keep]))
    assert.deepEqual(readdirSync(join(out, 'meshes')), [keep])
  } finally {
    if (before === undefined) delete process.env.RF_MESH_CACHE_DIR
    else process.env.RF_MESH_CACHE_DIR = before
    rmSync(dir, { recursive: true, force: true })
  }
})
