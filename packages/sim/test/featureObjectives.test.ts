import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { Rng, SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier, RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { CharMode } from '../src/character/constants.ts'
import { legacyLevel } from '../src/course.ts'
import type { HomeSpec, LevelSpec, ResolvedCourse, SpawnPoint } from '../src/course.ts'
import { ballFeature, goalFeature } from '../src/features/football.ts'
import type { CourseFeature, FeatureCtx, FeatureSeats } from '../src/features/feature.ts'
import { G, groups } from '../src/groups.ts'
import { neutralInput } from '../src/input.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'

// Shared football harness: StubSeats records teleports, the course lists a ball
// plus goal specs, and every feature snapshot is compared as raw bytes.

export interface Teleport { seat: number; at: SpawnPoint }

export class StubSeats implements FeatureSeats {
  readonly count = 2
  positions = [v3(0, 2, 0), v3(10, 2, 0)]
  velocities = [v3(0, 0, 0), v3(0, 0, 0)]
  directions = [v3(0, 0, 1), v3(0, 0, 1)]
  modes = [CharMode.ground, CharMode.ground]
  statuses = [PlayerStatus.alive, PlayerStatus.alive]
  teams = [0, 1]
  carries = [0, 0]
  ids = [-1, -1]
  inputs = [neutralInput(), neutralInput()]
  protectedFlags = [false, false]
  teleports: Teleport[] = []
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
}

export interface Harness {
  physics: RapierWorldSim
  seats: StubSeats
  events: { kind: string; seat: number; a: number; b: number }[]
  sounds: string[]
  ctx: FeatureCtx
  features: CourseFeature[]
  ball(): ReturnType<RapierWorldSim['body']>
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
  const seats = new StubSeats(), events: Harness['events'] = [], sounds: string[] = []
  const base: ResolvedCourse = {
    id: 'football-test', name: 'Football', kind: 'race', profiles: ['standard'], timeLimitS: 60,
    killPlaneY: -12, spawns: [], checkpoints: [], finish: null, path: [], regions: [],
    queuePad: null, obstacles: [], contentHash: 0, features: [],
  }
  const level: LevelSpec = { ...legacyLevel(base), homes: options.homes ?? [] }
  const course: ResolvedCourse = { ...base, level, features: [
    { id: 'ball', kind: 'ball', params: { spawn, radius: options.radius ?? 0.5,
      mass: options.mass ?? 5, resetS: options.resetS ?? 30 } },
    ...goals.map((goal, index) => ({ id: `goal-${index}`, kind: 'goal',
      params: { team: goal.team, center: goal.center, half: goal.half } })),
  ] }
  const ctx: FeatureCtx = {
    R, physics, seats, course, rng: new Rng(1), get tick() { return physics.tick },
    get roundTick() { return physics.tick }, entrants: 2, overtime: false, trailingTeam: -1,
    soundLoop() {},
    emit(kind, seat, a, b) { events.push({ kind, seat, a, b }) },
    sound(id) { sounds.push(id) },
  }
  const features = course.features!.map((spec, index) =>
    spec.kind === 'goal'
      ? goalFeature(spec, `football-test#/features/${index}`)
      : ballFeature(spec, `football-test#/features/${index}`))
  for (const feature of features) feature.init(ctx)
  const ballId = physics.ids().at(-1)!
  return {
    physics, seats, events, sounds, ctx, features,
    ball: () => physics.body(ballId),
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
