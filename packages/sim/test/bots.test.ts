import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Rng } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { BEHAVIOUR_FORMAT, BEHAVIOUR_VERSION, bindBehaviour, loadBehaviour, parseBehaviour } from '../src/bots/behaviour.ts'
import { courseCapabilities, nearestPathIndex, obstaclePhase, phaseInWindow, readMechanisms, readNavigation, regionDistance, regionNeighbours } from '../src/bots/courseRead.ts'
import { cheapestRegions, goalRegion, planRoute, regionExposure, replanDue, updateRoute } from '../src/bots/routes.ts'
import type { RouteInput, RoutePlan } from '../src/bots/routes.ts'
import { evaluateBrain, newMemory, raceBrain, rollSkill, survivalBrain } from '../src/bots/brain.ts'
import type { BotSkill, BrainInput } from '../src/bots/brain.ts'
import { BotSystem } from '../src/bots/botSystem.ts'
import { CharacterSystem } from '../src/character/system.ts'
import type { CourseKind, Motion, ObstacleSpec, PathNode, ResolvedCourse } from '../src/course.ts'
import { BTN, decodeInput, neutralInput } from '../src/input.ts'
import type { PlayerInput } from '../src/input.ts'
import { RoundSystem } from '../src/match/roundSystem.ts'
import { planRound } from '../src/match/rules.ts'
import type { MatchSetup } from '../src/match/setup.ts'
import { motionPose } from '../src/obstacles/motion.ts'
import { ObstacleSystem } from '../src/obstacles/system.ts'
import { isRefusal } from '../src/refusal.ts'
import { quatAxisAngle, quatMul, v3 } from '../src/vec.ts'
import type { Pose, Quat, Vec3 } from '../src/vec.ts'
import { FiestaWorld } from '../src/world.ts'

const ID = { x: 0, y: 0, z: 0, w: 1 }
const FWD = { x: 0, z: 1 }

function obstacle(id: string, t: Vec3, motion: Motion, half: Vec3): ObstacleSpec {
  return { id, asset: id, t, r: ID, s: v3(1, 1, 1), friction: 0.5, motion, colliders: [{ shape: 'cuboid', half, t: v3(0, 0, 0), r: ID }] }
}

function node(x: number, z: number, jump = false, dive = false): PathNode {
  return { p: v3(x, 0, z), jump, dive }
}

// Inline flat course along +Z: a floor, a wall, a spinner across the lane, a finish at z=36.
function course(id: string, kind: CourseKind): ResolvedCourse {
  const spawns = []
  for (let i = 0; i < 8; i++) spawns.push({ t: v3(-3.5 + i, 0, 1), facing: FWD })
  return {
    id, name: id, kind, profiles: ['standard', 'sprint'], timeLimitS: 60, killPlaneY: -10,
    spawns,
    checkpoints: [{ box: { center: v3(0, 1, 18), half: v3(10, 3, 1) }, respawn: { t: v3(0, 0, 18), facing: FWD } }],
    finish: kind === 'race' ? { center: v3(0, 1, 36), half: v3(10, 3, 1) } : null,
    path: kind === 'race'
      ? [node(0, 4), node(0, 9, true), node(0, 18), node(0, 30), node(0, 36, false, true)]
      : [node(-4, 4), node(4, 4), node(0, 10)],
    regions: [], queuePad: null, contentHash: 0,
    obstacles: [
      obstacle('floor', v3(0, -0.5, 18), { kind: 'static' }, v3(10, 0.5, 20)),
      obstacle('wall', v3(2, 0.5, 6), { kind: 'static' }, v3(1, 0.5, 0.3)),
      obstacle('spin', v3(0, 0.6, 7), { kind: 'spinner', axis: v3(0, 1, 0), radPerTick: 0.03, phase: 0 }, v3(4, 0.25, 0.25)),
    ],
  }
}

function brainInput(c: ResolvedCourse, pos: Vec3, over: Partial<BrainInput> = {}): BrainInput {
  return { course: c, pos, vel: v3(0, 0, 0), facing: FWD, grounded: true, mode: 0, obstacleAhead: false, hazardNear: false, ...over }
}

const SKILL: BotSkill = { reactionTicks: 0, aimError: 0, jumpLead: 0, diveChance: 0 }

describe('brains', () => {
  it('rollSkill stays in range and is deterministic per seed', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = rollSkill(new Rng(seed))
      assert.ok(Number.isInteger(s.reactionTicks) && s.reactionTicks >= 0 && s.reactionTicks <= 10, `reactionTicks ${s.reactionTicks}`)
      assert.ok(s.aimError >= 0 && s.aimError <= 0.2, `aimError ${s.aimError}`)
      assert.ok(s.jumpLead >= 0 && s.jumpLead <= 0.4, `jumpLead ${s.jumpLead}`)
      assert.ok(s.diveChance >= 0 && s.diveChance <= 0.3, `diveChance ${s.diveChance}`)
      assert.deepEqual(rollSkill(new Rng(seed)), s)
    }
    assert.notDeepEqual(rollSkill(new Rng(1)), rollSkill(new Rng(2)))
  })

  it('raceBrain advances pathIndex near a node', () => {
    const c = course('race-a', 'race')
    const mem = newMemory()
    raceBrain(brainInput(c, v3(0, 0.85, 3)), SKILL, mem, new Rng(1))
    assert.equal(mem.pathIndex, 1)
    // Far from node 1: no advance.
    raceBrain(brainInput(c, v3(0, 0.85, 3.2)), SKILL, mem, new Rng(1))
    assert.equal(mem.pathIndex, 1)
  })

  it('raceBrain sets the jump bit on a jump node', () => {
    const c = course('race-a', 'race')
    const near = newMemory()
    near.pathIndex = 1
    const code = raceBrain(brainInput(c, v3(0, 0.85, 7.5)), SKILL, near, new Rng(1))
    assert.notEqual(code & BTN.JUMP, 0)
    const far = newMemory()
    far.pathIndex = 1
    assert.equal(raceBrain(brainInput(c, v3(0, 0.85, 5)), SKILL, far, new Rng(1)) & BTN.JUMP, 0)
  })

  it('survivalBrain jumps when a hazard is near', () => {
    const c = course('surv-a', 'survival')
    const at = v3(0, 0.85, 1)
    assert.notEqual(survivalBrain(brainInput(c, at, { hazardNear: true }), SKILL, newMemory(), new Rng(1)) & BTN.JUMP, 0)
    assert.equal(survivalBrain(brainInput(c, at), SKILL, newMemory(), new Rng(1)) & BTN.JUMP, 0)
  })
})

