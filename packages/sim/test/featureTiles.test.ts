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
import { hexFieldFeature, hexLayout } from '../src/features/hexField.ts'
import { memoryTilesFeature } from '../src/features/memoryTiles.ts'
import { tileFieldFeature } from '../src/features/tiles.ts'

const R = await initRapier()
const PATH = 'tiles#/features/0'

class StubSeats implements FeatureSeats {
  readonly count: number
  constructor(count = 1) { this.count = count }
  grounds: number[] = []
  ground = -1
  onGround = true

  seat(i: number): number { return i }
  pos(_i: number, out: Vec3): Vec3 { return Object.assign(out, v3(0, 1, 0)) }
  vel(_i: number, out: Vec3): Vec3 { return Object.assign(out, v3(0, 0, 0)) }
  mode(_i: number): number { return CharMode.ground }
  grounded(_i: number): boolean { return this.onGround }
  groundCollider(i: number): number { return this.grounds[i] ?? this.ground }
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
  const events: { kind: Parameters<FeatureCtx['emit']>[0]; seat: number; a: number; b: number; tick: number }[] = []
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
    events,
    emit(kind: Parameters<FeatureCtx['emit']>[0], seat: number, a: number, b: number) {
      events.push({ kind, seat, a, b, tick: ctx.tick })
    },
    soundLoop() {},
    sound(id: string, _pos: Vec3, _strength: number) { sounds.push({ id, tick: ctx.tick }) },
  } satisfies FeatureCtx & { sounds: typeof sounds; events: typeof events }
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

function hexSpec(params: Record<string, unknown> = {}): FeatureSpec {
  return { id: 'hex', kind: 'hexField', params: {
    origin: [0, 0, 0], layers: 3, layerSpacingM: 5, rings: 6,
    flatM: 5.5, decayS: 1, warnS: 0.5, ...params,
  } }
}

function setupField(s: FeatureSpec, count = 1) {
  const seats = new StubSeats(count)
  const ctx = context(seats, courseOf([s]))
  const feature = (s.kind === 'hexField' ? hexFieldFeature : memoryTilesFeature)(s, PATH)
  feature.init(ctx)
  const colliders = ctx.physics.ids().map(id => ctx.physics.body(id).collider(0))
  return { feature, seats, ctx, colliders }
}

test('hexLayout: six rings have 127 centres with flatM neighbour spacing', () => {
  const centres = hexLayout(6, 5.5)
  assert.equal(centres.length, 127)
  assert.deepEqual(centres[0], v3(0, 0, 0))
  for (const [i, centre] of centres.entries()) {
    const distances = centres.filter((_, j) => j !== i)
      .map(other => Math.hypot(other.x - centre.x, other.z - centre.z))
    assert.ok(Math.abs(Math.min(...distances) - 5.5) < 1e-10)
  }
  for (const centre of centres.slice(1, 7)) {
    assert.ok(Math.abs(Math.hypot(centre.x, centre.z) - 5.5) < 1e-10)
  }
})

test('hexField: init pools 381 bodies and 300 ticks add none', () => {
  const { feature, ctx, seats, colliders } = setupField(hexSpec())
  const ids = [...ctx.physics.ids()]
  assert.equal(ids.length, 381)
  seats.ground = colliders[0].handle
  for (let tick = 1; tick <= 300; tick++) {
    step(feature, ctx, tick)
    assert.deepEqual(ctx.physics.ids(), ids, `pool at tick ${tick}`)
  }
  assert.equal(colliders[0].isEnabled(), false)
})

test('hexField: 60 entrants scale decay to 0.25, warning at tick 15', () => {
  const { feature, ctx, seats, colliders } = setupField(hexSpec({ scaleWithEntrants: true }))
  ctx.entrants = 60
  seats.ground = colliders[0].handle
  for (let tick = 1; tick <= 14; tick++) step(feature, ctx, tick)
  assert.deepEqual(cellState(feature), { state: 0, timer: 14 })
  step(feature, ctx, 15)
  assert.deepEqual(cellState(feature), { state: 1, timer: 30 })
  assert.deepEqual(ctx.sounds, [{ id: 'mech.tile-warn', tick: 15 }])
})

