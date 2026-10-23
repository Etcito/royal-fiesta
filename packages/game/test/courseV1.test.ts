import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { MOTION_KINDS } from '@royal-fiesta/sim/course'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import { fixtureResolver } from '../src/assets.ts'
import { canonicalJson, loadCourse } from '../src/course.ts'
import { MOTION_FIELDS, V0_ASSET_MAP, loadCourseV1, migrateCourseV0, podiumLayoutOf } from '../src/courseV1.ts'
import type { GameAssetResolver, MotionFieldType, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { AssetCategory, World } from '../src/gameAsset.ts'
import { collidersOf, parsePrims } from '../src/prims.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = (rel: string): Promise<string> => readFile(new URL(rel, ROOT), 'utf8')
const readJson = (rel: string): Record<string, any> => JSON.parse(readFileSync(new URL(rel, ROOT), 'utf8'))
const ID = { x: 0, y: 0, z: 0, w: 1 }
const ZERO = { x: 0, y: 0, z: 0 }

function sha256(doc: unknown): string {
  return createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex')
}

async function gameAsset(id: string, category: AssetCategory, collision: unknown[], world: World = 'candy'): Promise<ResolvedGameAsset> {
  const document = { nodes: [{ kind: 'box', size: [1, 1, 1] }], note: id }
  const json = {
    format: 'sdfm.game-asset', version: 1, game: 'royal-fiesta', id, name: id, category, world,
    mesher: { output: 'lowpoly' }, document, collision, anchors: {},
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, hash: sha256(document),
  }
  const source = { path: assetFilePath(world, id), json }
  return { asset: await parseGameAsset(json, source.path), source }
}

function resolverOf(list: readonly ResolvedGameAsset[]): GameAssetResolver & { calls: string[] } {
  const byId = new Map(list.map(a => [a.asset.id, a]))
  const calls: string[] = []
  return {
    calls,
    resolve(id: string): Promise<ResolvedGameAsset> {
      calls.push(id)
      const a = byId.get(id)
      if (!a) refuse('asset', `assets/${id}.asset.json`, `unknown asset '${id}'; add the asset file`)
      return Promise.resolve(a)
    },
  }
}

// The flat S3/S12 collider form of a ColliderSpec, so parseColliderJson gives it back exactly.
function flat(c: ColliderSpec): Record<string, unknown> {
  const t = [c.t.x, c.t.y, c.t.z]
  const r = [c.r.x, c.r.y, c.r.z, c.r.w]
  switch (c.shape) {
    case 'cuboid': return { shape: c.shape, half: [c.half.x, c.half.y, c.half.z], t, r }
    case 'roundCuboid': return { shape: c.shape, half: [c.half.x, c.half.y, c.half.z], border: c.border, t, r }
    case 'ball': return { shape: c.shape, radius: c.radius, t, r }
    default: return { shape: c.shape, halfHeight: c.halfHeight, radius: c.radius, t, r }
  }
}

// The named placeholders: every v0 prims fixture as a v1 asset with the prims collision.
async function placeholderAssets(): Promise<GameAssetResolver & { calls: string[] }> {
  const list: ResolvedGameAsset[] = []
  for (const [name, id] of Object.entries(V0_ASSET_MAP)) {
    const path = `fixtures/assets/${name}.prims.json`
    const prims = parsePrims(JSON.parse(await read(path)), path)
    let collision: unknown[] = []
    try { collision = collidersOf(prims, path).map(flat) } catch { collision = [] }
    list.push(await gameAsset(id, collision.length > 0 ? 'obstacle' : 'scenery', collision, name === 'bean' ? 'common' : 'candy'))
  }
  return resolverOf(list)
}

function obstacle(id: string, asset: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, asset, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1], friction: 0.5, motion: { kind: 'static' }, colliders: null, ...extra }
}

function v1Course(id: string, obstacles: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'royal-fiesta.course', version: 1, id, name: 'Test', world: 'candy', kind: 'gallery', profiles: ['standard', 'sprint'],
    timeLimitS: 60, killPlaneY: -12, spawns: Array.from({ length: 8 }, (_, i) => ({ t: [i, 1, 0], yawDeg: 0 })),
    checkpoints: [], finish: null, path: [], regions: [], queuePad: null, obstacles,
    decor: [], environment: null, podium: null, ...over,
  }
}

