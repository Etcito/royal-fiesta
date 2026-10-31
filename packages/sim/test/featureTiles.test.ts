import assert from 'node:assert/strict'
import test from 'node:test'
import { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier, RapierWorldSim as WorldSim } from '@gamesaloon/rollback-rapier'
import { CharMode } from '../src/character/constants.ts'
import type { FeatureSpec, ResolvedCourse } from '../src/course.ts'
import { legacyLevel } from '../src/course.ts'
import { neutralInput } from '../src/input.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { RefusalError } from '../src/refusal.ts'
import { v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'
import { GRAVITY_Y } from '../src/world.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureSeats } from '../src/features/feature.ts'
import { tileFieldFeature } from '../src/features/tiles.ts'

const R = await initRapier()
const PATH = 'tiles#/features/0'

class StubSeats implements FeatureSeats {
  readonly count = 1
  ground = -1
  onGround = true

  seat(i: number): number { return i }
  pos(_i: number, out: Vec3): Vec3 { return Object.assign(out, v3(0, 1, 0)) }
  vel(_i: number, out: Vec3): Vec3 { return Object.assign(out, v3(0, 0, 0)) }
  mode(_i: number): number { return CharMode.ground }
  grounded(_i: number): boolean { return this.onGround }
  groundCollider(_i: number): number { return this.ground }
  status(_i: number): number { return PlayerStatus.alive }
  team(_i: number): number { return 0 }
  input(_i: number) { return neutralInput() }
  protectedNow(_i: number): boolean { return false }
  setVelocity(): void {}
  addVelocity(): void {}
  teleport(): void {}
  kill(): void {}
  setCarry(): void {}
  carry(_i: number): number { return 0 }
  facing(_i: number, out: Vec3): Vec3 { return Object.assign(out, v3(0, 0, 1)) }
  setSwim(): void {}
  knock(): void {}
}

function context(seats: StubSeats, course: ResolvedCourse) {
  const sounds: { id: string; tick: number }[] = []
  const ctx = {
    R,
    physics: new WorldSim(R, { gravity: { x: 0, y: GRAVITY_Y, z: 0 } }),
    tick: 0,
    roundTick: 0,
    entrants: seats.count,
    overtime: false as boolean,
    trailingTeam: -1,
    course,
    seats,
    rng: new Rng(42).fork(9),
    sounds,
    emit() {},
    sound(id: string, _pos: Vec3, _strength: number) { sounds.push({ id, tick: ctx.tick }) },
  } satisfies FeatureCtx & { sounds: typeof sounds }
  return ctx
}

type TestCtx = ReturnType<typeof context>

function courseOf(features: FeatureSpec[]): ResolvedCourse {
  const course: ResolvedCourse = {
    id: 'tiles',
    name: 'Tiles',
    kind: 'survival',
    profiles: ['standard'],
    timeLimitS: 120,
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
  course.level = legacyLevel(course)
  return course
}

function spec(params: Record<string, unknown> = {}): FeatureSpec {
  return {
    id: 'tiles',
    kind: 'tileField',
    params: {
      tiles: [{ t: [0, 0, 0], size: [2, 2, 0.5] }],
      decayS: 1,
      warnS: 0.5,
      mode: 'permanent',
      resetS: 1,
      ...params,
    },
  }
}

function snapshotBytes(feature: CourseFeature): Uint8Array {
  const w = new SnapWriter()
  feature.snapshot(w)
  return w.bytes().slice()
}

function cellState(feature: CourseFeature): { state: number; timer: number } {
  const r = new SnapReader(snapshotBytes(feature))
  return { state: r.u8(), timer: r.u16() }
}

function step(feature: CourseFeature, ctx: TestCtx, tick: number): void {
  ctx.tick = tick
  ctx.roundTick = tick
  feature.preStep(ctx)
  feature.postStep(ctx)
}

function setup(params: Record<string, unknown> = {}) {
  const s = spec(params)
  const seats = new StubSeats()
  const ctx = context(seats, courseOf([s]))
  const feature = tileFieldFeature(s, PATH)
  feature.init(ctx)
  const colliders = ctx.physics.ids().map(id => ctx.physics.body(id).collider(0))
  assert.equal(colliders.length, 1)
  seats.ground = colliders[0].handle
  return { feature, ctx, seats, colliders }
}

test('tileField: solid through tick 59, warning at 60, falling at 90, gone at 120', () => {
  const { feature, ctx, colliders } = setup()
  assert.deepEqual(cellState(feature), { state: 0, timer: 0 })
  for (let tick = 1; tick <= 59; tick++) {
    step(feature, ctx, tick)
    assert.deepEqual(cellState(feature), { state: 0, timer: tick })
    assert.equal(colliders[0].isEnabled(), true)
  }
  assert.deepEqual(ctx.sounds, [])
  step(feature, ctx, 60)
  assert.deepEqual(cellState(feature), { state: 1, timer: 30 })
  for (let tick = 61; tick <= 89; tick++) {
    step(feature, ctx, tick)
    assert.deepEqual(cellState(feature), { state: 1, timer: 90 - tick })
    assert.equal(colliders[0].isEnabled(), true)
  }
  const warningDraw: FeatureDraw[] = []
  feature.draw(warningDraw)
  assert.equal(warningDraw.length, 1)
  assert.equal(warningDraw[0].tint, 1)
  step(feature, ctx, 90)
  assert.deepEqual(cellState(feature), { state: 2, timer: 0 })
  assert.equal(colliders[0].isEnabled(), false)
  for (let tick = 91; tick <= 119; tick++) step(feature, ctx, tick)
  assert.deepEqual(cellState(feature), { state: 2, timer: 29 })
  const fallingDraw: FeatureDraw[] = []
  feature.draw(fallingDraw)
  assert.equal(fallingDraw.length, 1)
  step(feature, ctx, 120)
  assert.deepEqual(cellState(feature), { state: 3, timer: 0 })
  assert.equal(colliders[0].isEnabled(), false)
  const goneDraw: FeatureDraw[] = []
  feature.draw(goneDraw)
  assert.deepEqual(goneDraw, [])
  assert.deepEqual(ctx.sounds, [
    { id: 'mech.tile-warn', tick: 60 },
    { id: 'mech.tile-fall', tick: 90 },
  ])
})

test('tileField: overtime starts warning at tick 30', () => {
  const { feature, ctx, colliders } = setup()
  ctx.overtime = true
  for (let tick = 1; tick <= 29; tick++) step(feature, ctx, tick)
  assert.deepEqual(cellState(feature), { state: 0, timer: 58 })
  assert.deepEqual(ctx.sounds, [])
  step(feature, ctx, 30)
  assert.deepEqual(cellState(feature), { state: 1, timer: 30 })
  assert.equal(colliders[0].isEnabled(), true)
  assert.deepEqual(ctx.sounds, [{ id: 'mech.tile-warn', tick: 30 }])
})

test('tileField: reset mode re-enables at tick 180 after resetS = 1', () => {
  const { feature, ctx, seats, colliders } = setup({ mode: 'reset', resetS: 1 })
  for (let tick = 1; tick <= 120; tick++) step(feature, ctx, tick)
  assert.deepEqual(cellState(feature), { state: 3, timer: 0 })
  seats.onGround = false
  for (let tick = 121; tick <= 179; tick++) {
    step(feature, ctx, tick)
    assert.equal(colliders[0].isEnabled(), false)
  }
  assert.deepEqual(cellState(feature), { state: 3, timer: 59 })
  step(feature, ctx, 180)
  assert.deepEqual(cellState(feature), { state: 0, timer: 0 })
  assert.equal(colliders[0].isEnabled(), true)
})

test('tileField: permanent mode stays disabled through tick 720 (10 times resetS)', () => {
  const { feature, ctx, colliders } = setup({ mode: 'permanent', resetS: 1 })
  for (let tick = 1; tick <= 120; tick++) step(feature, ctx, tick)
  assert.deepEqual(cellState(feature), { state: 3, timer: 0 })
  for (let tick = 121; tick <= 720; tick++) {
    step(feature, ctx, tick)
    assert.equal(colliders[0].isEnabled(), false)
    assert.equal(cellState(feature).state, 3)
  }
})

test('tileField: 513 tiles are refused at the tiles pointer', () => {
  const s = spec({
    tiles: Array.from({ length: 513 }, (_, i) => ({ t: [i * 2, 0, 0], size: [2, 2, 0.5] })),
  })
  assert.throws(() => tileFieldFeature(s, PATH), (error: unknown) => {
    assert.ok(error instanceof RefusalError)
    assert.equal(error.area, 'feature')
    assert.equal(error.path, `${PATH}/tiles`)
    return true
  })
})

test('tileField QB1: restore at warning tick 75 matches bytes and colliders through tick 195', () => {
  const original = setup({ mode: 'reset', resetS: 1 })
  for (let tick = 1; tick <= 75; tick++) step(original.feature, original.ctx, tick)
  assert.deepEqual(cellState(original.feature), { state: 1, timer: 15 })
  const saved = snapshotBytes(original.feature)
  const restored = setup({ mode: 'reset', resetS: 1 })
  assert.notEqual(restored.ctx.physics, original.ctx.physics)
  restored.ctx.tick = restored.ctx.roundTick = 75
  restored.feature.restore(new SnapReader(saved), restored.ctx)
  assert.deepEqual(snapshotBytes(restored.feature), saved)
  for (let tick = 76; tick <= 195; tick++) {
    step(original.feature, original.ctx, tick)
    step(restored.feature, restored.ctx, tick)
    assert.deepEqual(snapshotBytes(restored.feature), snapshotBytes(original.feature), `tick ${tick}`)
    assert.deepEqual(
      restored.colliders.map(collider => collider.isEnabled()),
      original.colliders.map(collider => collider.isEnabled()),
      `colliders at tick ${tick}`,
    )
  }
})
