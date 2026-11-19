import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { CAPSULE } from '../../sim/src/character/capsule.ts'
import { seatSpawn } from '../../sim/src/zones/seatSpawn.ts'
import { assetColliders, engineColliders } from '../src/ege/colliders.ts'
import { buildEngineAssembly, emitEngineScene } from '../src/ege/sceneEmitter.ts'
import type { EmitInput } from '../src/ege/sceneEmitter.ts'
import {
  FEATURE_EMITTERS,
  FEATURE_KIND_RANK,
  featureSalt,
  featureSnake,
  tintColor,
  visualOf,
} from '../src/ege/featureEmitters.ts'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'

const ROOT = new URL('../../../', import.meta.url)
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
const assets: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = readJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}
const engine = await loadEngine()
engine.setSchema(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))

async function inputOf(id: string): Promise<EmitInput> {
  const path = `courses/${id}.course.json`
  const course = await loadCourseV1(readJson(path), path, assets)
  assert.ok(course.sim)
  const resolved = new Map<string, ResolvedGameAsset>()
  for (const assetId of course.assetIds) resolved.set(assetId, await assets.resolve(assetId))
  return { course, assets: resolved, setup: { profile: 'sprint', seed: 7 } }
}

const AT = { x: 0, y: 0, z: 0 }
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }

test('a cuboid and a roundCuboid map to the exact halfExtents', () => {
  const list: ColliderSpec[] = [
    { shape: 'cuboid', half: { x: 1, y: 2, z: 3 }, t: { x: 4, y: 5, z: 6 }, r: IDENTITY },
    { shape: 'roundCuboid', half: { x: 1, y: 2, z: 3 }, border: 0.5, t: AT, r: IDENTITY },
  ]
  const out = engineColliders(list, 'courses/x.course.json#/obstacles/3/colliders')
  assert.deepEqual(out[0].halfExtents, [1, 2, 3])
  assert.deepEqual(out[0].t, [4, 5, 6])
  assert.deepEqual(out[1].halfExtents, [1.5, 2.5, 3.5])
})

test('ball, capsule and cylinder fields carry over', () => {
  const out = engineColliders([
    { shape: 'ball', radius: 2, t: AT, r: IDENTITY },
    { shape: 'capsule', radius: 1, halfHeight: 3, t: AT, r: IDENTITY },
    { shape: 'cylinder', radius: 4, halfHeight: 5, t: AT, r: IDENTITY },
  ], 'p')
  assert.deepEqual(out[0], { shape: 'ball', radius: 2, t: [0, 0, 0], r: [0, 0, 0, 1] })
  assert.deepEqual(out[1], { shape: 'capsule', radius: 1, halfHeight: 3, t: [0, 0, 0], r: [0, 0, 0, 1] })
  assert.deepEqual(out[2], { shape: 'cylinder', radius: 4, halfHeight: 5, t: [0, 0, 0], r: [0, 0, 0, 1] })
})

test('a cone is refused at its pointer', () => {
  const list: ColliderSpec[] = [
    { shape: 'cuboid', half: { x: 1, y: 1, z: 1 }, t: AT, r: IDENTITY },
    { shape: 'cone', radius: 1, halfHeight: 2, t: AT, r: IDENTITY },
  ]
  assert.throws(
    () => engineColliders(list, 'courses/x.course.json#/obstacles/3/colliders'),
    (e: unknown) => e instanceof RefusalError &&
      e.message === "[ege-scene] courses/x.course.json#/obstacles/3/colliders/1/shape: shape 'cone' has no engine collider (cuboid, roundCuboid, ball, capsule, cylinder); use one of those shapes in the asset's collision",
  )
})

test('assetColliders accepts the halfExtents alias and the params form', () => {
  const out = assetColliders([
    { shape: 'cuboid', halfExtents: [1, 2, 3] },
    { shape: 'ball', params: { radius: 2 } },
    { shape: 'roundCuboid', params: { halfExtents: [1, 1, 1], borderRadius: 0.25 } },
  ], 'asset#/collision')
  assert.deepEqual(out[0].halfExtents, [1, 2, 3])
  assert.equal(out[1].shape, 'ball')
  assert.equal(out[1].radius, 2)
  assert.deepEqual(out[2].halfExtents, [1.25, 1.25, 1.25])
})

test('feature snake names and salts follow the E3/E4 tables', () => {
  assert.equal(featureSnake('boostLane'), 'boost_lane')
  assert.equal(featureSalt(3), 0x103)
})

test('visualOf maps a draw asset to its engine shape, params and colour', () => {
  assert.deepEqual(visualOf('candy.floor-tile', { x: 2, y: 1, z: 4 }),
    { shape: 1, params: [1, 0.5, 2, 0], color: 0xF5D0E0 })
})