type Json = Record<string, any>

function validBehaviour(): Json {
  return {
    format: 'royal-fiesta.bot',
    version: 0,
    id: 'test-bot',
    name: 'Test bot',
    tick: { decisionTicks: 4, reactionTicks: 2, wobbleTicks: 45, stuckTicks: 30 },
    route: { preference: 'short', advanceDist: 1.5, arriveDist: 0.5 },
    rules: [{ id: 'jump-wall', predicate: 'obstacleAhead', action: 'jump' }],
  }
}

const MALFORMED: Array<{ name: string; edit: (o: Json) => void; path: string; reason: string }> = [
  { name: 'format', edit: o => { o.format = 'royal-fiesta.bots' }, path: '/format', reason: 'royal-fiesta.bot' },
  { name: 'version', edit: o => { o.version = 1 }, path: '/version', reason: 'version' },
  { name: 'missing rules', edit: o => { delete o.rules }, path: '/rules', reason: 'missing required field' },
  { name: 'non-integer tick', edit: o => { o.tick.decisionTicks = 2.5 }, path: '/tick/decisionTicks', reason: 'integer' },
  { name: 'tick range', edit: o => { o.tick.reactionTicks = -1 }, path: '/tick/reactionTicks', reason: '0..120' },
  { name: 'unknown tick key', edit: o => { o.tick.boost = 1 }, path: '/tick/boost', reason: 'unknown key' },
  { name: 'route preference', edit: o => { o.route.preference = 'scenic' }, path: '/route/preference', reason: 'scenic' },
  { name: 'route distance', edit: o => { o.route.advanceDist = 0 }, path: '/route/advanceDist', reason: '> 0' },
  { name: 'predicate', edit: o => { o.rules[0].predicate = 'teleport' }, path: '/rules/0/predicate', reason: 'teleport' },
  { name: 'predicate distance', edit: o => { o.rules[0].predicate = 'nearNode' }, path: '/rules/0/distance', reason: 'needs a distance' },
  { name: 'phase order', edit: o => { o.rules[0].phase = { from: 10, to: 5 } }, path: '/rules/0/phase', reason: 'after' },
  { name: 'phase integer', edit: o => { o.rules[0].phase = { from: 0.5, to: 10 } }, path: '/rules/0/phase/from', reason: 'integer' },
  { name: 'distance', edit: o => { o.rules[0].predicate = 'nearFinish'; o.rules[0].distance = -1 }, path: '/rules/0/distance', reason: 'distance' },
  { name: 'action', edit: o => { o.rules[0].action = 'fly' }, path: '/rules/0/action', reason: 'fly' },
  { name: 'duplicate rule id', edit: o => { o.rules.push({ ...o.rules[0] }) }, path: '/rules/1/id', reason: 'duplicate' },
]

const SHORT_TEXT = await readFile(new URL('../src/bots/behaviours/short.bot.json', import.meta.url), 'utf8')
const SAFE_TEXT = await readFile(new URL('../src/bots/behaviours/safe.bot.json', import.meta.url), 'utf8')

describe('behaviour', () => {
  it('loads both behaviour profiles and binds them to an S2 course', () => {
    const short = loadBehaviour(SHORT_TEXT, 'short.bot.json')
    const safe = loadBehaviour(SAFE_TEXT, 'safe.bot.json')
    assert.equal(short.format, BEHAVIOUR_FORMAT)
    assert.equal(short.version, BEHAVIOUR_VERSION)
    assert.equal(short.id, 'short-route')
    assert.equal(safe.id, 'safe-route')
    assert.equal(short.route.preference, 'short')
    assert.equal(safe.route.preference, 'safe')
    assert.ok(short.rules.length > 0 && safe.rules.length > 0)
    const c = course('race-a', 'race')
    assert.equal(bindBehaviour(short, c), short)
    assert.equal(bindBehaviour(safe, c), safe)
  })

  it('refuses malformed behaviour fields with identifiable paths', () => {
    for (const c of MALFORMED) {
      const o = validBehaviour()
      c.edit(o)
      assert.throws(
        () => parseBehaviour(o, 'test.bot.json'),
        (e: unknown) => isRefusal(e) && e.path === `test.bot.json#${c.path}` && e.reason.includes(c.reason),
        c.name,
      )
    }
  })

  it('refuses a useLever behaviour bound to a course without levers', () => {
    const o = validBehaviour()
    o.rules[0].action = 'useLever'
    const b = parseBehaviour(o, 'lever.bot.json')
    assert.equal(b.rules[0].action, 'useLever')
    assert.throws(
      () => bindBehaviour(b, course('race-a', 'race')),
      (e: unknown) => isRefusal(e) && e.path === 'behaviours/test-bot/rules/0/action' && e.reason.includes('levers'),
    )
    assert.equal(bindBehaviour(b, { id: 'lever-course', levers: [{}] }), b)
  })

  it('refuses invalid behaviour JSON text', () => {
    assert.throws(
      () => loadBehaviour('{ nope', 'broken.bot.json'),
      (e: unknown) => isRefusal(e) && e.path === 'broken.bot.json' && e.reason.includes('invalid JSON'),
    )
  })
})

const R: RapierModule = await initRapier()
const COURSES = [course('race-a', 'race'), course('surv-a', 'survival')]
const PLAYERS = 4

interface Rig { world: FiestaWorld<PlayerInput>; bots: BotSystem }

