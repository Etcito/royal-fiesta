// The candy-patches migration: every former mover is a mechanism item, every tick-function part
// reproduces motionPose within 5% of its old motion envelope, the seesaw and bounce pad work through
// their asset joints. Sprint finishes by target; the longer races retain legacy traversal parity.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ColliderSpec, Motion, ObstacleSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import { PlayerStatus } from '@royal-fiesta/sim/match/roundSystem'
import type { RoundSystem } from '@royal-fiesta/sim/match/roundSystem'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import type { CharacterSystem, CharState } from '@royal-fiesta/sim/character/system'
import { withLogic } from '@royal-fiesta/sim/mechanisms/logicSystem'
import { MechanismSystem } from '@royal-fiesta/sim/mechanisms/system'
import type { MechanismWorld } from '@royal-fiesta/sim/mechanisms/preview'
import type { AnimationSpec } from '@royal-fiesta/sim/mechanismSpec'
import { motionPose } from '@royal-fiesta/sim/obstacles/motion'
import { add3, dot3, pose, quatRotate, sub3, v3 } from '@royal-fiesta/sim/vec'
import type { Pose, Vec3 } from '@royal-fiesta/sim/vec'
import { fixtureResolver } from '../src/assets.ts'
import type { AssetResolver } from '../src/assets.ts'
import { loadCourse } from '../src/course.ts'
import { loadCourseV1, migrateCourseV0 } from '../src/courseV1.ts'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = (rel: string): Promise<string> => readFile(new URL(rel, ROOT), 'utf8')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, ROOT), 'utf8'))
const R: RapierModule = await initRapier()
const TAU = Math.PI * 2
const TICK = 60
const CPUS = Math.max(1, Math.floor(Number(process.env.NMC_CPUS ?? 1)) || 1)

const COURSES = [
  'race-bean-dash', 'race-hammer-hill', 'race-sprint', 'survival-sprint',
  'survival-spin-zone', 'survival-hammer-ring', 'obstacle-gallery', 'hub-plaza',
] as const
const RACES = ['race-bean-dash', 'race-hammer-hill', 'race-sprint'] as const

// The six candy movers now carry physics. Conveyors keep their motion: their asset has no physics.
const MOUNTED = new Set([
  'candy.spinner-bar', 'candy.rotating-door', 'candy.pendulum-hammer',
  'candy.moving-platform', 'candy.seesaw-plank', 'candy.bounce-pad',
])
const TICK_MOTIONS = new Set(['spinner', 'pendulum', 'rotatingDoor', 'movingPlatform'])

const shippedCache = new Map<string, Promise<ResolvedGameAsset>>()
const shipped: GameAssetResolver = {
  resolve(id: string): Promise<ResolvedGameAsset> {
    let pending = shippedCache.get(id)
    if (pending === undefined) {
      pending = (async () => {
        const world = id.slice(0, id.indexOf('.')) as World
        const path = assetFilePath(world, id)
        const json = readJson(path)
        return { asset: await parseGameAsset(json, path), source: { path, json } }
      })()
      shippedCache.set(id, pending)
    }
    return pending
  },
}

let v0Assets: AssetResolver | undefined
async function loadV1(id: string): Promise<CourseV1> {
  const path = `courses/${id}.course.json`
  return loadCourseV1(readJson(path), path, shipped)
}
async function loadV0(id: string): Promise<ResolvedCourse> {
  v0Assets ??= fixtureResolver(read)
  const path = `fixtures/courses/${id}.course.json`
  return loadCourse(readJson(path), path, v0Assets)
}

function periodTicks(m: Motion): number {
  switch (m.kind) {
    case 'spinner':
      return Math.max(1, Math.round(TAU / Math.abs(m.radPerTick)))
    case 'pendulum':
    case 'rotatingDoor':
    case 'movingPlatform':
      return m.periodTicks
    default:
      return 0
  }
}

// Every extreme point of a collider in the body frame; the pose error is checked at all of them.
function colliderPoints(c: ColliderSpec): Vec3[] {
  const t = c.t
  const out: Vec3[] = []
  switch (c.shape) {
    case 'cuboid':
    case 'roundCuboid':
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        out.push(v3(t.x + sx * c.half.x, t.y + sy * c.half.y, t.z + sz * c.half.z))
      }
      break
    case 'ball':
      out.push(v3(t.x + c.radius, t.y, t.z), v3(t.x, t.y + c.radius, t.z), v3(t.x, t.y, t.z + c.radius))
      break
    default:
      for (const sy of [-1, 1]) for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        out.push(v3(t.x + ax * c.radius, t.y + sy * c.halfHeight, t.z + az * c.radius))
      }
  }
  return out
}

