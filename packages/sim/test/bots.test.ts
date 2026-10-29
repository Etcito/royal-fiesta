import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Rng } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { BEHAVIOUR_FORMAT, BEHAVIOUR_VERSION, bindBehaviour, loadBehaviour, parseBehaviour } from '../src/bots/behaviour.ts'
import { newMemory, raceBrain, rollSkill, survivalBrain } from '../src/bots/brain.ts'
import type { BotSkill, BrainInput } from '../src/bots/brain.ts'
import { BotSystem } from '../src/bots/botSystem.ts'
import { CharacterSystem } from '../src/character/system.ts'
import type { CourseKind, Motion, ObstacleSpec, PathNode, ResolvedCourse } from '../src/course.ts'
import { BTN, neutralInput } from '../src/input.ts'
import type { PlayerInput } from '../src/input.ts'
import { RoundSystem } from '../src/match/roundSystem.ts'
import { planRound } from '../src/match/rules.ts'
import type { MatchSetup } from '../src/match/setup.ts'
import { ObstacleSystem } from '../src/obstacles/system.ts'
import { isRefusal } from '../src/refusal.ts'
import { v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'
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