const coursePath = (id: string): string => `courses/${id}.course.json`

async function refused(p: Promise<unknown>, area: string, where: string, contains: string[] = []): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(isRefusal(e), `expected a RefusalError, got ${String(e)}`)
    assert.ok(e.message.startsWith(`[${area}] ${where}: `), `message ${JSON.stringify(e.message)} does not start with [${area}] ${where}`)
    assert.ok(e.message.includes('; '), 'message names the fix')
    for (const c of contains) assert.ok(e.message.includes(c), `message ${JSON.stringify(e.message)} lacks ${c}`)
    return true
  })
}

let shared: Promise<ResolvedGameAsset[]> | undefined
function basics(): Promise<ResolvedGameAsset[]> {
  shared ??= Promise.all([
    gameAsset('candy.block', 'obstacle', [{ shape: 'cuboid', half: [1, 0.5, 2] }]),
    gameAsset('candy.ball', 'obstacle', [{ shape: 'ball', radius: 0.5, t: [0, 1, 0] }]),
    gameAsset('candy.hollow', 'obstacle', []),
    gameAsset('candy.flower', 'scenery', []),
    gameAsset('candy.podium-block', 'prop', [{ shape: 'cuboid', half: [1, 1, 1] }]),
  ])
  return shared
}

test('V0_ASSET_MAP maps the 14 candy prims and bean', () => {
  assert.equal(Object.keys(V0_ASSET_MAP).length, 15)
  const names = readdirSync(new URL('fixtures/assets/', ROOT)).filter(f => f.endsWith('.prims.json')).map(f => f.slice(0, -'.prims.json'.length)).sort()
  assert.deepEqual(Object.keys(V0_ASSET_MAP).sort(), names)
  for (const n of names) assert.equal(V0_ASSET_MAP[n], n === 'bean' ? 'penguin.body' : `candy.${n}`)
})

test('migrateCourseV0 of race-sprint', () => {
  const path = 'fixtures/courses/race-sprint.course.json'
  const v0 = readJson(path)
  const before = structuredClone(v0)
  const v1 = migrateCourseV0(v0, path)
  assert.deepEqual(v0, before, 'the input is not mutated')
  assert.equal(v1.version, 1)
  assert.equal(v1.world, 'candy')
  assert.deepEqual(v1.decor, [])
  assert.equal(v1.environment, null)
  assert.equal(v1.podium, null)
  assert.equal(Object.hasOwn(v1, 'assetsManifest'), false)
  const obstacles = v1.obstacles as Record<string, unknown>[]
  assert.deepEqual(obstacles.map(o => o.asset), v0.obstacles.map((o: { asset: string }) => `candy.${o.asset}`))
  assert.deepEqual(obstacles.map(o => ({ ...o, asset: null })), v0.obstacles.map((o: object) => ({ ...o, asset: null })))
  for (const k of Object.keys(v0)) {
    if (!['version', 'assetsManifest', 'obstacles'].includes(k)) assert.deepEqual(v1[k], v0[k], k)
  }
  assert.deepEqual(Object.keys(v1).sort(), [...Object.keys(v0).filter(k => k !== 'assetsManifest'), 'world', 'decor', 'environment', 'podium'].sort())
})

test('migrateCourseV0 refuses a store manifest and an unmapped asset', async () => {
  const path = 'fixtures/courses/race-sprint.course.json'
  const withManifest = { ...readJson(path), assetsManifest: 'a'.repeat(64) }
  await refused(Promise.resolve().then(() => migrateCourseV0(withManifest, path)), 'course', `${path}#/assetsManifest`)
  const unmapped = readJson(path)
  unmapped.obstacles[2].asset = 'mystery-box'
  await refused(Promise.resolve().then(() => migrateCourseV0(unmapped, path)), 'course', `${path}#/obstacles/2/asset`, ['mystery-box'])
  await refused(Promise.resolve().then(() => migrateCourseV0({ ...readJson(path), version: 1 }, path)), 'course', `${path}#/version`)
})

