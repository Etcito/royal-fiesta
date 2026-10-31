import assert from 'node:assert/strict'
import test from 'node:test'
import { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierModule, RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { CarryKind } from '../src/character/constants.ts'
import type { FeatureSpec, ResolvedCourse, SpawnPoint } from '../src/course.ts'
import type { PlayerInput } from '../src/input.ts'
import { neutralInput } from '../src/input.ts'
import type { Vec3 } from '../src/vec.ts'
import { createFeatures, FEATURE_KINDS } from '../src/features/catalog.ts'
import type { FeatureCtx, FeatureDraw, FeatureSeats } from '../src/features/feature.ts'
import type { FiestaEventKind } from '../src/zones/ledger.ts'
import { PROFILES } from '../src/match/setup.ts'
import { FiestaDomain } from '../src/zones/fiestaDomain.ts'
import { createFiestaDomainFactory } from '../src/zones/fiestaDomainFactory.ts'
import { parseZonesFile, ZONES_FORMAT, ZONES_VERSION } from '../src/zones/zonesFile.ts'

const COURSE_PATH = 'courses/test.course.json'

function course(features: FeatureSpec[]): ResolvedCourse {
  return {
    id: 'test',
    name: 'Test',
    kind: 'race',
    profiles: ['standard'],
    timeLimitS: 60,
    killPlaneY: -12,
    spawns: [],
    checkpoints: [],
    finish: null,
    path: [],
    regions: [],
    queuePad: null,
    obstacles: [],
    contentHash: 0,
    features,
  }
}

function marker(id: string, x = 0, y = 0, z = 0, radiusM?: number): FeatureSpec {
  return {
    id,
    kind: 'marker',
    params: radiusM === undefined ? { t: [x, y, z] } : { t: [x, y, z], radiusM },
  }
}

class StubSeats implements FeatureSeats {
  readonly count: number
  readonly positions: Vec3[]
  readonly zero: Vec3 = { x: 0, y: 0, z: 0 }
  readonly inputValue: PlayerInput = neutralInput()
  readonly spawn: SpawnPoint = { t: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } }

  constructor(positions: Vec3[]) {
    this.positions = positions
    this.count = positions.length
  }

  seat(i: number): number { return i }
  pos(i: number, out: Vec3): Vec3 {
    const p = this.positions[i]
    out.x = p.x
    out.y = p.y
    out.z = p.z
    return out
  }
  vel(_i: number, out: Vec3): Vec3 { out.x = 0; out.y = 0; out.z = 0; return out }
  mode(_i: number): number { return 0 }
  grounded(_i: number): boolean { return true }
  groundCollider(_i: number): number { return -1 }
  status(_i: number): number { return 0 }
  team(_i: number): number { return 0 }
  input(_i: number): PlayerInput { return this.inputValue }
  protectedNow(_i: number): boolean { return false }
  setVelocity(_i: number, _v: Vec3): void {}
  addVelocity(_i: number, _v: Vec3): void {}
  teleport(_i: number, _at: SpawnPoint): void {}
  kill(_i: number): void {}
  setCarry(_i: number, _kind: number, _id: number): void {}
  carry(_i: number): number { return 0 }
  facing(_i: number, out: Vec3): Vec3 { out.x = 0; out.y = 0; out.z = 1; return out }
  setSwim(_i: number, _inside: boolean, _drag: number, _buoyancy: number): void {}
  knock(_i: number, _v: Vec3): void {}
}

interface StubCtx extends FeatureCtx {
  readonly sounds: { id: string; pos: Vec3; strength: number }[]
  readonly events: { kind: FiestaEventKind; seat: number; a: number; b: number }[]
}

