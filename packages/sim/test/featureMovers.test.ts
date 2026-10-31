import assert from 'node:assert/strict'
import test from 'node:test'
import { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierModule, RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { initRapier, RapierWorldSim as WorldSim } from '@gamesaloon/rollback-rapier'
import { CHAR, CharMode } from '../src/character/constants.ts'
import type { Checkpoint, FeatureSpec, ResolvedCourse, SpawnPoint } from '../src/course.ts'
import { legacyLevel } from '../src/course.ts'
import { neutralInput } from '../src/input.ts'
import type { PlayerInput } from '../src/input.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'
import { GRAVITY_Y } from '../src/world.ts'
import { boostLaneFeature } from '../src/features/boostLane.ts'
import { catchVolumeFeature, launchPadFeature } from '../src/features/launch.ts'
import { swimVolumeFeature } from '../src/features/swim.ts'
import type { CourseFeature, FeatureCtx, FeatureFactory, FeatureSeats } from '../src/features/feature.ts'
import type { FiestaEventKind } from '../src/zones/ledger.ts'

const R = await initRapier()
const PHYSICS = new WorldSim(R, { gravity: { x: 0, y: GRAVITY_Y, z: 0 } })
const PATH = 'movers#/features/0'

interface VelocityCall { seat: number; v: Vec3 }
interface TeleportCall { seat: number; at: SpawnPoint }
interface SwimCall { seat: number; inside: boolean; drag: number; buoyancy: number }
interface CallLog {
  setVelocity: VelocityCall[]
  teleport: TeleportCall[]
  setSwim: SwimCall[]
  knock: VelocityCall[]
}

class StubSeats implements FeatureSeats {
  readonly count: number
  readonly positions: Vec3[]
  readonly velocities: Vec3[]
  readonly modes: number[]
  readonly statuses: number[]
  readonly teams: number[]
  readonly inputs: PlayerInput[]
  readonly protectedSeats: boolean[]
  readonly calls: CallLog = { setVelocity: [], teleport: [], setSwim: [], knock: [] }
  readonly scratch: Vec3 = v3(0, 0, 0)

  constructor(positions: Vec3[]) {
    this.count = positions.length
    this.positions = positions.map(p => ({ x: p.x, y: p.y, z: p.z }))
    this.velocities = positions.map(() => v3(0, 0, 0))
    this.modes = positions.map(() => CharMode.ground as number)
    this.statuses = positions.map(() => PlayerStatus.alive as number)
    this.teams = positions.map(() => 0)
    this.inputs = positions.map(() => neutralInput())
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
  mode(i: number): number { return this.modes[i] }
  grounded(_i: number): boolean { return this.modes[_i] === CharMode.ground }
  groundCollider(_i: number): number { return -1 }
  status(i: number): number { return this.statuses[i] }
  team(i: number): number { return this.teams[i] }
  input(i: number): PlayerInput { return this.inputs[i] }
  protectedNow(i: number): boolean { return this.protectedSeats[i] }
  setVelocity(i: number, v: Vec3): void {
    this.velocities[i] = { x: v.x, y: v.y, z: v.z }
    this.calls.setVelocity.push({ seat: i, v: { x: v.x, y: v.y, z: v.z } })
  }
  addVelocity(i: number, v: Vec3): void {
    const cur = this.velocities[i]
    this.velocities[i] = { x: cur.x + v.x, y: cur.y + v.y, z: cur.z + v.z }
  }
  teleport(i: number, at: SpawnPoint): void {
    this.positions[i] = { x: at.t.x, y: at.t.y, z: at.t.z }
    this.calls.teleport.push({ seat: i, at: { t: { ...at.t }, facing: { ...at.facing } } })
  }
  kill(i: number): void { this.statuses[i] = PlayerStatus.out }
  setCarry(_i: number, _kind: number, _id: number): void {}
  carry(_i: number): number { return 0 }
  facing(_i: number, out: Vec3): Vec3 { out.x = 0; out.y = 0; out.z = 1; return out }
  setSwim(i: number, inside: boolean, drag: number, buoyancy: number): void {
    this.calls.setSwim.push({ seat: i, inside, drag, buoyancy })
  }
  knock(i: number, v: Vec3): void {
    this.velocities[i] = { x: v.x, y: v.y, z: v.z }
    this.calls.knock.push({ seat: i, v: { x: v.x, y: v.y, z: v.z } })
  }
}

class TestCtx implements FeatureCtx {
  readonly R: RapierModule
  readonly physics: RapierWorldSim
  tick: number
  readonly roundTick: number
  readonly entrants: number
  readonly overtime = false
  readonly trailingTeam: number
  readonly course: ResolvedCourse
  readonly seats: StubSeats
  readonly rng: Rng
  readonly sounds: { id: string; pos: Vec3; strength: number }[] = []
  readonly events: { kind: FiestaEventKind; seat: number; a: number; b: number }[] = []

  constructor(R2: RapierModule, physics: RapierWorldSim, seats: StubSeats, course: ResolvedCourse,
    tick = 0, trailingTeam = -1) {
    this.R = R2
    this.physics = physics
    this.tick = tick
    this.roundTick = tick
    this.entrants = seats.count
    this.trailingTeam = trailingTeam
    this.course = course
    this.seats = seats
    this.rng = new Rng(42).fork(9)
  }

  emit(kind: FiestaEventKind, seat: number, a: number, b: number): void {
    this.events.push({ kind, seat, a, b })
  }
  sound(id: string, pos: Vec3, strength: number): void {
    this.sounds.push({ id, pos: { x: pos.x, y: pos.y, z: pos.z }, strength })
  }
}

function context(seats: StubSeats, course: ResolvedCourse, tick = 0, trailingTeam = -1): TestCtx {
  return new TestCtx(R, PHYSICS, seats, course, tick, trailingTeam)
}

function cp(respawn: Vec3, half: Vec3 = v3(1, 1, 1)): Checkpoint {
  return {
    box: { center: { ...respawn }, half: { ...half } },
    respawn: { t: { ...respawn }, facing: { x: 0, z: 1 } },
  }
}

function courseOf(features: FeatureSpec[], checkpoints: Checkpoint[] = [], stages: number[] = []): ResolvedCourse {
  const course: ResolvedCourse = {
    id: 'movers',
    name: 'Movers',
    kind: 'race',
    profiles: ['standard'],
    timeLimitS: 120,
    killPlaneY: -12,
    spawns: [],
    checkpoints,
    finish: null,
    path: [],
    regions: [],
    queuePad: null,
    obstacles: [],
    contentHash: 0,
    features,
  }
  course.level = { ...legacyLevel(course), route: { ordered: false, laps: 1, stages } }
  return course
}

function spec(kind: string, params: Record<string, unknown>): FeatureSpec {
  return { id: kind, kind, params }
}

function snapshotBytes(feature: { snapshot(w: SnapWriter): void }): Uint8Array {
  const w = new SnapWriter()
  feature.snapshot(w)
  return w.bytes().slice()
}

function callMark(seats: StubSeats): CallLog {
  return {
    setVelocity: seats.calls.setVelocity.slice(),
    teleport: seats.calls.teleport.slice(),
    setSwim: seats.calls.setSwim.slice(),
    knock: seats.calls.knock.slice(),
  }
}

function callsSince(seats: StubSeats, mark: CallLog): CallLog {
  return {
    setVelocity: seats.calls.setVelocity.slice(mark.setVelocity.length),
    teleport: seats.calls.teleport.slice(mark.teleport.length),
    setSwim: seats.calls.setSwim.slice(mark.setSwim.length),
    knock: seats.calls.knock.slice(mark.knock.length),
  }
}

interface SeatState {
  positions: Vec3[]
  velocities: Vec3[]
  modes: number[]
  statuses: number[]
  teams: number[]
  inputs: PlayerInput[]
  protectedSeats: boolean[]
}

function seatState(seats: StubSeats): SeatState {
  return {
    positions: seats.positions.map(p => ({ ...p })),
    velocities: seats.velocities.map(v => ({ ...v })),
    modes: [...seats.modes],
    statuses: [...seats.statuses],
    teams: [...seats.teams],
    inputs: seats.inputs.map(i => ({ ...i })),
    protectedSeats: [...seats.protectedSeats],
  }
}

function applySeatState(seats: StubSeats, state: SeatState): void {
  seats.positions.splice(0, seats.positions.length, ...state.positions.map(p => ({ ...p })))
  seats.velocities.splice(0, seats.velocities.length, ...state.velocities.map(v => ({ ...v })))
  seats.modes.splice(0, seats.modes.length, ...state.modes)
  seats.statuses.splice(0, seats.statuses.length, ...state.statuses)
  seats.teams.splice(0, seats.teams.length, ...state.teams)
  seats.inputs.splice(0, seats.inputs.length, ...state.inputs.map(i => ({ ...i })))
  seats.protectedSeats.splice(0, seats.protectedSeats.length, ...state.protectedSeats)
}

const BOOST_PARAMS = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  center: [0, 0, 0], half: [5, 5, 5], yawDeg: 0, boost: 4,
  durationS: 0.5, rechargeS: 2, eligibility: 'all', ...overrides,
})

