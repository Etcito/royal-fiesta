import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier, RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { CarryKind, CharMode } from '../src/character/constants.ts'
import { legacyLevel } from '../src/course.ts'
import type { FeatureSpec, HomeSpec, LevelSpec, ResolvedCourse, SpawnPoint } from '../src/course.ts'
import { bankFeature } from '../src/features/bank.ts'
import { captureZoneFeature } from '../src/features/capture.ts'
import { carryItemFeature } from '../src/features/carry.ts'
import { collectibleFeature } from '../src/features/collectibles.ts'
import { ballFeature, goalFeature } from '../src/features/football.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureSeats } from '../src/features/feature.ts'
import { tailSetFeature } from '../src/features/tails.ts'
import { G, groups } from '../src/groups.ts'
import { neutralInput } from '../src/input.ts'
import type { PlayerInput } from '../src/input.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'

// Shared football harness: StubSeats records teleports, the course lists a ball
// plus goal specs, and every feature snapshot is compared as raw bytes.

export interface Teleport { seat: number; at: SpawnPoint }

export class StubSeats implements FeatureSeats {
  readonly count: number
  positions: Vec3[]
  velocities: Vec3[]
  directions: Vec3[]
  modes: number[]
  statuses: number[]
  teams: number[]
  carries: number[]
  ids: number[]
  inputs: PlayerInput[]
  protectedFlags: boolean[]
  seatIds: number[]
  teleports: Teleport[] = []
  constructor(count = 2) {
    this.count = count
    const rows = <T>(make: (i: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i))
    this.positions = rows(i => v3(i * 10, 2, 0))
    this.velocities = rows(() => v3(0, 0, 0))
    this.directions = rows(() => v3(0, 0, 1))
    this.modes = rows(() => CharMode.ground)
    this.statuses = rows(() => PlayerStatus.alive)
    this.teams = rows(i => i % 2)
    this.carries = rows(() => 0)
    this.ids = rows(() => -1)
    this.inputs = rows(() => neutralInput())
    this.protectedFlags = rows(() => false)
    this.seatIds = rows(i => 20 + i)
  }
  seat(i: number) { return this.seatIds[i] }
  pos(i: number, out: Vec3) { return Object.assign(out, this.positions[i]) }
  vel(i: number, out: Vec3) { return Object.assign(out, this.velocities[i]) }
  facing(i: number, out: Vec3) { return Object.assign(out, this.directions[i]) }
  mode(i: number) { return this.modes[i] }
  grounded(i: number) { return this.modes[i] === CharMode.ground }
  groundCollider(_i: number) { return -1 }
  status(i: number) { return this.statuses[i] }
  team(i: number) { return this.teams[i] }
  input(i: number) { return this.inputs[i] }
  protectedNow(i: number) { return this.protectedFlags[i] }
  carry(i: number) { return this.carries[i] }
  setCarry(i: number, kind: number, id: number) { this.carries[i] = kind; this.ids[i] = id }
  setVelocity(i: number, v: Vec3) { this.velocities[i] = { ...v } }
  addVelocity(_i: number, _v: Vec3) {}
  teleport(i: number, at: SpawnPoint) {
    this.teleports.push({ seat: i, at: { t: { ...at.t }, facing: { ...at.facing } } })
  }
  kill(_i: number) {}
  setSwim(_i: number, _inside: boolean, _drag: number, _buoyancy: number) {}
  knock(_i: number, _v: Vec3) {}
}

export interface GoalCase {
  team: number
  center: [number, number, number]
  half: [number, number, number]
}

export interface HarnessOptions {
  spawn?: [number, number, number]
  radius?: number
  mass?: number
  resetS?: number
  goals?: GoalCase[]
  homes?: HomeSpec[]
  /** Extra feature specs after the ball and goals (collectible, bank, ...). */
  extraFeatures?: FeatureSpec[]
  /** false builds a course with no ball/goals, for the other objective cases. */
  withBall?: boolean
  /** Overrides ctx.roundTick; defaults to the physics tick. */
  roundTick?: () => number
  /** Seat count of the stub; defaults to 2. */
  count?: number
  /** Feature rng seed; defaults to 1. */
  seed?: number
}

export interface Harness {
  physics: RapierWorldSim
  seats: StubSeats
  events: { kind: string; seat: number; a: number; b: number }[]
  sounds: string[]
  ctx: FeatureCtx
  features: CourseFeature[]
  ball(): ReturnType<RapierWorldSim['body']>
  draw(): FeatureDraw[]
  snapshot(): Uint8Array[]
  restore(bytes: Uint8Array[]): void
  step(): void
}