function context(seats: FeatureSeats, tick: number, courseValue: ResolvedCourse): StubCtx {
  const sounds: StubCtx['sounds'] = []
  const events: StubCtx['events'] = []
  return {
    R: {} as RapierModule,
    physics: {} as RapierWorldSim,
    tick,
    roundTick: tick,
    entrants: seats.count,
    overtime: false,
    trailingTeam: -1,
    course: courseValue,
    seats,
    rng: new Rng(1),
    sounds,
    events,
    emit(kind: FiestaEventKind, seat: number, a: number, b: number): void { events.push({ kind, seat, a, b }) },
    sound(id: string, pos: Vec3, strength: number): void { sounds.push({ id, pos, strength }) },
  }
}

function snapshotBytes(feature: { snapshot(w: SnapWriter): void }): Uint8Array {
  const w = new SnapWriter()
  feature.snapshot(w)
  return w.bytes().slice()
}

test('a domain feature can set carry through its seats without refusal', async t => {
  const R = await initRapier()
  const c = course([marker('carry-stub')])
  c.spawns.push({ t: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 } })
  const zones = parseZonesFile({ format: ZONES_FORMAT, version: ZONES_VERSION, course: c.id,
    grid: { origin: [-10, -10], cell: [20, 20], cols: 1, rows: 1 }, parts: {}, tuning: {},
  }, 'inline.zones', c)
  const factory = createFiestaDomainFactory(R, {
    course: c, zones, profile: { ...PROFILES.sprint, introTicks: 0 }, kind: 'race', seatCount: 1,
  })
  const domain = factory.create({ id: 1, kind: 'seat', seats: [0], cells: [0], replicas: [0] }, 0)
  assert.ok(domain instanceof FiestaDomain)
  t.after(() => domain.inner.world.sim.free())
  const stub = t.mock.method(domain.features[0], 'preStep', (ctx: FeatureCtx) => {
    assert.equal(ctx.trailingTeam, -1)
    assert.equal(ctx.seats.carry(0), CarryKind.none)
    ctx.seats.setCarry(0, CarryKind.object, 7)
    assert.equal(ctx.seats.carry(0), CarryKind.object)
  })
  domain.step([neutralInput()], {
    count: 0, fromDomain() { throw new Error('no link') }, reader() { throw new Error('no link') },
  })
  assert.equal(stub.mock.callCount(), 1)
  assert.equal(domain.state(0).carry, CarryKind.object)
  assert.equal(domain.state(0).carryId, 7)
})

test('FEATURE_KINDS registers only the marker test kind in M3', () => {
  assert.deepEqual(Object.keys(FEATURE_KINDS), ['marker'])
})

test('an unknown kind is refused with its path and the known kinds', () => {
  const c = course([{ id: 'bad', kind: 'nope', params: {} }])
  assert.throws(() => createFeatures(c, COURSE_PATH), (error: unknown) => {
    assert.equal((error as Error).name, 'RefusalError')
    assert.equal((error as { area: string }).area, 'feature')
    assert.equal((error as { path: string }).path, `${COURSE_PATH}#/features/0/kind`)
    assert.match((error as Error).message, /known kinds: marker/)
    return true
  })
})

test('33 features are refused', () => {
  const features = Array.from({ length: 33 }, (_, i) => marker(`m${i}`))
  assert.throws(() => createFeatures(course(features), COURSE_PATH), (error: unknown) => {
    assert.equal((error as { path: string }).path, `${COURSE_PATH}#/features`)
    assert.match((error as Error).message, /at most 32/)
    return true
  })
})

test('a duplicate feature id is refused', () => {
  const c = course([marker('same'), marker('same')])
  assert.throws(() => createFeatures(c, COURSE_PATH), (error: unknown) => {
    assert.equal((error as { path: string }).path, `${COURSE_PATH}#/features/1/id`)
    assert.match((error as Error).message, /duplicate feature id 'same'/)
    return true
  })
})