test('loadCourseV1 of every v0 fixture equals loadCourse except contentHash and obstacles[].asset', async () => {
  const assets = await placeholderAssets()
  const v0Assets = fixtureResolver(read)
  const files = readdirSync(new URL('fixtures/courses/', ROOT)).filter(f => f.endsWith('.course.json')).sort()
  assert.ok(files.includes('race-sprint.course.json'))
  for (const f of files) {
    const path = `fixtures/courses/${f}`
    const json = readJson(path)
    const v0 = await loadCourse(json, path, v0Assets)
    const v1 = await loadCourseV1(json, path, assets)
    assert.ok(v1.sim, f)
    const { contentHash: h0, obstacles: o0, ...rest0 } = v0
    const { contentHash: h1, obstacles: o1, ...rest1 } = v1.sim
    assert.deepEqual(rest1, rest0, f)
    assert.deepEqual(o1.map(o => ({ ...o, asset: '' })), o0.map(o => ({ ...o, asset: '' })), f)
    assert.deepEqual(o1.map(o => o.asset), o0.map(o => V0_ASSET_MAP[o.asset]), f)
    assert.equal(h1, v1.contentHash)
    assert.notEqual(h1, h0, `${f}: the S13 hash differs from the v0 hash`)
    assert.equal(v1.world, 'candy')
    assert.deepEqual(v1.assetIds, [...new Set(o0.map(o => V0_ASSET_MAP[o.asset]))].sort())
  }
})

test('the asset collision is used, the course override wins, and s scales it', async () => {
  const assets = resolverOf(await basics())
  const c = await loadCourseV1(v1Course('t-collision', [obstacle('a', 'candy.block'), obstacle('b', 'candy.block', { colliders: [{ shape: 'ball', radius: 0.3 }] })]), coursePath('t-collision'), assets)
  const block = (await basics())[0].asset
  assert.deepEqual(c.sim?.obstacles[0].colliders, block.collision)
  assert.deepEqual(c.sim?.obstacles[0].colliders, [{ shape: 'cuboid', half: { x: 1, y: 0.5, z: 2 }, t: ZERO, r: ID }])
  assert.deepEqual(c.sim?.obstacles[1].colliders, [{ shape: 'ball', radius: 0.3, t: ZERO, r: ID }])
  assert.deepEqual(c.sim?.obstacles.map(o => o.asset), ['candy.block', 'candy.block'])

  const scaled = await loadCourseV1(v1Course('t-scale', [obstacle('a', 'candy.block', { s: [2, 2, 2] }), obstacle('b', 'candy.block', { s: [1, 3, 1] }), obstacle('c', 'candy.ball', { s: [2, 2, 2] })]), coursePath('t-scale'), assets)
  assert.deepEqual(scaled.sim?.obstacles[0].colliders, [{ shape: 'cuboid', half: { x: 2, y: 1, z: 4 }, t: ZERO, r: ID }])
  assert.deepEqual(scaled.sim?.obstacles[1].colliders, [{ shape: 'cuboid', half: { x: 1, y: 1.5, z: 2 }, t: ZERO, r: ID }])
  assert.deepEqual(scaled.sim?.obstacles[2].colliders, [{ shape: 'ball', radius: 1, t: { x: 0, y: 2, z: 0 }, r: ID }])

  await refused(loadCourseV1(v1Course('t-ball', [obstacle('a', 'candy.block'), obstacle('b', 'candy.ball', { s: [1, 2, 1] })]), coursePath('t-ball'), assets),
    'course', `${coursePath('t-ball')}#/obstacles/1/s`, ['non-uniform'])
})

test('contentHash mixes the asset hash and collision in obstacle order', async () => {
  const [block] = await basics()
  const other = await gameAsset('candy.block', 'obstacle', [{ shape: 'cuboid', half: [1, 0.5, 3] }])
  const json = v1Course('t-hash', [obstacle('a', 'candy.block', { colliders: [{ shape: 'ball', radius: 0.3 }] })])
  const a = await loadCourseV1(json, coursePath('t-hash'), resolverOf([block]))
  const b = await loadCourseV1(json, coursePath('t-hash'), resolverOf([other]))
  assert.deepEqual(a.sim?.obstacles, b.sim?.obstacles, 'the override decides the colliders')
  assert.notEqual(a.contentHash, b.contentHash, 'the asset collision is still part of the hash')
  const again = await loadCourseV1(structuredClone(json), coursePath('t-hash'), resolverOf([block]))
  assert.equal(again.contentHash, a.contentHash)
})

