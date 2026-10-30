import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { DomainSpec, ShadowView } from '@gamesaloon/rollback/zones'
import { initRapier, mergeEntityStreams } from '@gamesaloon/rollback-rapier'
import { CharMode } from '../src/character/constants.ts'
import type { Motion, ObstacleSpec, ResolvedCourse } from '../src/course.ts'
import { inBox } from '../src/course.ts'
import { neutralInput } from '../src/input.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { PROFILES } from '../src/match/setup.ts'
import { motionPose } from '../src/obstacles/motion.ts'
import { pose, quatIdentity, v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'
import { readBlob } from '../src/world.ts'
import { cellOf } from '../src/zones/cells.ts'
import { FiestaDomain } from '../src/zones/fiestaDomain.ts'
import { createFiestaDomainFactory } from '../src/zones/fiestaDomainFactory.ts'
import { decodeFiestaEvents } from '../src/zones/ledger.ts'
import type { FiestaEvent } from '../src/zones/ledger.ts'
import { parseZonesFile, ZONES_FORMAT, ZONES_VERSION } from '../src/zones/zonesFile.ts'

function obstacle(id: string, t: Vec3, half: Vec3, motion: Motion): ObstacleSpec {
  return { id, asset: id, t, r: quatIdentity(), s: v3(1, 1, 1), friction: 0.5, motion,
    colliders: [{ shape: 'cuboid', half, t: v3(0, 0, 0), r: quatIdentity() }] }
}

const course: ResolvedCourse = {
  id: 'domain-race', name: 'domain-race', kind: 'race', profiles: ['sprint'],
  timeLimitS: 60, killPlaneY: -10, contentHash: 1,
  spawns: [-6, 6, -3, 3].map(x => ({ t: v3(x, 0, 1), facing: { x: 0, z: 1 } })),
  checkpoints: [{ box: { center: v3(0, 1, 6), half: v3(12, 3, 1) },
    respawn: { t: v3(0, 0, 6), facing: { x: 0, z: 1 } } }],
  finish: { center: v3(0, 1, 15), half: v3(12, 3, 1) },
  path: [{ p: v3(0, 0, 15), jump: false, dive: false }],
  regions: [], queuePad: null,
  obstacles: [
    obstacle('floor', v3(0, -0.5, 8), v3(15, 0.5, 18), { kind: 'static' }),
    obstacle('spinner', v3(-9, 1, 8), v3(2, 0.2, 0.2),
      { kind: 'spinner', axis: v3(0, 1, 0), radPerTick: 0.04, phase: 0.2 }),
    obstacle('platform', v3(8, 1, 8), v3(2, 0.2, 2),
      { kind: 'movingPlatform', offset: v3(0, 2, 0), periodTicks: 120, phase: 0.3, wave: 'sine' }),
    obstacle('seesaw', v3(6, 1, 4), v3(2, 0.2, 2),
      { kind: 'seesaw', axis: v3(0, 0, 1), maxAngle: 0.5, spring: 10, damping: 2, inertia: 20 }),
  ],
}
const zones = parseZonesFile({ format: ZONES_FORMAT, version: ZONES_VERSION, course: course.id,
  grid: { origin: [-20, -10], cell: [20, 40], cols: 2, rows: 1 }, parts: {}, tuning: {},
}, 'inline.zones', course)
const R = await initRapier()
const factory = createFiestaDomainFactory(R, {
  course, zones, profile: { ...PROFILES.sprint, introTicks: 0 }, kind: 'race', seatCount: 4,
})
const noShadows: ShadowView = {
  count: 0, fromDomain() { throw new Error('no link') }, reader() { throw new Error('no link') },
}
const left = spec([0], [0])
const right = spec([1], [1])
const together = spec([0, 1], [0, 1])
const seesawIndex = 3

function spec(seats: number[], cells: number[]): DomainSpec {
  return { id: seats.length ? seats[0] + 1 : 5 + cells[0], kind: seats.length ? 'seat' : 'field',
    seats, cells, replicas: [0, 1] }
}

function track(t: TestContext, domain: unknown): FiestaDomain {
  assert.ok(domain instanceof FiestaDomain)
  t.after(() => domain.inner.world.sim.free())
  return domain
}

function exported(domain: FiestaDomain): SnapReader {
  const w = new SnapWriter()
  domain.exportEntities(w)
  return new SnapReader(w.bytes().slice())
}

function seatState(domain: FiestaDomain, seat: number) {
  return { ...structuredClone(domain.state(seat)), status: domain.status(seat) }
}

function seesawState(domain: FiestaDomain) {
  return domain.obstacles.seesawState(seesawIndex, { angle: 0, prevAngle: 0, angVel: 0 })
}

// Seed a valid handoff trailer with non-default gameplay state, independently of physics contacts.
function seedSeat(domain: FiestaDomain, seat: number, mode: number, knockbacks: number,
  status: number): void {
  const w = new SnapWriter()
  w.u8(mode)
  w.i32(9) // mode timer
  w.u8(0) // coyote
  w.u8(0) // jump buffer
  w.u8(0) // previous buttons
  w.u8(0) // dive used
  w.u8(255) // no grab target
  w.u16(0) // grab ticks
  w.u16(0) // grab cooldown
  w.f64(0)
  w.f64(1)
  w.u8(0) // grounded
  w.i16(-1) // ground obstacle
  w.u16(knockbacks)
  w.i32(domain.tick - 1)
  w.u8(0) // frozen
  w.u8(status === PlayerStatus.alive ? 0 : 1)
  w.i16(-1) // ground item
  w.i16(-1) // ground body
  w.i16(-1) // grab lever
  w.u8(status)
  w.i16(0) // checkpoint reached
  domain.readSeat(new SnapReader(w.bytes()), seat)
}

function stepApart(a: FiestaDomain, b: FiestaDomain): void {
  for (let tick = 0; tick < 20; tick++) {
    a.step([{ ...neutralInput(), moveX: -1 }], noShadows)
    b.step([{ ...neutralInput(), moveZ: 1 }], noShadows)
  }
  seedSeat(a, 0, CharMode.stunned, 3, PlayerStatus.alive)
  seedSeat(b, 1, CharMode.parked, 7, PlayerStatus.qualified)
  assert.notDeepEqual(a.state(0).pos, b.state(1).pos)
  assert.notDeepEqual(a.state(0).vel, b.state(1).vel)
}

test('replicas agree on each domain hash after every confirmed input tick', t => {
  for (const domainSpec of [left, right, spec([], [1])]) {
    const a = track(t, factory.create(domainSpec, 0))
    const b = track(t, factory.create(domainSpec, 0))
    for (let tick = 0; tick < 90; tick++) {
      const inputs = domainSpec.seats.map(() => ({ ...neutralInput(), moveZ: 1,
        jump: tick === 20, dive: tick === 35 }))
      a.step(inputs, noShadows)
      b.step(inputs, noShadows)
      assert.equal(a.tick, tick + 1)
      assert.equal(b.hash(), a.hash(), `domain ${domainSpec.id}, confirmed tick ${a.tick}`)
      for (const seat of domainSpec.seats) assert.deepEqual(seatState(b, seat), seatState(a, seat))
    }
  }
})

test('snapshot restore and replay agree with an uninterrupted replica', t => {
  const a = track(t, factory.create(together, 0))
  const b = track(t, factory.create(together, 0))
  const inputs = [neutralInput(), { ...neutralInput(), moveZ: 1 }]
  for (let i = 0; i < 12; i++) a.step(inputs, noShadows)
  const w = new SnapWriter()
  a.snapshot(w)
  b.restore(new SnapReader(w.bytes()))
  assert.equal(b.tick, a.tick)
  for (let i = 0; i < 20; i++) {
    a.step(inputs, noShadows)
    b.step(inputs, noShadows)
    assert.equal(b.hash(), a.hash())
    for (const seat of together.seats) assert.deepEqual(seatState(b, seat), seatState(a, seat))
  }
})

test('merge keeps both seats and takes the seesaw state from its owning cell', t => {
  const a = track(t, factory.create(left, 0))
  const b = track(t, factory.create(right, 0))
  stepApart(a, b)
  assert.equal(cellOf(zones.grid, course.obstacles[seesawIndex].t.x,
    course.obstacles[seesawIndex].t.z), right.cells[0])
  a.obstacles.setSeesawState(seesawIndex, -0.3, -0.2, -0.1)
  b.obstacles.setSeesawState(seesawIndex, 0.25, 0.2, 0.15)
  // The non-owner comes first: its local copy must not win the merge.
  const merged = track(t, factory.rebuild(together, a.tick, [exported(a), exported(b)]))
  assert.equal(merged.tick, a.tick)
  assert.deepEqual(merged.seats, [0, 1])
  assert.deepEqual(seatState(merged, 0), seatState(a, 0))
  assert.deepEqual(seatState(merged, 1), seatState(b, 1))
  assert.deepEqual(seesawState(merged), seesawState(b))
})

test('split keeps each seat state and transfers the seesaw only to its owner', t => {
  const source = track(t, factory.create(together, 0))
  for (let i = 0; i < 20; i++) source.step([
    { ...neutralInput(), moveX: -1 }, { ...neutralInput(), moveZ: 1 },
  ], noShadows)
  seedSeat(source, 0, CharMode.stunned, 4, PlayerStatus.alive)
  seedSeat(source, 1, CharMode.parked, 9, PlayerStatus.eliminated)
  source.obstacles.setSeesawState(seesawIndex, 0.3, 0.25, 0.1)
  for (const domainSpec of [left, right]) {
    const split = track(t, factory.rebuild(domainSpec, source.tick, [exported(source)]))
    const seat = domainSpec.seats[0]
    assert.equal(split.tick, source.tick)
    assert.deepEqual(split.seats, [seat])
    assert.deepEqual(seatState(split, seat), seatState(source, seat))
    assert.deepEqual(seesawState(split), seat === 1 ? seesawState(source)
      : { angle: 0, prevAngle: 0, angVel: 0 })
    const records = mergeEntityStreams([new SnapReader(readBlob(exported(split)))]).entities
    assert.deepEqual(records.map(record => record.owner), [seat])
  }
})

test('a rebuilt live seat keeps falling and colliding like the source', t => {
  const source = track(t, factory.create(left, 0))
  // Airborne and rising: a body rebuilt without gravity would keep this velocity forever.
  for (let i = 0; i < 70; i++) source.step([{ ...neutralInput(), jump: i === 65 }], noShadows)
  const rebuilt = track(t, factory.rebuild(left, source.tick, [exported(source)]))
  const body = (domain: FiestaDomain) => domain.inner.world.sim.body(domain.inner.world.bodyOf(1))
  assert.equal(body(rebuilt).gravityScale(), body(source).gravityScale())
  assert.equal(body(rebuilt).collider(0).collisionGroups(), body(source).collider(0).collisionGroups())
  for (let i = 0; i < 30; i++) {
    source.step([neutralInput()], noShadows)
    rebuilt.step([neutralInput()], noShadows)
  }
  assert.deepEqual(rebuilt.state(0).pos, source.state(0).pos)
})

test('a seat no source carries (its replicas were lost) is rebuilt at its spawn, live, on every replica', t => {
  const a = track(t, factory.create(left, 0))
  for (let tick = 0; tick < 20; tick++) a.step([{ ...neutralInput(), moveX: -1 }], noShadows)
  // The export of `right` never arrives: seat 1 has no body in any source.
  const merged = track(t, factory.rebuild(together, a.tick, [exported(a)]))
  const again = track(t, factory.rebuild(together, a.tick, [exported(a)]))
  const fresh = track(t, factory.create(together, a.tick))
  assert.deepEqual(merged.seats, [0, 1])
  assert.deepEqual(seatState(merged, 0), seatState(a, 0))
  assert.deepEqual(merged.state(1).pos, fresh.state(1).pos)
  assert.equal(merged.status(1), PlayerStatus.alive)
  const body = (domain: FiestaDomain) => domain.inner.world.sim.body(domain.inner.world.bodyOf(2))
  assert.equal(body(merged).gravityScale(), body(fresh).gravityScale())
  assert.equal(body(merged).collider(0).collisionGroups(), body(fresh).collider(0).collisionGroups())
  assert.equal(again.hash(), merged.hash())
  for (let i = 0; i < 10; i++) {
    merged.step([neutralInput(), neutralInput()], noShadows)
    again.step([neutralInput(), neutralInput()], noShadows)
  }
  assert.equal(again.hash(), merged.hash())
})


test('a zero-length shadow reader is skipped without changing the simulation', t => {
  const a = track(t, factory.create(left, 0))
  const b = track(t, factory.create(left, 0))
  let reads = 0
  const empty: ShadowView = {
    count: 1, fromDomain: () => right.id,
    reader() { reads++; return new SnapReader(new Uint8Array(0)) },
  }
  for (let tick = 0; tick < 5; tick++) {
    a.step([neutralInput()], empty)
    b.step([neutralInput()], noShadows)
    assert.equal(a.hash(), b.hash())
    assert.deepEqual(seatState(a, 0), seatState(b, 0))
  }
  assert.equal(reads, 5)
})

function assertKinematics(domain: FiestaDomain): void {
  for (const index of [1, 2]) {
    const expected = motionPose(course.obstacles[index], domain.tick, 0, pose())
    const body = domain.ctx.physics.body(domain.obstacles.bodyId(index))
    const actualT = body.translation()
    const actualR = body.rotation()
    // Rapier stores body poses as f32; motionPose evaluates in JS doubles.
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(Math.abs(actualT[axis] - expected.t[axis]) < 1e-5,
        `${course.obstacles[index].id} translation ${axis} at ${domain.tick}`)
    }
    for (const axis of ['x', 'y', 'z', 'w'] as const) {
      assert.ok(Math.abs(actualR[axis] - expected.r[axis]) < 1e-5,
        `${course.obstacles[index].id} rotation ${axis} at ${domain.tick}`)
    }
  }
  const records = mergeEntityStreams([new SnapReader(readBlob(exported(domain)))])
  assert.deepEqual(records.entities.map(record => [record.id, record.owner]),
    domain.seats.map(seat => [seat + 1, seat]))
  assert.equal(records.joints.length, 0)
}