function step(feature: CourseFeature, ctx: TestCtx, tick: number): void {
  ctx.tick = tick
  feature.preStep(ctx)
  feature.postStep(ctx)
}

test('boostLane: an eligible seat gains planar speed above maxRun within durationTicks and none after', () => {
  const s = spec('boostLane', BOOST_PARAMS())
  const seats = new StubSeats([v3(0, 0, 0)])
  seats.inputs[0] = { ...neutralInput(), moveZ: 1 }
  const ctx = context(seats, courseOf([s]))
  const feature = boostLaneFeature(s, PATH)
  feature.init(ctx)

  for (let tick = 0; tick < 30; tick++) step(feature, ctx, tick)
  const boosted = seats.calls.setVelocity
  assert.equal(boosted.length, 30)
  let peak = 0
  for (const call of boosted) peak = Math.max(peak, Math.hypot(call.v.x, call.v.z))
  assert.ok(peak > CHAR.maxRun + 0.5, `peak ${peak} exceeds maxRun ${CHAR.maxRun}`)
  assert.equal(ctx.sounds.length, 1)
  assert.equal(ctx.sounds[0].id, 'mech.boost')
  assert.deepEqual(ctx.sounds[0].pos, v3(0, 0, 0))

  const before = seats.calls.setVelocity.length
  for (let tick = 30; tick < 90; tick++) step(feature, ctx, tick)
  assert.equal(seats.calls.setVelocity.length, before)
  assert.equal(ctx.sounds.length, 1)
})

