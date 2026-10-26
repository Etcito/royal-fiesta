import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildContentIndex, contentDir, contentPath, packContent } from '../content.ts'

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

test('content pack includes baked meshes at extensionless cache-key URLs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-packed-mesh-'))
  const saved = process.env.RF_MESH_CACHE_DIR
  try {
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, 'courses'))
    mkdirSync(join(dir, 'cache'))
    process.env.RF_MESH_CACHE_DIR = join(dir, 'cache')
    const key = 'a'.repeat(64)
    writeFileSync(join(dir, 'cache', key + '.mesh'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(dir, 'cache', key + '.failed'), 'refused')
    packContent(join(dir, 'out'), dir)
    assert.deepEqual(readFileSync(join(dir, 'out/meshes', key)), Buffer.from([1, 2, 3]))
  } finally {
    if (saved === undefined) delete process.env.RF_MESH_CACHE_DIR
    else process.env.RF_MESH_CACHE_DIR = saved
    rmSync(dir, { recursive: true, force: true })
  }
})
