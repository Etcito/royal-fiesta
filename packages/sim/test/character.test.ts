import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { FIXED_DT, initRapier } from '@gamesaloon/rollback-rapier'
import type { BodyId, RapierModule } from '@gamesaloon/rollback-rapier'
import { CHAR, CarryKind, CharMode } from '../src/character/constants.ts'
import { approach2, turnFacing } from '../src/character/controller.ts'
import { CharacterSystem, characterBody } from '../src/character/system.ts'
import type { CharState } from '../src/character/system.ts'
import type { Motion, ObstacleSpec, ResolvedCourse, Surface } from '../src/course.ts'
import { PI, datan2 } from '../src/detmath.ts'
import { G, groups } from '../src/groups.ts'
import { decodeInput, inputCode, neutralInput } from '../src/input.ts'
import type { PlayerInput } from '../src/input.ts'
import { ObstacleSystem } from '../src/obstacles/system.ts'
import { v3, yawFacing } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'
import { FiestaWorld, GRAVITY_Y } from '../src/world.ts'
import type { SimSystem } from '../src/world.ts'

// Tests use CHAR.* symbolically: tuning the constants must not break them.

const MAX_TURN = CHAR.turnRate * FIXED_DT

function yawOf(f: { x: number; z: number }): number {
  return datan2(f.x, f.z)
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  return Math.sqrt(dx * dx + dz * dz)
}

describe('controller', () => {
  it('approach2 reaches the target in ceil(dist/maxDelta) calls and never overshoots', () => {
    const maxDelta = CHAR.maxRun / 4
    const target = { x: 0, z: CHAR.maxRun }
    const start = { x: 0, z: 0 }
    const calls = Math.ceil(dist2(start.x, start.z, target.x, target.z) / maxDelta)
    const p = { x: start.x, z: start.z }
    let previous = dist2(p.x, p.z, target.x, target.z)
    for (let i = 0; i < calls; i++) {
      approach2(p.x, p.z, target.x, target.z, maxDelta, p)
      const remaining = dist2(p.x, p.z, target.x, target.z)
      assert.ok(remaining <= previous, `call ${i}: distance to target grew`)
      assert.ok(remaining <= previous - maxDelta + 1e-12, `call ${i}: step exceeded maxDelta`)
      previous = remaining
    }
    assert.deepEqual(p, target, `after ${calls} calls`)
  })

  it('approach2 is a no-op at the target', () => {
    const target = { x: CHAR.maxRun, z: -CHAR.maxRun }
    approach2(target.x, target.z, target.x, target.z, CHAR.maxRun, target)
    assert.deepEqual(target, { x: CHAR.maxRun, z: -CHAR.maxRun })
  })

  it('turnFacing turns by exactly maxAngle when the target is behind', () => {
    const facing = yawFacing(0, { x: 0, z: 0 })
    const behind = yawFacing(PI, { x: 0, z: 0 })
    const out = turnFacing(facing.x, facing.z, behind.x, behind.z, MAX_TURN, { x: 0, z: 0 })
    const turned = Math.abs(yawOf(out) - yawOf(facing))
    assert.ok(Math.abs(turned - MAX_TURN) <= 1e-12, `turned ${turned}, wanted ${MAX_TURN}`)
  })

  it('turnFacing snaps when within maxAngle', () => {
    const facing = yawFacing(0, { x: 0, z: 0 })
    const aim = yawFacing(MAX_TURN / 2, { x: 0, z: 0 })
    const out = turnFacing(facing.x, facing.z, aim.x, aim.z, MAX_TURN, { x: 0, z: 0 })
    const inv = 1 / Math.sqrt(aim.x * aim.x + aim.z * aim.z)
    assert.equal(out.x, aim.x * inv)
    assert.equal(out.z, aim.z * inv)
  })

  it('turnFacing keeps the facing for a zero target', () => {
    const facing = yawFacing(1, { x: 0, z: 0 })
    const out = { x: 9, z: 9 }
    turnFacing(facing.x, facing.z, 0, 0, MAX_TURN, out)
    assert.equal(out.x, facing.x)
    assert.equal(out.z, facing.z)
    turnFacing(facing.x, facing.z, 1e-9, -1e-9, MAX_TURN, out)
    assert.equal(out.x, facing.x)
    assert.equal(out.z, facing.z)
  })

  it('turnFacing returns a unit vector', () => {
    const cases: [number, number, number, number][] = [
      [0, 1, 1, 0],
      [0, 1, 0, -1],
      [0, 1, 1, 1],
      [1, 0, 0, -1],
    ]
    const out = { x: 0, z: 0 }
    for (const [fx, fz, tx, tz] of cases) {
      turnFacing(fx, fz, tx, tz, MAX_TURN, out)
      const len = Math.sqrt(out.x * out.x + out.z * out.z)
      assert.ok(Math.abs(len - 1) <= 1e-12, `length ${len} for (${fx},${fz})->(${tx},${tz})`)
    }
  })

  it('out may alias the inputs', () => {
    const p = { x: 0, z: 0 }
    approach2(p.x, p.z, 0, CHAR.maxRun, CHAR.maxRun / 2, p)
    assert.deepEqual(p, { x: 0, z: CHAR.maxRun / 2 })

    const aim = yawFacing(MAX_TURN * 3, { x: 0, z: 0 })
    const aliased = { x: 0, z: 1 }
    const returned = turnFacing(aliased.x, aliased.z, aim.x, aim.z, MAX_TURN, aliased)
    assert.equal(returned, aliased)
    assert.deepEqual(returned, turnFacing(0, 1, aim.x, aim.z, MAX_TURN, { x: 0, z: 0 }))
  })
})

const R: RapierModule = await initRapier()
const GROUND_HALF = 20

// One fixed cuboid whose top is y=0 and whose +Z edge is a ledge at z=GROUND_HALF.
function groundSystem(): SimSystem<PlayerInput> {
  return {
    name: 'ground',
    init(ctx) {
      ctx.physics.createBody(ctx.R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), [
        ctx.R.ColliderDesc.cuboid(GROUND_HALF, 0.5, GROUND_HALF)
          .setCollisionGroups(groups(G.STATIC, G.CHAR | G.DEBRIS | G.PROBE)),
      ])
    },
    preStep() {},
    postStep() {},
    snapshot() {},
    restore() {},
  }
}