function rig(courseIndex: number): Rig {
  const setup: MatchSetup = { seed: 77, playerCount: PLAYERS, humans: [false, false, false, false], profile: 'sprint', courses: COURSES }
  const bots = new BotSystem(setup)
  const obs = new ObstacleSystem(COURSES)
  const chars = new CharacterSystem({ playerCount: PLAYERS })
  const round = new RoundSystem(setup)
  const world = new FiestaWorld<PlayerInput>(R, { playerCount: PLAYERS, systems: [bots, obs, chars, round] })
  obs.load(world.ctx, courseIndex)
  const plan = planRound(COURSES[courseIndex].kind === 'race' ? 0 : 1, PLAYERS)
  round.begin(world.ctx, plan, courseIndex, [0, 1, 2, 3], [0, 2, 4, 6], 3600)
  bots.resetForRound(world.ctx)
  return { world, bots }
}

const NEUTRAL: PlayerInput[] = []
for (let p = 0; p < PLAYERS; p++) NEUTRAL.push(neutralInput())

function run(w: FiestaWorld<PlayerInput>, n: number): void {
  for (let i = 0; i < n; i++) w.step(NEUTRAL)
}

describe('BotSystem', () => {
  it('constructs one bot per non-human and setBot/playerDropped toggle it', () => {
    const setup: MatchSetup = { seed: 5, playerCount: 3, humans: [true, false, true], profile: 'sprint', courses: COURSES }
    const bots = new BotSystem(setup)
    assert.deepEqual([bots.isBot(0), bots.isBot(1), bots.isBot(2)], [false, true, false])
    bots.setBot(0, true)
    assert.equal(bots.isBot(0), true)
    const chars = new CharacterSystem({ playerCount: 3 })
    const world = new FiestaWorld<PlayerInput>(R, { playerCount: 3, systems: [bots, chars] })
    world.playerDropped(2)
    assert.equal(bots.isBot(2), true)
  })

  for (const ci of [0, 1]) {
    it(`snapshot/restore keeps identical hashes after 120 ticks (${COURSES[ci].kind})`, () => {
      const a = rig(ci)
      run(a.world, 60)
      const bytes = a.world.takeSnapshotBytes()
      run(a.world, 120)
      const want = a.world.stateHash()

      // The bots must actually drive: someone left the spawn line.
      const chars = a.world.ctx.system<CharacterSystem>('characters')
      const pos = new Float64Array(PLAYERS * 3)
      chars.readPositions(a.world.ctx, pos)
      let moved = false
      for (let p = 0; p < PLAYERS; p++) if (Math.abs(pos[p * 3 + 2] - 1) > 1) moved = true
      assert.ok(moved, 'no bot moved')

      a.world.restoreSnapshotBytes(bytes)
      run(a.world, 120)
      assert.equal(a.world.stateHash(), want, 'same instance')

      const b = rig(ci)
      b.world.restoreSnapshotBytes(bytes)
      run(b.world, 120)
      assert.equal(b.world.stateHash(), want, 'fresh instance')
      a.world.free()
      b.world.free()
    })
  }
})

// Race course with three regions in a chain plus one isolated region, and every motion kind.
function readCourse(): ResolvedCourse {
  const c = course('read-a', 'race')
  c.regions = [
    { id: 0, box: { center: v3(0, 1, 5), half: v3(10, 3, 5) }, adjacent: [1] },
    { id: 1, box: { center: v3(0, 1, 15), half: v3(10, 3, 5) }, adjacent: [0, 2] },
    { id: 2, box: { center: v3(0, 1, 30), half: v3(10, 3, 10) }, adjacent: [1] },
    { id: 7, box: { center: v3(50, 1, 0), half: v3(1, 1, 1) }, adjacent: [] },
  ]
  const h = v3(1, 0.25, 1)
  c.obstacles.push(
    obstacle('pend', v3(0, 2, 12), { kind: 'pendulum', pivot: v3(0, 4, 12), axis: v3(0, 0, 1), amp: 0.9, periodTicks: 90, phase: 0.4 }, h),
    obstacle('door', v3(0, 1, 20), { kind: 'rotatingDoor', axis: v3(0, 1, 0), stepAngle: 1.5707963267948966, periodTicks: 60, moveTicks: 20, phaseTicks: 7 }, h),
    obstacle('plat', v3(0, 0, 25), { kind: 'movingPlatform', offset: v3(3, 0, 0), periodTicks: 80, phase: 1, wave: 'sine' }, h),
    obstacle('ping', v3(0, 0, 28), { kind: 'movingPlatform', offset: v3(0, 2, 0), periodTicks: 50, phase: 0.5, wave: 'pingpong' }, h),
    obstacle('saw', v3(0, 0, 32), { kind: 'seesaw', axis: v3(1, 0, 0), maxAngle: 0.4, spring: 2, damping: 1, inertia: 3 }, h),
    obstacle('belt', v3(0, 0, 34), { kind: 'conveyor', velocity: v3(1, 0, 0) }, h),
  )
  return c
}

function rotated(o: ObstacleSpec, angle: number): Quat {
  const q = { x: 0, y: 0, z: 0, w: 1 }
  quatAxisAngle((o.motion as { axis: Vec3 }).axis, angle, q)
  return quatMul(q, o.r, { x: 0, y: 0, z: 0, w: 1 })
}

function samePose(a: Quat, b: Quat): boolean {
  const s = Math.sign(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z) || 1
  return Math.abs(a.x - s * b.x) < 1e-12 && Math.abs(a.y - s * b.y) < 1e-12 && Math.abs(a.z - s * b.z) < 1e-12 && Math.abs(a.w - s * b.w) < 1e-12
}

