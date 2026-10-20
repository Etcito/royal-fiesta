import assert from 'node:assert/strict'
import test from 'node:test'
import { FIXED_DT, RapierWorldSim, initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ColliderSpec, Motion, ObstacleSpec, ResolvedCourse } from '../src/course.ts'
import { G, groups } from '../src/groups.ts'
import { isKinematic, motionPose } from '../src/obstacles/motion.ts'
import { ObstacleSystem } from '../src/obstacles/system.ts'
import { add3, pose, quatConj, quatIdentity, quatRotate, scale3, sub3, v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'
import { FiestaWorld } from '../src/world.ts'
import type { SimSystem, WorldCtx } from '../src/world.ts'
import { colliderDesc } from '../src/obstacles/colliders.ts'
import { RefusalError } from '../src/refusal.ts'

const R: RapierModule = await initRapier()

const t = { x: 1.5, y: -2, z: 3.25 }
const r = { x: 0, y: 0, z: 0, w: 1 }

// Builds a fixed body at the origin carrying the collider, so its world translation is t.
function build(c: ColliderSpec) {
  const sim = new RapierWorldSim(R)
  const id = sim.createBody(R.RigidBodyDesc.fixed(), [colliderDesc(R, c)])
  const col = sim.body(id).collider(0)
  return { sim, col }
}

function checkTranslation(col: { translation(): { x: number; y: number; z: number } }): void {
  const p = col.translation()
  assert.deepEqual({ x: p.x, y: p.y, z: p.z }, t)
}

test('colliderDesc: cuboid', () => {
  const { sim, col } = build({ shape: 'cuboid', half: { x: 1, y: 0.5, z: 2 }, t, r })
  assert.equal(col.shape.type, R.ShapeType.Cuboid)
  const h = col.halfExtents()
  assert.ok(h)
  assert.deepEqual({ x: h.x, y: h.y, z: h.z }, { x: 1, y: 0.5, z: 2 })
  checkTranslation(col)
  sim.free()
})

test('colliderDesc: roundCuboid', () => {
  const { sim, col } = build({ shape: 'roundCuboid', half: { x: 1, y: 0.5, z: 2 }, border: 0.25, t, r })
  assert.equal(col.shape.type, R.ShapeType.RoundCuboid)
  const h = col.halfExtents()
  assert.ok(h)
  assert.deepEqual({ x: h.x, y: h.y, z: h.z }, { x: 1, y: 0.5, z: 2 })
  assert.equal(col.roundRadius(), 0.25)
  checkTranslation(col)
  sim.free()
})

test('colliderDesc: ball', () => {
  const { sim, col } = build({ shape: 'ball', radius: 0.75, t, r })
  assert.equal(col.shape.type, R.ShapeType.Ball)
  assert.equal(col.radius(), 0.75)
  checkTranslation(col)
  sim.free()
})

test('colliderDesc: capsule, cylinder, cone', () => {
  const cases = [
    ['capsule', R.ShapeType.Capsule],
    ['cylinder', R.ShapeType.Cylinder],
    ['cone', R.ShapeType.Cone],
  ] as const
  for (let i = 0; i < cases.length; i++) {
    const [shape, type] = cases[i]
    const { sim, col } = build({ shape, halfHeight: 1.25, radius: 0.5, t, r })
    assert.equal(col.shape.type, type, shape)
    assert.equal(col.halfHeight(), 1.25, shape)
    assert.equal(col.radius(), 0.5, shape)
    checkTranslation(col)
    sim.free()
  }
})

test('colliderDesc: a non-primitive shape is refused', () => {
  const bad = { shape: 'trimesh', t, r } as never
  assert.throws(() => colliderDesc(R, bad), (e: unknown) => {
    assert.ok(e instanceof RefusalError)
    assert.match(e.message, /unknown shape 'trimesh'; primitive colliders only/)
    return true
  })
})

// --- ObstacleSystem ---

const I = { x: 0, y: 0, z: 0, w: 1 }
const O = { x: 0, y: 0, z: 0 }
const ONE = { x: 1, y: 1, z: 1 }

function obstacle(id: string, t: Vec3, motion: Motion, colliders: ColliderSpec[], friction = 0.5): ObstacleSpec {
  return { id, asset: id, t, r: I, s: ONE, friction, colliders, motion }
}

function box(hx: number, hy: number, hz: number): ColliderSpec {
  return { shape: 'cuboid', half: { x: hx, y: hy, z: hz }, t: O, r: I }
}

const course: ResolvedCourse = {
  id: 'test-course', name: 'Test', kind: 'race', profiles: ['standard'],
  timeLimitS: 60, killPlaneY: -10,
  spawns: [], checkpoints: [], finish: null, path: [], regions: [], queuePad: null,
  contentHash: 0,
  obstacles: [
    obstacle('floor', { x: 0, y: -0.5, z: 20 }, { kind: 'static' }, [box(10, 0.5, 20)], 0.8),
    obstacle('spin', { x: 0, y: 1, z: 5 }, { kind: 'spinner', axis: { x: 0, y: 1, z: 0 }, radPerTick: Math.PI / 120, phase: 0 },
      [box(4, 0.25, 0.25), { shape: 'ball', radius: 0.5, t: { x: 0, y: 0.5, z: 0 }, r: I }]),
    obstacle('pend', { x: 3, y: 2, z: 10 }, { kind: 'pendulum', pivot: { x: 3, y: 6, z: 10 }, axis: { x: 0, y: 0, z: 1 }, amp: 1, periodTicks: 180, phase: 0 },
      [{ shape: 'ball', radius: 1, t: O, r: I }]),
    obstacle('saw', { x: 0, y: 0.5, z: 15 }, { kind: 'seesaw', axis: { x: 1, y: 0, z: 0 }, maxAngle: 0.35, spring: 800, damping: 300, inertia: 900 },
      [box(2, 0.2, 4)]),
    obstacle('plat', { x: -4, y: 1, z: 25 }, { kind: 'movingPlatform', offset: { x: 4, y: 0, z: 0 }, periodTicks: 240, phase: 0, wave: 'sine' },
      [box(1.5, 0.25, 1.5)]),
    obstacle('wall', { x: 9, y: 1.5, z: 30 }, { kind: 'static' }, [box(0.5, 1.5, 3)], 0.25),
  ],
}

// Loads course 0 from init, like a round system would.
function loaderSystem(sys: ObstacleSystem, load: boolean): SimSystem<unknown> {
  return {
    name: 'loader',
    init(ctx) { if (load) sys.load(ctx, 0) },
    preStep() {},
    postStep() {},
    snapshot() {},
    restore() {},
  }
}

function makeWorld(load = true) {
  const sys = new ObstacleSystem([course])
  const world = new FiestaWorld<unknown>(R, { playerCount: 1, systems: [sys, loaderSystem(sys, load)] })
  return { sys, world }
}

function run(world: FiestaWorld<unknown>, toTick: number): void {
  while (world.tick < toTick) world.step([0])
}

test('ObstacleSystem.load: bodies, groups, friction', () => {
  const { sys, world } = makeWorld()
  try {
    assert.equal(sys.courseIndex, 0)
    assert.equal(sys.count, 6)
    assert.equal(sys.loadTick, 0)
    assert.equal(world.physics.bodyCount, 6)
    const word = groups(G.MOVING, G.CHAR | G.DEBRIS | G.PROBE)
    for (let i = 0; i < sys.count; i++) {
      const o = sys.spec(i)
      const rb = world.physics.body(sys.bodyId(i))
      const kin = isKinematic(o.motion.kind)
      assert.equal(rb.bodyType(), kin ? R.RigidBodyType.KinematicPositionBased : R.RigidBodyType.Fixed, o.id)
      assert.equal(rb.numColliders(), o.colliders.length, o.id)
      for (let k = 0; k < rb.numColliders(); k++) {
        const col = rb.collider(k)
        assert.equal(col.collisionGroups(), kin ? word : groups(G.STATIC, G.CHAR | G.DEBRIS | G.PROBE), o.id)
        assert.equal(col.friction(), Math.fround(o.friction), o.id)
        assert.equal(col.restitution(), 0, o.id)
      }
    }
    assert.throws(() => sys.load(world.ctx, 0), (e: unknown) => e instanceof RefusalError && /already loaded/.test(e.message))
    assert.throws(() => sys.spec(6), RefusalError)
    assert.throws(() => sys.bodyId(-1), RefusalError)
  } finally {
    world.free()
  }
})

test('ObstacleSystem.load refuses an out-of-range course', () => {
  const { sys, world } = makeWorld(false)
  try {
    assert.equal(sys.courseIndex, -1)
    assert.throws(() => sys.load(world.ctx, 1), (e: unknown) => e instanceof RefusalError && /out of range/.test(e.message))
  } finally {
    world.free()
  }
})

test('ObstacleSystem: kinematic bodies follow motionPose', () => {
  const { sys, world } = makeWorld()
  try {
    run(world, 60)
    const p = motionPose(sys.spec(1), 60, 0, pose())
    const rb = world.physics.body(sys.bodyId(1))
    const t = rb.translation()
    const q = rb.rotation()
    // Rapier stores f32: the translation is the exact f32 rounding of the f64 pose. The rotation
    // goes through Rapier's kinematic velocity integration, which lands within a few f32 ulps.
    const f = Math.fround
    assert.deepEqual([t.x, t.y, t.z], [f(p.t.x), f(p.t.y), f(p.t.z)])
    const got = [q.x, q.y, q.z, q.w]
    const want = [p.r.x, p.r.y, p.r.z, p.r.w]
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(got[k] - want[k]) <= 4e-7, `r[${k}] ${got[k]} vs ${want[k]}`)
    assert.deepEqual(sys.pose(1, 60, pose()), p)
  } finally {
    world.free()
  }
})