test('boostLane: it is not re-boosted before rechargeTicks', () => {
  const s = spec('boostLane', BOOST_PARAMS({ rechargeS: 2 }))
  const seats = new StubSeats([v3(0, 0, 0)])
  seats.inputs[0] = { ...neutralInput(), moveZ: 1 }
  const ctx = context(seats, courseOf([s]))
  const feature = boostLaneFeature(s, PATH)
  feature.init(ctx)

  for (let tick = 0; tick < 150; tick++) step(feature, ctx, tick)
  const before = seats.calls.setVelocity.length
  assert.equal(before, 30)
  assert.equal(ctx.sounds.length, 1)

  step(feature, ctx, 150)
  assert.equal(ctx.sounds.length, 2)
  assert.equal(seats.calls.setVelocity.length, before + 1)
})

test("boostLane: a 'trailingTeam' lane ignores the leading team", () => {
  const s = spec('boostLane', BOOST_PARAMS({ eligibility: 'trailingTeam' }))
  const seats = new StubSeats([v3(0, 0, 0), v3(1, 0, 0)])
  seats.teams[0] = 0
  seats.teams[1] = 1
  seats.inputs[0] = { ...neutralInput(), moveZ: 1 }
  seats.inputs[1] = { ...neutralInput(), moveZ: 1 }
  const ctx = context(seats, courseOf([s]), 0, 1)
  const feature = boostLaneFeature(s, PATH)
  feature.init(ctx)
  step(feature, ctx, 0)

  assert.equal(seats.calls.setVelocity.filter(call => call.seat === 0).length, 0)
  assert.ok(seats.calls.setVelocity.some(call => call.seat === 1))
  assert.equal(ctx.sounds.length, 1)
  assert.deepEqual(ctx.sounds[0].pos, v3(1, 0, 0))
})

