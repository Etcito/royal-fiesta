import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V0_ASSET_MAP } from '@royal-fiesta/game/courseV1'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { loadAllCoursesV1, loadCourseV1File, nodeGameAssets, v1Playlist } from '../src/contentFiles.ts'
import { loadCourseFile } from '../src/files.ts'
import { isAuthored, readAuthored } from '../../../tools/authored.ts'
import { repoRoot } from '../../../tools/bricks.ts'

test('loadAllCoursesV1 loads every course on disk sorted by id', async () => {
  const onDisk = readdirSync(join(repoRoot(), 'courses'))
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
  const root = repoRoot()
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