function checkColliderMap(sys: ObstacleSystem, world: FiestaWorld<unknown>): void {
  const ctx = world.ctx
  let max = -1
  for (let i = 0; i < sys.count; i++) {
    const rb = world.physics.body(sys.bodyId(i))
    for (let k = 0; k < rb.numColliders(); k++) {
      const h = rb.collider(k).handle
      if (h > max) max = h
      assert.equal(sys.obstacleOfCollider(ctx, h), i)
    }
  }
  assert.equal(sys.obstacleOfCollider(ctx, max + 1000), -1)
}

test('ObstacleSystem.obstacleOfCollider maps handles to indices', () => {
  const { sys, world } = makeWorld()
  try {
    checkColliderMap(sys, world)
  } finally {
    world.free()
  }
})

test('ObstacleSystem: restore at tick 30 + 30 ticks equals the uninterrupted run (QB1)', () => {
  const a = makeWorld()
  const b = makeWorld(false)
  try {
    a.sys.addLoad(3, { x: 0, y: 0.7, z: 17 }, 60)
    run(a.world, 30)
    a.sys.addLoad(3, { x: 0.5, y: 0.7, z: 13 }, 45)
    const bytes = a.world.takeSnapshotBytes()
    b.world.restoreSnapshotBytes(bytes)
    assert.deepEqual(b.world.takeSnapshotBytes(), bytes)
    assert.equal(b.sys.courseIndex, 0)
    assert.equal(b.sys.count, 6)
    checkColliderMap(b.sys, b.world)
    run(a.world, 60)
    run(b.world, 60)
    assert.equal(b.world.stateHash(), a.world.stateHash())
    checkColliderMap(b.sys, b.world)
  } finally {
    a.world.free()
    b.world.free()
  }
})

