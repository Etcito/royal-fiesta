import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { CHAR, CharMode } from '../src/character/constants.ts'
import { CharacterSystem } from '../src/character/system.ts'
import type { CharState } from '../src/character/system.ts'
import type { CourseKind, Motion, ObstacleSpec, ResolvedCourse, SpawnPoint } from '../src/course.ts'
import { PI } from '../src/detmath.ts'
import { NEUTRAL_CODE, decodeInput, inputCode, neutralInput } from '../src/input.ts'
import type { PlayerInput } from '../src/input.ts'
import { PlayerStatus, RoundSystem } from '../src/match/roundSystem.ts'
import type { RoundPlan } from '../src/match/rules.ts'
import type { MatchSetup } from '../src/match/setup.ts'
import { ObstacleSystem } from '../src/obstacles/system.ts'
import { v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'
import { FiestaWorld } from '../src/world.ts'
import type { SimSystem, WorldCtx } from '../src/world.ts'

const R: RapierModule = await initRapier()
const N = 8
const ALL = [0, 1, 2, 3, 4, 5, 6, 7]
const ID = { x: 0, y: 0, z: 0, w: 1 }
const STAND = CHAR.halfHeight + CHAR.radius + 0.01
const FORWARD = inputCode({ moveZ: 1 })
const SETUP_MARKER = 0x52544553

function obstacle(id: string, t: Vec3, motion: Motion, half: Vec3): ObstacleSpec {
  return { id, asset: id, t, r: ID, s: v3(1, 1, 1), friction: 0.5, motion, colliders: [{ shape: 'cuboid', half, t: v3(0, 0, 0), r: ID }] }
}

const FLOOR = obstacle('floor', v3(0, -0.5, 10), { kind: 'static' }, v3(40, 0.5, 40))
// Far from every spawn: only a player placed next to it gets knocked.
const SPINNER = obstacle('spin', v3(-12, CHAR.halfHeight + CHAR.radius, 10), { kind: 'spinner', axis: v3(0, 1, 0), radPerTick: PI / 60, phase: 0 }, v3(4, 0.25, 0.25))

function spawn(x: number, z: number): SpawnPoint {
  return { t: v3(x, 0, z), facing: { x: 0, z: 1 } }
}

function course(kind: CourseKind, extra: ObstacleSpec[] = []): ResolvedCourse {
  const race = kind === 'race'
  return {
    id: `round-${kind}`, name: `Round ${kind}`, kind, profiles: ['standard', 'sprint'], timeLimitS: 60, killPlaneY: -5,
    spawns: ALL.map((i) => spawn(-3.5 + i, 0)),
    checkpoints: race ? [{ box: { center: v3(0, 1, 5), half: v3(10, 2, 1) }, respawn: spawn(0, 5) }] : [],
    finish: race ? { center: v3(0, 1, 12), half: v3(10, 2, 1) } : null,
    path: [], regions: [], queuePad: null, obstacles: [FLOOR, ...extra], contentHash: 1,
  }
}

// Loads the only course in init, as the match system would before a round.
class SetupSystem implements SimSystem<PlayerInput> {
  readonly name = 'setup'
  readonly obstacles: ObstacleSystem
  constructor(obstacles: ObstacleSystem) { this.obstacles = obstacles }
  init(ctx: WorldCtx<PlayerInput>): void { this.obstacles.load(ctx, 0) }
  preStep(_ctx: WorldCtx<PlayerInput>, _inputs: readonly PlayerInput[]): void {}
  postStep(_ctx: WorldCtx<PlayerInput>): void {}
  snapshot(w: SnapWriter): void { w.u32(SETUP_MARKER) }
  restore(r: SnapReader, _ctx: WorldCtx<PlayerInput>): void {
    if (r.u32() !== SETUP_MARKER) throw new Error('round test setup marker mismatch')
  }
}

interface Rig {
  world: FiestaWorld<PlayerInput>
  chars: CharacterSystem
  round: RoundSystem
  inputs: PlayerInput[]
}

function rig(c: ResolvedCourse): Rig {
  const setup: MatchSetup = { seed: 1, playerCount: N, humans: ALL.map(() => false), profile: 'sprint', courses: [c] }
  const obstacles = new ObstacleSystem([c])
  const chars = new CharacterSystem({ playerCount: N })
  const round = new RoundSystem(setup)
  const world = new FiestaWorld<PlayerInput>(R, { playerCount: N, systems: [obstacles, chars, new SetupSystem(obstacles), round] })
  return { world, chars, round, inputs: ALL.map(() => neutralInput()) }
}

function begin(r: Rig, plan: RoundPlan, participants: readonly number[], capTicks: number, spawnOrder: readonly number[] = ALL): void {
  r.round.begin(r.world.ctx, plan, 0, participants, spawnOrder, capTicks)
}

function step(r: Rig, code: (p: number) => number = () => NEUTRAL_CODE): void {
  for (let p = 0; p < N; p++) decodeInput(code(p), r.inputs[p])
  r.world.step(r.inputs)
}

function stepUntil(r: Rig, done: () => boolean, max: number, code?: (p: number) => number): void {
  for (let i = 0; i < max; i++) {
    step(r, code)
    if (done()) return
  }
  assert.fail(`condition not met within ${max} ticks`)
}

function state(r: Rig, p: number): CharState {
  return r.chars.state(r.world.ctx, p, { pos: v3(0, 0, 0), vel: v3(0, 0, 0), facing: { x: 0, z: 0 }, mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0 })
}

function put(r: Rig, p: number, x: number, y: number, z: number): void {
  r.chars.place(r.world.ctx, p, { t: v3(x, y, z), facing: { x: 0, z: 1 } })
}

// Below the kill plane, as if the player had fallen off.
function drop(r: Rig, p: number): void {
  const s = state(r, p)
  put(r, p, s.pos.x, -10, s.pos.z)
}

function near(actual: number, expected: number, eps: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: ${actual} vs ${expected}`)
}

function statuses(r: Rig): number[] {
  return ALL.map((p) => r.round.status(p))
}

const RACE: RoundPlan = { index: 0, kind: 'race', final: false, target: 2 }
const SURVIVAL: RoundPlan = { index: 1, kind: 'survival', final: false, target: 2 }
const FINAL: RoundPlan = { index: 2, kind: 'survival', final: true, target: 1 }

describe('race', () => {
  it('begin places participants on their spawns and parks the others', () => {
    const r = rig(course('race'))
    begin(r, RACE, [1, 4, 6], 600, [5, 0, 2])
    assert.deepEqual(statuses(r), [0, 1, 0, 0, 1, 0, 1, 0])
    near(state(r, 1).pos.x, 1.5, 1e-9, 'p1 x (spawn 5)')
    near(state(r, 4).pos.x, -3.5, 1e-9, 'p4 x (spawn 0)')
    near(state(r, 6).pos.x, -1.5, 1e-9, 'p6 x (spawn 2)')
    for (const p of [0, 2, 3, 5, 7]) assert.equal(r.chars.isParked(p), true, `p${p} parked`)
    assert.equal(r.round.active, true)
    assert.equal(r.round.over, false)
    assert.equal(r.round.ticksLeft(r.world.ctx), 600)
    step(r)
    assert.equal(r.round.ticksLeft(r.world.ctx), 599)
    r.world.free()
  })

  it('a fall after the checkpoint respawns at the checkpoint respawn', () => {
    const r = rig(course('race'))
    begin(r, RACE, ALL, 3600)
    assert.equal(r.round.checkpoint(0), -1)
    stepUntil(r, () => r.round.checkpoint(0) === 0, 120, (p) => p === 0 ? FORWARD : NEUTRAL_CODE)
    step(r)
    drop(r, 0)
    const t = r.world.tick
    step(r)
    const s = state(r, 0)
    assert.equal(r.round.status(0), PlayerStatus.alive)
    assert.equal(r.round.checkpoint(0), 0)
    assert.equal(s.teleportTick, t)
    near(s.pos.x, 0, 1e-9, 'respawn x')
    near(s.pos.z, 5, 1e-9, 'respawn z')
    near(s.pos.y, STAND, 0.05, 'respawn y')
    r.world.free()
  })

  it('a fall with no checkpoint respawns at the player own spawn', () => {
    const r = rig(course('race'))
    begin(r, RACE, ALL, 3600, [7, 6, 5, 4, 3, 2, 1, 0])
    step(r)
    drop(r, 3)
    const t = r.world.tick
    step(r)
    const s = state(r, 3)
    assert.equal(r.round.status(3), PlayerStatus.alive)
    assert.equal(r.round.checkpoint(3), -1)
    assert.equal(s.teleportTick, t)
    near(s.pos.x, 0.5, 1e-9, 'spawn 4 x')
    near(s.pos.z, 0, 1e-9, 'spawn 4 z')
    near(s.pos.y, STAND, 0.05, 'spawn y')
    r.world.free()
  })

  it('finishers qualify frozen and the round ends by target', () => {
    const r = rig(course('race'))
    begin(r, RACE, ALL, 3600)
    const startTick = r.world.tick
    let tick = 0
    const runners = (p: number) => p === 0 || (p === 2 && tick >= 20) ? FORWARD : NEUTRAL_CODE
    let firstQualified = -1
    let closeTick = -1
    for (; tick < 400 && !r.round.over; tick++) {
      closeTick = r.world.tick
      step(r, runners)
      if (firstQualified < 0 && r.round.status(0) === PlayerStatus.qualified) {
        firstQualified = tick
        assert.equal(r.round.status(2), PlayerStatus.alive, 'p2 still running when p0 finishes')
        assert.equal(r.round.over, false)
        step(r, runners)
        tick++
        const s = state(r, 0)
        assert.equal(s.mode, CharMode.frozen)
        near(Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z), 0, 1e-3, 'frozen horizontal speed')
      }
    }
    assert.ok(firstQualified >= 0, 'p0 finished')
    assert.equal(r.round.over, true)
    const res = r.round.result()
    assert.deepEqual(res.qualified, [0, 2])
    assert.deepEqual(res.eliminated, [1, 3, 4, 5, 6, 7])
    assert.deepEqual(res.participants, ALL)
    assert.equal(res.reason, 'target')
    assert.equal(res.startTick, startTick)
    assert.equal(res.endTick, closeTick)
    assert.equal(r.round.checkpoint(0), 1, 'finished = checkpoints.length')
    assert.ok(r.round.progress(r.world.ctx, 0) > r.round.progress(r.world.ctx, 2), 'first finisher ranks first')
    r.round.end(r.world.ctx)
    assert.equal(r.round.active, false)
    step(r, () => FORWARD)
    for (const p of ALL) assert.equal(state(r, p).mode, CharMode.frozen, `p${p} frozen after end`)
    r.world.free()
  })
})

describe('survival', () => {
  it('a fall eliminates and parks; the round is over when alive <= target', () => {
    const r = rig(course('survival'))
    begin(r, SURVIVAL, [0, 1, 2, 3], 3600)
    step(r)
    drop(r, 3)
    step(r)
    assert.equal(r.round.status(3), PlayerStatus.eliminated)
    assert.equal(r.chars.isParked(3), true)
    assert.equal(r.round.over, false, '3 alive > target 2')
    step(r)
    drop(r, 1)
    const t = r.world.tick
    step(r)
    assert.equal(r.round.over, true)
    const res = r.round.result()
    assert.deepEqual(res.participants, [0, 1, 2, 3])
    assert.deepEqual(res.qualified, [0, 2])
    assert.deepEqual(res.eliminated, [3, 1])
    assert.equal(res.reason, 'target')
    assert.equal(res.endTick, t)
    assert.deepEqual(statuses(r), [2, 3, 2, 3, 0, 0, 0, 0])
    r.world.free()
  })

  it('the final ends by lastStanding', () => {
    const r = rig(course('survival'))
    begin(r, FINAL, [2, 5, 6], 3600)
    step(r)
    drop(r, 6)
    step(r)
    assert.equal(r.round.over, false)
    drop(r, 2)
    step(r)
    const res = r.round.result()
    assert.deepEqual(res.qualified, [5])
    assert.deepEqual(res.eliminated, [6, 2])
    assert.equal(res.reason, 'lastStanding')
    r.world.free()
  })
})

describe('caps', () => {
  it('race at the cap with a finisher: finishers qualify, the rest are eliminated', () => {
    const r = rig(course('race'))
    begin(r, { index: 0, kind: 'race', final: false, target: 3 }, ALL, 240)
    stepUntil(r, () => r.round.status(0) === PlayerStatus.qualified, 200, (p) => p === 0 ? FORWARD : NEUTRAL_CODE)
    assert.equal(r.round.over, false)
    stepUntil(r, () => r.round.over, 240)
    assert.equal(r.round.ticksLeft(r.world.ctx), 0)
    const res = r.round.result()
    assert.deepEqual(res.qualified, [0])
    assert.deepEqual(res.eliminated, [1, 2, 3, 4, 5, 6, 7])
    assert.equal(res.reason, 'timeCap')
    assert.equal(res.endTick - res.startTick, 240)
    r.world.free()
  })

  it('race at the cap with no finisher: the top target by progress qualify', () => {
    const r = rig(course('race'))
    begin(r, { index: 0, kind: 'race', final: false, target: 3 }, ALL, 30)
    put(r, 6, 0, 0, 5) // inside the checkpoint box
    put(r, 2, 0, 0, 3)
    put(r, 4, 0, 0, 2)
    stepUntil(r, () => r.round.over, 40)
    assert.equal(r.round.checkpoint(6), 0)
    const res = r.round.result()
    assert.deepEqual(res.qualified, [6, 2, 4])
    assert.deepEqual(res.eliminated, [0, 1, 3, 5, 7])
    assert.equal(res.reason, 'timeCap')
    r.world.free()
  })

  it('survival at the cap: every alive player qualifies', () => {
    const r = rig(course('survival'))
    begin(r, SURVIVAL, [0, 1, 2, 3, 4], 30)
    step(r)
    drop(r, 1)
    stepUntil(r, () => r.round.over, 40)
    const res = r.round.result()
    assert.deepEqual(res.qualified, [0, 2, 3, 4])
    assert.deepEqual(res.eliminated, [1])
    assert.equal(res.reason, 'timeCap')
    r.world.free()
  })

  it('final at the cap: the fewest knockbacks win, then the lowest index', () => {
    const r = rig(course('survival', [SPINNER]))
    begin(r, FINAL, [0, 1, 2], 90)
    put(r, 0, -12, 0, 12.5) // 2.5 m from the spinner axis
    stepUntil(r, () => r.round.over, 100)
    assert.ok(state(r, 0).knockbacks >= 1, 'p0 was knocked')
    assert.equal(state(r, 1).knockbacks, 0)
    assert.equal(state(r, 2).knockbacks, 0)
    const res = r.round.result()
    assert.deepEqual(res.qualified, [1])
    assert.equal(res.reason, 'timeCap')
    assert.equal(res.eliminated.length, 2)
    assert.deepEqual(res.eliminated.slice().sort(), [0, 2])
    r.world.free()
  })
})

describe('allFell', () => {
  it('everyone left falls in one tick: they qualify lowest index first', () => {
    const r = rig(course('survival'))
    begin(r, SURVIVAL, [0, 1, 2, 3], 3600)
    step(r)
    drop(r, 3)
    step(r)
    drop(r, 2)
    drop(r, 0)
    drop(r, 1)
    step(r)
    const res = r.round.result()
    assert.deepEqual(res.qualified, [0, 1, 2])
    assert.deepEqual(res.eliminated, [3])
    assert.equal(res.reason, 'allFell')
    r.world.free()
  })

  it('in the final the lowest index of the last fallers wins', () => {
    const r = rig(course('survival'))
    begin(r, FINAL, [2, 5], 3600)
    step(r)
    drop(r, 5)
    drop(r, 2)
    step(r)
    const res = r.round.result()
    assert.deepEqual(res.qualified, [2])
    assert.deepEqual(res.eliminated, [5])
    assert.equal(res.reason, 'allFell')
    r.world.free()
  })
})

describe('snapshot', () => {
  it('restore keeps result() and status() identical', () => {
    const runners = (p: number) => p === 1 || p === 5 ? FORWARD : NEUTRAL_CODE
    const r = rig(course('race'))
    begin(r, RACE, ALL, 3600)
    for (let i = 0; i < 40; i++) step(r, runners)
    const mid = r.world.takeSnapshotBytes()
    const midStatus = statuses(r)
    const midCp = ALL.map((p) => r.round.checkpoint(p))
    stepUntil(r, () => r.round.over, 300, runners)
    const res = r.round.result()
    const endStatus = statuses(r)
    const end = r.world.takeSnapshotBytes()
    const endTick = r.world.tick

    r.world.restoreSnapshotBytes(mid)
    assert.deepEqual(statuses(r), midStatus)
    assert.deepEqual(ALL.map((p) => r.round.checkpoint(p)), midCp)
    stepUntil(r, () => r.round.over, 300, runners)
    assert.equal(r.world.tick, endTick)
    assert.deepEqual(r.round.result(), res)
    assert.deepEqual(r.world.takeSnapshotBytes(), end)

    const fresh = rig(course('race'))
    fresh.world.restoreSnapshotBytes(end)
    assert.equal(fresh.round.active, true)
    assert.equal(fresh.round.over, true)
    assert.deepEqual(statuses(fresh), endStatus)
    assert.deepEqual(fresh.round.result(), res)
    assert.deepEqual(fresh.world.takeSnapshotBytes(), end)
    r.world.free()
    fresh.world.free()
  })

  it('a survival round with falls survives a round-trip into a fresh world', () => {
    const r = rig(course('survival'))
    begin(r, FINAL, [0, 3, 4], 3600)
    step(r)
    drop(r, 3)
    drop(r, 0)
    step(r)
    const res = r.round.result()
    const fresh = rig(course('survival'))
    fresh.world.restoreSnapshotBytes(r.world.takeSnapshotBytes())
    assert.deepEqual(statuses(fresh), statuses(r))
    assert.deepEqual(fresh.round.result(), res)
    assert.equal(res.reason, 'lastStanding')
    r.world.free()
    fresh.world.free()
  })
})