export async function harness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const spawn = options.spawn ?? [0, 2, 0]
  const goals = options.goals ?? []
  const R = await initRapier()
  const physics = new RapierWorldSim(R, { gravity: v3(0, -20, 0) })
  t.after(() => physics.free())
  physics.createBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), [
    R.ColliderDesc.cuboid(30, 0.5, 30)
      .setCollisionGroups(groups(G.STATIC, G.CHAR | G.MOVING | G.DEBRIS | G.PROBE)),
  ])
  const seats = new StubSeats(options.count ?? 2), events: Harness['events'] = [], sounds: string[] = []
  const base: ResolvedCourse = {
    id: 'football-test', name: 'Football', kind: 'race', profiles: ['standard'], timeLimitS: 60,
    killPlaneY: -12, spawns: [], checkpoints: [], finish: null, path: [], regions: [],
    queuePad: null, obstacles: [], contentHash: 0, features: [],
  }
  const level: LevelSpec = { ...legacyLevel(base), homes: options.homes ?? [] }
  const specs: FeatureSpec[] = options.withBall === false ? [] : [
    { id: 'ball', kind: 'ball', params: { spawn, radius: options.radius ?? 0.5,
      mass: options.mass ?? 5, resetS: options.resetS ?? 30 } },
    ...goals.map((goal, index) => ({ id: `goal-${index}`, kind: 'goal',
      params: { team: goal.team, center: goal.center, half: goal.half } })),
  ]
  specs.push(...(options.extraFeatures ?? []))
  const course: ResolvedCourse = { ...base, level, features: specs }
  const roundTick = options.roundTick ?? (() => physics.tick)
  const ctx: FeatureCtx = {
    R, physics, seats, course, rng: new Rng(options.seed ?? 1), get tick() { return physics.tick },
    get roundTick() { return roundTick() }, entrants: 2, overtime: false, trailingTeam: -1,
    soundLoop() {},
    emit(kind, seat, a, b) { events.push({ kind, seat, a, b }) },
    sound(id) { sounds.push(id) },
  }
  const features: CourseFeature[] = []
  let ballId = -1
  for (const [index, spec] of specs.entries()) {
    const path = `football-test#/features/${index}`
    const feature = spec.kind === 'goal' ? goalFeature(spec, path)
      : spec.kind === 'ball' ? ballFeature(spec, path)
      : spec.kind === 'captureZone' ? captureZoneFeature(spec, path)
      : spec.kind === 'bank' ? bankFeature(spec, path)
      : spec.kind === 'tailSet' ? tailSetFeature(spec, path)
      : spec.kind === 'carryItem' ? carryItemFeature(spec, path)
      : collectibleFeature(spec, path)
    const before = physics.ids().length
    feature.init(ctx)
    if (spec.kind === 'ball') ballId = physics.ids()[before] ?? -1
    features.push(feature)
  }
  return {
    physics, seats, events, sounds, ctx, features,
    ball: () => physics.body(ballId),
    draw() {
      const out: FeatureDraw[] = []
      for (const feature of features) feature.draw(out)
      return out
    },
    snapshot: () => features.map(feature => {
      const w = new SnapWriter()
      feature.snapshot(w)
      return w.bytes().slice()
    }),
    restore(bytes) {
      for (const [index, feature] of features.entries()) {
        feature.restore(new SnapReader(bytes[index]), ctx)
      }
    },
    step() {
      for (const feature of features) feature.preStep(ctx)
      physics.step()
      for (const feature of features) feature.postStep(ctx)
    },
  }
}

export function near(actual: Vec3, expected: Vec3, label = '') {
  for (const key of ['x', 'y', 'z'] as const) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6,
    `${label}${key}: ${actual[key]} != ${expected[key]}`)
}

function home(team: number, t: [number, number, number]): HomeSpec {
  return { team, box: { center: v3(...t), half: v3(1, 1, 1) },
    respawn: [{ t: v3(...t), facing: { x: 0, z: 1 } }] }
}

const SPAWN = v3(0, 2, 0)
const HOMES = [home(0, [-5, 1, 0]), home(1, [5, 1, 0])]

test('goal: a ball inside the team 0 goal scores once for team 1, then resets ball and seats', async t => {
  const h = await harness(t, {
    goals: [{ team: 0, center: [8, 2, 0], half: [1, 1, 1] }], homes: HOMES,
  })
  const ball = h.ball()
  ball.setTranslation(v3(8, 2, 0), true)
  h.step()
  assert.deepEqual(h.events, [{ kind: 'teamScore', seat: 1, a: 1, b: 0 }])
  assert.deepEqual(h.sounds, ['obj.goal'])
  assert.equal(h.seats.teleports.length, 0)

  for (let i = 0; i < 179; i++) h.step()
  assert.equal(h.seats.teleports.length, 0, 'nothing resets before the 180th tick')
  assert.equal(h.events.length, 1, 'the pending goal does not score twice')

  h.step()
  assert.equal(h.events.length, 1)
  near(ball.translation(), SPAWN, 'ball ')
  assert.deepEqual(h.seats.teleports.map(call => [call.seat, call.at.t]),
    [[0, v3(-5, 1, 0)], [1, v3(5, 1, 0)]])
  assert.deepEqual(h.seats.teleports.map(call => call.at.facing),
    [{ x: 0, z: 1 }, { x: 0, z: 1 }])
})

test('stuck: a ball that rests away from spawn returns after resetS', async t => {
  const h = await harness(t, { resetS: 1 })
  const ball = h.ball()
  ball.setTranslation(v3(5, 0.5, 0), true)
  ball.setLinvel(v3(0, 0, 0), true)
  h.step()
  for (let i = 0; i < 59; i++) h.step()
  assert.ok(Math.abs(ball.translation().x - 5) < 1e-6, 'not reset before resetS')
  h.step()
  near(ball.translation(), SPAWN, 'ball ')
})

test('botTarget: stands behind the ball on the line to the opponent goal', async t => {
  const h = await harness(t, {
    goals: [{ team: 1, center: [10, 2, 0], half: [1, 1, 1] }],
  })
  const out = v3(0, 0, 0)
  assert.equal(h.features[0].botTarget!(20, v3(0, 2, 5), out), true)
  near(out, v3(-1.5, 2, 0), 'behind ')
  assert.equal(h.features[0].botTarget!(20, v3(-5, 2, 0), out), true)
  near(out, v3(0, 2, 0), 'at the ball ')
  assert.equal(h.features[0].botTarget!(999, v3(0, 2, 0), out), false)
})