test('boostLane: a bad eligibility is refused', () => {
  const s = spec('boostLane', BOOST_PARAMS({ eligibility: 'nobody' }))
  assert.throws(() => boostLaneFeature(s, PATH), (error: unknown) => {
    const refusal = error as { name: string; area: string; path: string }
    assert.equal(refusal.name, 'RefusalError')
    assert.equal(refusal.area, 'feature')
    assert.equal(refusal.path, `${PATH}/eligibility`)
    return true
  })
})

test('launchPad: the ballistic velocity passes the target and reaches apexY', () => {
  const start = v3(0, 1, 0)
  const target = v3(10, 1, 0)
  const s = spec('launchPad', {
    center: [0, 1, 0], half: [1, 1, 1], target: [10, 1, 0], apexM: 3,
  })
  const seats = new StubSeats([start])
  const ctx = context(seats, courseOf([s]))
  const feature = launchPadFeature(s, PATH)
  feature.init(ctx)
  step(feature, ctx, 0)

  assert.equal(ctx.sounds.length, 1)
  assert.equal(ctx.sounds[0].id, 'mech.launch')
  const v = seats.velocities[0]

  const g = Math.abs(GRAVITY_Y)
  const apexY = Math.max(start.y, target.y) + 3
  let apex = -Infinity
  let closest = Infinity
  for (let t = 0; t <= 2; t += 1 / 6000) {
    const x = start.x + v.x * t
    const y = start.y + v.y * t - 0.5 * g * t * t
    const z = start.z + v.z * t
    apex = Math.max(apex, y)
    closest = Math.min(closest, Math.hypot(x - target.x, y - target.y, z - target.z))
  }
  assert.ok(Math.abs(apex - apexY) <= 0.05, `apex ${apex} vs ${apexY}`)
  assert.ok(closest <= 0.05, `closest ${closest}`)
})

test('launchPad: recoverOnly ignores other stages and fires after a protectedNow edge in its stage', () => {
  const cps = [cp(v3(0, 0, 0)), cp(v3(10, 0, 10))]
  const s = spec('launchPad', {
    center: [12, 0, 10], half: [1, 1, 1], target: [20, 0, 10], apexM: 2, recoverOnly: true,
  })
  const seats = new StubSeats([v3(10, 0, 10), v3(0, 0, 0)])
  const ctx = context(seats, courseOf([s], cps, [0, 1]))
  const feature = launchPadFeature(s, PATH)
  feature.init(ctx)

  step(feature, ctx, 0)
  assert.equal(seats.calls.setVelocity.length, 0)

  seats.protectedSeats[0] = true
  seats.protectedSeats[1] = true
  step(feature, ctx, 1)
  assert.equal(seats.calls.setVelocity.length, 0)

  seats.positions[0] = v3(12, 0, 10)
  seats.positions[1] = v3(12, 0, 10)
  step(feature, ctx, 2)
  assert.deepEqual(seats.calls.setVelocity.map(call => call.seat), [0])
  assert.equal(ctx.sounds.length, 1)

  step(feature, ctx, 3)
  assert.equal(seats.calls.setVelocity.length, 1)
})

test('launchPad: botTarget returns the pad, then false once the seat is past, and the target during flight', () => {
  const s = spec('launchPad', {
    center: [0, 0, 0], half: [1, 1, 1], target: [10, 0, 0], apexM: 2,
  })
  const seats = new StubSeats([v3(-5, 0, 0)])
  const ctx = context(seats, courseOf([s]))
  const feature = launchPadFeature(s, PATH)
  feature.init(ctx)
  const out = v3(0, 0, 0)
  assert.equal(feature.botTarget?.(0, seats.positions[0], out), true)
  assert.deepEqual(out, v3(0, 0, 0))
  seats.positions[0] = v3(20, 0, 0)
  assert.equal(feature.botTarget?.(0, seats.positions[0], out), false)

  const flying = new StubSeats([v3(0, 0, 0)])
  const flyingCtx = context(flying, courseOf([s]))
  const pad = launchPadFeature(s, PATH)
  pad.init(flyingCtx)
  step(pad, flyingCtx, 0)
  assert.equal(flying.calls.setVelocity.length, 1)
  const flightOut = v3(0, 0, 0)
  assert.equal(pad.botTarget?.(0, v3(20, 0, 0), flightOut), true)
  assert.deepEqual(flightOut, v3(10, 0, 0))
})