interface Rig { world: FiestaWorld<PlayerInput>; chars: CharacterSystem }

function rig(players = 1, placeAt = v3(0, 0, 0)): Rig {
  const chars = new CharacterSystem({ playerCount: players })
  const world = new FiestaWorld<PlayerInput>(R, { playerCount: players, systems: [groundSystem(), chars] })
  for (let p = 0; p < players; p++) {
    chars.place(world.ctx, p, { t: v3(placeAt.x + p * 2, placeAt.y, placeAt.z), facing: { x: 0, z: 1 } })
  }
  return { world, chars }
}

function input(partial: Partial<PlayerInput>): PlayerInput {
  return decodeInput(inputCode(partial), neutralInput())
}

// A domain-style recipe: the caller spawns the character bodies from the shared helper, then
// hands their ids to a CharacterSystem created with externalBodies.
function externalBodySystem(chars: CharacterSystem): SimSystem<PlayerInput> {
  return {
    name: 'externalBodies',
    init(ctx) {
      const ids: BodyId[] = []
      for (let p = 0; p < chars.playerCount; p++) {
        const recipe = characterBody(ctx.R, p)
        ids.push(ctx.physics.createBody(recipe.body, recipe.colliders))
      }
      chars.bindBodies(ids)
    },
    preStep() {},
    postStep() {},
    snapshot() {},
    restore() {},
  }
}

const NEUTRAL = neutralInput()
const FORWARD = input({ moveZ: 1 })
const JUMP = input({ jump: true })
const FORWARD_JUMP = input({ moveZ: 1, jump: true })
const DIVE = input({ dive: true })
const GRABBER = input({ moveZ: 1, grab: true })
const STAND = CHAR.halfHeight + CHAR.radius

function newState(): CharState {
  return { pos: v3(0, 0, 0), vel: v3(0, 0, 0), facing: { x: 0, z: 0 }, mode: 0, grounded: false, groundObstacle: 0, knockbacks: 0, teleportTick: 0 }
}

function stepN(r: Rig, n: number, inp: PlayerInput): CharState {
  for (let i = 0; i < n; i++) r.world.step([inp])
  return r.chars.state(r.world.ctx, 0, newState())
}

function hspeed(s: CharState): number {
  return Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z)
}

// Steps until the predicate holds on the state after a step; returns that step's index.
function stepUntil(r: Rig, inp: (i: number) => PlayerInput, done: (s: CharState) => boolean, max = 600): number {
  for (let i = 0; i < max; i++) {
    r.world.step([inp(i)])
    if (done(r.chars.state(r.world.ctx, 0, newState()))) return i
  }
  assert.fail(`condition not met within ${max} ticks`)
}

// Obstacle worlds: a ResolvedCourse built in code, loaded by a test-local system in init.
const ID = { x: 0, y: 0, z: 0, w: 1 }

function obstacle(id: string, t: Vec3, motion: Motion, half: Vec3): ObstacleSpec {
  return { id, asset: id, t, r: ID, s: v3(1, 1, 1), friction: 0.5, motion, colliders: [{ shape: 'cuboid', half, t: v3(0, 0, 0), r: ID }] }
}

function course(obstacles: ObstacleSpec[]): ResolvedCourse {
  return {
    id: 'char-test', name: 'Character test', kind: 'race', profiles: ['standard'], timeLimitS: 60, killPlaneY: -10,
    spawns: [], checkpoints: [], finish: null, path: [], regions: [], queuePad: null, contentHash: 0, obstacles,
  }
}

const FLOOR = obstacle('floor', v3(0, -0.5, 0), { kind: 'static' }, v3(10, 0.5, 10))

interface ObsRig extends Rig { obs: ObstacleSystem }

function obsRig(obstacles: ObstacleSpec[], at: Vec3): ObsRig {
  const obs = new ObstacleSystem([course(obstacles)])
  const loader: SimSystem<PlayerInput> = {
    name: 'loader',
    init(ctx) { obs.load(ctx, 0) },
    preStep() {},
    postStep() {},
    snapshot() {},
    restore() {},
  }
  const chars = new CharacterSystem({ playerCount: 1 })
  const world = new FiestaWorld<PlayerInput>(R, { playerCount: 1, systems: [obs, loader, chars] })
  chars.place(world.ctx, 0, { t: at, facing: { x: 0, z: 1 } })
  return { world, chars, obs }
}

// Player 0 grabs player 1, 0.8 m ahead and facing it.
function grabRig(): Rig {
  const r = rig(2)
  r.chars.place(r.world.ctx, 0, { t: v3(0, 0, 0), facing: { x: 0, z: 1 } })
  r.chars.place(r.world.ctx, 1, { t: v3(0, 0, 0.8), facing: { x: 0, z: -1 } })
  return r
}

function state(r: Rig, p = 0): CharState {
  return r.chars.state(r.world.ctx, p, newState())
}