test('QB1: restore at tick 60 of 120 reproduces the snapshot bytes exactly', async t => {
  const options = { goals: [{ team: 1, center: [10, 2, 0], half: [1, 1, 1] }] as GoalCase[] }
  const a = await harness(t, options), b = await harness(t, options)
  const drive = (h: Harness, tick: number) => {
    const ball = h.ball()
    if (tick === 45) ball.setTranslation(v3(10, 2, 0), true)
    else ball.setTranslation(v3(Math.sin(tick / 9) * 3, 2, Math.cos(tick / 11) * 3), true)
    ball.setLinvel(v3(0.5, 0, -0.25), true)
    h.step()
  }
  for (let tick = 0; tick < 60; tick++) drive(a, tick)
  const checkpoint = a.snapshot()
  b.physics.restoreSnapshot(a.physics.takeSnapshot())
  b.restore(checkpoint)
  assert.deepEqual(b.snapshot(), checkpoint)

  for (let tick = 60; tick < 120; tick++) { drive(a, tick); drive(b, tick) }
  assert.deepEqual(b.snapshot(), a.snapshot())
  assert.deepEqual(b.physics.takeSnapshot(), a.physics.takeSnapshot())

  const c = await harness(t, options), d = await harness(t, options)
  for (let tick = 0; tick < 120; tick++) { drive(c, tick); drive(d, tick) }
  assert.deepEqual(d.snapshot(), c.snapshot())
  assert.deepEqual(c.snapshot(), a.snapshot())
})

// Collectible cases: one spot per pickup, nearest available seat, regenS gate.

function collectibleCheck(params: { spots: [number, number, number][]; value?: number; regenS?: number }): FeatureSpec {
  return { id: 'pickup', kind: 'collectible', params: {
    spots: params.spots, value: params.value ?? 5, regenS: params.regenS ?? 1 } }
}

test('collectible: a seat on a spot scores once, hides the spot, then it returns after regenS', async t => {
  const h = await harness(t, {
    withBall: false,
    extraFeatures: [collectibleCheck({ spots: [[0, 2, 0]], value: 7, regenS: 0.1 })],
  })
  assert.equal(h.draw()[0].visible, true, 'available at the start')
  h.seats.positions = [v3(0, 2, 0), v3(20, 2, 0)]
  h.step()
  assert.deepEqual(h.events, [{ kind: 'score', seat: 20, a: 7, b: 0 }])
  assert.deepEqual(h.sounds, ['obj.pickup'])
  assert.equal(h.draw()[0].visible, false, 'hidden while regenerating')

  h.seats.positions[0] = v3(10, 2, 10)
  for (let i = 0; i < 5; i++) h.step()
  assert.equal(h.draw()[0].visible, false, 'still hidden one tick before regenS')
  h.step()
  assert.equal(h.draw()[0].visible, true, 'back at regenS')
  assert.equal(h.events.length, 1, 'no second pickup away from the spot')
})

test('collectible: on equal distance the lower room seat takes the spot', async t => {
  const h = await harness(t, {
    withBall: false,
    extraFeatures: [collectibleCheck({ spots: [[1, 2, 0]], value: 3 })],
  })
  h.seats.seatIds = [21, 20]
  h.seats.positions = [v3(0.5, 2, 0), v3(1.5, 2, 0)]
  h.step()
  assert.deepEqual(h.events, [{ kind: 'score', seat: 20, a: 3, b: 0 }])
})

test('collectible: no pickup before roundTick 0', async t => {
  let roundTick = -1
  const h = await harness(t, {
    withBall: false,
    roundTick: () => roundTick,
    extraFeatures: [collectibleCheck({ spots: [[0, 2, 0]], value: 4 })],
  })
  h.seats.positions[0] = v3(0, 2, 0)
  for (let i = 0; i < 5; i++) h.step()
  assert.equal(h.events.length, 0, 'the intro emits nothing')
  roundTick = 0
  h.step()
  assert.deepEqual(h.events, [{ kind: 'score', seat: 20, a: 4, b: 0 }])
})

test('collectible: botTarget takes the nearest available spot and is false when none is', async t => {
  const h = await harness(t, {
    withBall: false,
    extraFeatures: [collectibleCheck({ spots: [[0, 2, 0], [10, 2, 0]], value: 2, regenS: 2 })],
  })
  const out = v3(0, 0, 0)
  assert.equal(h.features[0].botTarget!(20, v3(1, 2, 0), out), true)
  near(out, v3(0, 2, 0), 'nearest ')

  h.seats.positions = [v3(0, 2, 0), v3(30, 2, 0)]
  h.step()
  assert.equal(h.events.length, 1)
  assert.equal(h.features[0].botTarget!(20, v3(1, 2, 0), out), true)
  near(out, v3(10, 2, 0), 'the other spot ')

  h.seats.positions[0] = v3(10, 2, 0)
  h.step()
  assert.equal(h.events.length, 2)
  assert.equal(h.features[0].botTarget!(20, v3(1, 2, 0), out), false, 'all spots wait for regen')
})