describe('course-read', () => {
  it('course-read navigation matches the supplied path, regions and adjacency', () => {
    const c = readCourse()
    const nav = readNavigation(c)
    assert.equal(nav.id, 'read-a')
    assert.deepEqual(nav.path.map(n => [n.index, n.p.z, n.jump, n.dive, n.region]), [
      [0, 4, false, false, 0], [1, 9, true, false, 0], [2, 18, false, false, 1], [3, 30, false, false, 2], [4, 36, false, true, 2],
    ])
    assert.deepEqual(nav.regions.map(r => [r.id, r.adjacent]), [[0, [1]], [1, [0, 2]], [2, [1]], [7, []]])
    assert.deepEqual(nav.finish, c.finish)
    assert.deepEqual(regionNeighbours(c, 1), [0, 2])
    assert.deepEqual(regionNeighbours(c, 99), [])
    assert.deepEqual([regionDistance(c, 0, 0), regionDistance(c, 0, 1), regionDistance(c, 0, 2), regionDistance(c, 0, 7), regionDistance(c, 99, 99)], [0, 1, 2, -1, -1])
    assert.equal(nearestPathIndex(c, v3(1, 0, 17)), 2)
    const mech = readMechanisms(c)
    assert.deepEqual(mech.map(m => [m.id, m.kind, m.kinematic, m.tickDriven, m.periodTicks, m.region]), [
      ['floor', 'static', false, true, null, 1], ['wall', 'static', false, true, null, 0], ['spin', 'spinner', true, true, null, 0],
      ['pend', 'pendulum', true, true, 90, 1], ['door', 'rotatingDoor', true, true, 60, 1], ['plat', 'movingPlatform', true, true, 80, 2],
      ['ping', 'movingPlatform', true, true, 50, 2], ['saw', 'seesaw', true, false, null, 2], ['belt', 'conveyor', false, true, null, 2],
    ])
  })

  it('course-read phases match motion evaluation at boundaries and wrapped ticks', () => {
    const c = readCourse()
    const pose: Pose = { t: v3(0, 0, 0), r: { x: 0, y: 0, z: 0, w: 1 } }
    const ticks = [0, 1, 6, 7, 19, 20, 21, 49, 50, 52, 53, 59, 60, 61, 79, 80, 89, 90, 91, 210, 1000, 54321, -1, -7, -60, -61]
    for (const o of c.obstacles) {
      for (const L of ticks) {
        const ph = obstaclePhase(o, L)
        motionPose(o, L, 0, pose)
        const m = o.motion
        const tag = `${o.id}@${L}`
        if (m.kind === 'spinner' || m.kind === 'pendulum' || m.kind === 'rotatingDoor') {
          assert.ok(samePose(pose.r, rotated(o, ph.value)), tag)
        } else if (m.kind === 'movingPlatform') {
          assert.equal(pose.t.x, o.t.x + m.offset.x * ph.value, tag)
          assert.equal(pose.t.y, o.t.y + m.offset.y * ph.value, tag)
        }
        if (ph.periodTicks !== null) {
          assert.ok(Number.isInteger(ph.cycleTick) && ph.cycleTick! >= 0 && ph.cycleTick! < ph.periodTicks, tag)
          // One full period later the phase repeats (door angle advances by exactly one step).
          const next = obstaclePhase(o, L + ph.periodTicks)
          assert.equal(next.cycleTick, ph.cycleTick, tag)
          assert.equal(next.moving, ph.moving, tag)
        }
      }
    }
    const door = c.obstacles.find(o => o.id === 'door')!
    // tau = L + 7: the door moves for cycle 0..19 and rests for 20..59.
    assert.deepEqual([-7, 12, 13, 52, 53, -8].map(L => [obstaclePhase(door, L).cycleTick, obstaclePhase(door, L).moving]),
      [[0, true], [19, true], [20, false], [59, false], [0, true], [59, false]])
    assert.equal(obstaclePhase(door, 13).value, 1.5707963267948966)
    assert.equal(obstaclePhase(door, -8).value, 0)
    const spin = c.obstacles.find(o => o.id === 'spin')!
    for (const L of [0, 210, 2095, -300]) {
      const v = obstaclePhase(spin, L).value
      assert.ok(v >= 0 && v < 6.283185307179586, `spin@${L}`)
    }
    const pend = c.obstacles.find(o => o.id === 'pend')!
    assert.deepEqual([0, 89, 90, 181, -1].map(L => obstaclePhase(pend, L).cycleTick), [0, 89, 0, 1, 89])
    assert.equal(phaseInWindow(door, 12, 0, 19), true)
    assert.equal(phaseInWindow(door, 13, 0, 19), false)
    assert.equal(phaseInWindow(c.obstacles.find(o => o.id === 'saw')!, 5, 0, 1000), false)
    assert.throws(() => obstaclePhase(door, 1.5), RangeError)
  })

  it('course-read reports capabilities without levers and refuses useLever', () => {
    const c = readCourse()
    const caps = courseCapabilities(c)
    assert.equal(caps.hasLevers, false)
    assert.deepEqual(caps.levers, [])
    assert.deepEqual(caps.actions, ['jump', 'dive', 'grab'])
    assert.deepEqual(caps.motionKinds, ['static', 'spinner', 'pendulum', 'rotatingDoor', 'movingPlatform', 'seesaw', 'conveyor'])
    assert.deepEqual([caps.hasPath, caps.hasRegions, caps.hasFinish], [true, true, true])
    const o = validBehaviour()
    o.rules[0].action = 'useLever'
    assert.throws(() => bindBehaviour(parseBehaviour(o, 'lever.bot.json'), caps), (e: unknown) => isRefusal(e) && e.reason.includes("course 'read-a'"))
  })

  it('course-read repeated reads leave inputs unchanged and return equal values', () => {
    const c = readCourse()
    const before = JSON.stringify(c)
    const reads = () => [
      readNavigation(c), readMechanisms(c), courseCapabilities(c), regionNeighbours(c, 1), regionDistance(c, 0, 2),
      nearestPathIndex(c, v3(0, 0, 10)), c.obstacles.map(o => [0, 37, 61, -5].map(L => obstaclePhase(o, L))),
    ]
    const a = reads()
    const nav = a[0] as ReturnType<typeof readNavigation>
    nav.path[0].p.x = 99
    nav.regions[0].adjacent.push(5)
    ;(a[3] as number[]).push(9)
    ;(a[1] as ReturnType<typeof readMechanisms>)[0].center.y = 42
    assert.equal(JSON.stringify(c), before)
    const b = reads()
    assert.deepEqual(b, reads())
    assert.equal(JSON.stringify(c), before)
  })
})

