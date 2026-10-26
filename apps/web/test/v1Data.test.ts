// V1 browser data without Vite: the pure stand-in core and the course dressing on a NullRenderPort.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonicalJson } from '@royal-fiesta/game/course'
import type { CourseV1, DecorItem } from '@royal-fiesta/game/courseV1'
import { assetFilePath, parseGameAsset } from '@royal-fiesta/game/gameAsset'
import type { GameAsset, World } from '@royal-fiesta/game/gameAsset'
import { parsePrims } from '@royal-fiesta/game/prims'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { browserGameAssets, loadV1Courses, standInFrom, v1Dressing } from '../src/content/v1Data.ts'

function sha256(doc: unknown): string {
  return createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex')
}

async function gameAsset(id: string, bounds: { min: number[]; max: number[] }, world: World = 'candy'): Promise<GameAsset> {
  const document = { nodes: [{ kind: 'box', size: [1, 1, 1] }], note: id }
  const json = {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta', id, name: `Asset ${id}`, category: 'prop', world,
    mesher: { output: 'lowpoly' }, document, collision: [], anchors: {}, bounds, hash: sha256(document),
  }
  return parseGameAsset(json, assetFilePath(world, id))
}

function course(id: string, decor: DecorItem[], environment: Record<string, unknown> | null): CourseV1 {
  return { id, name: id, kind: 'gallery', world: 'candy', decor, environment, podium: null, sim: null, assetIds: [...new Set(decor.map(d => d.asset))].sort(), contentHash: 0, json: {} }
}

function initPort(): NullRenderPort {
  const port = new NullRenderPort()
  void port.init({ canvas: null, width: 64, height: 64, viewports: [{ x: 0, y: 0, width: 64, height: 64 }] })
  return port
}

test('standInFrom with a v0 prims keeps it under the asset id', async () => {
  const path = 'fixtures/assets/spinner-bar.prims.json'
  const v0 = parsePrims(JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')), path)
  const asset = await gameAsset('candy.spinner-bar', { min: [-1, -1, -1], max: [1, 1, 1] })
  const s = standInFrom(asset, v0)
  assert.equal(s.id, 'candy.spinner-bar')
  assert.equal(s.name, `${v0.name} (dev stand-in)`)
  assert.deepEqual(s.nodes, v0.nodes)
  assert.deepEqual(s.materials, v0.materials)
  assert.equal(v0.id, 'spinner-bar', 'the input prims is not mutated')
  assert.deepEqual(parsePrims(JSON.parse(JSON.stringify(s)), 'stand-in'), s)
})

test('standInFrom without a v0 prims is a roundBox filling the bounds', async () => {
  const asset = await gameAsset('candy.lolly-tree', { min: [-1, 0, -0.5], max: [3, 4, 0.5] })
  const s = standInFrom(asset, null)
  assert.equal(s.id, 'candy.lolly-tree')
  assert.equal(s.name, 'Asset candy.lolly-tree (dev stand-in)')
  assert.equal(s.nodes.length, 1)
  const [node] = s.nodes
  assert.equal(node.kind, 'roundBox')
  assert.deepEqual(node.params.size, [4, 4, 1])
  assert.deepEqual(node.transform.t, [1, 2, 0])
  const radius = node.params.radius as number
  assert.ok(radius > 0 && radius < 0.5, `small radius, got ${radius}`)
  assert.deepEqual(Object.keys(s.materials), [node.material])
  assert.deepEqual(s.collision.colliders, [])
  assert.deepEqual(parsePrims(JSON.parse(JSON.stringify(s)), 'stand-in'), s)
})

test('v1Dressing creates one instance per decor item, passes the environment and leave destroys them', async () => {
  const tree = await gameAsset('candy.lolly-tree', { min: [-1, 0, -1], max: [1, 3, 1] })
  const rock = await gameAsset('candy.gum-rock', { min: [-1, 0, -1], max: [1, 1, 1] })
  const assets = new Map([[tree.id, tree], [rock.id, rock]])
  const asked: string[] = []
  const prims = (id: string): PrimsAsset => {
    asked.push(id)
    const a = assets.get(id)
    assert.ok(a, `asset ${id}`)
    return standInFrom(a, null)
  }
  const environment = { sky: 'candy-dusk', sun: { dir: [0, -1, 0.3], color: [1, 0.9, 0.8], intensity: 2 } }
  const decor: DecorItem[] = [
    { id: 'tree-a', asset: 'candy.lolly-tree', t: [0, 0, 5], r: [0, 0, 0, 1], s: [1, 1, 1] },
    { id: 'tree-b', asset: 'candy.lolly-tree', t: [4, 0, 9], r: [0, 0.7071068, 0, 0.7071068], s: [2, 2, 2] },
    { id: 'rock', asset: 'candy.gum-rock', t: [-3, 0, 2], r: [0, 0, 0, 1], s: [1, 0.5, 1] },
  ]
  const dressing = v1Dressing([course('gallery-a', decor, environment), course('plain', [], null)], prims)
  const port = initPort()

  dressing.enter(port, 'gallery-a')
  assert.deepEqual(asked, ['candy.lolly-tree', 'candy.gum-rock'], 'each decor asset is registered once')
  assert.equal(port.calls.registerAsset, 2)
  assert.equal(port.calls.createInstance, 3)
  assert.equal(port.calls.setTransform, 3)
  assert.equal(port.render().instances, 3)
  assert.deepEqual(port.lastEnvironment, environment)

  dressing.leave(port)
  assert.equal(port.render().instances, 0)

  dressing.enter(port, 'plain')
  assert.equal(port.lastEnvironment, null)
  assert.equal(port.render().instances, 0)
  dressing.leave(port)
})

test('v1Dressing.enter refuses an unknown course id', () => {
  const dressing = v1Dressing([course('plain', [], null)], () => assert.fail('no asset is asked'))
  const port = initPort()
  assert.throws(() => dressing.enter(port, 'nope'), (e: unknown) => {
    assert.ok(e instanceof RefusalError)
    assert.match(e.message, /^\[content\] courses\/nope\.course\.json: .*plain/)
    return true
  })
})

// Runtime resolution is exercised in Node with HTTP stubbed, without a Vite build.
function assetJson(asset: GameAsset): unknown {
  const { min, max } = asset.bounds
  return { ...asset, bounds: { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] } }
}