function podiumCourse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return v1Course('podium', [obstacle('block-1', 'candy.podium-block', { t: [0, 0.5, 0] }), obstacle('block-2', 'candy.podium-block', { t: [-2, 0.25, 0] })], {
    kind: 'podium', spawns: [],
    decor: [{ id: 'flower-1', asset: 'candy.flower', t: [3, 0, 1], r: [0, 0, 0, 1], s: [1, 1, 1] }],
    environment: { sky: 'candy-dusk', sun: { dir: [0, -1, 0], color: [1, 1, 1], intensity: 2 }, post: { bloom: 0.3 } },
    podium: {
      spots: [{ t: [0, 1, 0], yawDeg: 180 }, { t: [-2, 0.5, 0], yawDeg: 180 }, { t: [2, 0.25, 0], yawDeg: 180 }],
      camera: { eye: [0, 3, -8], target: [0, 1, 0], fovYDeg: 50 },
    },
    ...over,
  })
}

test('a podium course has sim null and a podium layout', async () => {
  const assets = resolverOf(await basics())
  const json = podiumCourse()
  const c = await loadCourseV1(json, coursePath('podium'), assets)
  assert.equal(c.kind, 'podium')
  assert.equal(c.sim, null)
  assert.deepEqual(c.assetIds, ['candy.flower', 'candy.podium-block'])
  assert.deepEqual(assets.calls, ['candy.podium-block', 'candy.podium-block', 'candy.flower'])
  assert.deepEqual(c.decor, [{ id: 'flower-1', asset: 'candy.flower', t: [3, 0, 1], r: [0, 0, 0, 1], s: [1, 1, 1] }])
  assert.equal(c.environment, json.environment, 'environment is passed through unchanged')
  assert.equal(typeof c.contentHash, 'number')
  assert.deepEqual(podiumLayoutOf(c), {
    courseId: 'podium',
    spots: [{ t: [0, 1, 0], yawDeg: 180 }, { t: [-2, 0.5, 0], yawDeg: 180 }, { t: [2, 0.25, 0], yawDeg: 180 }],
    camera: { eye: [0, 3, -8], target: [0, 1, 0], fovYDeg: 50, near: 0.1, far: 500 },
  })
  const race = await loadCourseV1(v1Course('t-gallery', [obstacle('a', 'candy.block')]), coursePath('t-gallery'), assets)
  await refused(Promise.resolve().then(() => podiumLayoutOf(race)), 'content', 'courses/t-gallery.course.json#/podium')
})

test('podium rules refuse', async () => {
  const assets = resolverOf(await basics())
  const p = coursePath('podium')
  const moving = podiumCourse()
  ;(moving.obstacles as Record<string, unknown>[])[1].motion = { kind: 'spinner', axis: [0, 1, 0], speedDegS: 90, phaseDeg: 0 }
  await refused(loadCourseV1(moving, p, assets), 'course', `${p}#/obstacles/1/motion/kind`)
  await refused(loadCourseV1(podiumCourse({ podium: null }), p, assets), 'course', `${p}#/podium`)
  const twoSpots = podiumCourse()
  ;(twoSpots.podium as { spots: unknown[] }).spots.pop()
  await refused(loadCourseV1(twoSpots, p, assets), 'course', `${p}#/podium/spots`)
  await refused(loadCourseV1(podiumCourse({ finish: { center: [0, 0, 0], half: [1, 1, 1] } }), p, assets), 'course', `${p}#/finish`)
  await refused(loadCourseV1(podiumCourse({ path: [{ p: [0, 0, 0], jump: false, dive: false }] }), p, assets), 'course', `${p}#/path`)
  const withPodium = v1Course('t-gallery', [obstacle('a', 'candy.block')], { podium: podiumCourse().podium })
  await refused(loadCourseV1(withPodium, coursePath('t-gallery'), assets), 'course', `${coursePath('t-gallery')}#/podium`)
})

test('an obstacle asset with an empty collision is refused unless the course overrides it', async () => {
  const assets = resolverOf(await basics())
  const p = coursePath('t-hollow')
  await refused(loadCourseV1(v1Course('t-hollow', [obstacle('a', 'candy.block'), obstacle('b', 'candy.hollow')]), p, assets),
    'course', `${p}#/obstacles/1/asset`, ['candy.hollow', 'empty collision'])
  const ok = await loadCourseV1(v1Course('t-hollow', [obstacle('b', 'candy.hollow', { colliders: [{ shape: 'cuboid', half: [1, 1, 1] }] })]), p, assets)
  assert.equal(ok.sim?.obstacles[0].colliders.length, 1)
})