test('kinematic poses follow the absolute tick in every domain and are never exported', t => {
  for (const domainSpec of [left, right, together, spec([], [1])]) {
    const domain = track(t, factory.create(domainSpec, 37))
    assertKinematics(domain)
    for (let i = 0; i < 8; i++) {
      domain.step(domain.seats.map(() => neutralInput()), noShadows)
      assertKinematics(domain)
    }
    const rebuilt = track(t, factory.rebuild(domainSpec, domain.tick, [exported(domain)]))
    assertKinematics(rebuilt)
    rebuilt.step(rebuilt.seats.map(() => neutralInput()), noShadows)
    assertKinematics(rebuilt)
  }
})

test('crossing the finish emits exactly one finish event through the ledger codec', t => {
  const domain = track(t, factory.create(left, 0))
  domain.characters.place(domain.ctx, 0, { t: v3(-6, 0, 13.8), facing: { x: 0, z: 1 } })
  assert.ok(course.finish)
  assert.equal(inBox(course.finish, domain.state(0).pos), false)
  const events: FiestaEvent[] = []
  let crossingTick = -1
  for (let i = 0; i < 60; i++) {
    const tick = domain.tick
    domain.step([{ ...neutralInput(), moveZ: 1 }], noShadows)
    if (crossingTick < 0 && domain.status(0) === PlayerStatus.qualified) crossingTick = tick
    const w = new SnapWriter()
    domain.events(w)
    const r = new SnapReader(w.bytes())
    assert.equal(decodeFiestaEvents(r, { kind: 'fall', seat: -1, tick: -1 },
      event => events.push({ ...event })), true)
    assert.equal(r.remaining, 0)
  }
  assert.ok(crossingTick >= 0, 'the seat crossed the finish')
  assert.deepEqual(events, [{ kind: 'finish', seat: 0, tick: crossingTick }])
  assert.equal(domain.status(0), PlayerStatus.qualified)
})