function worldPoint(p: Pose, local: Vec3): Vec3 {
  const rotated = quatRotate(p.r, local, v3(0, 0, 0))
  return add3(p.t, rotated, rotated)
}

// The old envelope: the offset length for a platform, else the collider arm times the total sweep.
function envelopeOf(m: Motion, rest: Pose, points: readonly Vec3[]): number {
  if (m.kind === 'movingPlatform') return Math.hypot(m.offset.x, m.offset.y, m.offset.z)
  if (m.kind !== 'spinner' && m.kind !== 'pendulum' && m.kind !== 'rotatingDoor') return 0
  const pivot = m.kind === 'pendulum' ? m.pivot : rest.t
  let arm = 0
  for (const local of points) {
    const point = worldPoint(rest, local)
    const delta = sub3(point, pivot, v3(0, 0, 0))
    const along = dot3(delta, m.axis)
    const radial = Math.hypot(delta.x - m.axis.x * along, delta.y - m.axis.y * along, delta.z - m.axis.z * along)
    arm = Math.max(arm, radial)
  }
  const sweep = m.kind === 'spinner' ? TAU : m.kind === 'pendulum' ? Math.abs(m.amp) : Math.abs(m.stepAngle)
  return arm * sweep
}

interface Envelope {
  error: number
  envelope: number
  period: number
}