describe('system', () => {
  it('init parks every player at its slot with groups 0', () => {
    const chars = new CharacterSystem({ playerCount: 3 })
    const world = new FiestaWorld<PlayerInput>(R, { playerCount: 3, systems: [groundSystem(), chars] })
    const pos = new Float64Array(9)
    chars.readPositions(world.ctx, pos)
    for (let p = 0; p < 3; p++) {
      assert.equal(chars.isParked(p), true)
      assert.deepEqual([pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2]],
        [CHAR.parkOrigin.x + p * CHAR.parkStep, CHAR.parkOrigin.y, CHAR.parkOrigin.z])
      assert.equal(chars.state(world.ctx, p, newState()).mode, CharMode.parked)
    }
    const ids = world.physics.ids()
    for (let k = 1; k < ids.length; k++) {
      const rb = world.physics.body(ids[k])
      assert.equal(rb.collider(0).collisionGroups(), 0)
      assert.equal(rb.gravityScale(), 0)
    }
    world.step([NEUTRAL, NEUTRAL, NEUTRAL])
    // Mass properties are computed by the first step, in f32.
    for (let k = 1; k < ids.length; k++) {
      const m = world.physics.body(ids[k]).mass()
      assert.ok(Math.abs(m - CHAR.mass) <= CHAR.mass * 1e-6, `mass ${m} (Rapier is f32)`)
    }
    const after = new Float64Array(9)
    chars.readPositions(world.ctx, after)
    assert.deepEqual(after, pos, 'parked players do not move')
    world.free()
  })

  it('external bodies bound from the shared recipe match V1 state after 60 steps', () => {
    const players = 2
    const script = (t: number, p: number): PlayerInput =>
      input({ moveX: ((t * 7 + p * 3) % 11) / 5 - 1, moveZ: ((t * 5 + p) % 13) / 6 - 1, jump: (t + p) % 23 < 2 })
    const placeAll = (chars: CharacterSystem, world: FiestaWorld<PlayerInput>): void => {
      for (let p = 0; p < players; p++) chars.place(world.ctx, p, { t: v3(p * 2, 0, 0), facing: { x: 0, z: 1 } })
    }
    const v1Chars = new CharacterSystem({ playerCount: players })
    const v1 = new FiestaWorld<PlayerInput>(R, { playerCount: players, systems: [groundSystem(), v1Chars] })
    placeAll(v1Chars, v1)
    const extChars = new CharacterSystem({ playerCount: players, externalBodies: true })
    const ext = new FiestaWorld<PlayerInput>(R, {
      playerCount: players,
      systems: [groundSystem(), extChars, externalBodySystem(extChars)],
    })
    placeAll(extChars, ext)
    // init created no bodies of its own: the recipe spawned exactly V1's bodies and bind copied the ids.
    assert.equal(ext.physics.bodyCount, v1.physics.bodyCount)
    for (let t = 0; t < 60; t++) {
      const frame = [script(t, 0), script(t, 1)]
      v1.step(frame)
      ext.step(frame)
    }
    for (let p = 0; p < players; p++) {
      assert.deepEqual(state({ world: ext, chars: extChars }, p), state({ world: v1, chars: v1Chars }, p), `player ${p}`)
    }
    v1.free()
    ext.free()
  })

  it('writePlayer/readPlayer round-trip every per-player field', () => {
    const players = 3
    const a = rig(players)
    for (let t = 0; t < 50; t++) {
      a.world.step([FORWARD, GRABBER, input({ moveX: -1, jump: t % 7 === 0 })])
    }
    const src = new SnapWriter()
    for (let p = 0; p < players; p++) a.chars.writePlayer(src, p)
    const bytes = src.bytes().slice()
    // The concatenation of the per-player blocks is exactly the system's snapshot.
    const snap = new SnapWriter()
    a.chars.snapshot(snap)
    assert.deepEqual(snap.bytes().slice(), bytes)

    const fresh = new CharacterSystem({ playerCount: players })
    const r = new SnapReader(bytes)
    for (let p = 0; p < players; p++) fresh.readPlayer(r, p)
    const out = new SnapWriter()
    for (let p = 0; p < players; p++) fresh.writePlayer(out, p)
    assert.deepEqual(out.bytes().slice(), bytes)
    a.world.free()
  })

  it('after place, the character is grounded within 60 ticks with mode ground', () => {
    const r = rig()
    assert.equal(r.chars.isParked(0), false)
    stepUntil(r, () => NEUTRAL, (s) => s.grounded && s.mode === CharMode.ground, 60)
    r.world.free()
  })

  it('full forward input reaches maxRun, and releasing it brakes to 0', () => {
    const r = rig()
    const run = stepN(r, 60, FORWARD)
    assert.ok(Math.abs(hspeed(run) - CHAR.maxRun) <= 1e-6, `speed ${hspeed(run)}`)
    assert.ok(run.facing.z > 1 - 1e-12)
    const stop = stepN(r, 60, NEUTRAL)
    assert.ok(hspeed(stop) <= 1e-6, `speed ${hspeed(stop)}`)
    r.world.free()
  })

  it('a jump press rises, and lands again', () => {
    const r = rig()
    const rest = stepN(r, 30, NEUTRAL)
    const up = stepN(r, 1, JUMP)
    assert.equal(up.mode, CharMode.air)
    assert.ok(up.vel.y > 0)
    const top = stepN(r, 20, JUMP)
    assert.ok(top.pos.y > rest.pos.y + 0.5, `apex ${top.pos.y}`)
    stepUntil(r, () => NEUTRAL, (s) => s.grounded && s.mode === CharMode.ground, 120)
    r.world.free()
  })

  // First tick (step index) whose probe sees no ground after running onto and off the ledge.
  // Queries see a placed body only after one physics step, so the place tick reads air.
  function ledgeTick(): number {
    const r = rig(1, v3(0, 0, GROUND_HALF - CHAR.maxRun))
    let landed = false
    const k = stepUntil(r, () => FORWARD, (s) => (landed = landed || s.grounded) && !s.grounded)
    r.world.free()
    return k
  }

  it('coyote: a jump pressed coyoteTicks-1 ticks after walking off a ledge fires', () => {
    const k = ledgeTick()
    for (const [late, fires] of [[CHAR.coyoteTicks - 1, true], [CHAR.coyoteTicks, false]] as const) {
      const r = rig(1, v3(0, 0, GROUND_HALF - CHAR.maxRun))
      stepN(r, k + late, FORWARD)
      const s = stepN(r, 1, FORWARD_JUMP)
      assert.equal(s.vel.y > 0, fires, `press ${late} ticks after the ledge: vy ${s.vel.y}`)
      r.world.free()
    }
  })

  it('buffer: a press jumpBufferTicks-1 ticks before landing fires on landing', () => {
    const settle = (r: Rig): void => { stepN(r, 30, NEUTRAL); stepN(r, 1, JUMP) }
    const a = rig()
    settle(a)
    const land = stepUntil(a, () => NEUTRAL, (s) => s.grounded)
    a.world.free()
    const pressAt = land - (CHAR.jumpBufferTicks - 1)
    const b = rig()
    settle(b)
    for (let i = 0; i < land; i++) b.world.step([i === pressAt ? JUMP : NEUTRAL])
    const s = stepN(b, 1, NEUTRAL)
    assert.ok(s.vel.y > 0, `vy ${s.vel.y}`)
    b.world.free()
  })

  it('override applies for exactly one tick', () => {
    const r = rig()
    stepN(r, 60, FORWARD)
    r.chars.override(0, inputCode({}))
    const once = stepN(r, 1, FORWARD)
    const braked = CHAR.maxRun - CHAR.groundBrake * FIXED_DT
    assert.ok(Math.abs(once.vel.z - braked) <= 1e-6, `override tick vz ${once.vel.z}`)
    const next = stepN(r, 1, FORWARD)
    const resumed = Math.min(CHAR.maxRun, braked + CHAR.groundAccel * FIXED_DT)
    assert.ok(Math.abs(next.vel.z - resumed) <= 1e-6, `next tick vz ${next.vel.z}`)
    r.world.free()
  })

  it('freeze keeps vertical motion and zeroes horizontal motion', () => {
    const r = rig(1, v3(0, 10, 0))
    const flying = stepN(r, 10, FORWARD)
    assert.ok(flying.vel.z > 0)
    r.chars.freeze(0, true)
    const frozen = stepN(r, 10, FORWARD_JUMP)
    assert.equal(hspeed(frozen), 0)
    assert.ok(frozen.vel.y < flying.vel.y && frozen.pos.y < flying.pos.y, 'still falling')
    assert.equal(frozen.mode, CharMode.frozen)
    r.world.free()
  })

  it('park then isParked', () => {
    const r = rig()
    stepN(r, 5, FORWARD)
    r.chars.park(r.world.ctx, 0)
    assert.equal(r.chars.isParked(0), true)
    const s = r.chars.state(r.world.ctx, 0, newState())
    assert.deepEqual(s.pos, CHAR.parkOrigin)
    assert.equal(s.teleportTick, r.world.tick)
    r.world.free()
  })

  it('snapshot round-trip: restore into a fresh world and step 100 ticks equal', () => {
    const players = 3
    const script = (t: number, p: number): PlayerInput =>
      input({ moveX: ((t * 7 + p * 3) % 11) / 5 - 1, moveZ: ((t * 5 + p) % 13) / 6 - 1, jump: (t + p) % 23 < 2 })
    const inputsAt = (t: number): PlayerInput[] => [0, 1, 2].map((p) => script(t, p))
    const a = rig(players)
    a.chars.freeze(2, true)
    for (let t = 0; t < 100; t++) a.world.step(inputsAt(t))
    const bytes = a.world.takeSnapshotBytes()
    const fresh = new CharacterSystem({ playerCount: players })
    const b = new FiestaWorld<PlayerInput>(R, { playerCount: players, systems: [groundSystem(), fresh] })
    b.restoreSnapshotBytes(bytes)
    assert.equal(b.stateHash(), a.world.stateHash())
    for (let t = 100; t < 200; t++) {
      a.world.step(inputsAt(t))
      b.step(inputsAt(t))
    }
    assert.equal(b.stateHash(), a.world.stateHash())
    a.world.free()
    b.free()
  })

  it('dive: at least diveSpeed after the press, then diveRecover for diveRecoverTicks after landing', () => {
    const r = rig()
    stepN(r, 30, NEUTRAL)
    assert.equal(stepN(r, 1, DIVE).mode, CharMode.dive)
    const after = stepN(r, 1, NEUTRAL)
    assert.ok(hspeed(after) >= CHAR.diveSpeed, `speed ${hspeed(after)}`)
    stepUntil(r, () => NEUTRAL, (s) => s.mode !== CharMode.dive, 120)
    const landed = state(r)
    assert.equal(landed.mode, CharMode.diveRecover)
    assert.equal(landed.grounded, true)
    assert.equal(stepN(r, CHAR.diveRecoverTicks - 1, NEUTRAL).mode, CharMode.diveRecover)
    assert.equal(stepN(r, 1, NEUTRAL).mode, CharMode.ground)
    r.world.free()
  })

  it('the second dive press in the same airtime is ignored', () => {
    const r = rig()
    stepN(r, 30, NEUTRAL)
    stepN(r, 1, JUMP)
    stepN(r, 5, NEUTRAL)
    assert.equal(stepN(r, 1, DIVE).mode, CharMode.dive)
    // Falling, so a second dive would lift vy to 0.6*diveUp.
    stepUntil(r, () => NEUTRAL, (s) => s.vel.y < 0, 60)
    const before = state(r)
    const second = stepN(r, 1, DIVE)
    assert.equal(second.mode, CharMode.dive)
    assert.ok(second.vel.y < before.vel.y, `vy ${before.vel.y} -> ${second.vel.y}`)
    assert.equal(hspeed(second), hspeed(before))
    r.world.free()
  })

  it('grab: the target running away is slowed to grabSlow*maxRun at most', () => {
    const r = grabRig()
    let grabbed = 0
    for (let i = 0; i < 60; i++) {
      r.world.step([GRABBER, FORWARD])
      if (state(r, 0).mode !== CharMode.grabbing) continue
      grabbed++
      const target = state(r, 1)
      assert.ok(hspeed(target) <= CHAR.grabSlow * CHAR.maxRun, `tick ${i}: target speed ${hspeed(target)}`)
    }
    assert.ok(grabbed >= 30, `grabbed for ${grabbed} ticks`)
    r.world.free()
  })

  it('a bounce pad sends vy to its speed', () => {
    const speed = 14
    const r = obsRig([obstacle('pad', v3(0, -0.5, 0), { kind: 'bouncePad', speed }, v3(2, 0.5, 2))], v3(0, 0, 0))
    stepUntil(r, () => NEUTRAL, (s) => s.vel.y > 0, 30)
    const s = state(r)
    // The step after the bounce has already applied one tick of gravity (Rapier is f32).
    assert.ok(Math.abs(s.vel.y - (speed + GRAVITY_Y * FIXED_DT)) <= 1e-4, `vy ${s.vel.y}`)
    assert.equal(s.mode, CharMode.air)
    r.world.free()
  })

  it('a conveyor carries a neutral character at the belt speed', () => {
    const belt = v3(0, 0, -3)
    const r = obsRig([obstacle('belt', v3(0, -0.5, 0), { kind: 'conveyor', velocity: belt }, v3(5, 0.5, 10))], v3(0, 0, 5))
    const s = stepN(r, 60, NEUTRAL)
    assert.equal(s.groundObstacle, 0)
    assert.ok(Math.abs(s.vel.x - belt.x) <= 1e-6 && Math.abs(s.vel.z - belt.z) <= 1e-6, `vel ${s.vel.x}, ${s.vel.z}`)
    r.world.free()
  })

  it('a fast kinematic spinner bar hitting a standing character stuns it', () => {
    // 3 deg/tick: the bar meets the character 2.5 m from the axis at about 7.9 m/s.
    const spin = obstacle('spin', v3(0, STAND, 0), { kind: 'spinner', axis: v3(0, 1, 0), radPerTick: PI / 60, phase: 0 }, v3(4, 0.25, 0.25))
    const r = obsRig([FLOOR, spin], v3(0, 0, 2.5))
    stepUntil(r, () => NEUTRAL, (s) => s.knockbacks >= 1, 60)
    const s = state(r)
    assert.equal(s.mode, CharMode.stunned)
    assert.ok(s.vel.y > 0, `vy ${s.vel.y}`)
    assert.notEqual(stepN(r, CHAR.stunTicks, NEUTRAL).mode, CharMode.stunned)
    r.world.free()
  })

  it('standing on a see-saw end tilts it', () => {
    const motion: Motion = { kind: 'seesaw', axis: v3(1, 0, 0), maxAngle: 0.35, spring: 800, damping: 300, inertia: 900 }
    const r = obsRig([obstacle('saw', v3(0, 0.5, 0), motion, v3(2, 0.2, 4))], v3(0, 0.7, 3))
    stepN(r, 60, NEUTRAL)
    assert.ok(r.obs.seesawAngle(0) > 0, `angle ${r.obs.seesawAngle(0)}`)
    r.world.free()
  })

  // Restores the snapshot taken at tick `at` (player 0 in `mode`) into a fresh world, then steps both.
  function roundTrip(make: () => Rig, script: (t: number) => PlayerInput[], at: number, mode: number): void {
    const a = make()
    for (let t = 0; t < at; t++) a.world.step(script(t))
    assert.equal(state(a).mode, mode)
    const b = make()
    b.world.restoreSnapshotBytes(a.world.takeSnapshotBytes())
    for (let t = at; t < at + 60; t++) {
      a.world.step(script(t))
      b.world.step(script(t))
    }
    assert.equal(b.world.stateHash(), a.world.stateHash())
    a.world.free()
    b.world.free()
  }

  it('snapshot round-trip during a dive and during a grab', () => {
    roundTrip(() => rig(), (t) => [t === 30 ? DIVE : NEUTRAL], 35, CharMode.dive)
    roundTrip(grabRig, () => [GRABBER, FORWARD], 10, CharMode.grabbing)
  })

  it('protection: overlapping characters do not push each other until it ends', () => {
    const r = rig(2)
    r.chars.place(r.world.ctx, 0, { t: v3(0, 0, 0), facing: { x: 0, z: 1 } })
    r.chars.place(r.world.ctx, 1, { t: v3(0.3, 0, 0), facing: { x: 0, z: 1 } })
    r.chars.setProtected(0, 60)
    assert.equal(state(r, 0).protectedUntil, 60)
    const gap = (): number => dist2(state(r, 0).pos.x, state(r, 0).pos.z, state(r, 1).pos.x, state(r, 1).pos.z)
    for (let t = 0; t < 60; t++) {
      r.world.step([NEUTRAL, NEUTRAL])
      assert.ok(gap() <= 0.32, `tick ${t}: protected characters pushed to ${gap()}`)
    }
    let separated = false
    for (let t = 0; t < 120 && !separated; t++) {
      r.world.step([NEUTRAL, NEUTRAL])
      separated = gap() >= 0.7
    }
    assert.ok(separated, `after protection the characters still overlap at ${gap()}`)
    r.world.free()
  })

  it('protection: a protected character can neither be grabbed nor grab', () => {
    const targetProtected = grabRig()
    targetProtected.chars.setProtected(1, 60)
    for (let t = 0; t < 60; t++) {
      targetProtected.world.step([GRABBER, NEUTRAL])
      assert.notEqual(state(targetProtected, 0).mode, CharMode.grabbing, `grabbed a protected target at tick ${t}`)
    }
    targetProtected.world.free()

    const grabberProtected = grabRig()
    grabberProtected.chars.setProtected(0, 60)
    for (let t = 0; t < 60; t++) {
      grabberProtected.world.step([GRABBER, NEUTRAL])
      assert.notEqual(state(grabberProtected, 0).mode, CharMode.grabbing, `protected character grabbed at tick ${t}`)
    }
    grabberProtected.world.free()
  })

  it('snapshot round-trip with an active protection reruns identically', () => {
    const players = 2
    const script = (t: number): PlayerInput[] => [
      input({ moveX: t % 3 === 0 ? 1 : 0, moveZ: 1 }),
      input({ moveZ: t % 2 === 0 ? 1 : 0, jump: t % 11 === 0 }),
    ]
    const a = rig(players)
    a.chars.setProtected(0, 100)
    a.chars.setProtected(1, 40)
    for (let t = 0; t < 20; t++) a.world.step(script(t))
    const bytes = a.world.takeSnapshotBytes()
    const fresh = new CharacterSystem({ playerCount: players })
    const b = new FiestaWorld<PlayerInput>(R, { playerCount: players, systems: [groundSystem(), fresh] })
    b.restoreSnapshotBytes(bytes)
    assert.equal(b.stateHash(), a.world.stateHash())
    assert.equal(state({ world: b, chars: fresh }, 0).protectedUntil, 100)
    // Runs past the end of both protections so the group restore is rerun too.
    for (let t = 20; t < 140; t++) {
      a.world.step(script(t))
      b.step(script(t))
    }
    assert.equal(b.stateHash(), a.world.stateHash())
    assert.equal(state({ world: b, chars: fresh }, 0).protectedUntil, 100)
    a.world.free()
    b.free()
  })
})

