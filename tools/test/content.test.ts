import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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

test('index and pack carry saved meshes and audio patches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-packed-mesh-'))
  try {
    mkdirSync(join(dir, 'assets/candy'), { recursive: true })
    mkdirSync(join(dir, 'courses'))
    mkdirSync(join(dir, 'audio'))
    writeFileSync(join(dir, 'assets/candy/candy.a.asset.json'), '{"hash":"x"}')
    writeFileSync(join(dir, 'assets/candy/candy.a.mesh'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(dir, 'assets/candy/candy.b.asset.json'), '{"hash":"y"}')
    writeFileSync(join(dir, 'audio/bell.haa.json'), '{"haa":1,"id":"bell"}')
    writeFileSync(join(dir, 'audio/notes.txt'), 'ignored')
    const index = packContent(join(dir, 'out'), dir)
    assert.equal(index.assets[0].mesh, 'assets/candy/candy.a.mesh')
    assert.equal('mesh' in index.assets[1], false)
    assert.deepEqual(index.audio, [{ id: 'bell', path: 'audio/bell.haa.json' }])
    assert.deepEqual(readFileSync(join(dir, 'out/assets/candy/candy.a.mesh')), Buffer.from([1, 2, 3]))
    assert.equal(readFileSync(join(dir, 'out/audio/bell.haa.json'), 'utf8'), '{"haa":1,"id":"bell"}')
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
  assert.ok(!ids.includes('costume.fish-scarf'))
  assert.deepEqual(ids, [...ids].sort())
})