// Two lanes from region 0 to the finish region 3: a short lane (1) with a pendulum, and a
// longer hazard-free detour (2 then 4).
function branchCourse(): ResolvedCourse {
  const c = course('branch-a', 'race')
  c.regions = [
    { id: 0, box: { center: v3(0, 1, 5), half: v3(10, 3, 5) }, adjacent: [1, 2] },
    { id: 1, box: { center: v3(0, 1, 15), half: v3(2, 3, 5) }, adjacent: [3] },
    { id: 2, box: { center: v3(-12, 1, 12), half: v3(2, 3, 3) }, adjacent: [4] },
    { id: 4, box: { center: v3(-12, 1, 22), half: v3(2, 3, 5) }, adjacent: [3] },
    { id: 3, box: { center: v3(0, 1, 32), half: v3(10, 3, 8) }, adjacent: [] },
  ]
  c.obstacles.push(obstacle('pend', v3(0, 2, 15), { kind: 'pendulum', pivot: v3(0, 4, 15), axis: v3(0, 0, 1), amp: 0.9, periodTicks: 90, phase: 0 }, v3(1, 0.25, 1)))
  return c
}

// Mirror-symmetric lanes 1 and 2 of exactly equal cost.
function tieCourse(): ResolvedCourse {
  const c = course('tie-a', 'race')
  c.regions = [
    { id: 0, box: { center: v3(0, 1, 5), half: v3(10, 3, 5) }, adjacent: [1, 2] },
    { id: 1, box: { center: v3(-5, 1, 15), half: v3(3, 3, 5) }, adjacent: [3] },
    { id: 2, box: { center: v3(5, 1, 15), half: v3(3, 3, 5) }, adjacent: [3] },
    { id: 3, box: { center: v3(0, 1, 30), half: v3(10, 3, 10) }, adjacent: [] },
  ]
  return c
}

const BEHAVIOURS = {
  short: loadBehaviour(SHORT_TEXT, 'short.bot.json'),
  safe: loadBehaviour(SAFE_TEXT, 'safe.bot.json'),
}

function routeInput(c: ResolvedCourse, pref: 'short' | 'safe', pos: Vec3, seed: number, tick: number, startTick = 0): RouteInput {
  return { course: c, behaviour: BEHAVIOURS[pref], pos, seed, tick, startTick }
}

function assertEdgesInAdjacency(c: ResolvedCourse, plan: RoutePlan): void {
  for (const e of plan.edges) {
    const r = c.regions.find(x => x.id === e.from)
    assert.ok(r !== undefined && r.adjacent.includes(e.to), `edge ${e.from}->${e.to}`)
  }
  for (let i = 1; i < plan.regions.length; i++) assert.deepEqual(plan.edges[i - 1], { from: plan.regions[i - 1], to: plan.regions[i] })
}

describe('routes', () => {
  it('routes: short takes the shorter lane and safe the lower-exposure lane', () => {
    const c = branchCourse()
    assert.equal(goalRegion(c), 3)
    assert.deepEqual([...regionExposure(c)], [[0, 1], [1, 1], [2, 0], [4, 0], [3, 0]])
    const short = planRoute(routeInput(c, 'short', v3(0, 0.85, 2), 1, 0))
    const safe = planRoute(routeInput(c, 'safe', v3(0, 0.85, 2), 1, 0))
    assert.deepEqual(short.regions, [0, 1, 3])
    assert.deepEqual(safe.regions, [0, 2, 4, 3])
    assert.deepEqual([short.preference, safe.preference, short.reachable, safe.reachable], ['short', 'safe', true, true])
    // Waypoints follow the course path inside the chosen regions.
    assert.deepEqual(short.waypoints, [0, 1, 2, 3, 4])
    assert.deepEqual(safe.waypoints, [0, 1, 3, 4])
    for (const p of [short, safe]) assertEdgesInAdjacency(c, p)
    assert.equal(cheapestRegions(c, 'short', 1, 3, 0), null)
  })

  it('routes: chosen edges exist in adjacency from every start region', () => {
    for (const c of [branchCourse(), tieCourse(), readCourse()]) {
      for (const r of c.regions) {
        for (const pref of ['short', 'safe'] as const) {
          for (const seed of [1, 2, 3]) {
            const plan = planRoute(routeInput(c, pref, r.box.center, seed, 0))
            assertEdgesInAdjacency(c, plan)
            if (plan.reachable && plan.regions.length > 0) {
              assert.equal(plan.regions[0], r.id)
              assert.equal(plan.regions[plan.regions.length - 1], goalRegion(c))
            }
          }
        }
      }
    }
  })

  it('routes: equal choices resolve from the seed and reproduce exactly', () => {
    const c = tieCourse()
    const picks = new Set<number>()
    for (let seed = 1; seed <= 32; seed++) {
      const a = planRoute(routeInput(c, 'short', v3(0, 0.85, 2), seed, 0))
      assert.deepEqual(planRoute(routeInput(c, 'short', v3(0, 0.85, 2), seed, 0)), a)
      assert.equal(a.regions.length, 3)
      picks.add(a.regions[1])
    }
    assert.deepEqual([...picks].sort(), [1, 2])
  })

  it('routes: disconnected destinations give a safe unreachable plan', () => {
    const c = readCourse()
    const plan = planRoute(routeInput(c, 'safe', v3(50, 1, 0), 9, 0))
    assert.equal(plan.reachable, false)
    assert.deepEqual(plan.regions, [7])
    assert.deepEqual(plan.edges, [])
    assert.ok(plan.waypoints.length > 0 && plan.waypoints.every((w, i) => i === 0 || w === plan.waypoints[i - 1] + 1))
    const flat = course('flat-a', 'race')
    const none = planRoute(routeInput(flat, 'short', v3(0, 0.85, 15), 9, 0))
    assert.deepEqual([none.regions, none.edges, none.waypoints, none.reachable], [[], [], [2, 3, 4], true])
  })

  it('routes: replanning happens only on the configured tick boundaries', () => {
    const c = branchCourse()
    for (const pref of ['short', 'safe'] as const) {
      const step = BEHAVIOURS[pref].tick.decisionTicks
      const start = 10
      let plan: RoutePlan | null = null
      const planned: number[] = []
      for (let tick = start; tick <= start + 5 * step; tick++) {
        const next: RoutePlan = updateRoute(plan, routeInput(c, pref, v3(0, 0.85, 2 + (tick - start) * 0.3), 4, tick, start))
        if (next !== plan) planned.push(tick)
        assert.equal(next.nextPlanTick, start + (Math.floor((tick - start) / step) + 1) * step)
        plan = next
      }
      assert.deepEqual(planned, [0, 1, 2, 3, 4, 5].map(k => start + k * step))
      // A bot without a plan gets one immediately, scheduled for the next boundary.
      const late = updateRoute(null, routeInput(c, pref, v3(0, 0.85, 2), 4, start + 1, start))
      assert.deepEqual([late.planTick, late.nextPlanTick], [start + 1, start + step])
      assert.deepEqual([replanDue(start, step, start - 1), replanDue(start, step, start + step), replanDue(start, step, start + step + 1)], [false, true, false])
    }
    assert.throws(() => planRoute(routeInput(c, 'short', v3(0, 0, 0), 1, 0.5)), RangeError)
  })

  it('routes: identical inputs reproduce identical routes and leave inputs unchanged', () => {
    const c = branchCourse()
    const before = JSON.stringify(c)
    const behaviourBefore = JSON.stringify(BEHAVIOURS.safe)
    const runs = () => [0, 6, 12, 60].map(t => planRoute(routeInput(c, 'safe', v3(-1, 0.85, 3 + t * 0.1), 77, t)))
    const a = runs()
    assert.deepEqual(runs(), a)
    assert.equal(JSON.stringify(c), before)
    assert.equal(JSON.stringify(BEHAVIOURS.safe), behaviourBefore)
  })
})