test('QB1: collectibles restore at tick 60 of 120 reproduces the snapshot bytes exactly', async t => {
  const options: HarnessOptions = {
    withBall: false,
    extraFeatures: [collectibleCheck({ spots: [[0, 2, 0], [3, 2, 0], [0, 2, 3]], value: 5, regenS: 0.5 })],
  }
  const a = await harness(t, options), b = await harness(t, options)
  const drive = (h: Harness, tick: number) => {
    h.seats.positions[0] = v3(Math.sin(tick / 7) * 3, 2, Math.cos(tick / 11) * 3)
    h.seats.positions[1] = v3(20 + (tick % 5), 2, 0)
    h.step()
  }
  for (let tick = 0; tick < 60; tick++) drive(a, tick)
  const checkpoint = a.snapshot()
  b.physics.restoreSnapshot(a.physics.takeSnapshot())
  b.restore(checkpoint)
  assert.deepEqual(b.snapshot(), checkpoint)

  for (let tick = 60; tick < 120; tick++) { drive(a, tick); drive(b, tick) }
  assert.deepEqual(b.snapshot(), a.snapshot())
  assert.deepEqual(b.physics.takeSnapshot(), a.physics.takeSnapshot())

  const c = await harness(t, options), d = await harness(t, options)
  for (let tick = 0; tick < 120; tick++) { drive(c, tick); drive(d, tick) }
  assert.deepEqual(d.snapshot(), c.snapshot())
  assert.deepEqual(c.snapshot(), a.snapshot())
})

// Capture zone cases: captureTicks progress, contests, takeovers, cross-zone bots.

function captureCheck(id: string, center: [number, number, number], half: [number, number, number],
  captureS = 0.5): FeatureSpec {
  return { id, kind: 'captureZone', params: { center, half, captureS } }
}

test('captureZone: two team 0 seats own an empty zone after captureTicks and score every 60 owned ticks', async t => {
  const h = await harness(t, {
    withBall: false,
    extraFeatures: [captureCheck('zone', [0, 2, 0], [2, 2, 2], 0.5)],
  })
  h.seats.teams = [0, 0]
  h.seats.positions = [v3(-1, 2, 0), v3(1, 2, 0)]

  for (let i = 0; i < 29; i++) h.step()
  assert.equal(h.draw()[0].tint, 0, 'unowned on tick 29')
  assert.equal(h.events.length, 0)
  h.step()
  assert.equal(h.draw()[0].tint, 2, 'owner 0 on the 30th tick')
  assert.equal(h.events.length, 0, 'the capture itself scores nothing')
  assert.deepEqual(h.sounds, ['obj.capture'])

  for (let i = 0; i < 58; i++) h.step()
  assert.equal(h.events.length, 0, 'no zone-second before the 60th owned tick')
  h.step()
  assert.deepEqual(h.events, [{ kind: 'teamScore', seat: 0, a: 1, b: 0 }])
  for (let i = 0; i < 60; i++) h.step()
  assert.deepEqual(h.events, [
    { kind: 'teamScore', seat: 0, a: 1, b: 0 },
    { kind: 'teamScore', seat: 0, a: 1, b: 0 },
  ])
  assert.equal(h.sounds.length, 1, 'one capture sound for one capture')
})

test('captureZone: one seat of each team is contested and leaves progress unchanged', async t => {
  const h = await harness(t, {
    withBall: false,
    extraFeatures: [captureCheck('zone', [0, 2, 0], [2, 2, 2], 1)],
  })
  h.seats.positions = [v3(-1, 2, 0), v3(20, 2, 0)]

  for (let i = 0; i < 20; i++) h.step()
  h.seats.positions[1] = v3(1, 2, 0)
  for (let i = 0; i < 20; i++) h.step()
  assert.equal(h.draw()[0].tint, 1, 'contested tint')
  assert.equal(h.events.length, 0, 'a contest emits nothing')

  h.seats.positions[1] = v3(20, 2, 0)
  for (let i = 0; i < 39; i++) h.step()
  assert.equal(h.draw()[0].tint, 0, '20+39 of 60 ticks is not a capture')
  h.step()
  assert.equal(h.draw()[0].tint, 2, 'the frozen 20 ticks resume to a capture')
  assert.equal(h.events.length, 0)
})

test('captureZone: a team 1 takeover restarts progress for team 1', async t => {
  const h = await harness(t, {
    withBall: false,
    extraFeatures: [captureCheck('zone', [0, 2, 0], [2, 2, 2], 0.5)],
  })
  h.seats.teams = [0, 0]
  h.seats.positions = [v3(-1, 2, 0), v3(1, 2, 0)]
  for (let i = 0; i < 30; i++) h.step()
  assert.equal(h.draw()[0].tint, 2, 'team 0 owns the zone')

  h.seats.teams = [1, 1]
  for (let i = 0; i < 29; i++) h.step()
  assert.equal(h.draw()[0].tint, 2, 'the takeover needs its own captureTicks')
  assert.equal(h.events.length, 0, 'team 0 scored no zone-second yet')
  h.step()
  assert.equal(h.draw()[0].tint, 3, 'team 1 owns it on the 30th takeover tick')
  assert.deepEqual(h.sounds, ['obj.capture', 'obj.capture'])

  for (let i = 0; i < 58; i++) h.step()
  assert.equal(h.events.length, 0, 'the score cadence restarts with the new owner')
  h.step()
  assert.deepEqual(h.events, [{ kind: 'teamScore', seat: 1, a: 1, b: 0 }])
})

