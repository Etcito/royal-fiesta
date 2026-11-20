import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import { EngineDomainFactory } from '@etcito/game-engine/zones'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ColliderSpec } from '@royal-fiesta/sim/course'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { CAPSULE } from '../../sim/src/character/capsule.ts'
import { seatSpawn } from '../../sim/src/zones/seatSpawn.ts'
import { assetColliders, engineColliders } from '../src/ege/colliders.ts'
import {
  buildEngineAssembly,
  emitEngineScene,
  isShowMembershipZoneId,
  isShowPublishZoneId,
  showMembershipZone,
  showPublishZone,
  showSceneOwnership,
  showSeatChildZone,
  showSeatZone,
  SHOW_CONTROL_NEUTRAL,
  SHOW_MEMBERSHIP_FEATURE_LAST,
  SHOW_MEMBERSHIP_SEAT_STRIDE,
  SHOW_MEMBERSHIP_ZONE_FIRST,
  SHOW_MEMBERSHIP_ZONE_LAST,
  SHOW_PUBLISH_FIELD_COUNT,
  SHOW_PUBLISH_STRIDE,
  SHOW_PUBLISH_ZONE_FIRST,
  SHOW_PUBLISH_ZONE_LAST,
  SHOW_SEAT_CHILD_ZONE_FIRST,
  SHOW_SEAT_CHILD_ZONE_LAST,
  SHOW_TEAM_ZONE_FIRST,
} from '../src/ege/sceneEmitter.ts'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'
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

function zoneRowsOf(scene: { entities: readonly { components?: Record<string, Record<string, unknown>> }[] }) {
  return scene.entities.flatMap((row, entity) => {
    const zone = row.components?.['ege.zone.id']
    if (!zone) return []
    const owner = zone.owner as number
    return [{ entity, zoneId: zone.id as number, owner: owner === 0xffff ? null : owner, group: zone.group as number }]
  })
}