function timingCase(kind: 'pendulum' | 'spinner' | 'movingPlatform', phase = 0) {
  const c = course('timing', 'race')
  c.path = [node(kind === 'spinner' ? 2 : 0, 10)]
  const motion: Motion = kind === 'spinner' ? { kind, axis: v3(0, 1, 0), radPerTick: 2 * Math.PI / 600, phase }
    : kind === 'pendulum' ? { kind, axis: v3(0, 0, 1), pivot: v3(0, 5, 4), amp: 1.2, periodTicks: 600, phase }
    : { kind, offset: v3(3, 0, 0), periodTicks: 600, wave: 'sine', phase }
  c.obstacles = [obstacle(kind, v3(0, kind === 'movingPlatform' ? -0.25 : 1, 4), motion, v3(kind === 'spinner' ? 4 : 1, 0.25, 0.2))]
  const raw = validBehaviour()
  raw.tick = { decisionTicks: 1, reactionTicks: 0, wobbleTicks: 45, stuckTicks: 30 }
  raw.rules = [{ id: 'window', predicate: 'always', phase: { from: 0, to: 600 }, distance: 10, action: 'grab' }]
  const behaviour = parseBehaviour(raw)
  const input = brainInput(c, v3(kind === 'spinner' ? 2 : 0, 0.85, 3.4), { vel: v3(0, 0, 8) })
  const route = planRoute({ course: c, behaviour, pos: input.pos, tick: 0, seed: 77 })
  const decide = (tick: number) => evaluateBrain(input, behaviour, route, tick)
  const moves = (ticks: number[]) => ticks.map(t => decodeInput(decide(t), neutralInput()).moveZ)
  return { c, raw, behaviour, input, route, decide, moves }
}

describe('brain-timing', () => {
  it('brain-timing: snapshots wait outside and advance inside each motion window', () => {
    assert.deepEqual(timingCase('pendulum').moves([0, 150, 300, 450, 600]), [0, 1, 0, 1, 0])
    assert.deepEqual(timingCase('spinner').moves([0, 150, 300, 450, 600]), [0, 1, 0, 1, 0])
    assert.deepEqual(timingCase('movingPlatform').moves([0, 150, 300, 450, 600]), [1, 0, 1, 0, 1])
  })

  it('brain-timing: phase, distance, approach and crossing all constrain entry', () => {
    const f = timingCase('spinner')
    f.behaviour.rules[0].phase = { from: 140, to: 170 }
    assert.deepEqual(f.moves([130, 140, 160, 168, 170]), [0, 1, 1, 0, 0])
    // From rest it takes longer to clear the same window than at running speed.
    f.input.vel.z = 0
    assert.equal(f.moves([160])[0], 0)
    f.input.vel.z = 8
    f.input.pos.z = 2
    assert.equal(f.moves([130])[0], 1, 'approach travel reaches the opening at tick 141')
    f.input.pos.z = 0
    assert.equal(f.moves([130])[0], 1, 'a remote obstacle must not halt the approach')
    f.input.pos.z = 3.4
    f.input.vel.z = 8
    f.behaviour.rules[0].distance = 0.1
    assert.equal(f.moves([130])[0], 1, 'an out-of-range phase rule does not match')
    assert.equal(f.decide(140) & BTN.GRAB, 0)
  })

  it('brain-timing: unrolled phase windows cross the cycle boundary', () => {
    for (const kind of ['pendulum', 'spinner', 'movingPlatform'] as const) {
      const f = timingCase(kind, kind === 'movingPlatform' ? 0 : Math.PI / 2)
      f.behaviour.rules[0].phase = kind === 'spinner' ? { from: 730, to: 770 } : { from: 580, to: 620 }
      assert.deepEqual(f.moves([570, 590, 600, 610, 620]), [0, 1, 1, 1, 0], kind)
    }
  })

  it('brain-timing: reaction and decision boundaries are integer-tick reproducible', () => {
    const f = timingCase('pendulum', Math.PI / 2)
    f.behaviour.tick.reactionTicks = 4
    f.behaviour.tick.decisionTicks = 6
    f.behaviour.rules[0].phase = { from: 10, to: 40 }
    assert.deepEqual(f.moves([0, 3, 4, 9, 10, 15, 16, 33, 34]), [0, 0, 0, 0, 1, 1, 1, 1, 0])
    assert.throws(() => f.decide(1.5), RangeError)
    assert.throws(() => f.decide(-1), RangeError)
  })

  it('brain-timing: stable rule priority and route targets translate to character inputs', () => {
    const f = timingCase('pendulum')
    f.c.obstacles = []
    f.raw.rules = [{ id: 'jump', predicate: 'nearNode', distance: 10, action: 'jump' }, { id: 'dive', predicate: 'always', action: 'dive' }]
    const behaviour = parseBehaviour(f.raw)
    assert.equal(evaluateBrain(f.input, behaviour, f.route, 0) & (BTN.JUMP | BTN.DIVE), BTN.JUMP)
    assert.equal(evaluateBrain(f.input, behaviour, f.route, 1) & (BTN.JUMP | BTN.DIVE), 0)
    behaviour.rules.reverse()
    assert.equal(evaluateBrain(f.input, behaviour, f.route, 0) & (BTN.JUMP | BTN.DIVE), BTN.DIVE)
    f.c.path.push(node(8, 3.4))
    f.route.waypoints = [1]
    assert.equal(decodeInput(f.decide(0), neutralInput()).moveX, 1)
    f.route.reachable = false
    assert.deepEqual(decodeInput(f.decide(0), neutralInput()), neutralInput())
  })

  it('brain-timing: repeated and reordered evaluations preserve all input snapshots', () => {
    const fixtures = ['pendulum', 'spinner', 'movingPlatform'].map(k => timingCase(k as 'pendulum' | 'spinner' | 'movingPlatform'))
    const before = JSON.stringify(fixtures)
    const ticks = [0, 149, 150, 299, 300, 599, 600]
    const expected = fixtures.map(f => ticks.map(f.decide))
    for (let i = fixtures.length - 1; i >= 0; i--) {
      const f = fixtures[i], mem = newMemory(), rng = new Rng(77), state = rng.state
      for (let j = ticks.length - 1; j >= 0; j--) {
        assert.equal(f.decide(ticks[j]), expected[i][j])
        const b = { ...f.input, bot: { behaviour: f.behaviour, route: f.route, localTick: ticks[j] } }
        assert.equal(raceBrain(b, SKILL, mem, rng), expected[i][j])
        assert.equal(survivalBrain(b, SKILL, mem, rng), expected[i][j])
      }
      assert.deepEqual(mem, newMemory())
      assert.equal(rng.state, state)
    }
    assert.equal(JSON.stringify(fixtures), before)
  })
})

