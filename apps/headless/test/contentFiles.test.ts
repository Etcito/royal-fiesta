import { contentDir } from '../../../tools/content.ts'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V0_ASSET_MAP } from '@royal-fiesta/game/courseV1'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { loadAllCoursesV1, loadCourseV1File, nodeGameAssets } from '../src/contentFiles.ts'
import { loadCourseFile } from '../src/files.ts'
import { isAuthored, readAuthored } from '../../../tools/authored.ts'
import { repoRoot } from '../../../tools/bricks.ts'
import { buildContent } from '../../../tools/placeholders.ts'

test('loadAllCoursesV1 loads every course on disk sorted by id', async () => {
  const onDisk = readdirSync(join(contentDir(), 'courses'))
    .filter(f => f.endsWith('.course.json'))
    .map(f => f.slice(0, -'.course.json'.length))
    .sort()
  const ids = (await loadAllCoursesV1()).map(c => c.id)
  assert.deepEqual(ids, onDisk)
  for (const id of [
    'hub-plaza', 'obstacle-gallery', 'podium', 'race-bean-dash', 'race-hammer-hill',
    'race-sprint', 'survival-hammer-ring', 'survival-spin-zone', 'survival-sprint',
  ]) assert.ok(ids.includes(id), id)
})

test('v1Playlist matches the v0 playlist for generated courses', async () => {
  // Shipped candy courses are authored mechanisms. Keep legacy parity covered
  // with generated assets and courses together in an isolated content root.
  const root = mkdtempSync(join(tmpdir(), 'rf-legacy-playlist-'))
  const previous = process.env.RF_CONTENT_DIR
  try {
    for (const [rel, text] of await buildContent({ files: [] })) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    cpSync(join(repoRoot(), 'fixtures/courses'), join(root, 'fixtures/courses'), { recursive: true })
    mkdirSync(join(root, 'tools'))
    writeFileSync(join(root, 'tools/authored.json'), JSON.stringify({ format: 'royal-fiesta.authored', version: 1, files: [] }))
    process.env.RF_CONTENT_DIR = root
    // Avoid reusing the shipped-content scanner's cached assets and courses.
    const legacyModule = '../src/contentFiles.ts?legacy-parity'
    const { v1Playlist } = await import(legacyModule) as typeof import('../src/contentFiles.ts')
    const authored = readAuthored(root)
    const set = (await v1Playlist('sprint')).filter(c =>
      !isAuthored(authored, `courses/${c.id}.course.json`) &&
      existsSync(join(root, 'fixtures', 'courses', `${c.id}.course.json`)))
    assert.ok(set.length > 0)
    for (const sim of set) {
      const old = await loadCourseFile(`fixtures/courses/${sim.id}.course.json`)
      const keys = Object.keys(old).filter(k => k !== 'contentHash' && k !== 'obstacles')
      assert.deepEqual(Object.keys(sim).sort(), Object.keys(old).sort(), sim.id)
      for (const k of keys) assert.deepEqual(sim[k as keyof typeof sim], old[k as keyof typeof old], `${sim.id}.${k}`)
      assert.equal(sim.obstacles.length, old.obstacles.length)
      sim.obstacles.forEach((o, i) => {
        const was = old.obstacles[i]
        assert.equal(o.asset, V0_ASSET_MAP[was.asset], `${sim.id} obstacle ${i}`)
        // Colliders now come from asset.collision with unchanged values.
        assert.deepEqual({ ...o, asset: was.asset }, was, `${sim.id} obstacle ${i}`)
      })
    }
  } finally {
    if (previous === undefined) delete process.env.RF_CONTENT_DIR
    else process.env.RF_CONTENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCourseV1File caches the Promise per path', () => {
  const rel = 'courses/race-sprint.course.json'
  assert.equal(loadCourseV1File(rel), loadCourseV1File(rel))
})

test('nodeGameAssets refuses an unknown id and lists the available ones', async () => {
  await assert.rejects(nodeGameAssets().resolve('candy.no-such'), e => isRefusal(e) && /\[assets\] candy\.no-such: unknown asset; available: .*candy\.spinner-bar/.test((e as Error).message))
  const r = await nodeGameAssets().resolve('penguin.body')
  assert.equal(r.source.path, 'assets/common/penguin.body.asset.json')
})