test('catchVolume: an entering seat is teleported to the respawn of its stage', () => {
  const cps = [cp(v3(1, 2, 3)), cp(v3(4, 5, 6))]
  const s = spec('catchVolume', { center: [0, 0, 0], half: [2, 1, 2], respawnStage: 1 })
  const seats = new StubSeats([v3(10, 0, 0)])
  const ctx = context(seats, courseOf([s], cps, [0, 1]))
  const feature = catchVolumeFeature(s, PATH)
  feature.init(ctx)
  step(feature, ctx, 0)
  assert.equal(seats.calls.teleport.length, 0)

  seats.positions[0] = v3(0, 0, 0)
  step(feature, ctx, 1)
  assert.deepEqual(seats.calls.teleport, [{ seat: 0, at: cps[1].respawn }])
})

test('catchVolume: a missing stage is refused at init', () => {
  const cps = [cp(v3(1, 2, 3)), cp(v3(4, 5, 6))]
  const s = spec('catchVolume', { center: [0, 0, 0], half: [2, 1, 2], respawnStage: 5 })
  const seats = new StubSeats([v3(0, 0, 0)])
  const ctx = context(seats, courseOf([s], cps, [0, 1]))
  const feature = catchVolumeFeature(s, PATH)
  assert.throws(() => feature.init(ctx), (error: unknown) => {
    const refusal = error as { name: string; area: string; path: string; message: string }
    assert.equal(refusal.name, 'RefusalError')
    assert.equal(refusal.area, 'feature')
    assert.equal(refusal.path, `${PATH}/respawnStage`)
    assert.match(refusal.message, /no checkpoint/)
    return true
  })
})

test('swimVolume: setSwim while inside and false on exit, and botTarget only while inside', () => {
  const s = spec('swimVolume', { center: [0, 0, 0], half: [2, 2, 2], drag: 3, buoyancy: 22 })
  const seats = new StubSeats([v3(0, 0, 0)])
  const ctx = context(seats, courseOf([s]))
  const feature = swimVolumeFeature(s, PATH)
  feature.init(ctx)
  const out = v3(0, 0, 0)
  assert.equal(feature.botTarget?.(0, seats.positions[0], out), false)

  step(feature, ctx, 0)
  assert.deepEqual(seats.calls.setSwim, [{ seat: 0, inside: true, drag: 3, buoyancy: 22 }])
  assert.equal(feature.botTarget?.(0, seats.positions[0], out), true)
  assert.deepEqual(out, v3(0, 2, 2.5))

  seats.positions[0] = v3(10, 0, 0)
  step(feature, ctx, 1)
  assert.deepEqual(seats.calls.setSwim[1], { seat: 0, inside: false, drag: 0, buoyancy: 0 })
  assert.equal(seats.calls.setSwim.length, 2)
  assert.equal(feature.botTarget?.(0, seats.positions[0], out), false)
})

interface Plan {
  factory: FeatureFactory
  spec: FeatureSpec
  course: ResolvedCourse
  makeSeats: () => StubSeats
  evolve: (tick: number, seats: StubSeats) => void
}

function runTick(feature: CourseFeature, ctx: TestCtx, plan: Plan, tick: number): void {
  plan.evolve(tick, ctx.seats)
  step(feature, ctx, tick)
}