it('brain-timing: moving platforms must align along the route and at foot height', () => {
  const f = timingCase('movingPlatform')
  const motion = f.c.obstacles[0].motion
  assert.equal(motion.kind, 'movingPlatform')
  if (motion.kind !== 'movingPlatform') return
  motion.offset = v3(0, 0, 3)
  assert.deepEqual(f.moves([0, 150, 300]), [1, 0, 0])
  motion.offset = v3(0, 3, 0)
  assert.deepEqual(f.moves([0, 150, 300]), [1, 0, 1])
})

function traversalRules(rules: Json['rules']): ReturnType<typeof parseBehaviour> {
  const raw = validBehaviour()
  raw.tick = { decisionTicks: 1, reactionTicks: 0, wobbleTicks: 45, stuckTicks: 30 }
  raw.rules = rules
  return parseBehaviour(raw)
}

function traversalCase(c: ResolvedCourse, pos: Vec3, over: Partial<BrainInput>, rules: Json['rules']) {
  const behaviour = traversalRules(rules)
  const input = brainInput(c, pos, over)
  const route = planRoute({ course: c, behaviour, pos, tick: 0, seed: 77 })
  return { c, behaviour, input, route, decide: (tick: number) => evaluateBrain(input, behaviour, route, tick) }
}

// Floor split at z=5..7 with a 2 m gap; the route continues on the far slab.
function gapCourse(): ResolvedCourse {
  const c = course('gap-traverse', 'race')
  c.path = [node(0, 3), node(0, 12)]
  c.obstacles = [
    obstacle('floor-a', v3(0, -0.5, 2.5), { kind: 'static' }, v3(10, 0.5, 2.5)),
    obstacle('floor-b', v3(0, -0.5, 9.5), { kind: 'static' }, v3(10, 0.5, 2.5)),
  ]
  return c
}

// Floor up to z=6, then a 1.6 m high slab whose top is the ledge; both path nodes sit on it.
function ledgeCourse(): ResolvedCourse {
  const c = course('ledge-traverse', 'race')
  c.path = [{ p: v3(0, 2.45, 7.5), jump: false, dive: false }, { p: v3(0, 2.45, 9.5), jump: false, dive: false }]
  c.obstacles = [
    obstacle('floor', v3(0, -0.5, 3), { kind: 'static' }, v3(4, 0.5, 3)),
    obstacle('ledge', v3(0, 0.8, 8), { kind: 'static' }, v3(4, 0.8, 2)),
  ]
  return c
}

function seesawCourse(): ResolvedCourse {
  const c = course('seesaw-traverse', 'race')
  c.path = [node(0, 4), node(0, 14)]
  c.obstacles = [
    obstacle('floor', v3(0, -0.5, 10), { kind: 'static' }, v3(10, 0.5, 10)),
    obstacle('saw', v3(0, 0.3, 8), { kind: 'seesaw', axis: v3(1, 0, 0), maxAngle: 0.4, spring: 2, damping: 1, inertia: 3 }, v3(2, 0.2, 1.5)),
  ]
  return c
}

const WAIT_RULE = [{ id: 'wait', predicate: 'stuck', action: 'jump' }]