test('captureZone: botTarget takes the nearest zone not owned by the seat team from either zone', async t => {
  const h = await harness(t, {
    withBall: false,
    extraFeatures: [
      captureCheck('zone-a', [0, 2, 0], [2, 2, 2], 0.5),
      captureCheck('zone-b', [10, 2, 0], [2, 2, 2], 0.5),
    ],
  })
  const out = v3(0, 0, 0)
  h.seats.teams = [0, 0]
  h.seats.positions = [v3(20, 2, 0), v3(20, 2, 0)]

  assert.equal(h.features[0].botTarget!(20, v3(1, 2, 0), out), true)
  near(out, v3(0, 2, 0), 'unowned nearest from zone a ')
  assert.equal(h.features[1].botTarget!(20, v3(1, 2, 0), out), true)
  near(out, v3(0, 2, 0), 'unowned nearest from zone b ')

  h.seats.positions = [v3(-1, 2, 0), v3(1, 2, 0)]
  for (let i = 0; i < 30; i++) h.step()
  assert.equal(h.draw()[0].tint, 2, 'team 0 owns zone a')
  h.seats.positions = [v3(20, 2, 0), v3(20, 2, 0)]

  assert.equal(h.features[0].botTarget!(20, v3(1, 2, 0), out), true)
  near(out, v3(10, 2, 0), 'skip the team 0 zone from zone a ')
  assert.equal(h.features[1].botTarget!(20, v3(1, 2, 0), out), true)
  near(out, v3(10, 2, 0), 'skip the team 0 zone from zone b ')

  h.seats.teams = [0, 1]
  assert.equal(h.features[0].botTarget!(21, v3(1, 2, 0), out), true)
  near(out, v3(0, 2, 0), 'a team 1 seat takes the nearest unowned zone ')

  h.seats.teams = [0, 0]
  h.seats.positions = [v3(9, 2, 0), v3(11, 2, 0)]
  for (let i = 0; i < 30; i++) h.step()
  assert.equal(h.draw()[1].tint, 2, 'team 0 owns zone b too')

  assert.equal(h.features[0].botTarget!(20, v3(9, 2, 0), out), true)
  near(out, v3(10, 2, 0), 'all owned: nearest from zone a ')
  assert.equal(h.features[1].botTarget!(20, v3(1, 2, 0), out), true)
  near(out, v3(0, 2, 0), 'all owned: nearest from zone b ')
})

test('QB1: capture zones restore at tick 60 of 120 reproduces the snapshot bytes exactly', async t => {
  const options: HarnessOptions = {
    withBall: false,
    extraFeatures: [
      captureCheck('zone-a', [0, 2, 0], [2, 2, 2], 0.5),
      captureCheck('zone-b', [10, 2, 0], [2, 2, 2], 0.5),
    ],
  }
  const a = await harness(t, options), b = await harness(t, options)
  const drive = (h: Harness, tick: number) => {
    h.seats.positions[0] = tick < 40 ? v3(1, 2, 0) : tick < 90 ? v3(9, 2, 0) : v3(-1, 2, 0)
    h.seats.positions[1] = tick < 10 ? v3(20, 2, 0)
      : tick < 20 ? v3(-1, 2, 0)
      : tick < 70 ? v3(10, 2, 0) : v3(20, 2, 0)
    h.step()
  }
  for (let tick = 0; tick < 60; tick++) drive(a, tick)
  const checkpoint = a.snapshot()
  b.physics.restoreSnapshot(a.physics.takeSnapshot())
  b.restore(checkpoint)
  assert.deepEqual(b.snapshot(), checkpoint)

  for (let tick = 60; tick < 120; tick++) { drive(a, tick); drive(b, tick) }
  assert.deepEqual(b.snapshot(), a.snapshot())
  assert.deepEqual(b.physics.takeSnapshot(), a.physics.takeSnapshot())

  const c = await harness(t, options), d = await harness(t, options)
  for (let tick = 0; tick < 120; tick++) { drive(c, tick); drive(d, tick) }
  assert.deepEqual(d.snapshot(), c.snapshot())
  assert.deepEqual(c.snapshot(), a.snapshot())
})

// Bank cases: a carried sweet deposits in the own bank, an enemy grab steals
// from the exposed bank, carry homes stay protected, and the bank keeps a
// carrying seat's grab held outside its own bank.

function bankCheck(id: string, team: number | null, center: [number, number, number],
  half: [number, number, number] = [2, 2, 2]): FeatureSpec {
  return { id, kind: 'bank', params: { team, center, half } }
}

function carryCheck(spawns: [number, number, number][],
  homes: { center: [number, number, number]; half: [number, number, number]; team: number | null }[] = []): FeatureSpec {
  return { id: 'sweets', kind: 'carryItem', params: { asset: 'candy.ball', spawns, resetS: 30, homes } }
}

function featureOf(h: Harness, kind: string): CourseFeature {
  const feature = h.features.find(candidate => candidate.kind === kind)
  assert.ok(feature, `missing ${kind} feature`)
  return feature
}

