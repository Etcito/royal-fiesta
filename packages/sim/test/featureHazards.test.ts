import assert from 'node:assert/strict'
import test from 'node:test'
import { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier, RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { CharMode } from '../src/character/constants.ts'
import { legacyLevel } from '../src/course.ts'
import type { FeatureSpec, ResolvedCourse, SpawnPoint } from '../src/course.ts'
import type {
  CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory, FeatureSeats, FeatureSound,
} from '../src/features/feature.ts'
import { annulusFeature } from '../src/features/annulus.ts'
import { killHeight, risingKillFeature } from '../src/features/risingKill.ts'
import { sweepFeature } from '../src/features/sweeps.ts'
import { neutralInput } from '../src/input.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { RefusalError } from '../src/refusal.ts'
import { v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'

const PATH = 'hazards#/features/0'
const params = { pattern: 'laser', center: [0, 0, 0], lengthM: 10, heightM: 0.775,
  gapM: 1.5, speedDegS: 90, telegraphS: 1, phases: [{ atS: 0 }, { atS: 3 }] }

async function rig(pattern = 'laser') {
  const R = await initRapier()
  const physics = new RapierWorldSim(R, { gravity: { x: 0, y: 0, z: 0 } })
  const sounds: FeatureSound[] = []
  const ctx: FeatureCtx & { roundTick: number; overtime: boolean } = {
    R, physics, tick: 0, roundTick: 0, overtime: false, entrants: 0, trailingTeam: -1,
    course: { id: 'hazards', name: 'Hazards', kind: 'survival', profiles: ['standard'],
      timeLimitS: 60, killPlaneY: -12, spawns: [], checkpoints: [], finish: null,
      path: [], regions: [], queuePad: null, obstacles: [], contentHash: 0 } satisfies ResolvedCourse,
    seats: { count: 0 } as FeatureSeats, rng: new Rng(1), emit() {},
    sound(id, pos, strength) { sounds.push({ id, pos: { ...pos }, strength, key: '', rate: 1, loop: false }) },
    soundLoop(key, id, pos, strength, rate) { sounds.push({ key, id, pos: { ...pos }, strength, rate, loop: true }) },
  }
  const feature = sweepFeature({ id: 'sweep', kind: 'sweep', params: { ...params, pattern, speedMps: 2 } }, 'test/sweep')
  feature.init(ctx)
  function step(tick: number) {
    ctx.roundTick = tick
    sounds.length = 0
    feature.preStep(ctx)
    feature.postStep(ctx)
    const draws: FeatureDraw[] = []
    feature.draw(draws)
    return draws
  }
  return { physics, ctx, sounds, feature, step }
}

test('laser telegraphs, starts a centred loop, carries overtime rate and stops at the next telegraph', async t => {
  const r = await rig()
  t.after(() => r.physics.free())
  assert.equal(r.step(59)[0].tint, 1)
  assert.equal(r.sounds.length, 0)
  const live = r.step(60)[0]
  assert.equal(live.tint, 0)
  assert.deepEqual(r.sounds, [{ key: 'sweep:laser', id: 'mech.laser', pos: live.t, strength: 1, rate: 1, loop: true }])
  r.ctx.overtime = true
  const moving = r.step(61)[0]
  assert.equal(r.sounds[0].rate, 1.5)
  assert.deepEqual(r.sounds[0].pos, moving.t)
  assert.notDeepEqual(moving.t, live.t)
  assert.equal(r.step(180)[0].tint, 1)
  assert.equal(r.sounds.length, 0)
})

test('paired bars preserve the jump window and restore the tick pose', async t => {
  const r = await rig('bars')
  t.after(() => r.physics.free())
  const draw = r.step(60)
  assert.equal(draw[0].t.y + draw[0].s.y / 2, 0.775)
  assert.equal(draw[1].t.y - draw[1].s.y / 2, 2.275)
  assert.equal(r.sounds[0].loop, false)
  r.ctx.overtime = true
  const before = r.step(100)
  assert.equal(r.sounds.length, 0)
  const w = new SnapWriter()
  r.feature.snapshot(w)
  r.step(120)
  r.feature.restore(new SnapReader(w.bytes()), r.ctx)
  const restored: FeatureDraw[] = []
  r.feature.draw(restored)
  assert.deepEqual(restored, before)
})

test('block leaves a traversable gap and sounds only when becoming live', async t => {
  const r = await rig('block')
  t.after(() => r.physics.free())
  const draw = r.step(60)
  const left = draw[0].t.x + draw[0].s.x / 2
  const right = draw[1].t.x - draw[1].s.x / 2
  assert.equal(right - left, 1.5)
  assert.equal(r.sounds[0].loop, false)
  r.step(61)
  assert.equal(r.sounds.length, 0)
})

test('unsafe low and high bar clearances are refused', () => {
  for (const overrides of [{ heightM: 0.8 }, { pattern: 'bars', gapM: 1 }]) {
    assert.throws(() => sweepFeature({ id: 'bad', kind: 'sweep', params: { ...params, ...overrides } }, 'test/sweep'))
  }
})

test('laser contact kills survival seats and knocks race seats; telegraph colliders are off', async t => {
  const r = await rig()
  t.after(() => r.physics.free())
  let killed = 0, knocked = 0
  Object.assign(r.ctx.seats, {
    count: 1, seat() { return 0 }, status() { return PlayerStatus.alive }, protectedNow() { return false }, mode() { return 0 },
    pos(_i: number, out: { x: number; y: number; z: number }) { return Object.assign(out, { x: 5, y: 0.775, z: 0 }) },
    kill() { killed++ }, knock() { knocked++ },
  })
  r.step(59)
  assert.equal(killed, 0)
  r.physics.world.forEachCollider(c => assert.equal(c.isEnabled(), false))
  r.step(60)
  assert.equal(killed, 1)
  r.physics.world.forEachCollider(c => assert.equal(c.isEnabled(), true))
  r.ctx.course.kind = 'race'
  r.step(60)
  assert.equal(knocked, 1)
})

class StubSeats implements FeatureSeats {
  readonly count: number
  readonly positions: Vec3[]
  readonly velocities: Vec3[]
  readonly statuses: number[]
  readonly grounds: number[]
  readonly protectedSeats: boolean[]
  readonly added: { seat: number; v: Vec3 }[] = []
  readonly knocks: { seat: number; v: Vec3 }[] = []
  readonly kills: number[] = []

  constructor(positions: Vec3[]) {
    this.count = positions.length
    this.positions = positions.map(p => ({ ...p }))
    this.velocities = positions.map(() => v3(0, 0, 0))
    this.statuses = positions.map(() => PlayerStatus.alive as number)
    this.grounds = positions.map(() => -1)
    this.protectedSeats = positions.map(() => false)
  }

  seat(i: number): number { return i }
  pos(i: number, out: Vec3): Vec3 {
    const p = this.positions[i]
    out.x = p.x
    out.y = p.y
    out.z = p.z
    return out
  }
  vel(i: number, out: Vec3): Vec3 {
    const v = this.velocities[i]
    out.x = v.x
    out.y = v.y
    out.z = v.z
    return out
  }
  mode(_i: number): number { return CharMode.ground }
  grounded(i: number): boolean { return this.grounds[i] >= 0 }
  groundCollider(i: number): number { return this.grounds[i] }
  status(i: number): number { return this.statuses[i] }
  team(_i: number): number { return 0 }
  input(_i: number) { return neutralInput() }
  protectedNow(i: number): boolean { return this.protectedSeats[i] }
  setVelocity(i: number, v: Vec3): void { this.velocities[i] = { ...v } }
  addVelocity(i: number, v: Vec3): void {
    const c = this.velocities[i]
    this.velocities[i] = { x: c.x + v.x, y: c.y + v.y, z: c.z + v.z }
    this.added.push({ seat: i, v: { ...v } })
  }
  teleport(i: number, at: SpawnPoint): void {
    this.positions[i] = { x: at.t.x, y: at.t.y, z: at.t.z }
  }
  kill(i: number): void {
    this.statuses[i] = PlayerStatus.out
    this.kills.push(i)
  }
  setCarry(): void {}
  carry(_i: number): number { return 0 }
  facing(_i: number, out: Vec3): Vec3 { out.x = 0; out.y = 0; out.z = 1; return out }
  setSwim(): void {}
  knock(i: number, v: Vec3): void {
    this.velocities[i] = { ...v }
    this.knocks.push({ seat: i, v: { ...v } })
  }
}

type HazardCtx = FeatureCtx & { roundTick: number; overtime: boolean; sounds: FeatureSound[] }

type HazardRig = Awaited<ReturnType<typeof hazardRig>>

async function hazardRig(
  spec: FeatureSpec, factory: FeatureFactory, seats: StubSeats, course: ResolvedCourse, roundTick = 0,
) {
  const R = await initRapier()
  const physics = new RapierWorldSim(R, { gravity: { x: 0, y: 0, z: 0 } })
  const sounds: FeatureSound[] = []
  const ctx: HazardCtx = {
    R, physics, tick: roundTick, roundTick, overtime: false, entrants: seats.count, trailingTeam: -1,
    course, seats, rng: new Rng(1), emit() {},
    sound(id, pos, strength) {
      sounds.push({ key: '', rate: 1, id, pos: { ...pos }, strength, loop: false })
    },
    soundLoop(key, id, pos, strength, rate) {
      sounds.push({ key, rate, id, pos: { ...pos }, strength, loop: true })
    },
    sounds,
  }
  const base = physics.bodyCount
  const feature = factory(spec, PATH)
  feature.init(ctx)
  return { physics, ctx, seats, feature, bodies: physics.ids().slice(base), sounds }
}

function hazardCourse(kind: ResolvedCourse['kind'] = 'survival', path: Vec3[] = []): ResolvedCourse {
  return {
    id: 'hazards', name: 'Hazards', kind, profiles: ['standard'], timeLimitS: 60, killPlaneY: -12,
    spawns: [], checkpoints: [], finish: null,
    path: path.map(p => ({ p: { ...p }, jump: false, dive: false })),
    regions: [], queuePad: null, obstacles: [], contentHash: 0,
  }
}

function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`)
}

function angleOf(q: { w: number }): number {
  return 2 * Math.acos(Math.max(-1, Math.min(1, q.w)))
}

function snapshotBytes(feature: CourseFeature): Uint8Array {
  const w = new SnapWriter()
  feature.snapshot(w)
  return w.bytes().slice()
}

function drawsOf(feature: CourseFeature): FeatureDraw[] {
  const out: FeatureDraw[] = []
  feature.draw(out)
  return out
}

function bodyPoses(r: HazardRig): { t: Vec3; q: { x: number; y: number; z: number; w: number } }[] {
  return r.bodies.map(id => {
    const body = r.physics.body(id)
    const t = body.translation()
    const q = body.rotation()
    return { t: { x: t.x, y: t.y, z: t.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } }
  })
}

function annulusSpec(): FeatureSpec {
  return { id: 'ring', kind: 'annulus', params: {
    center: [0, 0, 0], innerM: 2, outerM: 6, thickM: 0.4, speedDegS: 90, segments: 8,
  } }
}

function risingSpec(overrides: Record<string, unknown> = {}): FeatureSpec {
  return { id: 'slime', kind: 'risingKill', params: {
    startY: 0, endY: 10, startS: 0, riseMps: 2, clock: { t: [0, 0, 0] }, halfM: 20, ...overrides,
  } }
}

function drivePose(r: HazardRig, tick: number, overtime: boolean): void {
  r.ctx.roundTick = tick
  r.ctx.overtime = overtime
  r.feature.preStep(r.ctx)
  r.physics.step()
}

function driveKill(r: HazardRig, tick: number, overtime: boolean): void {
  r.ctx.roundTick = tick
  r.ctx.overtime = overtime
  r.feature.preStep(r.ctx)
  r.feature.postStep(r.ctx)
}

test('annulus: segment 0 turns 0, 45 and 90 degrees by roundTick 0, 30 and 60', async t => {
  const r = await hazardRig(annulusSpec(), annulusFeature, new StubSeats([v3(100, 0, 0)]), hazardCourse())
  t.after(() => r.physics.free())
  const body = r.physics.body(r.bodies[0])
  drivePose(r, 0, false)
  near(angleOf(body.rotation()), 0, 'tick 0')
  drivePose(r, 30, false)
  near(angleOf(body.rotation()), Math.PI / 4, 'tick 30')
  drivePose(r, 60, false)
  near(angleOf(body.rotation()), Math.PI / 2, 'tick 60')
})

test('annulus: overtime advances the pose 1.5x per tick', async t => {
  const normal = await hazardRig(annulusSpec(), annulusFeature, new StubSeats([v3(100, 0, 0)]), hazardCourse())
  const overtime = await hazardRig(annulusSpec(), annulusFeature, new StubSeats([v3(100, 0, 0)]), hazardCourse())
  t.after(() => normal.physics.free())
  t.after(() => overtime.physics.free())
  for (let tick = 0; tick <= 30; tick++) {
    drivePose(normal, tick, false)
    drivePose(overtime, tick, tick > 0)
  }
  const slow = angleOf(normal.physics.body(normal.bodies[0]).rotation())
  const fast = angleOf(overtime.physics.body(overtime.bodies[0]).rotation())
  near(slow, Math.PI / 4, 'normal pose at tick 30')
  near(fast, 1.5 * slow, 'overtime pose at tick 30')
  near(fast, 3 * Math.PI / 8, 'overtime 67.5 degrees')
})

test('annulus: a grounded seat receives the tangential point velocity omega cross r', async t => {
  const seats = new StubSeats([v3(0, 0, 4)])
  const r = await hazardRig(annulusSpec(), annulusFeature, seats, hazardCourse())
  t.after(() => r.physics.free())
  seats.grounds[0] = r.physics.body(r.bodies[0]).collider(0).handle
  r.ctx.roundTick = 0
  r.feature.preStep(r.ctx)

  assert.equal(seats.added.length, 1)
  const v = seats.velocities[0]
  const omega = Math.PI / 2
  near(Math.hypot(v.x, v.z), omega * 4, 'magnitude rad(speed) * radius')
  near(v.z * 4, 0, 'radial component')
  near(v.y, 0, 'planar')
  assert.ok(v.x > 0)
})

test('killHeight: waits for startS, rises, clamps at endY and overtime adds riseMps per second', () => {
  near(killHeight(2, 10, 5, 1.5, 4 * 60, 0), 2, 'before startS')
  near(killHeight(2, 10, 5, 1.5, 7 * 60, 0), 5, '2 s after startS')
  near(killHeight(2, 10, 5, 1.5, 10_000, 0), 10, 'clamped at endY')
  near(killHeight(2, 10, 5, 1.5, 5 * 60, 60), 3.5, '60 overtime ticks add riseMps')
  near(killHeight(2, 10, 5, 1.5, 0, 60), 3.5, 'overtime counts before startS')
})

test('risingKill: kills seats below the height, spares ones above and protected seats', async t => {
  const seats = new StubSeats([v3(0, 0.5, 0), v3(0, 2, 0), v3(0, 0.25, 0)])
  seats.protectedSeats[2] = true
  const r = await hazardRig(risingSpec(), risingKillFeature, seats, hazardCourse())
  t.after(() => r.physics.free())
  driveKill(r, 30, false)

  assert.deepEqual(seats.kills, [0])
  assert.equal(seats.statuses[0], PlayerStatus.out)
  assert.equal(seats.statuses[1], PlayerStatus.alive)
  assert.equal(seats.statuses[2], PlayerStatus.alive)
})

test('QB1: annulus snapshot, restore and 120 ticks give identical bytes and poses', async t => {
  const course = hazardCourse()
  const a = await hazardRig(annulusSpec(), annulusFeature, new StubSeats([v3(0, 0, 4)]), course)
  t.after(() => a.physics.free())
  for (let tick = 0; tick < 60; tick++) drivePose(a, tick, tick >= 30)
  const saved = snapshotBytes(a.feature)

  const b = await hazardRig(annulusSpec(), annulusFeature, new StubSeats([v3(0, 0, 4)]), course, 60)
  t.after(() => b.physics.free())
  b.feature.restore(new SnapReader(saved.slice()), b.ctx)
  assert.deepEqual(snapshotBytes(b.feature), saved)

  for (let tick = 60; tick < 180; tick++) {
    drivePose(a, tick, true)
    drivePose(b, tick, true)
    assert.deepEqual(drawsOf(a.feature), drawsOf(b.feature), `poses at tick ${tick}`)
  }
  assert.deepEqual(snapshotBytes(a.feature), snapshotBytes(b.feature))
  assert.deepEqual(bodyPoses(a), bodyPoses(b))
})

test('QB1: risingKill snapshot, restore and 120 ticks give identical bytes and poses', async t => {
  const spec = risingSpec({ riseMps: 0.1 })
  const course = hazardCourse('survival', [v3(0, 8, 0), v3(0, 6, 0)])
  const a = await hazardRig(spec, risingKillFeature, new StubSeats([v3(0, 8, 0)]), course)
  t.after(() => a.physics.free())
  for (let tick = 0; tick < 60; tick++) driveKill(a, tick, tick >= 30)
  const saved = snapshotBytes(a.feature)

  const b = await hazardRig(spec, risingKillFeature, new StubSeats([v3(0, 8, 0)]), course, 60)
  t.after(() => b.physics.free())
  b.feature.restore(new SnapReader(saved.slice()), b.ctx)
  assert.deepEqual(snapshotBytes(b.feature), saved)

  for (let tick = 60; tick < 180; tick++) {
    driveKill(a, tick, true)
    driveKill(b, tick, true)
    assert.deepEqual(drawsOf(a.feature), drawsOf(b.feature), `poses at tick ${tick}`)
  }
  assert.deepEqual(snapshotBytes(a.feature), snapshotBytes(b.feature))
})

function sweepSpec(overrides: Record<string, unknown> = {}): FeatureSpec {
  return { id: 'sweep', kind: 'sweep', params: {
    ...params, phases: [{ atS: 0 }, { atS: 2 }], ...overrides,
  } }
}

function courseOf(kind: 'survival' | 'race'): ResolvedCourse {
  const course = hazardCourse(kind)
  course.level = { ...legacyLevel(course), kind }
  return course
}

test('sweep: phase at 2 s telegraphs throughout ticks 120..179 and goes live at 180', async t => {
  const r = await hazardRig(sweepSpec({ pattern: 'bars' }), sweepFeature, new StubSeats([]), courseOf('survival'))
  t.after(() => r.physics.free())
  assert.equal(r.bodies.length, 2)
  for (let tick = 0; tick <= 240; tick++) {
    drivePose(r, tick, false)
    if (tick < 119) continue
    const live = tick === 119 || tick >= 180
    for (const id of r.bodies) {
      assert.equal(r.physics.body(id).collider(0).isEnabled(), live, `collider at tick ${tick}`)
    }
    for (const draw of drawsOf(r.feature)) {
      assert.equal(draw.tint, live ? 0 : 1, `tint at tick ${tick}`)
      assert.equal(draw.visible, true)
    }
  }
})

test('sweep: rotating bars have tick-derived positions and angles', async t => {
  const r = await hazardRig(sweepSpec({ pattern: 'bars', phases: [{ atS: 0 }] }),
    sweepFeature, new StubSeats([]), courseOf('survival'))
  t.after(() => r.physics.free())
  for (const [tick, angle] of [[60, 0], [90, Math.PI / 4], [120, Math.PI / 2]]) {
    drivePose(r, tick, false)
    const draws = drawsOf(r.feature)
    assert.equal(draws.length, 2)
    for (let i = 0; i < 2; i++) {
      const body = r.physics.body(r.bodies[i])
      near(angleOf(body.rotation()), angle, `bar ${i} angle at ${tick}`)
      near(body.translation().x, 5 * Math.cos(angle), `bar ${i} x at ${tick}`)
      near(body.translation().z, -5 * Math.sin(angle), `bar ${i} z at ${tick}`)
      near(angleOf(draws[i].r), angle, `draw ${i} angle at ${tick}`)
    }
    near(draws[0].t.y + draws[0].s.y / 2, 0.775, 'low bar top')
    near(draws[1].t.y - draws[1].s.y / 2, 2.275, 'high bar underside')
  }
})

for (const kind of ['survival', 'race'] as const) {
  test(`sweep: laser contact uses the ${kind} level's kill or knock behavior`, async t => {
    const seats = new StubSeats([v3(5, 0.775, 0)])
    const r = await hazardRig(sweepSpec(), sweepFeature, seats, courseOf(kind))
    t.after(() => r.physics.free())
    driveKill(r, 59, false)
    assert.deepEqual(seats.kills, [])
    assert.equal(seats.knocks.length, 0)
    driveKill(r, 60, false)
    assert.deepEqual(seats.kills, kind === 'survival' ? [0] : [])
    assert.equal(seats.knocks.length, kind === 'race' ? 1 : 0)
    if (kind === 'race') {
      assert.equal(seats.knocks[0].seat, 0)
      assert.ok(Math.hypot(seats.knocks[0].v.x, seats.knocks[0].v.z) > 0)
      assert.equal(seats.status(0), PlayerStatus.alive)
    }
  })
}