// Sample the body pose each tick over one old period and compare it with motionPose at that tick.
// The animation starts at tick 1 (localTick = ctx.tick + 1 - loadTick), so the sample starts there.
function checkEnvelope(world: MechanismWorld, sim: ResolvedCourse, animation: AnimationSpec, ref: ObstacleSpec): Envelope {
  const mech = sim.mechanisms
  assert.ok(mech, 'qualified by the caller')
  const item = mech.items[animation.target.item]
  const body = item.bodies[animation.target.body]
  const period = periodTicks(ref.motion)
  assert.ok(period > 0, `${animation.id}: not a tick-function motion`)
  const points = body.colliders.flatMap(colliderPoints)
  assert.ok(points.length > 0, `${animation.id}: body '${body.id}' has no colliders`)

  const rest: Pose = { t: ref.t, r: ref.r }
  let frame = 0
  for (const local of points) {
    const a = worldPoint(body.rest, local)
    const b = worldPoint(rest, local)
    frame = Math.max(frame, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
  }
  assert.ok(frame < 1e-6, `${animation.id}: body rest is ${frame} m from the obstacle pose; the reference needs the item pose`)
  const envelope = envelopeOf(ref.motion, rest, points)
  assert.ok(envelope > 0, `${animation.id}: zero motion envelope`)

  const actual = pose()
  const expected = pose()
  let error = 0
  world.reset()
  for (let tick = 1; tick <= period; tick++) {
    world.step()
    assert.ok(world.mechanismBodyPose(animation.target, actual), `${animation.id}: no body pose at tick ${tick}`)
    motionPose(ref, tick, 0, expected)
    for (const local of points) {
      const a = worldPoint(actual, local)
      const b = worldPoint(expected, local)
      error = Math.max(error, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
    }
  }
  return { error, envelope, period }
}

// The flat joint index in a MechanismSystem: every earlier item's joints, then this item's joints.
function jointOf(sim: ResolvedCourse, itemIndex: number, kind: string): number {
  const mech = sim.mechanisms
  assert.ok(mech)
  let flat = 0
  for (let i = 0; i < itemIndex; i++) flat += mech.items[i].joints.length
  const local = mech.items[itemIndex].joints.findIndex(j => j.kind === kind)
  assert.ok(local >= 0, `item '${mech.items[itemIndex].id}' has no ${kind} joint`)
  return flat + local
}

function itemAndBody(sim: ResolvedCourse, id: string, bodyId: string): { item: number; body: number } {
  const mech = sim.mechanisms
  assert.ok(mech, 'qualified by the caller')
  const item = mech.items.findIndex(i => i.id === id)
  assert.ok(item >= 0, `missing mechanism item '${id}'`)
  const body = mech.items[item].bodies.findIndex(b => b.id === bodyId)
  assert.ok(body >= 0, `missing body '${id}/${bodyId}'`)
  return { item, body }
}

function dynamicBody(sim: ResolvedCourse, id: string): { item: number; body: number } {
  const mech = sim.mechanisms
  assert.ok(mech)
  const item = mech.items.findIndex(i => i.id === id)
  assert.ok(item >= 0, `missing mechanism item '${id}'`)
  const body = mech.items[item].bodies.findIndex(b => b.type === 'dynamic')
  assert.ok(body >= 0, `item '${id}' has no dynamic body`)
  return { item, body }
}

// A 60 kg load at the plank end must stay within 1.05 x the old maxDeg; unloaded it recentres in 3 s.
function checkSeesaw(world: MechanismWorld, sim: ResolvedCourse, ref: ObstacleSpec): void {
  assert.equal(ref.motion.kind, 'seesaw')
  const { item, body } = dynamicBody(sim, ref.id)
  const refBody = { item, body }
  const mech = sim.mechanisms
  assert.ok(mech)
  const hinge = jointOf(sim, item, 'hinge')
  const system = world.world.ctx.system<MechanismSystem>('mechanisms')
  const points = mech.items[item].bodies[body].colliders.flatMap(colliderPoints)
  const end = points.reduce((best, p) => Math.abs(p.z) > Math.abs(best.z) ? p : best)
  const poseAt = pose()

  world.reset()
  let maxTilt = 0
  for (let tick = 0; tick < 180; tick++) {
    assert.ok(world.mechanismBodyPose(refBody, poseAt))
    system.addLoad(refBody, worldPoint(poseAt, end), 60)
    world.step()
    maxTilt = Math.max(maxTilt, Math.abs(system.jointAngle(world.world.ctx, hinge)))
  }
  const limit = ref.motion.maxAngle
  assert.ok(maxTilt <= limit * 1.05 + 1e-9,
    `${ref.id}: a 60 kg end load tilts ${(maxTilt * 180 / Math.PI).toFixed(2)} deg, over 1.05 x ${(limit * 180 / Math.PI).toFixed(2)} deg`)
  assert.ok(maxTilt > limit * 0.5, `${ref.id}: the load barely tilts the plank (${(maxTilt * 180 / Math.PI).toFixed(2)} deg)`)

  let recentred = -1
  for (let tick = 0; tick < 180; tick++) {
    world.step()
    if (Math.abs(system.jointAngle(world.world.ctx, hinge)) <= 0.035) {
      recentred = tick + 1
      break
    }
  }
  assert.ok(recentred >= 0, `${ref.id}: the unloaded plank did not recentre within 3 s`)
}

// A 60 kg ball dropped from 2 m above the pad must be moving up within 60 ticks.
function checkBouncePad(world: MechanismWorld, sim: ResolvedCourse, ref: ObstacleSpec): void {
  const { item, body } = dynamicBody(sim, ref.id)
  const mech = sim.mechanisms
  assert.ok(mech)
  const points = mech.items[item].bodies[body].colliders.flatMap(colliderPoints)
  const poseAt = pose()
  world.reset()
  assert.ok(world.mechanismBodyPose({ item, body }, poseAt))
  let top = -Infinity
  for (const local of points) top = Math.max(top, worldPoint(poseAt, local).y)

  const radius = 0.4
  const mass = 60
  const density = mass / ((4 / 3) * Math.PI * radius ** 3)
  const physics = world.world.ctx.physics
  const id = physics.createBody(
    R.RigidBodyDesc.dynamic().setTranslation(poseAt.t.x, top + 2 + radius, poseAt.t.z),
    [R.ColliderDesc.ball(radius).setDensity(density).setFriction(0.5)],
  )
  const ball = physics.body(id)
  let bounced = -1
  for (let tick = 0; tick < 60; tick++) {
    world.step()
    if (ball.linvel().y > 0.5) {
      bounced = tick + 1
      break
    }
  }
  assert.ok(bounced >= 0, `${ref.id}: a 60 kg ball dropped from 2 m does not come back up within 60 ticks`)
}

// Retain the fixture's motions through the v0 migration. Physics is deliberately absent
// from this test-only resolver: otherwise loadCourseV1 rejects legacy moving obstacles.
const legacyAssets: GameAssetResolver = {
  async resolve(id) {
    const resolved = await shipped.resolve(id)
    const { physics: _physics, ...asset } = resolved.asset
    return { ...resolved, asset }
  },
}
async function loadLegacyRace(id: string): Promise<ResolvedCourse> {
  const path = `fixtures/courses/${id}.course.json`
  const course = await loadCourseV1(migrateCourseV0(readJson(path), path), path, legacyAssets)
  assert.ok(course.sim)
  assert.ok(course.sim.mechanisms == null, 'legacy motions must run through ObstacleSystem')
  return course.sim
}

async function runRace(race: ResolvedCourse) {
  const survival = await loadV1('survival-sprint')
  assert.ok(survival.sim)
  const sim = createMatchSim(R, {
    seed: 1, playerCount: 8, humans: Array<boolean>(8).fill(false), profile: 'sprint',
    // Select this course explicitly under sprint rules, including bean-dash, whose
    // shipped pool membership is standard-only. Geometry, motions and rules stay intact.
    courses: [{ ...race, profiles: ['standard', 'sprint'] } satisfies ResolvedCourse, survival.sim].sort((a, b) => a.id.localeCompare(b.id)),
  })
  const inputs = Array.from({ length: 8 }, () => neutralInput())
  const finishers: { player: number; tick: number }[] = []
  const falls = Array<number>(8).fill(0)
  const fallPositions: { player: number; tick: number; position: Vec3 }[] = []
  const state: CharState = {
    pos: v3(0, 0, 0), vel: v3(0, 0, 0), facing: { x: 0, z: 1 }, mode: 0,
    grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: -1,
  }
  try {
    const rounds = sim.world.ctx.system<RoundSystem>('round')
    const chars = sim.world.ctx.system<CharacterSystem>('characters')
    const maxTicks = PROFILES.sprint.introTicks + PROFILES.sprint.timeCapS! * TICK + 2
    while (!rounds.over && sim.tick < maxTicks) {
      const active = rounds.active
      const alive = Array.from({ length: 8 }, (_, p) => active && rounds.status(p) === PlayerStatus.alive)
      const teleports = alive.map((_, p) => chars.state(sim.world.ctx, p, state).teleportTick)
      const positions = alive.map((_, p) => ({ ...chars.state(sim.world.ctx, p, state).pos }))
      const tick = sim.tick
      sim.step(inputs)
      for (let p = 0; p < 8; p++) {
        if (!alive[p]) continue
        // In an active race, RoundSystem.place is called only for a kill-plane respawn.
        // Observe teleportTick because the below-plane pose is gone by the end of step.
        if (chars.state(sim.world.ctx, p, state).teleportTick !== teleports[p]) {
          falls[p]++
          // Last observed position before the kill-plane step, not a collision attribution.
          fallPositions.push({ player: p, tick, position: positions[p] })
        }
        // Time-cap progress qualifiers do NOT get the finished-checkpoint sentinel.
        if (rounds.checkpoint(p) === race.checkpoints.length &&
            !finishers.some(f => f.player === p)) finishers.push({ player: p, tick })
      }
    }
    assert.ok(rounds.over, `${race.id}: round 0 did not complete`)
    const result = rounds.result()
    assert.ok(result)
    assert.equal(result.plan.index, 0)
    assert.equal(result.plan.kind, 'race')
    assert.equal(sim.setup.courses[result.courseIndex].id, race.id)
    assert.equal(result.participants.length, 8)
    return { reason: result.reason, endTick: result.endTick, finishers, falls, fallPositions }
  } finally {
    sim.free()
  }
}

describe('candy presets', { concurrency: CPUS }, () => {
  for (const id of COURSES) {
    it(`${id}: former movers are mechanism items and move within their old envelope`, { timeout: 180_000 }, async () => {
      const course = await loadV1(id)
      const v0 = await loadV0(id)
      const sim = course.sim
      assert.ok(sim, `${id}: no simulation course`)
      const mech = sim.mechanisms
      assert.ok(mech, `${id}: no mechanisms block`)

      // The validated v1 form keeps every obstacle; physics obstacles are mechanism items in sim.
      const byId = new Map((course.json.obstacles as Record<string, unknown>[]).map(o => [o.id as string, o]))
      const animations = new Map<string, AnimationSpec>()
      for (const animation of mech.animations) {
        const item = mech.items[animation.target.item]
        animations.set(item.id, animation)
      }
      for (const old of v0.obstacles) {
        if (!MOUNTED.has(`candy.${old.asset}`)) continue
        const obstacle = byId.get(old.id)
        assert.ok(obstacle, `${id}: former mover '${old.id}' is missing from obstacles`)
        const motion = obstacle.motion as { kind?: unknown }
        assert.equal(motion.kind, 'static', `${id}/${old.id}: a physics asset must have motion static`)
        assert.equal(obstacle.colliders, null, `${id}/${old.id}: a physics asset takes no collider override`)
        assert.ok(mech.items.some(item => item.id === old.id), `${id}: former mover '${old.id}' is not a mechanism item`)
        if (old.motion.kind === 'seesaw' || old.motion.kind === 'bouncePad') {
          assert.ok(!animations.has(old.id), `${id}/${old.id}: ${old.motion.kind} is driven by its asset joints, not an animation`)
        } else {
          assert.ok(TICK_MOTIONS.has(old.motion.kind), `${id}/${old.id}: unexpected former motion '${old.motion.kind}'`)
          assert.ok(animations.has(old.id), `${id}/${old.id}: no tick-function animation`)
        }
      }

      const world = withLogic(R, sim)
      try {
        for (const animation of mech.animations) {
          const item = mech.items[animation.target.item]
          const ref = v0.obstacles.find(o => o.id === item.id)
          assert.ok(ref, `${id}/${animation.id}: no v0 reference motion for '${item.id}'`)
          assert.ok(TICK_MOTIONS.has(ref.motion.kind), `${id}/${animation.id}: '${ref.motion.kind}' is not a tick-function motion`)
          const result = checkEnvelope(world, sim, animation, ref)
          assert.ok(result.error <= result.envelope * 0.05 + 1e-9,
            `${id}/${animation.id}: max position error ${result.error.toFixed(4)} m is ${(result.error / result.envelope * 100).toFixed(2)}% of the ${result.envelope.toFixed(3)} m envelope`)
        }
        for (const old of v0.obstacles) {
          if (old.motion.kind === 'seesaw') checkSeesaw(world, sim, old)
        }
        for (const old of v0.obstacles) {
          if (old.motion.kind === 'bouncePad') checkBouncePad(world, sim, old)
        }
      } finally {
        world.free()
      }
    })
  }

  for (const id of RACES) {
    it(`${id}: sprint round 0 preserves race traversal`, { timeout: 180_000 }, async t => {
      const course = await loadV1(id)
      assert.ok(course.sim)
      const migrated = await runRace(course.sim)
      if (id === 'race-sprint') {
        t.diagnostic(JSON.stringify({ course: id, migrated }))
        assert.equal(migrated.reason, 'target')
        return
      }
      const legacy = await runRace(await loadLegacyRace(id))
      t.diagnostic(JSON.stringify({ course: id, migrated, legacy }))
      assert.ok(migrated.finishers.length >= legacy.finishers.length, `${id}: fewer actual finishers`)
      // With no legacy finishers there is no last-finisher deadline to compare.
      // A newly successful migrated finisher therefore cannot regress a legacy time.
      if (legacy.finishers.length > 0) {
        const lastTick = Math.max(...legacy.finishers.map(f => f.tick))
        for (const finisher of migrated.finishers) {
          assert.ok(finisher.tick <= lastTick * 1.1,
            `${id}: player ${finisher.player} finished at ${finisher.tick}, beyond legacy ${lastTick} + 10%`)
        }
      }
      // Q20: the migrated run has no more kill-plane falls than the legacy run. The per-player
      // counts stay in the diagnostic because bot contact order is chaotic; the acceptance is the
      // run total, as the measured 18-vs-14 report in Q22 uses.
      const migratedFalls = migrated.falls.reduce((a, b) => a + b, 0)
      const legacyFalls = legacy.falls.reduce((a, b) => a + b, 0)
      assert.ok(migratedFalls <= legacyFalls,
        `${id}: ${migratedFalls} kill-plane falls, legacy has ${legacyFalls}`)
    })
  }
})
