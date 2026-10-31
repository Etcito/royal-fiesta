import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier, RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { CarryKind, CharMode } from '../src/character/constants.ts'
import type { ResolvedCourse, SpawnPoint } from '../src/course.ts'
import { carryItemFeature } from '../src/features/carry.ts'
import type { FeatureCtx, FeatureDraw, FeatureSeats } from '../src/features/feature.ts'
import { G, groups } from '../src/groups.ts'
import { neutralInput } from '../src/input.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'

class StubSeats implements FeatureSeats {
  readonly count = 2
  positions = [v3(0, 2, 0), v3(10, 2, 0)]
  velocities = [v3(0, 0, 0), v3(0, 0, 0)]
  directions = [v3(0, 0, 1), v3(0, 0, 1)]
  modes: number[] = [CharMode.ground, CharMode.air]
  statuses: number[] = [PlayerStatus.alive, PlayerStatus.alive]
  teams = [0, 1]
  carries: number[] = [CarryKind.none, CarryKind.none]
  ids = [-1, -1]
  inputs = [neutralInput(), neutralInput()]
  protected = [false, false]
  calls: number[][] = []
  seat(i: number) { return i + 20 }
  pos(i: number, out: Vec3) { return Object.assign(out, this.positions[i]) }
  vel(i: number, out: Vec3) { return Object.assign(out, this.velocities[i]) }
  facing(i: number, out: Vec3) { return Object.assign(out, this.directions[i]) }
  mode(i: number) { return this.modes[i] }
  grounded(i: number) { return this.modes[i] === CharMode.ground }
  groundCollider(_i: number) { return -1 }
  status(i: number) { return this.statuses[i] }
  team(i: number) { return this.teams[i] }
  input(i: number) { return this.inputs[i] }
  protectedNow(i: number) { return this.protected[i] }
  carry(i: number) { return this.carries[i] }
  setCarry(i: number, kind: number, id: number) {
    this.calls.push([i, kind, id]); this.carries[i] = kind; this.ids[i] = id
  }
  setVelocity(i: number, v: Vec3) { this.velocities[i] = { ...v } }
  addVelocity(_i: number, _v: Vec3) {}
  teleport(_i: number, _at: SpawnPoint) {}
  kill(_i: number) {}
  setSwim(_i: number, _inside: boolean, _drag: number, _buoyancy: number) {}
  knock(_i: number, _v: Vec3) {}
}

type Home = { center: number[]; half: number[]; team: number | null }
async function harness(t: TestContext, spawns = [[0, 2, 0.5]], resetS = 30, homes: Home[] = []) {
  const R = await initRapier()
  const physics = new RapierWorldSim(R, { gravity: v3(0, -20, 0) })
  t.after(() => physics.free())
  physics.createBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), [
    R.ColliderDesc.cuboid(30, 0.5, 30).setCollisionGroups(groups(G.STATIC, G.CHAR | G.DEBRIS | G.PROBE)),
  ])
  const seats = new StubSeats(), sounds: string[] = []
  const course: ResolvedCourse = {
    id: 'carry-test', name: 'Carry', kind: 'race', profiles: ['standard'], timeLimitS: 60,
    killPlaneY: -12, spawns: [], checkpoints: [], finish: null, path: [], regions: [],
    queuePad: null, obstacles: [], contentHash: 0, features: [],
  }
  const ctx: FeatureCtx = {
    R, physics, seats, course, rng: new Rng(1), get tick() { return physics.tick },
    get roundTick() { return physics.tick }, entrants: 2, overtime: false, trailingTeam: -1,
    soundLoop() {},
    emit() { assert.fail('carry emits no events') }, sound(id) { sounds.push(id) },
  }
  const feature = carryItemFeature({ id: 'items', kind: 'carryItem',
    params: { asset: 'candy.ball', spawns, resetS, homes } }, '/features/0')
  feature.init(ctx)
  const draw = () => { const out: FeatureDraw[] = []; feature.draw(out); return out }
  const bytes = () => { const w = new SnapWriter(); feature.snapshot(w); return w.bytes().slice() }
  const pre = () => feature.preStep(ctx)
  const step = () => { pre(); physics.step(); feature.postStep(ctx) }
  return { physics, seats, sounds, ctx, feature, draw, bytes, pre, step }
}
function near(actual: Vec3, expected: Vec3) {
  for (const key of ['x', 'y', 'z'] as const) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6,
    `${key}: ${actual[key]} != ${expected[key]}`)
}

test('pick: nearest within 1 m attaches and follows the facing hand anchor', async t => {
  const h = await harness(t, [[0, 2, 0.9], [0, 2, 0.4], [0, 2, 1.1]])
  h.seats.inputs[0].grab = true; h.pre()
  assert.deepEqual(h.seats.calls, [[0, CarryKind.object, 1]])
  near(h.draw()[1].t, v3(0, 2.25, 0.55))
  h.seats.positions[0] = v3(3, 4, 5); h.seats.directions[0] = v3(1, 0, 0)
  h.pre()
  near(h.draw()[1].t, v3(3.55, 4.25, 5))
  assert.equal(h.draw()[1].tint, 4)
  assert.deepEqual(h.sounds, ['move.carry'])
})