test('bank: carrying a sweet inside the own bank emits nothing until it is released', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [
    bankCheck('bank-0', 0, [0, 2, 0]),
    carryCheck([[6, 2, 0.5]]),
  ] })
  h.seats.positions[0] = v3(6, 2, 0)
  h.seats.inputs[0].grab = true
  h.step()
  assert.equal(h.seats.carry(0), CarryKind.object)
  assert.equal(h.events.length, 0, 'the sweet starts outside the bank')

  h.seats.positions[0] = v3(0, 2, 0)
  h.step()
  assert.equal(h.seats.carry(0), CarryKind.object, 'the grab stays held inside the bank')
  assert.equal(h.events.length, 0, 'a held sweet inside the bank never counts')

  h.seats.inputs[0].grab = false
  h.step()
  assert.deepEqual(h.events, [{ kind: 'teamScore', seat: 0, a: 1, b: 0 }])
  assert.deepEqual(h.sounds, ['move.carry', 'move.release', 'obj.bank'])
  h.step()
  assert.equal(h.events.length, 1, 'a sweet resting in the bank counts once')
})

test('bank: an enemy grab steals a deposited sweet and scores -1 for the owner team', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [
    bankCheck('bank-0', 0, [0, 2, 0]),
    carryCheck([[6, 2, 0.5]]),
  ] })
  h.seats.positions[0] = v3(6, 2, 0)
  h.seats.inputs[0].grab = true
  h.step()
  h.seats.positions[0] = v3(0, 2, 0)
  h.step()
  h.seats.inputs[0].grab = false
  h.step()
  assert.deepEqual(h.events, [{ kind: 'teamScore', seat: 0, a: 1, b: 0 }], 'team 0 banks it')

  h.seats.positions[1] = v3(0, 2, 0)
  h.seats.inputs[1].grab = true
  h.step()
  assert.equal(h.seats.carry(1), CarryKind.object, 'an exposed enemy bank does not block the grab')
  assert.deepEqual(h.events, [
    { kind: 'teamScore', seat: 0, a: 1, b: 0 },
    { kind: 'teamScore', seat: 0, a: -1, b: 0 },
  ])
  assert.deepEqual(h.sounds, ['move.carry', 'move.release', 'obj.bank', 'move.carry', 'obj.steal'])
})

test('bank: a protected carry home of the other team still blocks the grab', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [
    bankCheck('bank-0', 0, [10, 2, 0]),
    carryCheck([[0, 2, 0.5]], [{ center: [0, 2, 0], half: [2, 2, 2], team: 1 }]),
  ] })
  h.seats.positions[0] = v3(0, 2, 0)
  h.seats.inputs[0].grab = true
  h.step()
  assert.equal(h.seats.carry(0), CarryKind.none, 'team 0 cannot grab in the team 1 home')
  assert.equal(h.events.length, 0)

  h.seats.inputs[0].grab = false
  h.seats.positions[1] = v3(0, 2, 0)
  h.seats.inputs[1].grab = true
  h.step()
  assert.equal(h.seats.carry(1), CarryKind.object, 'the home team may grab')
  assert.deepEqual(h.sounds, ['move.carry'])
})

test('bank: grabCandidates holds a carrying seat grab outside its own bank only', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [
    bankCheck('bank-0', 0, [0, 2, 0]),
    bankCheck('bank-1', 1, [20, 2, 0]),
    bankCheck('bank-null', null, [40, 2, 0]),
    carryCheck([[10, 2, 0.5]]),
  ] })
  const bank = featureOf(h, 'bank')
  const out: { id: number; dist: number }[] = []
  const candidates = (at: Vec3): typeof out => {
    out.length = 0
    h.seats.positions[0] = at
    bank.grabCandidates!(at, v3(0, 0, 1), out)
    return out
  }
  h.seats.carries[0] = CarryKind.object
  assert.deepEqual(candidates(v3(10, 2, 0)), [{ id: -1, dist: 0 }], 'outside every bank')
  assert.deepEqual(candidates(v3(0, 2, 0)), [], 'inside its own team bank')
  assert.deepEqual(candidates(v3(40, 2, 0)), [], 'inside a null bank')
  assert.deepEqual(candidates(v3(20, 2, 0)), [{ id: -1, dist: 0 }],
    'an enemy bank does not hold the grab')
  h.seats.carries[0] = CarryKind.none
  assert.deepEqual(candidates(v3(10, 2, 0)), [], 'not carrying')
})

test('bank: botTarget of a carrying seat is the nearest own or null bank', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [
    bankCheck('enemy', 1, [0, 2, 0]),
    bankCheck('own', 0, [6, 2, 0]),
    bankCheck('neutral', null, [10, 2, 0]),
    carryCheck([[0, 2, 0.5]]),
  ] })
  const out = v3(0, 0, 0)
  h.seats.carries[0] = CarryKind.object
  assert.equal(featureOf(h, 'bank').botTarget!(20, v3(0, 2, 0), out), true)
  near(out, v3(6, 2, 0), 'own bank ')

  const neutral = await harness(t, { withBall: false, extraFeatures: [
    bankCheck('enemy', 1, [0, 2, 0]),
    bankCheck('neutral', null, [10, 2, 0]),
    carryCheck([[0, 2, 0.5]]),
  ] })
  neutral.seats.carries[0] = CarryKind.object
  assert.equal(featureOf(neutral, 'bank').botTarget!(20, v3(0, 2, 0), out), true)
  near(out, v3(10, 2, 0), 'null bank ')

  const enemyOnly = await harness(t, { withBall: false, extraFeatures: [
    bankCheck('enemy', 1, [0, 2, 0]),
    carryCheck([[0, 2, 0.5]]),
  ] })
  enemyOnly.seats.carries[0] = CarryKind.object
  assert.equal(featureOf(enemyOnly, 'bank').botTarget!(20, v3(0, 2, 0), out), false,
    'an enemy bank is not a carrying target')
})