test('snapshot -> restore is identical per feature (QB1)', () => {
  const plans: { name: string; plan: Plan }[] = []

  const boostSpec = spec('boostLane', BOOST_PARAMS({ durationS: 2, rechargeS: 5 }))
  plans.push({
    name: 'boostLane',
    plan: {
      factory: boostLaneFeature,
      spec: boostSpec,
      course: courseOf([boostSpec]),
      makeSeats: () => {
        const seats = new StubSeats([v3(0, 0, 0)])
        seats.inputs[0] = { ...neutralInput(), moveZ: 1 }
        return seats
      },
      evolve: () => {},
    },
  })

  const launchSpec = spec('launchPad', {
    center: [12, 0, 10], half: [1, 1, 1], target: [20, 0, 10], apexM: 2, recoverOnly: true,
  })
  const launchCourse = courseOf([launchSpec], [cp(v3(0, 0, 0)), cp(v3(10, 0, 10))], [0, 1])
  plans.push({
    name: 'launchPad',
    plan: {
      factory: launchPadFeature,
      spec: launchSpec,
      course: launchCourse,
      makeSeats: () => new StubSeats([v3(10, 0, 10)]),
      evolve: (tick, seats) => {
        seats.protectedSeats[0] = tick >= 10
        seats.positions[0] = tick >= 70 ? v3(12, 0, 10) : tick >= 20 ? v3(0, 0, 0) : v3(10, 0, 10)
      },
    },
  })

  const catchSpec = spec('catchVolume', { center: [0, 0, 0], half: [2, 2, 2], respawnStage: 1 })
  const catchCourse = courseOf([catchSpec], [cp(v3(1, 2, 3)), cp(v3(4, 5, 6))], [0, 1])
  plans.push({
    name: 'catchVolume',
    plan: {
      factory: catchVolumeFeature,
      spec: catchSpec,
      course: catchCourse,
      makeSeats: () => new StubSeats([v3(10, 0, 0)]),
      evolve: (tick, seats) => {
        const inside = (tick >= 40 && tick < 80) || tick >= 100
        seats.positions[0] = inside ? v3(0, 0, 0) : v3(10, 0, 0)
      },
    },
  })

  const swimSpec = spec('swimVolume', { center: [0, 0, 0], half: [2, 2, 2], drag: 3, buoyancy: 22 })
  plans.push({
    name: 'swimVolume',
    plan: {
      factory: swimVolumeFeature,
      spec: swimSpec,
      course: courseOf([swimSpec]),
      makeSeats: () => new StubSeats([v3(0, 0, 0)]),
      evolve: (tick, seats) => {
        const inside = tick < 70 || tick >= 90
        seats.positions[0] = inside ? v3(0, 0, 0) : v3(10, 0, 0)
      },
    },
  })

  for (const entry of plans) {
    const plan = entry.plan
    const seatsA = plan.makeSeats()
    const ctxA = context(seatsA, plan.course)
    const featureA = plan.factory(plan.spec, PATH)
    featureA.init(ctxA)
    let snap: Uint8Array | null = null
    let markA: CallLog | null = null
    let stateA: SeatState | null = null
    for (let tick = 0; tick < 120; tick++) {
      if (tick === 60) {
        snap = snapshotBytes(featureA)
        markA = callMark(seatsA)
        stateA = seatState(seatsA)
      }
      runTick(featureA, ctxA, plan, tick)
    }

    assert.ok(snap !== null && markA !== null && stateA !== null, `${entry.name}: snapshot at tick 60`)
    const seatsB = plan.makeSeats()
    applySeatState(seatsB, stateA)
    const ctxB = context(seatsB, plan.course, 60)
    const featureB = plan.factory(plan.spec, PATH)
    featureB.init(ctxB)
    const reader = new SnapReader(snap)
    featureB.restore(reader, ctxB)
    assert.equal(reader.remaining, 0, `${entry.name}: restore consumes the snapshot`)
    const markB = callMark(seatsB)
    for (let tick = 60; tick < 120; tick++) runTick(featureB, ctxB, plan, tick)

    const afterA = callsSince(seatsA, markA)
    const afterB = callsSince(seatsB, markB)
    assert.deepEqual(afterA, afterB, `${entry.name}: recorded calls`)
    assert.ok(afterA.setVelocity.length + afterA.teleport.length + afterA.setSwim.length > 0,
      `${entry.name}: continuation has recorded calls`)
    assert.deepEqual(snapshotBytes(featureA), snapshotBytes(featureB), `${entry.name}: final snapshot bytes`)
  }
})
