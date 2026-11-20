import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
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

test('show scenes emit sparse stable identities and copied ownership metadata', async () => {
  const input = await inputOf('race-sprint')
  const show = { worldKind: 'show_field' as const, seatOf: [2, 40, 59], inputSlots: [7, -1, 1], humans: [true, false, true] }
  const emitted = emitEngineScene(engine, { ...input, show })
  assert.deepEqual(emitted.show, {
    worldKind: 'show_field',
    seats: show.seatOf.map((roomSeat, roundSeat) => ({ roomSeat, roundSeat, inputSlot: show.inputSlots[roundSeat], entity: emitted.seatEntities[roundSeat] })),
    ownership: emitted.seatEntities.map((entity, i) => ({ entity, zoneId: show.seatOf[i] + 1, owner: i, group: 0 })),
  })
  for (const [i, entity] of emitted.seatEntities.entries()) {
    assert.deepEqual(emitted.scene.entities[entity].components?.show_seat_identity,
      { room_seat: show.seatOf[i], round_seat: i, input_slot: show.inputSlots[i], bot: show.humans[i] ? 0 : 1 })
  }
  show.seatOf[0] = 3
  assert.equal(emitted.show?.seats[0].roomSeat, 2)
  const empty = emitEngineScene(engine, { ...input, show: { worldKind: 'show_hub', seatOf: [], inputSlots: [], humans: [] } })
  assert.deepEqual(empty.show, { worldKind: 'show_hub', seats: [], ownership: [] })
  assert.equal(Object.hasOwn(emitEngineScene(engine, input), 'show'), false)
})

test('the authored show_seat world loads all 60 zone identities with zero, one or two humans', async () => {
  const input = await inputOf('race-sprint')
  const layout = schemaLayout(engine)
  const seatOf = Array.from({ length: 60 }, (_, i) => i)
  for (const humanSeats of [[], [59], [2, 59]]) {
    const humans = seatOf.map(seat => humanSeats.includes(seat))
    const inputSlots = seatOf.map(seat => humans[seat] ? (seat === 59 ? 7 : 1) : -1)
    const emitted = emitEngineScene(engine, { ...input, show: { worldKind: 'show_seat', seatOf, inputSlots, humans } })
    assert.equal(emitted.show?.seats.length, 60)
    assert.equal(emitted.show.seats[59].roomSeat, 59)
    const world = engine.createWorld(emitted.text)
    try {
      const { components } = readWorldState(engine, world, layout)
      const identities = Object.entries(components.show_seat_identity)
      const roomSeats = new Set<number>()
      for (const [entity, identity] of identities) {
        const seat = identity.room_seat
        assert.ok(typeof seat === 'number' && seatOf.includes(seat))
        roomSeats.add(seat)
        assert.deepEqual(identity, { room_seat: seat, round_seat: seat, input_slot: inputSlots[seat], bot: humans[seat] ? 0 : 1 })
        assert.deepEqual(components['ege.zone.id'][entity], { id: seat + 1, owner: seat, group: 0 })
      }
      assert.equal(identities.length, 60)
      assert.equal(roomSeats.size, 60)
    } finally {
      engine.freeWorld(world)
    }
  }
})

test('show roster rejects malformed or conflicting mappings', async () => {
  const input = await inputOf('race-sprint')
  const cases: NonNullable<EmitInput['show']>[] = [
    { worldKind: 'show_seat', seatOf: [1], inputSlots: [], humans: [true] },
    { worldKind: 'show_seat', seatOf: [1, 1], inputSlots: [-1, -1], humans: [false, false] },
    { worldKind: 'show_seat', seatOf: [2, 1], inputSlots: [-1, -1], humans: [false, false] },
    { worldKind: 'show_seat', seatOf: [60], inputSlots: [-1], humans: [false] },
    { worldKind: 'show_field', seatOf: [1, 2], inputSlots: [3, 3], humans: [true, true] },
    { worldKind: 'show_field', seatOf: [1], inputSlots: [0], humans: [false] },
    { worldKind: 'show_field', seatOf: [1], inputSlots: [-1], humans: [true] },
    { worldKind: 'show_hub', seatOf: [1], inputSlots: [1], humans: [true] },
  ]
  for (const show of cases) assert.throws(() => buildEngineAssembly({ ...input, show }), RefusalError)
})