test('QB1: banks and carry items restore at tick 60 of 120 reproduces the snapshot bytes exactly', async t => {
  const options: HarnessOptions = {
    withBall: false,
    extraFeatures: [
      bankCheck('bank-0', 0, [0, 2, 0]),
      bankCheck('bank-1', 1, [8, 2, 0]),
      carryCheck([[0, 2, 0.5], [8, 2, 0.5]]),
    ],
  }
  const a = await harness(t, options), b = await harness(t, options)
  const drive = (h: Harness, tick: number) => {
    h.seats.inputs[0].grab = tick >= 2 && tick < 80
    h.seats.positions[0] = tick < 10 || (tick >= 40 && tick < 70) ? v3(0, 2, 0)
      : tick < 40 ? v3(Math.sin(tick / 7) * 0.5, 2, Math.cos(tick / 9) * 0.5)
      : v3(8, 2, 0)
    h.step()
  }
  for (let tick = 0; tick < 60; tick++) drive(a, tick)
  assert.equal(a.seats.carry(0), CarryKind.object, 'the checkpoint holds a carried sweet')
  const checkpoint = a.snapshot()
  b.physics.restoreSnapshot(a.physics.takeSnapshot())
  b.seats.carries = [...a.seats.carries]
  b.seats.ids = [...a.seats.ids]
  b.restore(checkpoint)
  assert.deepEqual(b.snapshot(), checkpoint)

  for (let tick = 60; tick < 120; tick++) { drive(a, tick); drive(b, tick) }
  assert.deepEqual(b.snapshot(), a.snapshot())
  assert.deepEqual(b.physics.takeSnapshot(), a.physics.takeSnapshot())

  const c = await harness(t, options), d = await harness(t, options)
  for (let tick = 0; tick < 120; tick++) { drive(c, tick); drive(d, tick) }
  assert.deepEqual(d.snapshot(), c.snapshot())
  assert.deepEqual(c.snapshot(), a.snapshot())
})

// Tail cases: half the seats start with a tail, a grab transfers it with an
// immunity window, a death frees it, the spawn is the free pool, and bots flee
// or chase depending on possession.

function tailCheck(count: 'half' | number, spawn: [number, number, number] = [0, 2, 0],
  immunityS = 1): FeatureSpec {
  return { id: 'tails', kind: 'tailSet', params: { count, spawn, immunityS } }
}

function holdersOf(h: Harness): number[] {
  return h.seats.carries.flatMap((kind, i) => kind === CarryKind.tail ? [i] : [])
}

test('tailSet: half of 4 seats hold a tail from the first round tick, same seed same holders', async t => {
  const options: HarnessOptions = { withBall: false, count: 4, extraFeatures: [tailCheck('half')] }
  const a = await harness(t, options), b = await harness(t, options)
  a.step()
  b.step()
  const holders = holdersOf(a)
  assert.equal(holders.length, 2, 'two of four seats hold a tail')
  assert.deepEqual(holdersOf(b), holders, 'the same seed picks the same holders')
  assert.equal(a.events.length, 2)
  assert.ok(a.events.every(event => event.kind === 'possess' && event.a === 1 && event.b === 0))
  assert.deepEqual(new Set(a.events.map(event => event.seat)),
    new Set(holders.map(i => a.seats.seatIds[i])), 'possess 1 for each holder seat')
  assert.deepEqual(a.sounds, ['obj.tail', 'obj.tail'])
  for (const i of holders) assert.equal(a.seats.ids[i], 0, 'carryId 0')
  for (const i of [0, 1, 2, 3].filter(i => !holders.includes(i))) {
    assert.equal(a.seats.carries[i], CarryKind.none)
  }
  a.step()
  assert.equal(a.events.length, 2, 'the tails are given only once')
})

test('tailSet: a grab press next to a holder transfers the tail', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [tailCheck(1)] })
  h.step()
  const holder = holdersOf(h)[0]
  const grabber = holder === 0 ? 1 : 0
  h.events.length = 0
  h.sounds.length = 0
  h.seats.positions[holder] = v3(0, 2, 0)
  h.seats.positions[grabber] = v3(0.5, 2, 0)
  h.seats.inputs[grabber].grab = true
  h.step()
  assert.equal(h.seats.carry(holder), CarryKind.none, 'the old holder loses the tail')
  assert.equal(h.seats.carry(grabber), CarryKind.tail, 'the new holder carries it')
  assert.deepEqual(h.events, [
    { kind: 'possess', seat: h.seats.seatIds[holder], a: 0, b: 0 },
    { kind: 'possess', seat: h.seats.seatIds[grabber], a: 1, b: 0 },
  ])
  assert.deepEqual(h.sounds, ['obj.tail'])
})

test('tailSet: a grab during immunityS fails and succeeds when it expires', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [tailCheck(1, [0, 2, 0], 1)] })
  h.step()
  const first = holdersOf(h)[0]
  const second = first === 0 ? 1 : 0
  h.seats.positions[first] = v3(0, 2, 0)
  h.seats.positions[second] = v3(0.5, 2, 0)
  h.seats.inputs[second].grab = true
  h.step()
  assert.equal(h.seats.carry(second), CarryKind.tail, 'the second seat takes the tail')
  assert.equal(h.physics.tick, 2)

  h.seats.inputs[first].grab = true
  h.step()
  assert.equal(h.seats.carry(first), CarryKind.none, 'the old holder cannot retake it during immunity')
  assert.equal(h.seats.carry(second), CarryKind.tail)

  while (h.physics.tick < 60) h.step()
  h.seats.inputs[first].grab = false
  h.step()
  assert.equal(h.physics.tick, 61)
  h.seats.inputs[first].grab = true
  h.step()
  assert.equal(h.seats.carry(first), CarryKind.tail, 'the expired immunity allows the grab')
  assert.equal(h.seats.carry(second), CarryKind.none)
})

