import assert from 'node:assert/strict'
import test from 'node:test'
import { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier, RapierWorldSim } from '@gamesaloon/rollback-rapier'
import type { FeatureCtx, FeatureDraw, FeatureSeats, FeatureSound } from '../src/features/feature.ts'
import type { ResolvedCourse } from '../src/course.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { sweepFeature } from '../src/features/sweeps.ts'

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
