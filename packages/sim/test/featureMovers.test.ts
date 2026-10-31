import assert from 'node:assert/strict'
import test from 'node:test'
import { Rng, SnapReader, SnapWriter, fnv1a32 } from '@gamesaloon/rollback'
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
import { carryItemFeature } from '../src/features/carry.ts'
import { boostLaneFeature } from '../src/features/boostLane.ts'
import { doorBankFeature } from '../src/features/doorBank.ts'
import { catchVolumeFeature, launchPadFeature } from '../src/features/launch.ts'
import { rollingLogFeature } from '../src/features/rollingLog.ts'
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
  readonly carries: number[]
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
    this.carries = positions.map(() => 0)
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
  setCarry(i: number, kind: number, _id: number): void { this.carries[i] = kind }
  carry(i: number): number { return this.carries[i] }
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
    tick = 0, trailingTeam = -1, rng?: Rng) {
    this.R = R2
    this.physics = physics
    this.tick = tick
    this.roundTick = tick
    this.entrants = seats.count
    this.trailingTeam = trailingTeam
    this.course = course
    this.seats = seats
    this.rng = rng ?? new Rng(42).fork(9)
  }

  emit(kind: FiestaEventKind, seat: number, a: number, b: number): void {
    this.events.push({ kind, seat, a, b })
  }
  sound(id: string, pos: Vec3, strength: number): void {
    this.sounds.push({ id, pos: { x: pos.x, y: pos.y, z: pos.z }, strength })
  }
}

function context(seats: StubSeats, course: ResolvedCourse, tick = 0, trailingTeam = -1, rng?: Rng): TestCtx {
  return new TestCtx(R, PHYSICS, seats, course, tick, trailingTeam, rng)
}