describe('M4 state', () => {
  it('setCarry shows in state() and refuses an out-of-range kind or id', () => {
    const r = rig()
    r.chars.setCarry(0, CarryKind.object, 7)
    const s = state(r)
    assert.equal(s.carry, CarryKind.object)
    assert.equal(s.carryId, 7)
    assert.throws(() => r.chars.setCarry(0, CarryKind.crown + 1, 1), /kind/)
    assert.throws(() => r.chars.setCarry(0, CarryKind.object, 32768), /id/)
    assert.equal(state(r).carry, CarryKind.object)
    assert.equal(state(r).carryId, 7)
    r.world.free()
  })

  it('knock stuns, sets the velocity and counts one knockback', () => {
    const r = rig()
    stepN(r, 30, NEUTRAL)
    r.chars.knock(r.world.ctx, 0, v3(3, 4, 5))
    const s = state(r)
    assert.equal(s.mode, CharMode.stunned)
    assert.equal(s.knockbacks, 1)
    assert.deepEqual([s.vel.x, s.vel.y, s.vel.z], [3, 4, 5])
    r.world.free()
  })

  it('setSwim(true) enters swim with buoyancy and drag; setSwim(false) returns to air', () => {
    const r = rig()
    stepN(r, 30, FORWARD)
    const before = state(r)
    const drag = 3
    const buoyancy = 5
    r.chars.setSwim(r.world.ctx, 0, true, drag, buoyancy)
    const swim = state(r)
    assert.equal(swim.mode, CharMode.swim)
    assert.ok(Math.abs(swim.vel.y - (before.vel.y + buoyancy * FIXED_DT)) <= 1e-6, `vy ${before.vel.y} -> ${swim.vel.y}`)
    const k = Math.max(0, 1 - drag * FIXED_DT)
    assert.ok(Math.abs(swim.vel.x - before.vel.x * k) <= 1e-6, `vx ${before.vel.x} -> ${swim.vel.x}`)
    assert.ok(Math.abs(swim.vel.z - before.vel.z * k) <= 1e-6, `vz ${before.vel.z} -> ${swim.vel.z}`)
    r.chars.setSwim(r.world.ctx, 0, false, drag, buoyancy)
    assert.equal(state(r).mode, CharMode.air)
    r.world.free()
  })

  it('a carrying player holding grab within range starts no grab', () => {
    const r = grabRig()
    r.chars.setCarry(0, CarryKind.object, 1)
    for (let t = 0; t < 30; t++) {
      r.world.step([GRABBER, NEUTRAL])
      assert.notEqual(state(r, 0).mode, CharMode.grabbing, `grabbed at tick ${t}`)
    }
    r.world.free()
  })

  it('setSurfaceFriction refuses a missing surface, a negative and a non-finite value', () => {
    const r = rig()
    assert.throws(() => r.chars.setSurfaceFriction({ ice: 0.1 }), /missing normal/)
    assert.throws(() => r.chars.setSurfaceFriction({ normal: -0.1, ice: 0.1, mud: 1, rubber: 0.3 }), /non-negative/)
    assert.throws(() => r.chars.setSurfaceFriction({ normal: Number.NaN, ice: 0.1, mud: 1, rubber: 0.3 }), /non-negative/)
    r.world.free()
  })

  it('writePlayer -> readPlayer round-trips slideSpeed, carry, carryId and strokeTimer byte for byte', () => {
    const w = new SnapWriter()
    w.u8(CharMode.swim)
    w.i32(17)
    w.u8(2)
    w.u8(3)
    w.u8(5)
    w.u8(1)
    w.u8(0xff)
    w.u16(9)
    w.u16(11)
    w.f64(0.25)
    w.f64(-0.75)
    w.u8(1)
    w.i16(3)
    w.u16(4)
    w.i32(55)
    w.u8(0)
    w.u8(0)
    w.i16(1)
    w.i16(2)
    w.i16(3)
    w.i32(88)
    w.f64(6.5)
    w.u8(CarryKind.object)
    w.i16(7)
    w.u8(4)
    const bytes = w.bytes().slice()

    const fresh = new CharacterSystem({ playerCount: 1 })
    fresh.readPlayer(new SnapReader(bytes), 0)
    const out = new SnapWriter()
    fresh.writePlayer(out, 0)
    assert.deepEqual(out.bytes().slice(), bytes)
  })
})