test('tint 2 is the palette blue and the registry holds only known kinds', () => {
  assert.equal(tintColor(2, 0), 0x54BAFF)
  assert.ok(Object.keys(FEATURE_EMITTERS).every((kind) => Object.hasOwn(FEATURE_KIND_RANK, kind)))
})

test('race-sprint emits eight capsule seats and sprint round state', async () => {
  const input = await inputOf('race-sprint')
  const emitted = emitEngineScene(engine, input)
  const sim = input.course.sim
  assert.ok(sim)
  assert.equal(emitted.seatEntities.length, 8)
  for (let i = 0; i < 8; i++) {
    const entity = emitted.scene.entities[emitted.seatEntities[i]]
    const collider = entity.colliders?.[0]
    const spawn: { x: number; y: number; z: number } = seatSpawn(sim, i).t
    assert.equal(collider?.shape, 'capsule')
    assert.equal(collider?.radius, CAPSULE.radius)
    assert.equal(collider?.half_height, CAPSULE.halfHeight)
    assert.deepEqual(entity.components?.['ege.transform']?.pos, [spawn.x, spawn.y, spawn.z])
  }
  assert.equal(emitted.scene.resources?.round?.intro_ticks, 60)
  assert.equal(emitted.scene.resources?.round?.ended_tick, -1)
})

test('race-sprint, survival-sprint and hub-plaza create engine worlds', async () => {
  for (const id of ['race-sprint', 'survival-sprint', 'hub-plaza']) {
    const emitted = emitEngineScene(engine, await inputOf(id))
    assert.ok(engine.createWorld(emitted.text) >= 1, id)
  }
})

test('building an assembly refuses a course without a simulation part', async () => {
  const input = await inputOf('race-sprint')
  const course: CourseV1 = { ...input.course, sim: null }
  assert.throws(
    () => buildEngineAssembly({ ...input, course }),
    (error: unknown) => error instanceof RefusalError &&
      error.message === '[ege-scene] courses/race-sprint.course.json: the course has no simulation part (kind race); pass a race, survival, hub or gallery course',
  )
})

test('movers expose their course surface and item body entities are indexed', async () => {
  const input = await inputOf('race-sprint')
  const emitted = emitEngineScene(engine, input)
  assert.ok(input.course.sim)
  assert.equal(emitted.obstacleEntities.length, input.course.sim.obstacles.length)
  for (let i = 0; i < emitted.obstacleEntities.length; i++) {
    const entity = emitted.scene.entities[emitted.obstacleEntities[i]]
    assert.equal(entity.components?.surface?.obstacle, i)
  }
  const expected = input.course.sim.mechanisms?.items ?? []
  assert.equal(emitted.itemBodies.size, expected.reduce((sum, item) => sum + item.bodies.length, 0))
  for (const item of expected) for (const body of item.bodies) {
    const key = `${item.id}/${body.id}`
    assert.ok(key.startsWith(`${item.id}/`))
    assert.equal(emitted.itemBodies.get(key), emitted.index(key))
  }
  assert.ok(engine.createWorld(emitted.text) >= 1)
})

test('a course cone collider is refused at its course pointer', async () => {
  const json = readJson('courses/race-sprint.course.json') as { obstacles: { colliders: unknown; s: number[] }[] }
  json.obstacles[3].colliders = [{ shape: 'cone', radius: 0.5, halfHeight: 0.5 }]
  json.obstacles[3].s = [1, 1, 1]
  const path = 'courses/race-sprint.course.json'
  const course = await loadCourseV1(json, path, assets)
  const resolved = new Map<string, ResolvedGameAsset>()
  for (const assetId of course.assetIds) resolved.set(assetId, await assets.resolve(assetId))
  assert.throws(
    () => buildEngineAssembly({ course, assets: resolved, setup: { profile: 'sprint', seed: 7 } }),
    (error: unknown) => error instanceof RefusalError &&
      error.message.startsWith("[ege-scene] courses/race-sprint.course.json#/obstacles/3/colliders/0/shape: shape 'cone' has no engine collider"),
  )
})

test('a course feature kind without a registered emitter is refused', async () => {
  const input = await inputOf('s1-e-sugar-sprint')
  assert.ok(input.course.sim)
  const course = structuredClone(input.course)
  course.sim!.features![0].kind = 'notAKind'
  assert.throws(
    () => buildEngineAssembly({ ...input, course }),
    (error: unknown) => error instanceof RefusalError &&
      error.message === `[ege-scene] courses/s1-e-sugar-sprint.course.json#/features/0/kind: feature kind 'notAKind' has no engine emitter; registered: ${Object.keys(FEATURE_EMITTERS).sort().join(', ')}`,
  )
})