test('tailSet: every 60 round ticks each holder re-emits possess 1', async t => {
  const h = await harness(t, { withBall: false, count: 4, extraFeatures: [tailCheck('half', [0, 2, 0], 0)] })
  h.step()
  const seats = holdersOf(h).map(i => h.seats.seatIds[i])
  assert.equal(seats.length, 2)
  h.events.length = 0
  for (let i = 0; i < 59; i++) h.step()
  assert.equal(h.events.length, 0, 'nothing on round ticks 1..59')
  h.step()
  assert.deepEqual(h.events, seats.map(seat => ({ kind: 'possess', seat, a: 1, b: 0 })))
  h.events.length = 0
  for (let i = 0; i < 59; i++) h.step()
  assert.equal(h.events.length, 0, 'nothing on round ticks 61..119')
  h.step()
  assert.deepEqual(h.events, seats.map(seat => ({ kind: 'possess', seat, a: 1, b: 0 })))
  assert.deepEqual(h.sounds, ['obj.tail', 'obj.tail'], 're-emits make no sound')
})

test('tailSet: an eliminated holder returns its tail to the free pool', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [tailCheck(1, [0, 2, 0], 0)] })
  h.step()
  const holder = holdersOf(h)[0]
  const other = holder === 0 ? 1 : 0
  h.events.length = 0
  h.seats.statuses[holder] = PlayerStatus.eliminated
  h.step()
  assert.equal(h.seats.carry(holder), CarryKind.none)
  assert.equal(h.seats.ids[holder], -1)
  assert.deepEqual(h.events, [{ kind: 'possess', seat: h.seats.seatIds[holder], a: 0, b: 0 }])

  h.seats.positions[other] = v3(0, 2, 0)
  h.seats.inputs[other].grab = true
  h.step()
  assert.equal(h.seats.carry(other), CarryKind.tail, 'another seat takes the freed tail at the spawn')
})

test('tailSet: botTarget makes holders flee and non-holders chase', async t => {
  const h = await harness(t, { withBall: false, extraFeatures: [tailCheck(1, [20, 2, 0], 0)] })
  h.step()
  const holder = holdersOf(h)[0]
  const chaser = holder === 0 ? 1 : 0
  const out = v3(0, 0, 0)
  const tails = featureOf(h, 'tailSet')
  h.seats.positions[holder] = v3(0, 2, 0)
  h.seats.positions[chaser] = v3(4, 2, 0)

  assert.equal(tails.botTarget!(h.seats.seatIds[holder], v3(0, 2, 0), out), true)
  near(out, v3(-6, 2, 0), 'flee away from the chaser ')
  assert.equal(tails.botTarget!(h.seats.seatIds[chaser], v3(4, 2, 0), out), true)
  near(out, v3(0, 2, 0), 'chase the holder ')

  h.seats.statuses[holder] = PlayerStatus.eliminated
  h.step()
  assert.equal(tails.botTarget!(h.seats.seatIds[chaser], v3(4, 2, 0), out), true)
  near(out, v3(20, 2, 0), 'chase the freed tail at the spawn ')
})

test('QB1: tails restore at tick 60 of 120 reproduces the snapshot bytes exactly', async t => {
  const options: HarnessOptions = {
    withBall: false, count: 4,
    extraFeatures: [tailCheck('half', [0, 2, 0], 0.5)],
  }
  const a = await harness(t, options), b = await harness(t, options)
  const drive = (h: Harness, tick: number) => {
    h.seats.inputs[0].grab = tick % 7 < 3
    h.seats.inputs[1].grab = tick % 11 < 2
    h.seats.inputs[2].grab = tick === 30 || tick === 45
    if (tick === 6) h.seats.statuses[2] = PlayerStatus.eliminated
    h.seats.positions[0] = v3(Math.sin(tick / 7) * 0.5, 2, 0)
    h.seats.positions[1] = v3(Math.cos(tick / 9) * 0.5, 2, 0)
    h.seats.positions[2] = v3(0, 2, 0.5)
    h.seats.positions[3] = v3(20 + (tick % 5), 2, 0)
    h.step()
  }
  for (let tick = 0; tick < 60; tick++) drive(a, tick)
  const checkpoint = a.snapshot()
  b.physics.restoreSnapshot(a.physics.takeSnapshot())
  b.seats.carries = [...a.seats.carries]
  b.seats.ids = [...a.seats.ids]
  b.seats.statuses = [...a.seats.statuses]
  b.restore(checkpoint)
  assert.deepEqual(b.snapshot(), checkpoint)

  for (let tick = 60; tick < 120; tick++) { drive(a, tick); drive(b, tick) }
  assert.deepEqual(b.snapshot(), a.snapshot())
  assert.deepEqual(b.physics.takeSnapshot(), a.physics.takeSnapshot())

  const c = await harness(t, options), d = await harness(t, options)
  for (let tick = 0; tick < 120; tick++) { drive(c, tick); drive(d, tick) }
  assert.deepEqual(d.snapshot(), c.snapshot())
  assert.deepEqual(c.snapshot(), a.snapshot())
})