test('hexField: four layers of eight rings exceed 512 and are refused', () => {
  assert.throws(() => hexFieldFeature(hexSpec({ layers: 4, rings: 8 }), PATH), (error: unknown) => {
    assert.ok(error instanceof RefusalError)
    assert.equal(error.area, 'feature')
    assert.equal(error.path, `${PATH}/rings`)
    return true
  })
})

test('hexField QB1: 381-cell snapshot after decay restores identical bytes', () => {
  const original = setupField(hexSpec())
  original.seats.ground = original.colliders[0].handle
  for (let tick = 1; tick <= 75; tick++) step(original.feature, original.ctx, tick)
  assert.deepEqual(cellState(original.feature), { state: 1, timer: 15 })
  const saved = snapshotBytes(original.feature)
  const restored = setupField(hexSpec())
  restored.seats.ground = restored.colliders[0].handle
  restored.ctx.tick = restored.ctx.roundTick = 75
  restored.feature.restore(new SnapReader(saved), restored.ctx)
  assert.deepEqual(snapshotBytes(restored.feature), saved)
  for (let tick = 76; tick <= 195; tick++) {
    step(original.feature, original.ctx, tick)
    step(restored.feature, restored.ctx, tick)
    assert.deepEqual(snapshotBytes(restored.feature), snapshotBytes(original.feature))
    assert.deepEqual(restored.colliders.map(c => c.isEnabled()), original.colliders.map(c => c.isEnabled()))
  }
})

function memorySpec(): FeatureSpec {
  return { id: 'memory', kind: 'memoryTiles', params: {
    origin: [0, 0, 0], cols: 4, rows: 4, cellM: 2, symbols: 4,
    cycles: 2, revealS: 1, hideS: 0.5, choiceS: 1, penaltyS: 14,
  } }
}

function markers(feature: CourseFeature): FeatureDraw[] {
  const draw: FeatureDraw[] = []
  feature.draw(draw)
  return draw.filter(item => item.asset === 'candy.floor-disc')
}

function startMemoryChoice() {
  const run = setupField(memorySpec(), 2)
  step(run.feature, run.ctx, 0)
  const symbols = markers(run.feature).map(marker => marker.tint)
  assert.equal(symbols.length, 16)
  for (let tick = 1; tick <= 89; tick++) step(run.feature, run.ctx, tick)
  assert.deepEqual(markers(run.feature), [])
  assert.ok(run.colliders.every(c => c.isEnabled()))
  step(run.feature, run.ctx, 90)
  const target = markers(run.feature)[0].tint
  const correct = symbols.findIndex(symbol => symbol === target)
  const wrong = symbols.findIndex(symbol => symbol !== target)
  assert.ok(correct >= 0 && wrong >= 0, 'seed exercises both correct and wrong cells')
  assert.deepEqual(run.colliders.map(c => c.isEnabled()), symbols.map(symbol => symbol === target))
  run.seats.grounds = [run.colliders[correct].handle, run.colliders[wrong].handle]
  return run
}