test('pick ties use item index; held grab is not a new press', async t => {
  const h = await harness(t, [[0, 2, 0.5], [0, 2, -0.5]])
  h.seats.protected[0] = true; h.seats.inputs[0].grab = true; h.pre()
  h.seats.protected[0] = false; h.pre()
  assert.deepEqual(h.seats.calls, [])
  h.seats.inputs[0].grab = false; h.pre()
  h.seats.inputs[0].grab = true; h.pre()
  assert.deepEqual(h.seats.calls, [[0, CarryKind.object, 0]])
})

test('one per bean: existing carry of every kind excludes pickup', async t => {
  for (const kind of [CarryKind.object, CarryKind.player, CarryKind.tail, CarryKind.crown]) {
    const h = await harness(t)
    h.seats.carries[0] = kind; h.seats.inputs[0].grab = true; h.pre()
    assert.deepEqual(h.seats.calls, [])
    assert.equal(h.draw()[0].tint, 0)
  }
})

test('drop on stun releases and falls onto the static floor', async t => {
  const h = await harness(t)
  h.seats.inputs[0].grab = true; h.pre()
  h.seats.modes[0] = CharMode.stunned; h.pre()
  assert.deepEqual(h.seats.calls.at(-1), [0, CarryKind.none, -1])
  near(h.draw()[0].t, v3(0, 2.25, 0.55))
  for (let i = 0; i < 120; i++) h.step()
  assert.ok(h.draw()[0].t.y > 0.3 && h.draw()[0].t.y < 0.36)
  assert.deepEqual(h.sounds, ['move.carry', 'move.release'])
})

test('release: grab up drops at the current hand with holder velocity', async t => {
  const h = await harness(t)
  h.seats.inputs[0].grab = true; h.pre()
  h.seats.positions[0] = v3(2, 3, 4); h.seats.velocities[0] = v3(3, 1, 0)
  h.seats.inputs[0].grab = false; h.pre()
  near(h.draw()[0].t, v3(2, 3.25, 4.55))
  assert.deepEqual(h.seats.calls.at(-1), [0, CarryKind.none, -1])
  h.step()
  assert.ok(h.draw()[0].t.x > 2)
})

for (const loss of ['eliminated', 'parked'] as const) test(`fall: ${loss} drops at the last hand`, async t => {
  const h = await harness(t)
  h.seats.inputs[0].grab = true; h.pre()
  const last = h.draw()[0].t
  h.seats.positions[0] = v3(100, -500, 100)
  if (loss === 'eliminated') h.seats.statuses[0] = PlayerStatus.eliminated
  else h.seats.modes[0] = CharMode.parked
  h.pre()
  near(h.draw()[0].t, last)
  assert.deepEqual(h.seats.calls.at(-1), [0, CarryKind.none, -1])
})

test('reset: untouched item resets at resetTicks, not before', async t => {
  const h = await harness(t, [[0, 2, 0.5]], 1)
  for (let i = 0; i < 59; i++) h.step()
  h.pre(); assert.ok(h.draw()[0].t.y < 1)
  h.step(); h.pre()
  near(h.draw()[0].t, v3(0, 2, 0.5))
})

test('reset: below killPlaneY resets immediately', async t => {
  const h = await harness(t)
  h.seats.inputs[0].grab = true; h.pre()
  h.seats.positions[0].y = -20; h.seats.inputs[0].grab = false; h.pre()
  near(h.draw()[0].t, v3(0, 2, 0.5))
})

test('protected home: team 0 cannot pick up inside team 1 home; team 1 can', async t => {
  const h = await harness(t, [[0, 2, 0.5]], 30,
    [{ center: [0, 2, 0.5], half: [1, 1, 1], team: 1 }])
  h.seats.inputs[0].grab = true; h.pre()
  assert.deepEqual(h.seats.calls, [])
  h.seats.positions[1] = v3(0, 2, 0); h.seats.inputs[1].grab = true; h.pre()
  assert.deepEqual(h.seats.calls, [[1, CarryKind.object, 0]])
})