describe('M4 slide', () => {
  // Writes one player block in exactly writePlayer's order, with slide state seeded.
  function seedSlide(r: Rig, speed: number, p = 0): void {
    const w = new SnapWriter()
    w.u8(CharMode.slide)
    w.i32(0)
    w.u8(CHAR.coyoteTicks)
    w.u8(0)
    w.u8(0)
    w.u8(0)
    w.u8(0xff) // grabTarget -1
    w.u16(0)
    w.u16(0)
    w.f64(0)
    w.f64(1)
    w.u8(1) // grounded
    w.i16(-1)
    w.u16(0)
    w.i32(-1)
    w.u8(0)
    w.u8(0)
    w.i16(-1)
    w.i16(-1)
    w.i16(-1)
    w.i32(-1)
    w.f64(speed)
    w.u8(CarryKind.none)
    w.i16(-1)
    w.u8(0)
    r.chars.readPlayer(new SnapReader(w.bytes()), p)
  }

  function surfaceFloor(surface: Surface, friction = 2): ObstacleSpec {
    const floor = obstacle(`floor-${surface}`, v3(0, -0.5, 0), { kind: 'static' }, v3(20, 0.5, 20))
    floor.surface = surface
    floor.friction = friction
    return floor
  }

  function slideRig(surface: Surface, speed: number, friction = 2): ObsRig {
    const r = obsRig([surfaceFloor(surface, friction)], v3(0, 0, 0))
    stepN(r, 30, NEUTRAL)
    seedSlide(r, speed)
    return r
  }

  it('a grounded dive at run speed lands in slide; a dive from standing lands in diveRecover', () => {
    // A conveyor adds 4 m/s to the 8 m/s run: the dive carries 12 m/s into the landing.
    const belt = obstacle('belt', v3(0, -0.5, 0), { kind: 'conveyor', velocity: v3(0, 0, 4) }, v3(20, 0.5, 20))
    const fast = obsRig([belt], v3(0, 0, -5))
    const run = stepN(fast, 60, FORWARD)
    assert.ok(hspeed(run) >= CHAR.slide.enterSpeed, `run speed ${hspeed(run)}`)
    fast.world.step([input({ moveZ: 1, dive: true })])
    stepUntil(fast, () => NEUTRAL, (s) => s.mode !== CharMode.dive, 120)
    assert.equal(state(fast).mode, CharMode.slide)
    fast.world.free()

    const still = rig()
    stepN(still, 30, NEUTRAL)
    stepN(still, 1, DIVE)
    stepUntil(still, () => NEUTRAL, (s) => s.mode !== CharMode.dive, 120)
    assert.equal(state(still).mode, CharMode.diveRecover)
    still.world.free()
  })

  it('a stroke adds strokeImpulse on ice and the cooldown blocks a second press', () => {
    const plain = slideRig('ice', 12)
    stepN(plain, 1, NEUTRAL)
    const noStroke = state(plain).slideSpeed!
    plain.world.free()

    const stroke = slideRig('ice', 12)
    stepN(stroke, 1, JUMP)
    const afterStroke = state(stroke)
    assert.equal(afterStroke.mode, CharMode.slide)
    assert.ok(Math.abs(afterStroke.slideSpeed! - noStroke - CHAR.slide.strokeImpulse) <= 1e-9,
      `stroke added ${afterStroke.slideSpeed! - noStroke}`)
    stroke.world.free()

    // Release, then press again inside the cooldown: the second stroke is ignored.
    const second = slideRig('ice', 12)
    stepN(second, 1, JUMP)
    stepN(second, 1, NEUTRAL)
    stepN(second, 1, JUMP)
    stepN(second, 1, NEUTRAL)
    const pressedTwice = state(second).slideSpeed!
    second.world.free()
    const once = slideRig('ice', 12)
    stepN(once, 1, JUMP)
    stepN(once, 3, NEUTRAL)
    const pressedOnce = state(once).slideSpeed!
    once.world.free()
    assert.ok(Math.abs(pressedTwice - pressedOnce) <= 1e-9,
      `second press added ${pressedTwice - pressedOnce}`)
  })

  it('60 ticks of slide from 10 m/s travel ice > normal > mud', () => {
    const travel = (surface: Surface): number => {
      const r = slideRig(surface, 10)
      const before = state(r)
      const after = stepN(r, 60, NEUTRAL)
      const d = dist2(before.pos.x, before.pos.z, after.pos.x, after.pos.z)
      r.world.free()
      return d
    }
    const ice = travel('ice')
    const normal = travel('normal')
    const mud = travel('mud')
    assert.ok(ice > normal && normal > mud, `ice ${ice}, normal ${normal}, mud ${mud}`)
  })

  it('an obstacle friction 0.1 on normal decelerates less than friction 0.5', () => {
    const speedAfter = (friction: number): number => {
      const r = slideRig('normal', 12, friction)
      const s = stepN(r, 60, NEUTRAL)
      assert.equal(s.mode, CharMode.slide)
      const speed = hspeed(s)
      r.world.free()
      return speed
    }
    const low = speedAfter(0.1)
    const high = speedAfter(0.5)
    assert.ok(low > high, `friction 0.1 ${low} m/s, friction 0.5 ${high} m/s`)
  })

  it('slide ends below exitSpeed', () => {
    const r = slideRig('normal', 10)
    let s = state(r)
    for (let i = 0; i < 300 && s.mode === CharMode.slide; i++) s = stepN(r, 1, NEUTRAL)
    assert.equal(s.mode, CharMode.ground)
    assert.ok(s.slideSpeed! < CHAR.slide.exitSpeed, `slideSpeed ${s.slideSpeed}`)
    r.world.free()
  })
})