for (const { name, overrides, pointer } of [
  { name: 'laser height 0.9', overrides: { heightM: 0.9 }, pointer: '0/heightM' },
  { name: 'bars height plus gap 2.0', overrides: { pattern: 'bars', heightM: 0.5, gapM: 1.5 }, pointer: '0/gapM' },
  { name: 'block gap 1.0', overrides: { pattern: 'block', gapM: 1, speedMps: 2 }, pointer: '0/gapM' },
  { name: 'equal phase times', overrides: { phases: [{ atS: 0 }, { atS: 2 }, { atS: 2 }] }, pointer: '2/atS' },
  { name: 'decreasing phase times', overrides: { phases: [{ atS: 0 }, { atS: 2 }, { atS: 1 }] }, pointer: '2/atS' },
]) {
  test(`sweep refuses ${name}`, () => {
    assert.throws(() => sweepFeature(sweepSpec(overrides), PATH), (error: unknown) => {
      assert.ok(error instanceof RefusalError)
      assert.equal(error.area, 'feature')
      assert.equal(error.path, `${PATH}/phases/${pointer}`)
      return true
    })
  })
}

for (const pattern of ['laser', 'bars', 'block']) {
  test(`QB1: ${pattern} sweep restores mid-telegraph and replays 120 ticks identically`, async t => {
    const spec = sweepSpec({ pattern, speedMps: 2 })
    const course = courseOf('survival')
    const a = await hazardRig(spec, sweepFeature, new StubSeats([]), course)
    t.after(() => a.physics.free())
    for (let tick = 0; tick <= 150; tick++) drivePose(a, tick, tick >= 140)
    assert.ok(drawsOf(a.feature).every(draw => draw.tint === 1))
    const saved = snapshotBytes(a.feature)
    const b = await hazardRig(spec, sweepFeature, new StubSeats([]), course, 150)
    t.after(() => b.physics.free())
    b.feature.restore(new SnapReader(saved.slice()), b.ctx)
    assert.deepEqual(snapshotBytes(b.feature), saved)
    assert.deepEqual(drawsOf(b.feature), drawsOf(a.feature))
    assert.deepEqual(bodyPoses(b), bodyPoses(a))
    for (let tick = 151; tick <= 270; tick++) {
      for (const r of [a, b]) {
        r.sounds.length = 0
        drivePose(r, tick, true)
        r.feature.postStep(r.ctx)
      }
      assert.deepEqual(snapshotBytes(b.feature), snapshotBytes(a.feature), `bytes at ${tick}`)
      assert.deepEqual(drawsOf(b.feature), drawsOf(a.feature), `draws at ${tick}`)
      assert.deepEqual(bodyPoses(b), bodyPoses(a), `bodies at ${tick}`)
      assert.deepEqual(b.sounds, a.sounds, `sounds at ${tick}`)
      for (let i = 0; i < a.bodies.length; i++) {
        assert.equal(b.physics.body(b.bodies[i]).collider(0).isEnabled(),
          a.physics.body(a.bodies[i]).collider(0).isEnabled(), `collider ${i} at ${tick}`)
      }
    }
    assert.ok(drawsOf(a.feature).every(draw => draw.tint === 0))
  })
}
