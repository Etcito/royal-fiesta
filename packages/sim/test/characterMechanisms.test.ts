import assert from 'node:assert/strict'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { CHAR, CharMode } from '../src/character/constants.ts'
import { CharacterSystem } from '../src/character/system.ts'
import type { CharState } from '../src/character/system.ts'
import type { ResolvedCourse, Surface } from '../src/course.ts'
import { G, groups } from '../src/groups.ts'
import { decodeInput, inputCode, neutralInput } from '../src/input.ts'
import type { PlayerInput } from '../src/input.ts'
import { emptyMechanisms } from '../src/mechanismSpec.ts'
import type { BodySpec, JointSpec } from '../src/mechanismSpec.ts'
import { MechanismSystem } from '../src/mechanisms/system.ts'
import { pose, quatRotate } from '../src/vec.ts'
import { FiestaWorld } from '../src/world.ts'

const R = await initRapier()
const O = { x: 0, y: 0, z: 0 }
const I = { x: 0, y: 0, z: 0, w: 1 }
const REF = { item: 0, body: 0 }
const NEUTRAL = neutralInput()
const RUN = decodeInput(inputCode({ moveZ: 1 }), neutralInput())
const STAND = CHAR.halfHeight + CHAR.radius
function state(): CharState {
  return { pos: { ...O }, vel: { ...O }, facing: { x: 0, z: 1 }, mode: 0,
    grounded: false, groundObstacle: -1, groundBody: null, grabLever: -1,
    knockbacks: 0, teleportTick: -1 }
}
function body(overrides: Partial<BodySpec> = {}): BodySpec {
  return { id: 'platform', type: 'dynamic', rest: pose(), density: 100,
    colliders: [{ shape: 'cuboid', half: { x: 3, y: 0.1, z: 1 }, t: O, r: I }],
    friction: 0, restitution: 0, linearDamping: 0, angularDamping: 0.1,
    gravityScale: 1, ccd: true, surface: 'normal', ...overrides }
}
function hinge(overrides: Partial<JointSpec> = {}): JointSpec {
  return { id: 'pivot', kind: 'hinge', a: { item: -1, body: 0 }, b: REF,
    anchorA: O, anchorB: O, axis: { x: 0, y: 0, z: 1 }, limits: null,
    stiffness: 0, damping: 0, length: 0, motor: null, ...overrides }
}
function fixture(b: BodySpec, joints: JointSpec[] = [], at = O) {
  const course: ResolvedCourse = {
    id: 'character-lab', name: 'Character lab', kind: 'gallery', profiles: ['standard'],
    timeLimitS: 60, killPlaneY: -100, spawns: [], checkpoints: [], finish: null,
    path: [], regions: [], queuePad: null, obstacles: [], contentHash: 0,
    mechanisms: { ...emptyMechanisms(), items: [{ id: 'lab', asset: 'lab', t: O, r: I,
      s: { x: 1, y: 1, z: 1 }, bodies: [b], joints: [] }], joints },
  }
  const mechanisms = new MechanismSystem([course])
  const chars = new CharacterSystem({ playerCount: 1 })
  const world = new FiestaWorld<PlayerInput>(R, { playerCount: 1, systems: [mechanisms, chars] })
  mechanisms.load(world.ctx, 0)
  // Populate Rapier query structures before placing the character on the body.
  world.step([NEUTRAL])
  chars.place(world.ctx, 0, { t: at, facing: { x: 0, z: 1 } })
  const out = state()
  return { world, mechanisms, chars, read: () => chars.state(world.ctx, 0, out) }
}
function floor(surface: Surface, at = O) {
  return fixture(body({ type: 'fixed', surface, rest: { t: { x: 0, y: -0.5, z: 0 }, r: I },
    colliders: [{ shape: 'cuboid', half: { x: 10, y: 0.5, z: 100 }, t: O, r: I }] }), [], at)
}

test('neutral character rides a motor-driven radius-3 platform for 240 ticks', () => {
  const f = fixture(body({ colliders: [{ shape: 'cylinder', radius: 3, halfHeight: 0.1, t: O, r: I }] }),
    [hinge({ axis: { x: 0, y: 1, z: 0 }, motor: { mode: 'speed', speed: 0.5, target: 0,
      stiffness: 0, damping: 1000, maxForce: 100000, enabled: true } })], { x: 2, y: 0.1, z: 0 })
  try {
    const p = pose()
    for (let tick = 0; tick < 240; tick++) {
      f.world.step([NEUTRAL])
      const s = f.read()
      assert.equal(s.grounded, true, `grounded at tick ${tick}`)
      assert.deepEqual(s.groundBody, REF, `ground body at tick ${tick}`)
      assert.equal(s.groundObstacle, -1)
      assert.ok(f.mechanisms.bodyPose(f.world.ctx, REF, p))
      const carried = quatRotate(p.r, { x: 2, y: 0.1 + STAND, z: 0 }, { ...O })
      const distance = Math.hypot(s.pos.x - p.t.x - carried.x,
        s.pos.y - p.t.y - carried.y, s.pos.z - p.t.z - carried.z)
      assert.ok(distance < 0.3, `tick ${tick}: carried-point distance ${distance}`)
    }
    assert.ok(Math.abs(f.mechanisms.jointAngle(f.world.ctx, 0)) > 0.5, 'motor actually rotates')
  } finally { f.world.free() }
})