function runtime(files: Record<string, unknown>) {
  const requests: { url: string; cache: RequestCache | undefined }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, cache: init?.cache })
    const value = files[url.replace('https://content.example/', '')]
    return new Response(JSON.stringify(value), { status: value === undefined ? 404 : 200 })
  }
  return { options: { root: 'https://content.example', fetch: fetcher }, requests }
}

test('runtime resolves on demand, caches within the page and revalidates every request', async () => {
  const asset = await gameAsset('candy.test', { min: [-1, -1, -1], max: [1, 1, 1] })
  const path = 'assets/candy/candy.test.asset.json'
  const stub = runtime({ 'index.json': { assets: [{ id: asset.id, world: 'candy', path, hash: asset.hash }], courses: [] }, [path]: assetJson(asset) })
  const resolver = browserGameAssets(stub.options)
  assert.equal(stub.requests.length, 0)
  assert.equal((await resolver.resolve(asset.id)).asset.hash, asset.hash)
  await resolver.resolve(asset.id)
  assert.equal(stub.requests.length, 2)
  assert.ok(stub.requests.every(r => r.cache === 'no-cache'))
  assert.equal((await browserGameAssets(stub.options).resolve(asset.id)).asset.hash, asset.hash)
  assert.equal(stub.requests.length, 4)
})

test('runtime unknown and duplicate ids preserve the refusals', async () => {
  const entry = { id: 'candy.test', world: 'candy', path: 'assets/candy/candy.test.asset.json', hash: '' }
  const unknown = runtime({ 'index.json': { assets: [entry], courses: [] } })
  await assert.rejects(browserGameAssets(unknown.options).resolve('missing'), /unknown asset id 'missing'; add the asset file or use one of: candy.test/)
  const duplicate = runtime({ 'index.json': { assets: [entry, { ...entry, path: 'assets/common/candy.test.asset.json' }], courses: [] } })
  await assert.rejects(browserGameAssets(duplicate.options).resolve(entry.id), /asset id 'candy.test' is also assets\/candy\/candy.test.asset.json; ids are unique across assets\/, rename one/)
  assert.equal(duplicate.requests.length, 1)
})

test('runtime refuses asset id and world mismatches against the file path', async () => {
  const asset = await gameAsset('candy.test', { min: [-1, -1, -1], max: [1, 1, 1] })
  for (const [id, path, reason] of [
    ['candy.other', 'assets/candy/candy.other.asset.json', /id 'candy.test' does not match the file stem 'candy.other'/],
    ['candy.test', 'assets/common/candy.test.asset.json', /world 'candy' does not match the folder 'common'/],
  ] as const) {
    const stub = runtime({ 'index.json': { assets: [{ id, world: 'candy', path, hash: asset.hash }], courses: [] }, [path]: assetJson(asset) })
    await assert.rejects(browserGameAssets(stub.options).resolve(id), reason)
  }
})

test('runtime courses fetch the index and course with no-cache and preserve parse errors', async () => {
  const stub = runtime({ 'index.json': { assets: [], courses: [{ id: 'bad', path: 'courses/bad.course.json' }] }, 'courses/bad.course.json': {} })
  await assert.rejects(loadV1Courses(() => {}, stub.options), (error: unknown) => error instanceof RefusalError && error.area === 'course' && error.path.startsWith('courses/bad.course.json'))
  assert.equal(stub.requests.length, 2)
  assert.ok(stub.requests.every(r => r.cache === 'no-cache'))
})