test('ObstacleSystem.restore refuses a course count mismatch', () => {
  const a = makeWorld()
  const sys = new ObstacleSystem([{ ...course, obstacles: course.obstacles.slice(1) }])
  const b = new FiestaWorld<unknown>(R, { playerCount: 1, systems: [sys, loaderSystem(sys, false)] })
  try {
    assert.throws(() => b.restoreSnapshotBytes(a.world.takeSnapshotBytes()),
      (e: unknown) => e instanceof RefusalError && /snapshot\/count/.test(e.message))
  } finally {
    a.world.free()
    b.free()
  }
})

test('ObstacleSystem.addLoad refusals', () => {
  const { sys, world } = makeWorld()
  try {
    assert.throws(() => sys.addLoad(1, O, 1), (e: unknown) => e instanceof RefusalError && /not a seesaw/.test(e.message))
    assert.throws(() => sys.addLoad(3, { x: NaN, y: 0, z: 0 }, 1), RefusalError)
    assert.throws(() => sys.addLoad(3, O, Infinity), RefusalError)
    for (let k = 0; k < 64; k++) sys.addLoad(3, O, 1)
    assert.throws(() => sys.addLoad(3, O, 1), (e: unknown) => e instanceof RefusalError && /too many loads; /.test(e.message))
    assert.equal(sys.seesawAngle(3), 0)
  } finally {
    world.free()
  }
})