test('botTarget: nearest free item, home when none free, eligible home while carrying', async t => {
  const h = await harness(t, [[0, 2, 0.5], [5, 2, 0]], 30, [
    { center: [1, 2, 0], half: [0.1, 0.1, 0.1], team: 1 },
    { center: [8, 2, 0], half: [1, 1, 1], team: null },
    { center: [12, 2, 0], half: [1, 1, 1], team: 0 },
  ])
  const out = v3(0, 0, 0), target = (i: number) => h.feature.botTarget!(h.seats.seat(i), h.seats.positions[i], out)
  assert.equal(target(0), true); near(out, v3(0, 2, 0.5))
  h.seats.inputs[0].grab = true; h.pre()
  assert.equal(target(0), true); near(out, v3(8, 2, 0))
  assert.equal(h.feature.botTarget!(999, v3(0, 2, 0), out), false)
  const empty = await harness(t, [[0, 2, 0.5]], 30,
    [{ center: [4, 2, 0], half: [1, 1, 1], team: null }])
  empty.seats.inputs[0].grab = true; empty.pre()
  assert.equal(empty.feature.botTarget!(21, v3(0, 2, 0), out), true); near(out, v3(4, 2, 0))
  const noHome = await harness(t)
  noHome.seats.inputs[0].grab = true; noHome.pre()
  assert.equal(noHome.feature.botTarget!(21, v3(0, 2, 0), out), false)
  assert.equal(noHome.feature.botTarget!(20, v3(0, 2, 0), out), false)
})

test('grabCandidates includes only free items in range and facing cone', async t => {
  const h = await harness(t, [[0, 2, 0.25], [0, 2, 0.75], [0, 2, -0.75], [0, 2, 1.1]])
  h.seats.inputs[0].grab = true; h.pre()
  const out: { id: number; dist: number }[] = []
  h.feature.grabCandidates!(v3(0, 2, 0), v3(0, 0, 1), out)
  assert.deepEqual(out, [{ id: 1, dist: 0.75 }])
})

test('QB1: restore tick 60 of 180 reproduces exact snapshot bytes and poses after pickup/drop', async t => {
  const a = await harness(t), b = await harness(t)
  const drive = (h: typeof a, tick: number) => {
    h.seats.inputs[0].grab = tick >= 10 && tick < 90
    h.seats.positions[0] = tick <= 10 ? v3(0, 2, 0) : v3((tick - 10) / 100, 0.35, 0)
    h.step()
  }
  for (let tick = 0; tick < 60; tick++) drive(a, tick)
  assert.equal(a.seats.carry(0), CarryKind.object)
  const checkpoint = a.bytes(), physics = a.physics.takeSnapshot()
  b.physics.restoreSnapshot(physics)
  b.seats.carries = [...a.seats.carries]; b.seats.ids = [...a.seats.ids]
  b.feature.restore(new SnapReader(checkpoint), b.ctx)
  assert.deepEqual(b.bytes(), checkpoint)
  for (let tick = 60; tick < 180; tick++) { drive(a, tick); drive(b, tick) }
  assert.deepEqual(a.sounds, ['move.carry', 'move.release'])
  assert.deepEqual(b.sounds, ['move.release'])
  const expected = a.bytes(), actual = b.bytes()
  assert.equal(actual.length, expected.length)
  for (let i = 0; i < expected.length; i++) assert.equal(actual[i], expected[i], `byte ${i}`)
  assert.deepEqual(b.physics.takeSnapshot(), a.physics.takeSnapshot())
  assert.deepEqual(b.draw(), a.draw())
})

test('pickup conflicts use room seat order even when domain slots are reversed', async t => {
  const h = await harness(t)
  h.seats.seat = i => 21 - i
  h.seats.positions[1] = { ...h.seats.positions[0] }
  h.seats.inputs.forEach(input => { input.grab = true })
  h.pre()
  assert.deepEqual(h.seats.calls, [[1, CarryKind.object, 0]])
})

test('restored holder and held-grab edge follow room identity after slot reorder', async t => {
  const h = await harness(t)
  h.seats.inputs[0].grab = true
  h.pre()
  const saved = h.bytes()
  for (const values of [h.seats.positions, h.seats.velocities, h.seats.directions, h.seats.modes,
    h.seats.statuses, h.seats.teams, h.seats.carries, h.seats.ids, h.seats.inputs, h.seats.protected]) values.reverse()
  h.seats.seat = i => 21 - i
  h.feature.restore(new SnapReader(saved), h.ctx)
  h.seats.positions[1] = v3(4, 2, 0)
  h.pre()
  near(h.draw()[0].t, v3(4, 2.25, 0.55))
  assert.equal(h.seats.carry(1), CarryKind.object)
  assert.deepEqual(h.sounds, ['move.carry'], 'held grab does not pick up again or release')
  h.seats.inputs[1].grab = false
  h.pre()
  assert.deepEqual(h.seats.calls.at(-1), [1, CarryKind.none, -1])
})

test('restore preserves sleeping and spinning carry bodies exactly', async t => {
  const h = await harness(t)
  const id = h.physics.ids().at(-1)!
  const body = h.physics.body(id)
  body.setAngvel(v3(1, 2, 3), true)
  h.step()
  for (const sleeping of [false, true]) {
    if (sleeping) h.physics.body(id).sleep()
    const feature = h.bytes(), physics = h.physics.takeSnapshot()
    h.physics.restoreSnapshot(physics)
    h.feature.restore(new SnapReader(feature), h.ctx)
    assert.deepEqual(h.bytes(), feature)
    assert.deepEqual(h.physics.takeSnapshot(), physics)
  }
})