function featureRng(seed: number, id: string): Rng {
  return new Rng(seed).fork(fnv1a32(new TextEncoder().encode(id)))
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

interface DoorState { solid: boolean; open: boolean; revealed: boolean; openTick: number }

function doorStates(feature: CourseFeature): DoorState[] {
  const reader = new SnapReader(snapshotBytes(feature))
  const out: DoorState[] = []
  while (reader.remaining > 0) {
    out.push({
      solid: reader.u8() !== 0,
      open: reader.u8() !== 0,
      revealed: reader.u8() !== 0,
      openTick: reader.i32(),
    })
  }
  return out
}

function doorAt(x: number, z = 10): Record<string, unknown> {
  return { t: [x, 1, z], yawDeg: 0, size: [2, 2, 0.6] }
}

function bodiesSince(ctx: TestCtx, base: number): number[] {
  return ctx.physics.ids().slice(base)
}

function colliderFlags(ctx: TestCtx, base: number): boolean[] {
  return bodiesSince(ctx, base).map(id => ctx.physics.body(id).collider(0).isEnabled())
}

function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`)
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
  carries: number[]
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
    carries: [...seats.carries],
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
  seats.carries.splice(0, seats.carries.length, ...state.carries)
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

test('catchVolume: zone membership changes remain deterministic across restore', () => {
  const s = spec('catchVolume', { center: [0, 0, 0], half: [2, 1, 2], respawnStage: 0 })
  // A respawn inside the volume keeps occupancy set, exposing slot reuse bugs.
  const course = courseOf([s], [cp(v3(0, 0, 0))], [0])
  const members = (ids: number[]): StubSeats => {
    const seats = new StubSeats(ids.map(() => v3(0, 0, 0)))
    seats.seat = i => ids[i]
    return seats
  }
  const original = catchVolumeFeature(s, PATH)
  const initial = context(members([10, 20]), course)
  original.init(initial)
  original.preStep(initial)
  assert.equal(initial.seats.calls.teleport.length, 2)
  const saved = snapshotBytes(original)
  const restored = catchVolumeFeature(s, PATH)
  restored.init(initial)
  restored.restore(new SnapReader(saved), initial)

  for (const feature of [original, restored]) {
    // Seat 10 leaves; seat 30 enters its slot without changing the count.
    const replaced = context(members([30, 20]), course, 1)
    feature.preStep(replaced)
    assert.deepEqual(replaced.seats.calls.teleport.map(c => replaced.seats.seat(c.seat)), [30])
    // Shrink between pre/post, then grow and reorder surviving seats.
    const shrunk = context(members([20]), course, 1)
    feature.postStep(shrunk)
    assert.equal(shrunk.seats.calls.teleport.length, 0)
    const grown = context(members([40, 20, 50]), course, 2)
    feature.preStep(grown)
    assert.deepEqual(grown.seats.calls.teleport.map(c => grown.seats.seat(c.seat)), [40, 50])
    grown.seats.positions[1] = v3(10, 0, 0)
    feature.postStep(grown)
    grown.seats.positions[1] = v3(0, 0, 0)
    feature.preStep(grown)
    assert.deepEqual(grown.seats.calls.teleport.map(c => grown.seats.seat(c.seat)), [40, 50, 20])
    feature.postStep(context(members([]), course, 3))
  }
  assert.deepEqual(snapshotBytes(original), snapshotBytes(restored))
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

function swimInsideStates(feature: CourseFeature): number[] {
  const reader = new SnapReader(snapshotBytes(feature))
  const count = reader.u16()
  const states: number[] = []
  for (let i = 0; i < count; i++) {
    assert.equal(reader.u16(), i, 'swim state retains the room seat identity')
    states.push(reader.u8())
  }
  assert.equal(reader.remaining, 0, 'swim snapshot consumes exactly its state')
  return states
}

function swimRig(count: number, insideSeats: number[]): { seats: StubSeats; ctx: TestCtx; feature: CourseFeature } {
  const inside = new Set(insideSeats)
  const seats = new StubSeats(Array.from({ length: count }, (_, i) => inside.has(i) ? v3(0, 0, 0) : v3(10, 0, 0)))
  const s = spec('swimVolume', { center: [0, 0, 0], half: [2, 2, 2], drag: 3, buoyancy: 22 })
  const ctx = context(seats, courseOf([s]))
  const feature = swimVolumeFeature(s, PATH)
  feature.init(ctx)
  step(feature, ctx, 0)
  return { seats, ctx, feature }
}

test('swimVolume: restore resizes the per-seat state between 8 and 60 seats', () => {
  const source = swimRig(8, [0, 1, 2])
  assert.deepEqual(swimInsideStates(source.feature), [1, 1, 1, 0, 0, 0, 0, 0])
  const saved = snapshotBytes(source.feature)

  const grown = swimRig(60, [0, 1, 2])
  grown.feature.restore(new SnapReader(saved), grown.ctx)
  const grownStates = swimInsideStates(grown.feature)
  assert.equal(grownStates.length, 60, 'the restored state covers every live seat')
  assert.deepEqual(grownStates.slice(0, 8), [1, 1, 1, 0, 0, 0, 0, 0])
  assert.ok(grownStates.slice(8).every(state => state === 0), 'seats past the snapshot start outside')
  grown.seats.calls.setSwim.length = 0
  step(grown.feature, grown.ctx, 1)
  assert.deepEqual(grown.seats.calls.setSwim.map(call => call.seat), [0, 1, 2])
  const out = v3(0, 0, 0)
  assert.equal(grown.feature.botTarget?.(0, grown.seats.positions[0], out), true)
  assert.equal(grown.feature.botTarget?.(59, grown.seats.positions[59], out), false)

  const largeSource = swimRig(60, [3, 4])
  const largeSaved = snapshotBytes(largeSource.feature)
  assert.equal(swimInsideStates(largeSource.feature).length, 60)
  const small = swimRig(8, [3, 4])
  small.feature.restore(new SnapReader(largeSaved), small.ctx)
  assert.deepEqual(swimInsideStates(small.feature), [0, 0, 0, 1, 1, 0, 0, 0])
  small.seats.calls.setSwim.length = 0
  step(small.feature, small.ctx, 1)
  assert.deepEqual(small.seats.calls.setSwim.map(call => call.seat), [3, 4])
})

function logSpec(overrides: Record<string, unknown> = {}): FeatureSpec {
  return spec('rollingLog', {
    from: [0, 1, 0], to: [0, 1, 8], radius: 2, length: 2, speed: 2, periodS: 16, ...overrides,
  })
}

function advanceTo(feature: CourseFeature, ctx: TestCtx, tick: number): void {
  ctx.tick = tick - 1
  feature.preStep(ctx)
  ctx.physics.step()
}

function bodyAngle(body: { rotation(): { w: number } }): number {
  return 2 * Math.acos(Math.max(-1, Math.min(1, body.rotation().w)))
}

test('rollingLog: the body pose at 0, a quarter and a half cycle matches from/to and the pauses', () => {
  const s = logSpec()
  const seats = new StubSeats([v3(50, 0, 50)])
  const ctx = context(seats, courseOf([s]), 0, -1, featureRng(1, s.id))
  const base = ctx.physics.bodyCount
  const feature = rollingLogFeature(s, PATH)
  feature.init(ctx)
  const ids = bodiesSince(ctx, base)
  assert.equal(ids.length, 1)
  const body = ctx.physics.body(ids[0])

  assert.deepEqual({ ...body.translation() }, v3(0, 1, 0))
  near(bodyAngle(body), 0, 'angle at tick 0')

  advanceTo(feature, ctx, 120)
  assert.deepEqual({ ...body.translation() }, v3(0, 1, 4))
  near(bodyAngle(body), 4 / 2, 'angle at half the travel')

  advanceTo(feature, ctx, 240)
  assert.deepEqual({ ...body.translation() }, v3(0, 1, 8))
  near(bodyAngle(body), 8 / 2, 'angle at the quarter cycle')

  advanceTo(feature, ctx, 360)
  assert.deepEqual({ ...body.translation() }, v3(0, 1, 8), 'the log pauses at to')

  advanceTo(feature, ctx, 480)
  assert.deepEqual({ ...body.translation() }, v3(0, 1, 8), 'the pause runs to the half cycle')
})

test('rollingLog: a seat in the path is knocked up, a protected seat is not', () => {
  const s = logSpec({ from: [0, 0, 0], to: [0, 0, 8], radius: 1, speed: 5, periodS: 8 })
  const seats = new StubSeats([v3(0, 0, 1.5), v3(0, 0, 1.5)])
  seats.protectedSeats[1] = true
  const ctx = context(seats, courseOf([s]))
  const feature = rollingLogFeature(s, PATH)
  feature.init(ctx)
  step(feature, ctx, 0)

  assert.deepEqual(seats.calls.knock.map(call => call.seat), [0])
  const v = seats.calls.knock[0].v
  assert.equal(v.y, CHAR.knockUp)
  near(v.x, 0, 'no sideways knock')
  near(v.z, 5 * CHAR.knockGain + CHAR.knockNormal, 'log velocity along the normal')
  assert.equal(ctx.sounds.length, 1)
  assert.equal(ctx.sounds[0].id, 'mech.log')
})

test('rollingLog: a period too short for the speed is refused', () => {
  const s = logSpec({ to: [0, 1, 10], speed: 5, periodS: 3 })
  assert.throws(() => rollingLogFeature(s, PATH), (error: unknown) => {
    const refusal = error as { name: string; area: string; path: string; message: string }
    assert.equal(refusal.name, 'RefusalError')
    assert.equal(refusal.area, 'feature')
    assert.equal(refusal.path, `${PATH}/periodS`)
    assert.match(refusal.message, /raise periodS or speed/)
    return true
  })
})

function bankSpec(id: string, real: number[] = [2], breakSpeed = 6): FeatureSpec {
  const doors = [doorAt(0), doorAt(4), doorAt(8), doorAt(12)]
  return {
    id,
    kind: 'doorBank',
    params: { rows: real.map(count => ({ doors, real: count })), breakSpeed },
  }
}

test('doorBank: the seed draws exactly real solid doors per row and ids fork the stream', () => {
  const rows = [
    { doors: [doorAt(0), doorAt(4), doorAt(8), doorAt(12), doorAt(16), doorAt(20)], real: 2 },
    { doors: [doorAt(0), doorAt(4), doorAt(8), doorAt(12), doorAt(16)], real: 1 },
  ]
  const draw = (id: string): DoorState[] => {
    const s: FeatureSpec = { id, kind: 'doorBank', params: { rows, breakSpeed: 6 } }
    const seats = new StubSeats([v3(0, 1, 0)])
    const ctx = context(seats, courseOf([s]), 0, -1, featureRng(1, id))
    const feature = doorBankFeature(s, PATH)
    feature.init(ctx)
    return doorStates(feature)
  }
  const a = draw('door-a')
  const b = draw('door-b')
  const counts = [a.slice(0, 6), a.slice(6)].map(group => group.filter(door => door.solid).length)
  assert.deepEqual(counts, [2, 1])
  assert.notDeepEqual(a.map(door => door.solid), b.map(door => door.solid))
})

test('doorBank: a diving seat opens a breakable panel and disables its collider', () => {
  const s = bankSpec('doors')
  const seats = new StubSeats([v3(0, 1, 10)])
  const ctx = context(seats, courseOf([s]), 0, -1, featureRng(1, s.id))
  const base = ctx.physics.bodyCount
  const feature = doorBankFeature(s, PATH)
  feature.init(ctx)
  const states = doorStates(feature)
  const panel = states.findIndex(door => !door.solid)
  assert.ok(panel >= 0, 'a breakable panel exists')

  seats.positions[0] = v3(panel * 4, 1, 10)
  seats.modes[0] = CharMode.dive
  step(feature, ctx, 0)

  assert.equal(doorStates(feature)[panel].open, true)
  assert.equal(ctx.physics.body(bodiesSince(ctx, base)[panel]).collider(0).isEnabled(), false)
  assert.deepEqual(ctx.sounds.map(sound => sound.id), ['mech.door-break'])
})

test('doorBank: a walk at 3 m/s does not open a panel at breakSpeed 6', () => {
  const s = bankSpec('doors')
  const seats = new StubSeats([v3(0, 1, 10)])
  const ctx = context(seats, courseOf([s]), 0, -1, featureRng(1, s.id))
  const base = ctx.physics.bodyCount
  const feature = doorBankFeature(s, PATH)
  feature.init(ctx)
  const panel = doorStates(feature).findIndex(door => !door.solid)
  assert.ok(panel >= 0, 'a breakable panel exists')

  seats.positions[0] = v3(panel * 4, 1, 10)
  seats.velocities[0] = v3(0, 0, 3)
  step(feature, ctx, 0)

  assert.equal(doorStates(feature)[panel].open, false)
  assert.equal(ctx.physics.body(bodiesSince(ctx, base)[panel]).collider(0).isEnabled(), true)
  assert.equal(ctx.sounds.length, 0)
})

test('doorBank: a solid door never opens and is revealed once', () => {
  const s = bankSpec('doors')
  const seats = new StubSeats([v3(0, 1, 10)])
  const ctx = context(seats, courseOf([s]), 0, -1, featureRng(1, s.id))
  const base = ctx.physics.bodyCount
  const feature = doorBankFeature(s, PATH)
  feature.init(ctx)
  const solid = doorStates(feature).findIndex(door => door.solid)
  assert.ok(solid >= 0, 'a solid door exists')

  seats.positions[0] = v3(solid * 4, 1, 10)
  seats.modes[0] = CharMode.dive
  step(feature, ctx, 0)
  const after = doorStates(feature)[solid]
  assert.equal(after.open, false)
  assert.equal(after.revealed, true)
  assert.equal(ctx.physics.body(bodiesSince(ctx, base)[solid]).collider(0).isEnabled(), true)
  assert.deepEqual(ctx.sounds.map(sound => sound.id), ['mech.door'])

  step(feature, ctx, 1)
  assert.equal(ctx.sounds.length, 1, 'revealed only once')
})

test('doorBank: botTarget skips revealed doors and prefers an open door', () => {
  const s = bankSpec('doorBank')
  const seats = new StubSeats([v3(0, 1, 0)])
  const ctx = context(seats, courseOf([s]), 0, -1, featureRng(1, s.id))
  const feature = doorBankFeature(s, PATH)
  feature.init(ctx)
  const states = doorStates(feature)
  assert.equal(states[0].solid, true)
  assert.equal(states[3].solid, true)
  const out = v3(0, 0, 0)

  seats.positions[0] = v3(0, 1, 10)
  seats.modes[0] = CharMode.dive
  step(feature, ctx, 0)
  assert.equal(feature.botTarget?.(0, v3(0, 1, 0), out), true)
  assert.deepEqual(out, v3(4, 1, 10), 'skips the revealed nearest door')

  seats.positions[0] = v3(8, 1, 10)
  step(feature, ctx, 1)
  assert.equal(feature.botTarget?.(0, v3(0, 1, 0), out), true)
  assert.deepEqual(out, v3(8, 1, 10), 'prefers the open door')

  assert.equal(feature.botTarget?.(0, v3(0, 1, 20), out), false)
})

test('doorBank: real >= doors is refused', () => {
  const s = bankSpec('doorBank', [2])
  const rows = s.params.rows as { doors: unknown[]; real: number }[]
  rows[0].real = rows[0].doors.length
  assert.throws(() => doorBankFeature(s, PATH), (error: unknown) => {
    const refusal = error as { name: string; area: string; path: string }
    assert.equal(refusal.name, 'RefusalError')
    assert.equal(refusal.area, 'feature')
    assert.equal(refusal.path, `${PATH}/rows/0/real`)
    return true
  })
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

  const logSpecRun = logSpec({ from: [0, 0, 0], to: [0, 0, 8], radius: 1, speed: 5, periodS: 8 })
  plans.push({
    name: 'rollingLog',
    plan: {
      factory: rollingLogFeature,
      spec: logSpecRun,
      course: courseOf([logSpecRun]),
      makeSeats: () => new StubSeats([v3(0, 0, 8.5)]),
      evolve: (_tick, seats) => {
        seats.positions[0] = v3(0, 0, 8.5)
        seats.velocities[0] = v3(0, 0, 0)
      },
    },
  })

  const bankSpecRun = bankSpec('doorBank')
  const bankWindows: [number, number, Vec3][] = [
    [10, 20, v3(0, 1, 10)], [25, 35, v3(4, 1, 10)], [70, 80, v3(8, 1, 10)], [95, 105, v3(12, 1, 10)],
  ]
  plans.push({
    name: 'doorBank',
    plan: {
      factory: doorBankFeature,
      spec: bankSpecRun,
      course: courseOf([bankSpecRun]),
      makeSeats: () => new StubSeats([v3(0, 1, 0)]),
      evolve: (tick, seats) => {
        const window = bankWindows.find(([from, to]) => tick >= from && tick < to)
        seats.modes[0] = window ? CharMode.dive : CharMode.ground
        seats.positions[0] = window ? window[2] : v3(0, 1, 0)
        seats.velocities[0] = v3(0, 0, 0)
      },
    },
  })

  for (const entry of plans) {
    const plan = entry.plan
    const seatsA = plan.makeSeats()
    const ctxA = context(seatsA, plan.course)
    const baseA = ctxA.physics.bodyCount
    const featureA = plan.factory(plan.spec, PATH)
    featureA.init(ctxA)
    let snap: Uint8Array | null = null
    let markA: CallLog | null = null
    let stateA: SeatState | null = null
    let soundMarkA = 0
    for (let tick = 0; tick < 120; tick++) {
      if (tick === 60) {
        snap = snapshotBytes(featureA)
        markA = callMark(seatsA)
        stateA = seatState(seatsA)
        soundMarkA = ctxA.sounds.length
      }
      runTick(featureA, ctxA, plan, tick)
    }
    const flagsA = colliderFlags(ctxA, baseA)

    assert.ok(snap !== null && markA !== null && stateA !== null, `${entry.name}: snapshot at tick 60`)
    const seatsB = plan.makeSeats()
    applySeatState(seatsB, stateA)
    const ctxB = context(seatsB, plan.course, 60)
    const baseB = ctxB.physics.bodyCount
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
    const soundsA = ctxA.sounds.slice(soundMarkA)
    const soundsB = ctxB.sounds.slice()
    assert.deepEqual(soundsA, soundsB, `${entry.name}: recorded sounds`)
    assert.deepEqual(flagsA, colliderFlags(ctxB, baseB), `${entry.name}: collider enabled flags`)
    const recorded = afterA.setVelocity.length + afterA.teleport.length + afterA.setSwim.length +
      afterA.knock.length + soundsA.length
    assert.ok(recorded > 0, `${entry.name}: continuation has recorded calls`)
    assert.deepEqual(snapshotBytes(featureA), snapshotBytes(featureB), `${entry.name}: final snapshot bytes`)
  }
})

const restoreCases: [FeatureFactory, FeatureSpec][] = [
  [boostLaneFeature, spec('boostLane', BOOST_PARAMS())],
  [launchPadFeature, spec('launchPad', {
    center: [0, 0, 0], half: [2, 2, 2], target: [0, 0, 12], apexM: 3, recoverOnly: true,
  })],
  [catchVolumeFeature, spec('catchVolume', { center: [0, 0, 0], half: [2, 2, 2], respawnStage: 0 })],
  [swimVolumeFeature, spec('swimVolume', { center: [0, 0, 0], half: [2, 2, 2], drag: 3, buoyancy: 22 })],
  [rollingLogFeature, logSpec({ from: [0, 0, 0], to: [0, 0, 8], radius: 1, speed: 5, periodS: 8 })],
  [doorBankFeature, bankSpec('doors')],
  [carryItemFeature, spec('carryItem', { asset: 'candy.ball', spawns: [[0, 0, 0.5]], resetS: 1,
    homes: [{ center: [0, 0, 20], half: [2, 2, 2], team: null }] })],
]

for (const [factory, s] of restoreCases) test(`${s.kind}: 60 seats restore across three peer sizes and replay every tick`, t => {
  const course = courseOf([s], [cp(v3(0, 0, 0))], [0])
  const makeSeats = (n: number) => new StubSeats(Array.from({ length: n }, () => v3(0, 0, 0)))
  const peer = (n: number) => {
    const physics = new WorldSim(R, { gravity: v3(0, GRAVITY_Y, 0) })
    t.after(() => physics.free())
    const ctx = new TestCtx(R, physics, makeSeats(n), course)
    const feature = factory(s, PATH)
    feature.init(ctx)
    return { ctx, feature }
  }
  const drive = (p: ReturnType<typeof peer>, tick: number) => {
    const seats = p.ctx.seats
    for (let i = 0; i < seats.count; i++) {
      // Includes held grabs, exits, recovery, launch flight and high-index seats.
      const id = seats.seat(i)
      seats.positions[i] = tick % 24 < 12 ? v3(0, 0, 0) : v3((id % 4) * 4, 1, 10)
      seats.inputs[i] = { ...neutralInput(), moveZ: 1, grab: tick % 30 < 20 }
      seats.protectedSeats[i] = tick % 40 === 0
      seats.modes[i] = tick % 24 < 12 ? CharMode.ground : CharMode.dive
      seats.velocities[i] = v3(0, 0, 7)
    }
    p.ctx.tick = tick
    p.feature.preStep(p.ctx)
    p.ctx.physics.step()
    p.feature.postStep(p.ctx)
  }
  const source = peer(60)
  for (let tick = 0; tick < 40; tick++) drive(source, tick)
  const snapshot = snapshotBytes(source.feature)
  const physics = source.ctx.physics.takeSnapshot()
  const peers = [8, 20, 60].map(n => {
    const p = peer(n)
    const seats = makeSeats(60)
    applySeatState(seats, seatState(source.ctx.seats))
    p.ctx.physics.restoreSnapshot(physics)
    p.ctx = new TestCtx(R, p.ctx.physics, seats, course, 39)
    const reader = new SnapReader(snapshot)
    p.feature.restore(reader, p.ctx)
    assert.equal(reader.remaining, 0)
    assert.deepEqual(snapshotBytes(p.feature), snapshot, `initial size ${n}: exact round trip`)
    return p
  })
  source.ctx.sounds.length = 0
  for (const calls of Object.values(source.ctx.seats.calls)) calls.length = 0
  peers.push(source) // Compare restored peers with uninterrupted simulation too.
  for (let tick = 40; tick < 100; tick++) {
    // A new domain may contain fewer seats, then expand or reorder without
    // reconstructing its features. Restore must use identities and current count.
    if (tick === 60 || tick === 70 || tick === 80) {
      const n = tick === 60 ? 8 : 60
      const saved = snapshotBytes(peers[0].feature)
      for (const p of peers) {
        const seats = makeSeats(n)
        seats.seat = i => tick === 60 ? i + 52 : tick === 80 ? 59 - i : i
        p.ctx = new TestCtx(R, p.ctx.physics, seats, course, tick - 1)
        p.feature.restore(new SnapReader(saved), p.ctx)
      }
    }
    for (const p of peers) drive(p, tick)
    for (const p of peers.slice(1)) {
      assert.deepEqual(snapshotBytes(p.feature), snapshotBytes(peers[0].feature), `first divergent tick ${tick}`)
      assert.deepEqual(seatState(p.ctx.seats), seatState(peers[0].ctx.seats), `seat effects at ${tick}`)
      assert.deepEqual(p.ctx.seats.calls, peers[0].ctx.seats.calls, `feature calls at ${tick}`)
      assert.deepEqual(p.ctx.sounds, peers[0].ctx.sounds, `sounds at ${tick}`)
      assert.deepEqual(p.ctx.physics.takeSnapshot(), peers[0].ctx.physics.takeSnapshot(), `physics at ${tick}`)
    }
  }
})