test('bad marker params are refused with a fix', () => {
  assert.throws(() => createFeatures(course([{ id: 'a', kind: 'marker', params: { t: [0, NaN, 0] } }]), COURSE_PATH),
    (error: unknown) => {
      assert.equal((error as { path: string }).path, `${COURSE_PATH}#/features/0/t`)
      assert.match((error as Error).message, /finite/)
      return true
    })
  assert.throws(() => createFeatures(course([{ id: 'a', kind: 'marker', params: { t: [0, 0] } }]), COURSE_PATH),
    (error: unknown) => {
      assert.equal((error as { path: string }).path, `${COURSE_PATH}#/features/0/t`)
      assert.match((error as Error).message, /\[x,y,z\]/)
      return true
    })
  assert.throws(() => createFeatures(course([marker('a', 0, 0, 0, 0)]), COURSE_PATH), (error: unknown) => {
    assert.equal((error as { path: string }).path, `${COURSE_PATH}#/features/0/radiusM`)
    assert.match((error as Error).message, /0\.1\.\.10/)
    return true
  })
  assert.throws(() => createFeatures(course([marker('a', 0, 0, 0, 10.1)]), COURSE_PATH), (error: unknown) => {
    assert.equal((error as { path: string }).path, `${COURSE_PATH}#/features/0/radiusM`)
    return true
  })
})

test('a marker counts a touch, sounds once and tints its draw', () => {
  const c = course([marker('m', 0, 0, 0)])
  const feature = createFeatures(c, COURSE_PATH)[0]
  const seats = new StubSeats([{ x: 0.5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }])
  const ctx = context(seats, 120, c)
  feature.init(ctx)
  feature.postStep(ctx)
  assert.equal(ctx.sounds.length, 1)
  assert.deepEqual(ctx.sounds[0], { id: 'obj.pickup', pos: { x: 0, y: 0, z: 0 }, strength: 1 })
  assert.equal(ctx.events.length, 0)
  const draws: FeatureDraw[] = []
  feature.draw(draws)
  assert.equal(draws.length, 1)
  assert.equal(draws[0].asset, 'candy.floor-disc')
  assert.deepEqual(draws[0].s, { x: 1, y: 0.1, z: 1 })
  assert.equal(draws[0].tint, 4)

  const out: Vec3 = { x: 0, y: 0, z: 0 }
  assert.equal(feature.botTarget?.(0, { x: 9, y: 9, z: 9 }, out), true)
  assert.deepEqual(out, { x: 0, y: 0, z: 0 })
})

test('a marker snapshot -> restore into a fresh marker -> snapshot is identical', () => {
  const c = course([marker('m', 1, 2, 3, 2)])
  const seats = new StubSeats([{ x: 2, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }, { x: 9, y: 9, z: 9 }])
  const ctx = context(seats, 777, c)
  const feature = createFeatures(c, COURSE_PATH)[0]
  feature.init(ctx)
  feature.postStep(ctx)

  const bytes = snapshotBytes(feature)
  const reader = new SnapReader(bytes)
  assert.equal(reader.u32(), 2)
  assert.equal(reader.i32(), 777)
  assert.equal(reader.remaining, 0)

  const fresh = createFeatures(c, COURSE_PATH)[0]
  fresh.init(ctx)
  fresh.restore(new SnapReader(bytes), ctx)
  assert.deepEqual(snapshotBytes(fresh), bytes)

  const draws: FeatureDraw[] = []
  fresh.draw(draws)
  assert.equal(draws[0].tint, 0)
})

test('a no-touch tick reports zero touches and keeps the last touch tick', () => {
  const c = course([marker('m', 0, 0, 0)])
  const seats = new StubSeats([{ x: 0, y: 0, z: 0 }])
  const feature = createFeatures(c, COURSE_PATH)[0]
  feature.init(context(seats, 10, c))
  feature.postStep(context(seats, 10, c))
  const touching = snapshotBytes(feature)

  seats.positions[0] = { x: 5, y: 0, z: 0 }
  const after = context(seats, 11, c)
  feature.postStep(after)
  assert.equal(after.sounds.length, 0)
  const bytes = snapshotBytes(feature)
  const reader = new SnapReader(bytes)
  assert.equal(reader.u32(), 0)
  assert.equal(reader.i32(), 10)
  assert.notDeepEqual(bytes, touching)
})