test('memoryTiles: reveal at 0, hide at 60, choice at 90, matches at 149', () => {
  const run = setupField(memorySpec(), 2)
  assert.deepEqual(markers(run.feature), [])
  step(run.feature, run.ctx, 0)
  const reveal = markers(run.feature)
  assert.equal(reveal.length, 16)
  assert.ok(reveal.every(marker => marker.visible && marker.tint >= 1 && marker.tint <= 4))
  for (let tick = 1; tick <= 59; tick++) step(run.feature, run.ctx, tick)
  assert.deepEqual(markers(run.feature), reveal)
  step(run.feature, run.ctx, 60)
  assert.deepEqual(markers(run.feature), [])

  const choice = startMemoryChoice()
  for (let tick = 91; tick <= 148; tick++) step(choice.feature, choice.ctx, tick)
  assert.deepEqual(choice.ctx.events, [])
  step(choice.feature, choice.ctx, 149)
  assert.deepEqual(choice.ctx.events, [
    { kind: 'match', seat: 0, a: 1, b: 1, tick: 149 },
    { kind: 'match', seat: 1, a: 0, b: 840, tick: 149 },
  ])
  step(choice.feature, choice.ctx, 150)
  assert.equal(choice.ctx.events.length, 2)
  assert.equal(markers(choice.feature).length, 16)
  assert.ok(choice.colliders.every(c => c.isEnabled()))
})

test('memoryTiles: same feature rng repeats symbols and bot guesses for each seat and cycle', () => {
  const a = setupField(memorySpec())
  const b = setupField(memorySpec())
  const guesses: Vec3[] = []
  for (let tick = 0; tick <= 240; tick++) {
    step(a.feature, a.ctx, tick)
    step(b.feature, b.ctx, tick)
    if (tick === 0 || tick === 150) {
      assert.equal(markers(a.feature).length, 16)
      assert.deepEqual(markers(a.feature), markers(b.feature))
    }
    if (tick === 60 || tick === 210) {
      for (let seat = 0; seat < 8; seat++) {
        const first = v3(0, 0, 0), repeated = v3(0, 0, 0), other = v3(0, 0, 0)
        assert.equal(a.feature.botTarget!(seat, v3(0, 0, 0), first), true)
        assert.equal(a.feature.botTarget!(seat, v3(20, 1, -20), repeated), true)
        assert.equal(b.feature.botTarget!(seat, v3(0, 0, 0), other), true)
        assert.deepEqual(repeated, first)
        assert.deepEqual(other, first)
        guesses[seat] = first
      }
      assert.equal(a.ctx.rng.int(0, 1000000), b.ctx.rng.int(0, 1000000))
    }
    if (tick === 90 || tick === 240) {
      for (let seat = 0; seat < guesses.length; seat++) {
        const target = v3(0, 0, 0)
        assert.equal(a.feature.botTarget!(seat, v3(0, 0, 0), target), true)
        assert.deepEqual(target, guesses[seat], 'guess stays stable from hide into choice')
      }
    }
  }
})

test('memoryTiles QB1: restore at mid-choice tick 110 preserves bytes, colliders and matches', () => {
  const original = startMemoryChoice()
  for (let tick = 91; tick <= 110; tick++) step(original.feature, original.ctx, tick)
  const saved = snapshotBytes(original.feature)
  const restored = setupField(memorySpec(), 2)
  restored.ctx.tick = restored.ctx.roundTick = 110
  restored.seats.grounds = original.seats.grounds.map(handle => {
    const index = original.colliders.findIndex(c => c.handle === handle)
    return restored.colliders[index].handle
  })
  restored.feature.restore(new SnapReader(saved), restored.ctx)
  assert.deepEqual(snapshotBytes(restored.feature), saved)
  assert.deepEqual(restored.colliders.map(c => c.isEnabled()), original.colliders.map(c => c.isEnabled()))
  for (let tick = 111; tick <= 300; tick++) {
    step(original.feature, original.ctx, tick)
    step(restored.feature, restored.ctx, tick)
    assert.deepEqual(snapshotBytes(restored.feature), snapshotBytes(original.feature), `tick ${tick}`)
    assert.deepEqual(restored.colliders.map(c => c.isEnabled()), original.colliders.map(c => c.isEnabled()))
    assert.deepEqual(markers(restored.feature), markers(original.feature))
    assert.deepEqual(restored.ctx.events, original.ctx.events)
  }
  assert.ok(restored.colliders.every(c => c.isEnabled()))
})