describe('brain-traversal', () => {
  it('brain-traversal: a gap close ahead is jumped once, and not from afar or mid-air', () => {
    const c = gapCourse()
    const near = traversalCase(c, v3(0, 0.85, 3.5), { vel: v3(0, 0, 8) }, WAIT_RULE)
    assert.notEqual(near.decide(0) & BTN.JUMP, 0)
    assert.equal(near.decide(1) & BTN.JUMP, 0, 'the pulse never retriggers on the next tick')
    assert.notEqual(decodeInput(near.decide(0), neutralInput()).moveZ, 0, 'the bot keeps steering at the far side')
    const far = traversalCase(c, v3(0, 0.85, 1.5), { vel: v3(0, 0, 8) }, WAIT_RULE)
    assert.equal(far.decide(0) & BTN.JUMP, 0, 'a gap beyond jump lead does not trigger')
    const across = traversalCase(c, v3(0, 0.85, 8.5), { vel: v3(0, 0, 8) }, WAIT_RULE)
    assert.equal(across.decide(0) & BTN.JUMP, 0, 'the far slab needs no jump')
    const air = traversalCase(c, v3(0, 1.3, 3.5), { vel: v3(0, 0, 8), grounded: false, mode: 1 }, WAIT_RULE)
    assert.equal(air.decide(0) & BTN.JUMP, 0, 'airborne bots never buffer a jump')
    const waiting = traversalCase(c, v3(0, 0.85, 3.5), { vel: v3(0, 0, 8) },
      [{ id: 'wait', predicate: 'always', phase: { from: 0, to: 90 }, action: 'grab' }])
    assert.notEqual(waiting.decide(0) & BTN.JUMP, 0, 'a waiting grab rule never suppresses the gap jump')
  })

  it('brain-traversal: the near-finish dive aims at the finish and dives only when eligible', () => {
    const c = course('finish-traverse', 'race')
    const rules = [{ id: 'dive-finish', predicate: 'nearFinish', distance: 3, action: 'dive' }]
    const f = traversalCase(c, v3(0, 0.85, 33.5), { vel: v3(0, 0, 7) }, rules)
    assert.notEqual(f.decide(0) & BTN.DIVE, 0)
    assert.equal(f.decide(1) & BTN.DIVE, 0, 'the dive pulse needs a fresh press')
    assert.ok(decodeInput(f.decide(0), neutralInput()).moveZ > 0.9, 'the dive faces the finish centre')
    const recovering = traversalCase(c, v3(0, 0.85, 33.5), { vel: v3(0, 0, 7), mode: 2 }, rules)
    assert.equal(recovering.decide(0) & BTN.DIVE, 0, 'a diving character cannot dive again')
    const afar = traversalCase(c, v3(0, 0.85, 28), { vel: v3(0, 0, 7) }, rules)
    assert.equal(afar.decide(0) & BTN.DIVE, 0, 'the near-finish rule does not match from afar')
  })

  it('brain-traversal: a see-saw is dived across from the ground, not from afar or while diving', () => {
    const c = seesawCourse()
    const near = traversalCase(c, v3(0, 0.85, 5.5), { vel: v3(0, 0, 7) }, WAIT_RULE)
    assert.notEqual(near.decide(0) & BTN.DIVE, 0)
    assert.ok(decodeInput(near.decide(0), neutralInput()).moveZ > 0.9, 'the dive crosses towards the far edge')
    assert.equal(near.decide(1) & BTN.DIVE, 0)
    const far = traversalCase(c, v3(0, 0.85, 1), { vel: v3(0, 0, 7) }, WAIT_RULE)
    assert.equal(far.decide(0) & BTN.DIVE, 0, 'no see-saw within dive distance')
    const diving = traversalCase(c, v3(0, 0.85, 5.5), { vel: v3(0, 0, 7), mode: 2 }, WAIT_RULE)
    assert.equal(diving.decide(0) & BTN.DIVE, 0, 'a diving character does not retrigger')
  })

  it('brain-traversal: a reachable ledge is jumped at, grabbed while hanging, then left behind', () => {
    const c = ledgeCourse()
    const base = traversalCase(c, v3(0, 0.85, 4.5), { vel: v3(0, 0, 6) }, WAIT_RULE)
    assert.notEqual(base.decide(0) & BTN.JUMP, 0, 'the bot jumps at the ledge')
    assert.equal(base.decide(0) & BTN.GRAB, 0, 'it does not grab from the ground')
    const rising = traversalCase(c, v3(0, 1.4, 5.6), { vel: v3(0, 2, 4), grounded: false, mode: 1 }, WAIT_RULE)
    assert.notEqual(rising.decide(0) & BTN.GRAB, 0, 'an airborne bot grabs the ledge it can reach')
    assert.equal(rising.decide(0) & BTN.JUMP, 0)
    const hanging = traversalCase(c, v3(0, 1.9, 5.9), { vel: v3(0, 0, 0), grounded: false, mode: 5 }, WAIT_RULE)
    assert.notEqual(hanging.decide(0) & BTN.GRAB, 0, 'the hang holds grab')
    const up = traversalCase(c, v3(0, 2.45, 8.2), { vel: v3(0, 0, 4) }, WAIT_RULE)
    assert.equal(up.decide(0) & BTN.GRAB, 0, 'on the ledge the grab is released')
    assert.equal(up.decide(0) & BTN.JUMP, 0)
    assert.ok(decodeInput(up.decide(0), neutralInput()).moveZ > 0.9, 'the route continues across the ledge')
  })

  it('brain-traversal: repeated snapshot-and-seed evaluations return equal actions', () => {
    const fixtures = [
      traversalCase(gapCourse(), v3(0, 0.85, 3.5), { vel: v3(0, 0, 8) }, WAIT_RULE),
      traversalCase(course('finish-traverse', 'race'), v3(0, 0.85, 33.5), { vel: v3(0, 0, 7) }, [{ id: 'dive-finish', predicate: 'nearFinish', distance: 3, action: 'dive' }]),
      traversalCase(seesawCourse(), v3(0, 0.85, 5.5), { vel: v3(0, 0, 7) }, WAIT_RULE),
      traversalCase(ledgeCourse(), v3(0, 1.4, 5.6), { vel: v3(0, 2, 4), grounded: false, mode: 1 }, WAIT_RULE),
    ]
    const snapshot = (f: typeof fixtures[number]) => JSON.stringify({ input: f.input, behaviour: f.behaviour, route: f.route })
    const before = fixtures.map(snapshot)
    const ticks = [0, 1, 2, 3]
    const expected = fixtures.map(f => ticks.map(f.decide))
    for (let i = fixtures.length - 1; i >= 0; i--) {
      const saved = JSON.parse(before[i])
      const mem = newMemory()
      const rng = new Rng(91)
      const state = rng.state
      for (let j = ticks.length - 1; j >= 0; j--) {
        assert.equal(evaluateBrain(saved.input, saved.behaviour, saved.route, ticks[j]), expected[i][j])
        const withBot = { ...saved.input, bot: { behaviour: saved.behaviour, route: saved.route, localTick: ticks[j] } }
        assert.equal(raceBrain(withBot, SKILL, mem, rng), expected[i][j])
        assert.equal(survivalBrain(withBot, SKILL, mem, rng), expected[i][j])
      }
      assert.deepEqual(mem, newMemory())
      assert.equal(rng.state, state)
    }
    assert.deepEqual(fixtures.map(snapshot), before)
  })
})