test('S13 refusals name file#pointer and a fix', async () => {
  const assets = resolverOf(await basics())
  const p = coursePath('t-bad')
  const bad = (obstacles: unknown[], over: Record<string, unknown> = {}): Promise<unknown> => loadCourseV1(v1Course('t-bad', obstacles, over), p, assets)
  const block = [obstacle('a', 'candy.block')]
  await refused(bad(block, { assetsManifest: null }), 'course', `${p}#/assetsManifest`, ['v1 courses have no assetsManifest'])
  await refused(bad(block, { extra: 1 }), 'course', `${p}#/extra`)
  await refused(bad(block, { world: 'lava' }), 'course', `${p}#/world`)
  await refused(bad(block, { kind: 'arena' }), 'course', `${p}#/kind`)
  await refused(bad([obstacle('a', 'candy.missing')]), 'course', `${p}#/obstacles/0/asset`, ['candy.missing'])
  await refused(bad([obstacle('a', 'floor-tile')]), 'course', `${p}#/obstacles/0/asset`)
  await refused(bad(block, { decor: [{ id: 'd', asset: 'candy.nope', t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }] }), 'course', `${p}#/decor/0/asset`, ['candy.nope'])
  await refused(bad(block, { decor: [{ id: 'a', asset: 'candy.flower', t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }] }), 'course', `${p}#/decor/0/id`)
  await refused(bad(block, { decor: [{ id: 'd', asset: 'candy.flower', t: [0, 0, 0], r: [0, 0, 0, 2], s: [1, 1, 1] }] }), 'course', `${p}#/decor/0/r`)
  await refused(bad(block, { decor: [{ id: 'd', asset: 'candy.flower', t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 0, 1] }] }), 'course', `${p}#/decor/0/s`)
  await refused(bad(block, { environment: { weather: 'rain' } }), 'course', `${p}#/environment/weather`)
  await refused(bad(block, { environment: { sun: { dir: [0, -1, 0], color: [1, 1, 1] } } }), 'course', `${p}#/environment/sun/intensity`)
  const noDecor = v1Course('t-bad', block)
  delete noDecor.decor
  await refused(loadCourseV1(noDecor, p, assets), 'course', `${p}#/decor`)
})

function sampleValue(t: MotionFieldType): unknown {
  if (t === 'number') return 1
  if (t === 'vec3') return [0, 1, 0]
  return t.enum[0]
}

test('MOTION_FIELDS: exactly the S2 keys of every motion kind', async () => {
  assert.deepEqual(Object.keys(MOTION_FIELDS).sort(), [...MOTION_KINDS].sort())
  const assets = resolverOf(await basics())
  const p = coursePath('t-motion')
  for (const kind of MOTION_KINDS) {
    const motion: Record<string, unknown> = { kind }
    for (const [k, t] of Object.entries(MOTION_FIELDS[kind])) motion[k] = sampleValue(t)
    const load = (m: Record<string, unknown>): Promise<unknown> => loadCourseV1(v1Course('t-motion', [obstacle('a', 'candy.block', { motion: m })]), p, assets)
    const c = await load(motion) as { sim: { obstacles: { motion: { kind: string } }[] } }
    assert.equal(c.sim.obstacles[0].motion.kind, kind)
    await refused(load({ ...motion, extra: 1 }), 'course', `${p}#/obstacles/0/motion/extra`, ['unknown key'])
    const missing = Object.keys(MOTION_FIELDS[kind])[0] ?? 'kind'
    const fewer = { ...motion }
    delete fewer[missing]
    await refused(load(fewer), 'course', `${p}#/obstacles/0/motion/${missing}`)
  }
})

test('courseV1.ts imports no MAMA, raa-sdfm or app code (rule 1.5)', () => {
  const src = readFileSync(new URL('packages/game/src/courseV1.ts', ROOT), 'utf8')
  const specifiers = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1])
  assert.ok(specifiers.length > 0)
  for (const s of specifiers) assert.doesNotMatch(s, /mama|raa-sdfm|apps\//i, s)
  assert.doesNotMatch(src, /import\(/)
})
