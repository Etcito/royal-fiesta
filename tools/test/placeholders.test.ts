import { contentPath } from '../content.ts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { loadCourseV1, V0_ASSET_MAP } from '../../packages/game/src/courseV1.ts'
import type { GameAssetResolver } from '../../packages/game/src/courseV1.ts'
import { parseGameAsset } from '../../packages/game/src/gameAsset.ts'
import type { GameAsset, GameAssetSource } from '../../packages/game/src/gameAsset.ts'
import { collidersOf, parsePrims } from '../../packages/game/src/prims.ts'
import { readAuthored } from '../authored.ts'
import { repoRoot } from '../bricks.ts'
import { buildContent } from '../placeholders.ts'

const root = repoRoot()
const readJson = (rel: string): unknown => JSON.parse(readFileSync(contentPath(rel, root), 'utf8'))
const filesIn = (dir: string, suffix: string): string[] =>
  readdirSync(contentPath(dir, root), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesIn(`${dir}/${e.name}`, suffix) : e.name.endsWith(suffix) ? [`${dir}/${e.name}`] : [])

async function loadAssets(): Promise<Map<string, { asset: GameAsset; source: GameAssetSource; world: string; path: string }>> {
  const out = new Map<string, { asset: GameAsset; source: GameAssetSource; world: string; path: string }>()
  for (const path of filesIn('assets', '.asset.json').sort()) {
    const json = readJson(path)
    const asset = await parseGameAsset(json, path)
    out.set(asset.id, { asset, source: { path, json }, world: path.split('/')[1], path })
  }
  return out
}

test('buildContent equals the files on disk', async () => {
  const authored = readAuthored(root)
  const built = await buildContent(authored)
  const disk = [...filesIn('assets', '.asset.json'), ...filesIn('courses', '.course.json')].sort()
  const builtKeys = [...built.keys()]
  assert.deepEqual([...builtKeys, ...authored.files].sort(), disk)
  for (const f of authored.files) {
    assert.ok(!built.has(f), `${f} is both built and authored`)
    assert.ok(disk.includes(f), `authored file missing on disk: ${f}`)
  }
  for (const [path, text] of built) assert.equal(readFileSync(contentPath(path, root), 'utf8'), text, path)
})

test('assets parse, match their stem and world, and keep the prims collision', async () => {
  const assets = await loadAssets()
  const generated = [...new Set([...Object.values(V0_ASSET_MAP), 'penguin.body', 'candy.podium-block'])]
  assert.equal(generated.length, 16)
  assert.ok(assets.size >= 16)
  for (const id of generated) assert.ok(assets.has(id), `missing asset ${id}`)
  for (const [id, a] of assets) {
    assert.equal(a.path.split('/').pop(), `${id}.asset.json`)
    assert.equal(a.world, a.asset.world)
  }
  for (const [name, id] of Object.entries(V0_ASSET_MAP)) {
    const rel = `fixtures/assets/${name}.prims.json`
    const prims = parsePrims(readJson(rel), rel)
    assert.deepEqual(assets.get(id)?.asset.collision, collidersOf(prims, rel), id)
  }
  assert.equal(assets.get('penguin.body')?.world, 'common')
  assert.deepEqual(assets.get('candy.podium-block')?.asset.collision.length, 1)
})

test('courses load through an in-memory asset source', async () => {
  const assets = await loadAssets()
  const resolver: GameAssetResolver = {
    async resolve(id) {
      const a = assets.get(id)
      if (!a) throw new Error(`no asset ${id}`)
      return { asset: a.asset, source: a.source }
    },
  }
  const paths = filesIn('courses', '.course.json')
  assert.ok(paths.length >= 9)
  for (const id of ['hub-plaza', 'obstacle-gallery', 'podium', 'race-bean-dash', 'race-hammer-hill', 'race-sprint',
    'survival-hammer-ring', 'survival-spin-zone', 'survival-sprint']) assert.ok(paths.includes(`courses/${id}.course.json`), id)
  const loaded = new Map<string, Awaited<ReturnType<typeof loadCourseV1>>>()
  for (const path of paths) {
    const c = await loadCourseV1(readJson(path), path, resolver)
    assert.equal(`courses/${c.id}.course.json`, path)
    loaded.set(c.id, c)
  }
  assert.equal(loaded.get('hub-plaza')?.kind, 'hub')
  const podium = loaded.get('podium')
  assert.equal(podium?.kind, 'podium')
  assert.equal(podium?.sim, null)
  assert.equal(podium?.podium?.spots.length, 3)
})