for (const [surface, factor] of [['normal', 1], ['ice', 1.1], ['mud', 0.6], ['rubber', 1]] as const) {
  test(`${surface}: full running speed reaches and stays at 8 × ${factor}`, () => {
    const f = floor(surface)
    try {
      for (let tick = 0; tick < 180; tick++) {
        f.world.step([RUN])
        const s = f.read()
        const speed = Math.hypot(s.vel.x, s.vel.z)
        assert.equal(s.grounded, true)
        assert.deepEqual(s.groundBody, REF)
        assert.ok(speed <= 8 * factor + 0.2, `tick ${tick}: speed ${speed}`)
        if (tick >= 120) assert.ok(Math.abs(speed - 8 * factor) <= 0.2, `speed ${speed}`)
      }
    } finally { f.world.free() }
  })
}

function stoppingDistance(surface: Surface): number {
  const f = floor(surface)
  try {
    for (let tick = 0; tick < 120; tick++) f.world.step([RUN])
    const start = f.read().pos.z
    assert.ok(f.read().vel.z >= 7.8, 'starts at full running speed')
    for (let tick = 0; tick < 180; tick++) {
      f.world.step([NEUTRAL])
      const s = f.read()
      assert.equal(s.grounded, true)
      if (Math.hypot(s.vel.x, s.vel.z) < 0.01) return s.pos.z - start
    }
    assert.fail(`${surface} did not stop within 180 ticks`)
  } finally { f.world.free() }
}
test('ice stopping distance from full speed exceeds three times normal', () => {
  const normal = stoppingDistance('normal')
  const ice = stoppingDistance('ice')
  assert.ok(normal > 0)
  assert.ok(ice > 3 * normal, `ice ${ice}, normal ${normal}`)
})

test('a 3 m drop onto rubber rebounds at 60% of impact speed within 10%', () => {
  const f = floor('rubber', { x: 0, y: 3, z: 0 })
  try {
    let impactSpeed = 0
    for (let tick = 0; tick < 120; tick++) {
      f.world.step([NEUTRAL])
      const s = f.read()
      if (s.vel.y > 0 && impactSpeed > 3) {
        const expected = 0.6 * impactSpeed
        assert.ok(Math.abs(s.vel.y - expected) <= expected * 0.1,
          `rebound ${s.vel.y}, expected ${expected} from impact ${impactSpeed}`)
        assert.equal(s.mode, CharMode.air)
        return
      }
      impactSpeed = Math.max(impactSpeed, -s.vel.y)
    }
    assert.fail('rubber did not bounce within 120 ticks')
  } finally { f.world.free() }
})

test('character weight tips a limited plank toward the occupied side within 120 ticks', () => {
  const f = fixture(body(), [hinge({ limits: [-0.25, 0.25] })], { x: 1.5, y: 0.1, z: 0 })
  try {
    let tipped = false
    for (let tick = 0; tick < 120; tick++) {
      f.world.step([NEUTRAL])
      // Read immediately after step: mechanism postStep must not erase character loads.
      assert.equal(f.mechanisms.loadKg(REF), 60, `load at tick ${tick}`)
      assert.deepEqual(f.read().groundBody, REF)
      if (f.mechanisms.jointAngle(f.world.ctx, 0) < -0.05) tipped = true
    }
    assert.ok(tipped, 'positive-X end tips down under the character')
  } finally { f.world.free() }
})

test('characters still step on a flat floor without mechanisms or obstacles', () => {
  const chars = new CharacterSystem({ playerCount: 2 })
  const world = new FiestaWorld<PlayerInput>(R, { playerCount: 2, systems: [chars] })
  try {
    world.physics.createBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), [
      R.ColliderDesc.cuboid(20, 0.5, 20).setCollisionGroups(groups(G.STATIC, G.CHAR | G.PROBE)),
    ])
    for (let p = 0; p < 2; p++) chars.place(world.ctx, p,
      { t: { x: p * 3, y: 0, z: 0 }, facing: { x: 0, z: 1 } })
    for (let tick = 0; tick < 120; tick++) world.step([RUN, NEUTRAL])
    assert.equal(world.tick, 120)
    assert.equal(world.ctx.hasSystem('mechanisms'), false)
    assert.equal(world.ctx.hasSystem('obstacles'), false)
    for (let p = 0; p < 2; p++) {
      const s = chars.state(world.ctx, p, state())
      assert.equal(s.grounded, true)
      assert.equal(s.groundBody, null)
      assert.equal(s.groundObstacle, -1)
      assert.ok(Math.abs(s.pos.y - STAND) < 0.1)
      if (p === 0) assert.ok(s.pos.z > 10, 'running character advances')
      else assert.ok(Math.abs(s.pos.z) < 0.1, 'neutral character stays put')
    }
  } finally { world.free() }
})