test('show scenes emit sparse stable identities and copied ownership metadata', async () => {
  const input = await inputOf('race-sprint')
  const show = { worldKind: 'show_field' as const, seatOf: [2, 40, 59], inputSlots: [7, -1, 1], humans: [true, false, true] }
  const emitted = emitEngineScene(engine, { ...input, show })
  assert.deepEqual(emitted.show, {
    worldKind: 'show_field',
    seats: show.seatOf.map((roomSeat, roundSeat) => ({ roomSeat, roundSeat, inputSlot: show.inputSlots[roundSeat], entity: emitted.seatEntities[roundSeat] })),
    ownership: zoneRowsOf(emitted.scene),
  })
  assert.deepEqual(emitted.show?.ownership, showSceneOwnership(emitted.scene, show.seatOf, input.course.sim!.features?.length ?? 0))
  // The seat anchors stay the first ownership rows; every attached child and cumulative publisher follows its anchor.
  const anchored = show.seatOf.map((roomSeat, roundSeat) => ({ entity: emitted.seatEntities[roundSeat], zoneId: roomSeat + 1, owner: roundSeat, group: roomSeat + 1 }))
  assert.deepEqual(emitted.show?.ownership.slice(0, anchored.length), anchored)
  for (const [i, entity] of emitted.seatEntities.entries()) {
    const seat = emitted.scene.entities[entity]
    assert.deepEqual(seat.components?.show_seat_identity,
      { room_seat: show.seatOf[i], round_seat: i, input_slot: show.inputSlots[i], bot: show.humans[i] ? 0 : 1 })
    // Explicit neutral control: a raw zero would decode as a full diagonal (-1,-1), not standstill.
    assert.deepEqual(seat.components?.show_control, { code: SHOW_CONTROL_NEUTRAL })
    const child = emitted.scene.entities[emitted.index(`show/seat/${i}`)]
    assert.deepEqual(child.components?.['ege.zone.id'], showSeatChildZone(show.seatOf[i], i))
    assert.deepEqual(child.components?.show_character_ref, { owner: entity, target: 0xffffffff, lever: 0xffffffff, carry: 0xffffffff })
    if (show.humans[i]) {
      assert.equal(child.components?.bot_memory, undefined)
      assert.equal(child.components?.bot_route, undefined)
    } else {
      assert.deepEqual(child.components?.bot_memory, {
        owner: entity, rng_state: 7, ticks: 0, wait_ticks: 0, path_index: 0, stuck_ticks: 0, last_x: 0, last_z: 0, wobble: 0,
      })
      assert.deepEqual(child.components?.bot_route, {
        owner: entity, preference: 0, seed: 0, plan_tick: -1, next_plan_tick: 0, cost: 0, reachable: 0,
        region_count: 0, edge_count: 0, waypoint_count: 0,
      })
    }
    for (let field = 0; field < SHOW_PUBLISH_FIELD_COUNT; field++) {
      const publisher = emitted.scene.entities[emitted.index(`show/publish/${i}/${field}`)]
      assert.deepEqual(publisher.components?.['ege.zone.id'], showPublishZone(show.seatOf[i], field, i))
    }
  }
  // No feature is zoned: authored feature data is reconstructed from the scene in every island.
  for (const feature of emitted.featureEntities) assert.equal(emitted.scene.entities[feature].components?.['ege.zone.id'], undefined)
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
        assert.deepEqual(components['ege.zone.id'][entity], { id: seat + 1, owner: seat, group: seat + 1 })
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

test('membership zone ids follow the reserved allocation with checked boundaries', () => {
  assert.equal(SHOW_MEMBERSHIP_ZONE_FIRST, 0x40000000)
  assert.equal(SHOW_MEMBERSHIP_ZONE_LAST, 0x7fffffff)
  assert.equal(SHOW_MEMBERSHIP_SEAT_STRIDE, 64)
  assert.equal(SHOW_MEMBERSHIP_FEATURE_LAST, 16777215)
  assert.deepEqual(showMembershipZone(0, 0, 0), { id: 0x40000000, owner: 0, group: 1 })
  assert.deepEqual(showMembershipZone(2, 59, 2), { id: 0x40000000 + 2 * 64 + 59, owner: 2, group: 60 })
  const last = showMembershipZone(16777215, 59, 59)
  assert.deepEqual(last, { id: 0x7ffffffb, owner: 59, group: 60 })
  assert.ok(isShowMembershipZoneId(last.id))
  // Adjacent features never overlap: the last seat of one feature sits below the first seat of the next.
  assert.ok(showMembershipZone(7, 59, 0).id < showMembershipZone(8, 0, 0).id)
  assert.deepEqual(showSeatZone(59, 2), { id: 60, owner: 2, group: 60 })
  assert.equal(isShowMembershipZoneId(0x3fffffff), false)
  assert.equal(isShowMembershipZoneId(0x80000000), false)
  assert.equal(isShowMembershipZoneId(65536 + 59 * 32 + 18), false)
  for (const [index, room, round] of [[16777216, 0, 0], [-1, 0, 0], [1.5, 0, 0], [Number.NaN, 0, 0], [2 ** 53, 0, 0], [0, 60, 0], [0, -1, 0], [0, 0, 60], [0, 0.5, 0]]) {
    assert.throws(() => showMembershipZone(index, room, round), RefusalError, `${index}/${room}/${round}`)
  }
})

test('seat anchors join their membership group and conflicting zone identities are refused', async () => {
  const input = await inputOf('race-sprint')
  const show = { worldKind: 'show_seat' as const, seatOf: [0, 59], inputSlots: [-1, -1], humans: [false, false] }
  const emitted = emitEngineScene(engine, { ...input, show })
  // The text, the scene and the copied metadata describe the same ownership, ordered by scene entity index.
  const fromText = JSON.parse(emitted.text) as typeof emitted.scene
  const featureCount = input.course.sim!.features?.length ?? 0
  assert.deepEqual(showSceneOwnership(fromText, show.seatOf, featureCount), emitted.show?.ownership)
  assert.deepEqual(emitted.show?.ownership.map(row => row.entity), zoneRowsOf(emitted.scene).map(row => row.entity))
  assert.deepEqual(emitted.show?.ownership.slice(0, 2).map(row => row.entity), emitted.seatEntities)
  for (const [roundSeat, entity] of emitted.seatEntities.entries()) {
    const zone = emitted.scene.entities[entity].components?.['ege.zone.id']
    assert.deepEqual(zone, { id: show.seatOf[roundSeat] + 1, owner: roundSeat, group: show.seatOf[roundSeat] + 1 })
    assert.ok(emitted.scene.entities[entity].body, 'the group anchor is physical')
    const child = emitted.index(`show/seat/${roundSeat}`)
    assert.equal(emitted.scene.entities[child].body, undefined, 'the seat child is nonphysical')
    assert.deepEqual(emitted.scene.entities[child].components?.['ege.zone.id'], showSeatChildZone(show.seatOf[roundSeat], roundSeat))
  }
  for (const feature of emitted.featureEntities) assert.equal(emitted.scene.entities[feature].components?.['ege.zone.id'], undefined)
  const withZone = (id: number, owner: number, group: number) => {
    const scene = structuredClone(emitted.scene)
    scene.entities.push({ name: 'probe', components: { 'ege.zone.id': { id, owner, group } } })
    return scene
  }
  const conflicts = [
    withZone(SHOW_MEMBERSHIP_ZONE_FIRST, 0, 1),
    withZone(showMembershipZone(3, 59, 1).id, 1, 60),
    withZone(SHOW_MEMBERSHIP_ZONE_LAST, 0xffff, 0),
    withZone(60, 0xffff, 0),
    // A child or publisher id with another family's owner/group is a collision, not a silent renaming.
    withZone(SHOW_SEAT_CHILD_ZONE_FIRST, 1, 60),
    withZone(SHOW_SEAT_CHILD_ZONE_LAST, 1, 1),
    withZone(SHOW_PUBLISH_ZONE_FIRST, 1, 60),
    withZone(SHOW_PUBLISH_ZONE_LAST, 1, 60),
  ]
  for (const scene of conflicts) assert.throws(() => showSceneOwnership(scene, show.seatOf, featureCount), RefusalError)
  assert.throws(() => showSceneOwnership(withZone(SHOW_TEAM_ZONE_FIRST, 0, 1), show.seatOf, 1), RefusalError)
  const lostAnchor = structuredClone(emitted.scene)
  lostAnchor.entities[emitted.seatEntities[1]].components!['ege.zone.id'] = { id: 60, owner: 1, group: 0 }
  assert.throws(() => showSceneOwnership(lostAnchor, show.seatOf), RefusalError)
  const lostChild = structuredClone(emitted.scene)
  delete lostChild.entities[emitted.index('show/seat/1')].components!['ege.zone.id']
  assert.throws(() => showSceneOwnership(lostChild, show.seatOf), RefusalError)
  const noOwner = showSceneOwnership(withZone(SHOW_MEMBERSHIP_ZONE_FIRST - 1, 0xffff, 0), show.seatOf, featureCount)
  assert.equal(noOwner.length, emitted.show!.ownership.length + 1)
  assert.equal(noOwner.at(-1)?.owner, null, 'the engine NO_OWNER sentinel maps to null')
})

test('seat children and cumulative publishers use collision-free stable ranges', () => {
  assert.equal(SHOW_CONTROL_NEUTRAL, 32639)
  assert.equal(SHOW_SEAT_CHILD_ZONE_FIRST, 61)
  assert.equal(SHOW_SEAT_CHILD_ZONE_LAST, 120)
  assert.equal(SHOW_PUBLISH_ZONE_FIRST, 65536)
  assert.equal(SHOW_PUBLISH_STRIDE, 32)
  assert.equal(SHOW_PUBLISH_FIELD_COUNT, 19)
  assert.equal(SHOW_PUBLISH_ZONE_LAST, 67455)
  assert.equal(SHOW_TEAM_ZONE_FIRST, 131072)
  assert.deepEqual(showSeatChildZone(0, 0), { id: 61, owner: 0, group: 1 })
  assert.deepEqual(showSeatChildZone(59, 2), { id: 120, owner: 2, group: 60 })
  assert.deepEqual(showPublishZone(0, 0, 0), { id: 65536, owner: 0, group: 1 })
  assert.deepEqual(showPublishZone(59, 18, 2), { id: 65536 + 59 * 32 + 18, owner: 2, group: 60 })
  assert.ok(isShowPublishZoneId(65536))
  assert.ok(isShowPublishZoneId(67455))
  assert.equal(isShowPublishZoneId(65535), false)
  assert.equal(isShowPublishZoneId(67456), false)
  // The families do not overlap the membership reservation or one another.
  assert.ok(SHOW_PUBLISH_ZONE_LAST < SHOW_TEAM_ZONE_FIRST)
  assert.ok(SHOW_TEAM_ZONE_FIRST < SHOW_MEMBERSHIP_ZONE_FIRST)
  assert.ok(SHOW_SEAT_CHILD_ZONE_LAST < SHOW_PUBLISH_ZONE_FIRST)
  assert.equal(showSeatChildZone(59, 2).id < showPublishZone(0, 0, 0).id, true)
  for (const [room, round, field] of [[-1, 0, 0], [60, 0, 0], [0, 60, 0], [0, 0.5, 0], [0, 0, -1], [0, 0, 19], [0, 0, 1.5]]) {
    assert.throws(() => showPublishZone(room, field, round), RefusalError, `${room}/${round}/${field}`)
  }
  for (const [room, round] of [[-1, 0], [60, 0], [0, 60], [0, 0.5]]) {
    assert.throws(() => showSeatChildZone(room, round), RefusalError, `${room}/${round}`)
  }
})

// Test-local runtime insertion of seat-anchored catch-volume membership rows; production creation stays with the
// catch/swim feature scripts. A row is reused by authored feature index plus live character entity, its feature
// reference is refreshed to the current feature entity and `inside` counts the ticks the row has been stepped.
const MEMBERSHIP_PROBE = `import { getComponent, isNull, newRecord, readColumn, setComponent, spawn } from 'ege'
import { EgeZoneId, Feature, ShowFeatureMembership, ShowSeatIdentity } from '../components.gen'

export function rf_probe_membership(): void {
  const seats = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)
  const features = readColumn<Feature>(Feature.ID, Feature.SIZE)
  const rows = readColumn<ShowFeatureMembership>(ShowFeatureMembership.ID, ShowFeatureMembership.SIZE)
  for (let s: u32 = 0; s < seats.count; s++) {
    const character = seats.entity(s)
    const room = seats.at(s).room_seat
    const anchor = getComponent<EgeZoneId>(character, EgeZoneId.ID, EgeZoneId.SIZE)
    if (isNull<EgeZoneId>(anchor)) continue
    for (let f: u32 = 0; f < features.count; f++) {
      const feature = features.at(f)
      if (feature.kind != 3) continue
      let found = false
      for (let r: u32 = 0; r < rows.count; r++) {
        const row = rows.at(r)
        if (row.index != feature.index || row.character != character) continue
        row.feature = features.entity(f)
        row.inside = row.inside + 1
        found = true
      }
      if (found) continue
      if (feature.index > 16777215 || room > 59) continue
      const id: u64 = <u64>0x40000000 + <u64>feature.index * 64 + <u64>room
      if (id > 0x7fffffff) continue
      const entity = spawn()
      const row = newRecord<ShowFeatureMembership>(ShowFeatureMembership.SIZE)
      row.owner = character
      row.feature = features.entity(f)
      row.character = character
      row.index = feature.index
      row.inside = 1
      setComponent<ShowFeatureMembership>(entity, ShowFeatureMembership.ID, ShowFeatureMembership.SIZE, row)
      const zone = newRecord<EgeZoneId>(EgeZoneId.SIZE)
      zone.id = <u32>id
      zone.owner = anchor.owner
      zone.group = anchor.group
      setComponent<EgeZoneId>(entity, EgeZoneId.ID, EgeZoneId.SIZE, zone)
    }
  }
  rows.write()
}
`

const NO_SHADOWS = { count: 0, fromDomain: () => 0, reader: () => new SnapReader(new Uint8Array(0)) }

test('a seat-anchored membership row keeps its zone identity through zone transfer and rebuild', async () => {
  const schema = JSON.parse(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')) as {
    world_kinds: { name: string; players: number; schedule: { system: string; kind: string }[] }[]
  }
  const showSeat = schema.world_kinds.find(kind => kind.name === 'show_seat')
  const catchPre = showSeat?.schedule.find(entry => entry.system === 'rf.feature.catch_volume.pre')
  assert.ok(catchPre)
  // The probe runs under a copy of the production catch-volume access lists in a zone-tracking world kind.
  schema.world_kinds.push({
    name: 'membership_probe',
    players: 8,
    schedule: [
      { ...structuredClone(catchPre), system: 'rf.probe.membership' },
      { system: 'ege.physics', kind: 'engine' },
      { system: 'ege.zone.track', kind: 'engine' },
    ],
  })
  const schemaText = JSON.stringify(schema)
  const files = [...collectRfScripts(), { name: 'probe/membership.as.ts', text: MEMBERSHIP_PROBE }]
  const compiled = await (await rfCompiler()).compile(files, schemaText)
  assert.deepEqual(compiled.diagnostics.filter(d => d.severity === 'error').map(formatRfDiagnostic), [])
  assert.ok(compiled.wasm)
  const probeEngine = await loadEngine()
  probeEngine.setSchema(schemaText)
  const module = await loadScript(probeEngine, compiled.wasm, { name: 'rf-scripts' })
  const layout = schemaLayout(probeEngine)

  const input = await inputOf('s1-f-taffy-circuit')
  const show = { worldKind: 'show_seat' as const, seatOf: [3, 17, 59], inputSlots: [0, -1, -1], humans: [true, false, false] }
  const emitted = emitEngineScene(probeEngine, { ...input, show })
  const catchFeatures = emitted.featureEntities.filter(entity => emitted.scene.entities[entity].components?.feature?.kind === 3)
  assert.ok(catchFeatures.length >= 1)
  const featureIndex = (entity: number) => emitted.scene.entities[entity].components?.feature?.index as number
  const host = new ScriptHost(module)
  const factory = new EngineDomainFactory({
    engine: probeEngine,
    scenes: { seat: { ...emitted.scene, world_kind: 'membership_probe' } },
    grid: { cols: 1, rows: 1, cellSize: 4096, originX: -2048, originZ: -2048 },
    runner: () => host,
    inputPlayers: spec => spec.seats.map(roundSeat => show.inputSlots[roundSeat]),
  })
  const step = (sim: ReturnType<EngineDomainFactory['create']>) => {
    for (let i = 0; i < sim.spec.seats.length; i++) factory.codec.decode(0, 0)
    sim.step([], NO_SHADOWS)
  }
  const rowsOf = (world: number) => {
    const state = readWorldState(probeEngine, world, layout)
    const seatOfRoom = new Map(Object.entries(state.components.show_seat_identity).map(([entity, identity]) => [identity.room_seat as number, Number(entity)]))
    const rows = Object.entries(state.components.show_feature_membership).map(([entity, row]) => ({ entity: Number(entity), row, zone: state.components['ege.zone.id'][entity] }))
    return { state, seatOfRoom, rows }
  }

  try {
    const source = factory.create({ id: 1, kind: 'seat', cells: [], seats: [0, 1, 2], replicas: [0] }, 0)
    step(source)
    const before = rowsOf(source.world)
    assert.equal(before.rows.length, show.seatOf.length * catchFeatures.length)
    for (const [roundSeat, room] of show.seatOf.entries()) {
      const character = before.seatOfRoom.get(room)
      assert.ok(character !== undefined)
      assert.deepEqual(before.state.components['ege.zone.id'][character], showSeatZone(room, roundSeat))
      for (const feature of catchFeatures) {
        const matches: typeof before.rows = before.rows.filter(({ row }) => row.character === character && row.index === featureIndex(feature))
        assert.equal(matches.length, 1)
        assert.deepEqual(matches[0].row, { owner: character, feature, character, index: featureIndex(feature), inside: 1 })
        assert.deepEqual(matches[0].zone, showMembershipZone(featureIndex(feature), room, roundSeat))
      }
    }

    // Transfer room seat 59 (round seat 2) alone into another domain built from the source export.
    const exported = new SnapWriter()
    source.exportEntities(exported)
    const target = factory.rebuild({ id: 2, kind: 'field', cells: [], seats: [2], replicas: [0] }, source.tick, [new SnapReader(exported.bytes())])
    const moved = rowsOf(target.world)
    const character = moved.seatOfRoom.get(59)
    assert.ok(character !== undefined)
    assert.deepEqual([...moved.seatOfRoom.keys()], [59])
    assert.deepEqual(moved.state.components['ege.zone.id'][character], { id: 60, owner: 2, group: 60 })
    assert.equal(moved.rows.length, catchFeatures.length)
    for (const feature of catchFeatures) {
      const matches: typeof moved.rows = moved.rows.filter(({ row }) => row.index === featureIndex(feature))
      assert.equal(matches.length, 1)
      // Entity references are remapped onto the rebuilt character; the static feature keeps its scene entity.
      assert.deepEqual(matches[0].row, { owner: character, feature, character, index: featureIndex(feature), inside: 1 })
      assert.deepEqual(matches[0].zone, { id: 0x40000000 + featureIndex(feature) * 64 + 59, owner: 2, group: 60 })
    }

    // Stepping the rebuilt domain reuses the transferred row instead of creating a second one.
    step(target)
    const after = rowsOf(target.world)
    assert.equal(after.rows.length, catchFeatures.length)
    for (const { row, zone } of after.rows) {
      assert.equal(row.character, character)
      assert.equal(row.inside, 2)
      assert.equal(zone.group, 60)
    }
    assert.equal(module.faultCount, 0, module.faults.map(fault => fault.message).join('; '))
    factory.release(source)
  } finally {
    factory.dispose()
  }
})

// The ownership probe kind tracks zones without running scripts, so a split/merge moves the emitted template only.
function ownershipProbeSchema(): string {
  const schema = JSON.parse(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')) as {
    world_kinds: { name: string; players: number; schedule: { system: string; kind: string }[] }[]
  }
  schema.world_kinds.push({
    name: 'ownership_probe',
    players: 8,
    schedule: [{ system: 'ege.zone.track', kind: 'engine' }],
  })
  return JSON.stringify(schema)
}

test('split and merge move each seat child and cumulative publisher with its anchor exactly once', async () => {
  const schemaText = ownershipProbeSchema()
  const probeEngine = await loadEngine()
  probeEngine.setSchema(schemaText)
  const layout = schemaLayout(probeEngine)
  const input = await inputOf('s1-f-taffy-circuit')
  const show = { worldKind: 'show_seat' as const, seatOf: [3, 17, 59], inputSlots: [0, -1, -1], humans: [true, false, false] }
  const emitted = emitEngineScene(probeEngine, { ...input, show })
  const factory = new EngineDomainFactory({
    engine: probeEngine,
    scenes: { seat: { ...emitted.scene, world_kind: 'ownership_probe' } },
    grid: { cols: 1, rows: 1, cellSize: 4096, originX: -2048, originZ: -2048 },
    inputPlayers: spec => spec.seats.map(roundSeat => show.inputSlots[roundSeat]),
  })
  const exportOf = (sim: ReturnType<EngineDomainFactory['create']>) => {
    const writer = new SnapWriter()
    sim.exportEntities(writer)
    return writer.bytes()
  }
  const checkSeat = (state: ReturnType<typeof readWorldState>, roundSeat: number) => {
    const components = state.components as unknown as Record<string, Record<string, { [field: string]: number }>>
    const seatEntry = Object.entries(components.show_seat_identity).find(([, identity]) => identity.round_seat === roundSeat)
    assert.ok(seatEntry, `round seat ${roundSeat} is present`)
    const seatEntity = Number(seatEntry[0])
    const roomSeat = seatEntry[1].room_seat
    assert.deepEqual(components['ege.zone.id'][seatEntity], showSeatZone(roomSeat, roundSeat))
    const refs = Object.entries(components.show_character_ref).filter(([, ref]) => ref.owner === seatEntity)
    assert.equal(refs.length, 1, `round seat ${roundSeat} has one character reference`)
    assert.deepEqual(refs[0][1], { owner: seatEntity, target: 0xffffffff, lever: 0xffffffff, carry: 0xffffffff })
    const child = components['ege.zone.id'][Number(refs[0][0])]
    assert.deepEqual(child, showSeatChildZone(roomSeat, roundSeat))
    if (!show.humans[roundSeat]) {
      const memory = Object.entries(components.bot_memory).filter(([, row]) => row.owner === seatEntity)
      assert.equal(memory.length, 1)
      const route = Object.entries(components.bot_route).filter(([, row]) => row.owner === seatEntity)
      assert.equal(route.length, 1)
      assert.equal(route[0][1].plan_tick, -1)
    }
    const publishers = Object.entries(components['ege.zone.id'])
      .filter(([, zone]) => isShowPublishZoneId(zone.id) && zone.group === roomSeat + 1)
      .map(([, zone]) => zone.id)
      .sort((a, b) => a - b)
    assert.deepEqual(publishers, Array.from({ length: SHOW_PUBLISH_FIELD_COUNT }, (_, field) => showPublishZone(roomSeat, field, roundSeat).id))
    return seatEntity
  }

  try {
    const source = factory.create({ id: 1, kind: 'seat', cells: [], seats: [0, 1, 2], replicas: [0] }, 0)
    const before = readWorldState(probeEngine, source.world, layout)
    for (let roundSeat = 0; roundSeat < show.seatOf.length; roundSeat++) checkSeat(before, roundSeat)
    assert.equal(Object.keys(before.components.show_seat_identity).length, show.seatOf.length)

    // Split: transfer only room seat 59 (round seat 2) into a fresh domain.
    const split = factory.rebuild({ id: 2, kind: 'field', cells: [], seats: [2], replicas: [0] }, source.tick, [new SnapReader(exportOf(source))])
    const moved = readWorldState(probeEngine, split.world, layout)
    assert.deepEqual(Object.values(moved.components.show_seat_identity).map(row => row.room_seat), [59])
    const movedSeat = checkSeat(moved, 2)
    assert.equal(movedSeat, Object.keys(moved.components.show_seat_identity).map(Number)[0])

    // Merge: two single-seat domains export their live entities; the rebuilt domain holds both groups once.
    const partA = factory.create({ id: 3, kind: 'seat', cells: [], seats: [0], replicas: [0] }, 0)
    const partB = factory.create({ id: 4, kind: 'seat', cells: [], seats: [2], replicas: [0] }, 0)
    const merged = factory.rebuild({ id: 5, kind: 'field', cells: [], seats: [0, 2], replicas: [0] }, 0,
      [new SnapReader(exportOf(partA)), new SnapReader(exportOf(partB))])
    const both = readWorldState(probeEngine, merged.world, layout)
    const bothComponents = both.components as unknown as Record<string, Record<string, { [field: string]: number }>>
    assert.deepEqual(Object.values(bothComponents.show_seat_identity).map(row => row.room_seat).sort((a, b) => a - b), [3, 59])
    const seats = [checkSeat(both, 0), checkSeat(both, 2)]
    assert.equal(new Set(seats).size, 2)
    const zones = Object.values(bothComponents['ege.zone.id']).map(zone => zone.id)
    assert.equal(zones.length, new Set(zones).size, 'no duplicate zone ids after merge')
    factory.release(partA)
    factory.release(partB)
    factory.release(source)
  } finally {
    factory.dispose()
  }
})