describe('M4 swim and determinism', () => {
  // A test volume registered after the characters, like the swimVolume feature.
  function heldSwim(chars: CharacterSystem, drag: number, buoyancy: number): SimSystem<PlayerInput> {
    return {
      name: 'heldSwim',
      init() {},
      preStep(ctx) {
        for (let p = 0; p < chars.playerCount; p++) chars.setSwim(ctx, p, true, drag, buoyancy)
      },
      postStep() {},
      snapshot() {},
      restore() {},
    }
  }

  function volumeRig(volume: (chars: CharacterSystem) => SimSystem<PlayerInput>, at: Vec3): Rig {
    const chars = new CharacterSystem({ playerCount: 1 })
    const world = new FiestaWorld<PlayerInput>(R, {
      playerCount: 1,
      systems: [groundSystem(), chars, volume(chars)],
    })
    chars.place(world.ctx, 0, { t: at, facing: { x: 0, z: 1 } })
    return { world, chars }
  }

  it('held in swim, buoyancy makes it rise and no buoyancy makes it sink', () => {
    const floats = volumeRig((chars) => heldSwim(chars, 2, 24), v3(0, 10, 0))
    const floatStart = state(floats).pos.y
    const risen = stepN(floats, 30, NEUTRAL)
    assert.equal(risen.mode, CharMode.swim)
    assert.ok(risen.pos.y > floatStart + 0.2, `rose from ${floatStart} to ${risen.pos.y}`)
    floats.world.free()

    const sinks = volumeRig((chars) => heldSwim(chars, 2, 0), v3(0, 10, 0))
    const sinkStart = state(sinks).pos.y
    const sunk = stepN(sinks, 30, NEUTRAL)
    assert.equal(sunk.mode, CharMode.swim)
    assert.ok(sunk.pos.y < sinkStart - 1, `sank from ${sinkStart} to ${sunk.pos.y}`)
    sinks.world.free()
  })

  it('a stroke in swim adds the impulse along the facing', () => {
    // A tiny drag leaves the impulse added in preStep untouched by the volume's setSwim.
    const r = volumeRig((chars) => heldSwim(chars, 1e-9, 0), v3(0, 10, 0))
    stepN(r, 5, NEUTRAL)
    const before = state(r)
    assert.equal(before.mode, CharMode.swim)
    const after = stepN(r, 1, JUMP)
    assert.equal(after.mode, CharMode.swim)
    const k = 1 - 1e-9 * FIXED_DT
    assert.ok(Math.abs(after.vel.z - (before.vel.z * k + CHAR.swim.strokeImpulse)) <= 1e-6,
      `vz ${before.vel.z} -> ${after.vel.z}`)
    assert.ok(Math.abs(after.vel.x - before.vel.x * k) <= 1e-6, `vx ${before.vel.x} -> ${after.vel.x}`)
    r.world.free()
  })

  it('protection: a protected player is neither grabbed nor a grabber, and its groups exclude CHAR', () => {
    const target = grabRig()
    target.chars.setProtected(1, 60)
    const grabber = grabRig()
    grabber.chars.setProtected(0, 60)
    for (let t = 0; t < 60; t++) {
      target.world.step([GRABBER, NEUTRAL])
      grabber.world.step([GRABBER, NEUTRAL])
      assert.notEqual(state(target, 0).mode, CharMode.grabbing, `grabbed a protected target at tick ${t}`)
      assert.notEqual(state(grabber, 0).mode, CharMode.grabbing, `protected player grabbed at tick ${t}`)
    }
    target.world.free()
    grabber.world.free()

    const r = rig(2)
    const ids = r.world.physics.ids()
    const colliderGroups = (p: number): number =>
      r.world.ctx.physics.body(ids[1 + p]).collider(0).collisionGroups()
    const live = groups(G.CHAR, G.STATIC | G.MOVING | G.CHAR)
    const shielded = groups(G.CHAR, G.STATIC | G.MOVING)
    // Ticks 0..3 are protected (protectedUntil 4); the fifth step restores the normal groups.
    r.chars.setProtected(0, 4)
    for (let t = 0; t < 4; t++) {
      r.world.step([NEUTRAL, NEUTRAL])
      assert.equal(colliderGroups(0), shielded, `tick ${t}`)
      assert.equal(colliderGroups(0) & G.CHAR, 0, `tick ${t}: CHAR still in the filter`)
      assert.equal(colliderGroups(1), live, `tick ${t}: unprotected player`)
    }
    r.world.step([NEUTRAL, NEUTRAL])
    assert.equal(colliderGroups(0), live, 'protection over')
    r.world.free()
  })

  // QB1: run, dive onto an ice conveyor into slide, strokes, then swim inside a test box.
  function swimBox(chars: CharacterSystem): SimSystem<PlayerInput> {
    const center = v3(0, 2, 27)
    const half = v3(5, 5, 10)
    const inside = new Uint8Array(chars.playerCount)
    const pos = new Float64Array(chars.playerCount * 3)
    return {
      name: 'swimBox',
      init() {},
      preStep(ctx) {
        chars.readPositions(ctx, pos)
        for (let p = 0; p < chars.playerCount; p++) {
          const now = Math.abs(pos[p * 3] - center.x) <= half.x &&
            Math.abs(pos[p * 3 + 1] - center.y) <= half.y &&
            Math.abs(pos[p * 3 + 2] - center.z) <= half.z
          if (now) chars.setSwim(ctx, p, true, 2, 24)
          else if (inside[p] !== 0) chars.setSwim(ctx, p, false, 0, 0)
          inside[p] = now ? 1 : 0
        }
      },
      postStep() {},
      snapshot(w) {
        w.u16(inside.length)
        for (let i = 0; i < inside.length; i++) w.u8(inside[i])
      },
      restore(r) {
        const n = r.u16()
        for (let i = 0; i < n; i++) inside[i] = r.u8()
      },
    }
  }

  function determinismRig(): Rig {
    const ice = obstacle('ice-conveyor', v3(0, -0.5, 0), { kind: 'conveyor', velocity: v3(0, 0, 4) }, v3(40, 0.5, 40))
    ice.surface = 'ice'
    ice.friction = 2
    const obs = new ObstacleSystem([course([ice])])
    const loader: SimSystem<PlayerInput> = {
      name: 'loader',
      init(ctx) { obs.load(ctx, 0) },
      preStep() {},
      postStep() {},
      snapshot() {},
      restore() {},
    }
    const chars = new CharacterSystem({ playerCount: 1 })
    const world = new FiestaWorld<PlayerInput>(R, {
      playerCount: 1,
      systems: [obs, loader, chars, swimBox(chars)],
    })
    chars.place(world.ctx, 0, { t: v3(0, 0, 0), facing: { x: 0, z: 1 } })
    return { world, chars }
  }

  it('QB1: a 240-tick scripted run restores its tick-90 snapshot and reruns identically', () => {
    const script = (t: number): PlayerInput => {
      if (t === 50) return input({ moveZ: 1, dive: true })
      if (t === 80 || t === 100 || t === 130 || t === 160 || t === 200) return input({ moveZ: 1, jump: true })
      return FORWARD
    }
    const first = new Map<number, number>()
    const a = determinismRig()
    for (let t = 0; t < 90; t++) {
      a.world.step([script(t)])
      const s = state(a)
      if (!first.has(s.mode)) first.set(s.mode, t)
    }
    assert.equal(state(a).mode, CharMode.slide, 'the snapshot lands mid-slide')
    const at90 = a.world.takeSnapshotBytes()

    const b = determinismRig()
    b.world.restoreSnapshotBytes(at90)
    assert.deepEqual(b.world.takeSnapshotBytes(), at90, 'restored snapshot bytes')

    const seenA: CharState[] = []
    const seenB: CharState[] = []
    for (let t = 90; t < 240; t++) {
      a.world.step([script(t)])
      b.world.step([script(t)])
      seenA.push(state(a))
      seenB.push(state(b))
    }
    for (let i = 0; i < seenA.length; i++) {
      assert.deepEqual(seenB[i], seenA[i], `tick ${90 + i}`)
      if (!first.has(seenA[i].mode)) first.set(seenA[i].mode, 90 + i)
    }
    for (const mode of [CharMode.dive, CharMode.slide, CharMode.swim]) {
      assert.ok(first.has(mode), `mode ${mode} never entered`)
    }
    assert.ok(first.get(CharMode.slide)! < first.get(CharMode.swim)!, 'slide comes before swim')
    assert.equal(state(a).mode, CharMode.swim, 'the run ends in swim')
    assert.deepEqual(b.world.takeSnapshotBytes(), a.world.takeSnapshotBytes(), 'final snapshot bytes')
    a.world.free()
    b.world.free()
  })
})