test('ObstacleSystem.unload removes every body', () => {
  const { sys, world } = makeWorld(false)
  try {
    const before = world.physics.bodyCount
    sys.load(world.ctx, 0)
    run(world, 10)
    assert.equal(sys.loadTick, 0)
    assert.equal(world.physics.bodyCount, before + 6)
    sys.unload(world.ctx)
    assert.equal(world.physics.bodyCount, before)
    assert.equal(sys.courseIndex, -1)
    assert.equal(sys.count, 0)
    run(world, 12)
  } finally {
    world.free()
  }
})

// --- see-saw integration and point velocity ---

const SAW = 3
const SAW_MAX = 0.35

// Steps the world once, adding a load at t0 + (0, 0, dz) first.
function loadedStep(sys: ObstacleSystem, world: FiestaWorld<unknown>, dz: number): void {
  const t0 = sys.spec(SAW).t
  sys.addLoad(SAW, { x: t0.x, y: t0.y, z: t0.z + dz }, 60)
  world.step([0])
}

test('see-saw: no load keeps angle 0 exactly', () => {
  const { sys, world } = makeWorld()
  try {
    for (let k = 0; k < 120; k++) {
      world.step([0])
      assert.equal(sys.seesawAngle(SAW), 0)
    }
  } finally {
    world.free()
  }
})

test('see-saw: a load at +z gives the hand-computed positive angle', () => {
  const { sys, world } = makeWorld()
  try {
    loadedStep(sys, world, 3)
    // arm (0,0,3) x force (0,-1200,0) = (3600,0,0); axis (1,0,0) -> tau = 3600.
    const dt = FIXED_DT
    const alpha = (3600 - 800 * 0 - 300 * 0) / 900
    const angVel = 0 + alpha * dt
    const angle = 0 + angVel * dt
    assert.ok(angle > 0)
    assert.equal(sys.seesawAngle(SAW), angle)
  } finally {
    world.free()
  }
})

for (const dz of [3, -3]) {
  test(`see-saw: a steady load at z${dz > 0 ? '+' : ''}${dz} tilts monotonically and clamps`, () => {
    const { sys, world } = makeWorld()
    try {
      const sign = Math.sign(dz)
      let prev = 0
      let clampedAt = -1
      for (let k = 0; k < 120; k++) {
        loadedStep(sys, world, dz)
        const a = sys.seesawAngle(SAW)
        assert.ok(a * sign >= prev * sign, `tick ${k}: ${a} after ${prev}`)
        if (clampedAt < 0 && a === sign * SAW_MAX) clampedAt = k
        if (clampedAt >= 0) assert.equal(a, sign * SAW_MAX)
        prev = a
      }
      assert.ok(clampedAt > 0, 'never clamped')
      // angVel was 0 at the clamp: one unloaded step moves only by the spring term.
      world.step([0])
      const alpha = (0 - 800 * (sign * SAW_MAX) - 300 * 0) / 900
      assert.equal(sys.seesawAngle(SAW), sign * SAW_MAX + (0 + alpha * FIXED_DT) * FIXED_DT)
    } finally {
      world.free()
    }
  })
}

test('see-saw: pending loads and angles survive snapshot -> restore (QB1)', () => {
  const a = makeWorld()
  const b = makeWorld(false)
  try {
    for (let k = 0; k < 20; k++) loadedStep(a.sys, a.world, 3)
    a.sys.addLoad(SAW, { x: 0.5, y: 0.7, z: 18 }, 45)
    a.sys.addLoad(SAW, { x: -0.5, y: 0.7, z: 12 }, 30)
    const bytes = a.world.takeSnapshotBytes()
    b.world.restoreSnapshotBytes(bytes)
    assert.deepEqual(b.world.takeSnapshotBytes(), bytes)
    a.world.step([0])
    b.world.step([0])
    assert.notEqual(a.sys.seesawAngle(SAW), 0)
    assert.equal(b.sys.seesawAngle(SAW), a.sys.seesawAngle(SAW))
    assert.equal(b.world.stateHash(), a.world.stateHash())
  } finally {
    a.world.free()
    b.world.free()
  }
})

// Runs `fn` inside preStep, after the obstacles have integrated.
function probeWorld(fn: (ctx: WorldCtx<unknown>) => void) {
  const sys = new ObstacleSystem([course])
  const probe: SimSystem<unknown> = {
    name: 'probe', init() {}, preStep(ctx) { fn(ctx) }, postStep() {}, snapshot() {}, restore() {},
  }
  const world = new FiestaWorld<unknown>(R, { playerCount: 1, systems: [sys, loaderSystem(sys, true), probe] })
  return { sys, world }
}

test('ObstacleSystem.pointVelocity of a spinner rim is omega x r', () => {
  let v: Vec3 | null = null
  const SPIN = 1
  const { sys, world } = probeWorld((ctx) => {
    if (ctx.tick !== 30) return
    const t0 = sys.spec(SPIN).t
    v = sys.pointVelocity(ctx, SPIN, { x: t0.x + 4, y: t0.y, z: t0.z }, v3(0, 0, 0))
  })
  try {
    run(world, 31)
    assert.ok(v !== null)
    const got: Vec3 = v
    const k = Math.PI / 120
    const omega = k * 60
    // The chord is tangent at mid-tick: r is (4,0,0) turned by half a tick about +Y.
    const rx = 4 * Math.cos(k / 2)
    const rz = -4 * Math.sin(k / 2)
    assert.ok(Math.abs(got.x - omega * rz) <= 1e-3, `vx ${got.x}`)
    assert.ok(Math.abs(got.y) <= 1e-3, `vy ${got.y}`)
    assert.ok(Math.abs(got.z - -omega * rx) <= 1e-3, `vz ${got.z}`)
  } finally {
    world.free()
  }
})

test('ObstacleSystem.pointVelocity of a tilting see-saw is the pose finite difference', () => {
  let got: Vec3 | null = null
  let L = -1
  let a1 = 0
  const p = { x: 1, y: 1.2, z: 17 }
  const { sys, world } = probeWorld((ctx) => {
    if (ctx.tick !== 10) return
    L = sys.localTick(ctx)
    a1 = sys.seesawAngle(SAW)
    got = sys.pointVelocity(ctx, SAW, p, v3(0, 0, 0))
  })
  try {
    for (let k = 0; k < 10; k++) loadedStep(sys, world, 3)
    const a0 = sys.seesawAngle(SAW)
    loadedStep(sys, world, 3)
    assert.ok(got !== null)
    const v: Vec3 = got
    assert.equal(L, 10)
    assert.ok(a0 > 0 && a1 > a0 && a1 < SAW_MAX, `mid-tilt ${a0} -> ${a1}`)
    const o = sys.spec(SAW)
    const pa = motionPose(o, L, a0, pose())
    const pb = motionPose(o, L + 1, a1, pose())
    const local = quatRotate(quatConj(pa.r, quatIdentity()), sub3(p, pa.t, v3(0, 0, 0)), v3(0, 0, 0))
    const p1 = add3(pb.t, quatRotate(pb.r, local, v3(0, 0, 0)), v3(0, 0, 0))
    const want = scale3(sub3(p1, p, v3(0, 0, 0)), 1 / FIXED_DT, v3(0, 0, 0))
    assert.ok(Math.abs(v.x - want.x) <= 1e-9 && Math.abs(v.y - want.y) <= 1e-9 && Math.abs(v.z - want.z) <= 1e-9,
      `${JSON.stringify(v)} vs ${JSON.stringify(want)}`)
    assert.ok(Math.abs(want.y) + Math.abs(want.z) > 0.01, 'see-saw is moving')
  } finally {
    world.free()
  }
})
