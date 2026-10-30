import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ObstacleSpec, PathNode, ResolvedCourse } from '../src/course.ts'
import { matchLogJson } from '../src/match/log.ts'
import { createMatchSim, Phase } from '../src/match/matchSim.ts'
import type { MatchViewState } from '../src/match/matchSim.ts'
import { runMatchOffline } from '../src/match/offline.ts'
import type { OfflineResult } from '../src/match/offline.ts'
import type { MatchSetup } from '../src/match/setup.ts'
import { isRefusal } from '../src/refusal.ts'
import { emptyMechanisms, isMechanismView } from '../src/mechanismSpec.ts'
import type { BodySpec, JointSpec, MechEvent, MechItem } from '../src/mechanismSpec.ts'
import { pose, v3 } from '../src/vec.ts'
import type { Vec3 } from '../src/vec.ts'
import { neutralInput } from '../src/input.ts'

const ID = { x: 0, y: 0, z: 0, w: 1 }
const FWD = { x: 0, z: 1 }

function floor(t: Vec3, half: Vec3): ObstacleSpec {
  return { id: 'floor', asset: 'floor', t, r: ID, s: v3(1, 1, 1), friction: 0.5, motion: { kind: 'static' }, colliders: [{ shape: 'cuboid', half, t: v3(0, 0, 0), r: ID }] }
}

function node(x: number, z: number, dive = false): PathNode {
  return { p: v3(x, 0, z), jump: false, dive }
}

function spawns(): ResolvedCourse['spawns'] {
  const out = []
  for (let i = 0; i < 8; i++) out.push({ t: v3(-3.5 + i, 0, 1), facing: FWD })
  return out
}

// Flat race: finish 10 m ahead of the spawn line.
const RACE: ResolvedCourse = {
  id: 'race-flat', name: 'race-flat', kind: 'race', profiles: ['standard', 'sprint'], timeLimitS: 60, killPlaneY: -10,
  spawns: spawns(),
  checkpoints: [{ box: { center: v3(0, 1, 6), half: v3(10, 3, 1) }, respawn: { t: v3(0, 0, 6), facing: FWD } }],
  finish: { center: v3(0, 1, 11), half: v3(10, 3, 1) },
  path: [node(0, 6), node(0, 11, true)],
  regions: [], queuePad: null, contentHash: 1,
  obstacles: [floor(v3(0, -0.5, 8), v3(10, 0.5, 10))],
}

// Flat survival arena; the kill plane is far below so rounds end on the cap.
const SURVIVAL: ResolvedCourse = {
  id: 'surv-flat', name: 'surv-flat', kind: 'survival', profiles: ['standard', 'sprint'], timeLimitS: 60, killPlaneY: -30,
  spawns: spawns(),
  checkpoints: [],
  finish: null,
  path: [node(-3, 3), node(3, 3), node(0, 6)],
  regions: [], queuePad: null, contentHash: 2,
  obstacles: [floor(v3(0, -0.5, 4), v3(10, 0.5, 10))],
}

const R: RapierModule = await initRapier()
const SETUP: MatchSetup = { seed: 1234, playerCount: 4, humans: [false, false, false, false], profile: 'sprint', courses: [RACE, SURVIVAL] }

let plainCache: OfflineResult | null = null
function plain(): OfflineResult {
  if (plainCache === null) plainCache = runMatchOffline(R, SETUP)
  return plainCache
}

describe('MatchSim', () => {
  it('a 4-bot sprint match reaches done with one winner and a podium', () => {
    const res = plain()
    const log = res.log
    assert.ok(log.winner >= 0 && log.winner < 4, `winner ${log.winner}`)
    assert.ok(log.podium.length >= 1 && log.podium.length <= 3, `podium ${log.podium}`)
    assert.equal(log.podium[0], log.winner)
    assert.equal(new Set(log.podium).size, log.podium.length)
    assert.equal(log.finalTick, res.ticks)
    assert.equal(res.rollbacks, 0)
    const last = log.rounds[log.rounds.length - 1]
    assert.deepEqual(last.qualified, [log.winner])
  })

  it('the log has a race round and the final', () => {
    const rounds = plain().log.rounds
    assert.ok(rounds.some((r) => r.kind === 'race' && !r.final && r.course === 'race-flat'))
    const last = rounds[rounds.length - 1]
    assert.equal(last.final, true)
    assert.equal(last.kind, 'survival')
    assert.equal(rounds.filter((r) => r.final).length, 1)
  })

  it('two runs give identical log JSON and finalHash', () => {
    const a = plain()
    const b = runMatchOffline(R, SETUP)
    assert.equal(matchLogJson(b.log), matchLogJson(a.log))
    assert.equal(b.finalHash, a.finalHash)
    assert.equal(b.log.finalHash, a.log.finalHash)
  })

  it('forced rollbacks into the same and fresh instances match the plain run (QB1)', () => {
    const a = plain()
    const cases = [{ every: 37, back: 9, fresh: false }, { every: 113, back: 15, fresh: true }]
    for (let i = 0; i < cases.length; i++) {
      const fr = cases[i]
      const b = runMatchOffline(R, SETUP, { forcedRollback: fr })
      assert.ok(b.rollbacks > 0, `no rollback ran for ${JSON.stringify(fr)}`)
      assert.equal(matchLogJson(b.log), matchLogJson(a.log), JSON.stringify(fr))
      assert.equal(b.finalHash, a.finalHash, JSON.stringify(fr))
      assert.equal(b.ticks, a.ticks)
    }
  })

  it('refuses when maxTicks is exceeded', () => {
    assert.throws(() => runMatchOffline(R, SETUP, { maxTicks: 10 }), (e: unknown) => isRefusal(e) && e.message.includes('match did not finish in 10 ticks'))
  })

  it('phase() starts in round 0 intro and ends in done', () => {
    const sim = createMatchSim(R, SETUP)
    try {
      const view: MatchViewState = {
        tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: 0, roundKind: null, final: false, courseIndex: 0,
        roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
      }
      const inputs = [neutralInput(), neutralInput(), neutralInput(), neutralInput()]
      sim.step(inputs)
      sim.phase(view)
      assert.equal(view.phase, Phase.intro)
      assert.equal(view.roundIndex, 0)
      assert.equal(view.roundKind, 'race')
      while (!sim.done) sim.step(inputs)
      sim.phase(view)
      assert.equal(view.phase, Phase.done)
      assert.equal(view.winner, plain().log.winner)
      assert.deepEqual(view.podium, plain().log.podium)
    } finally {
      sim.free()
    }
  })
})

// Inline sim-only lab: no dependency on the game's asset or course loaders.
function mechanismRace(): ResolvedCourse {
  const m = emptyMechanisms()
  function item(id: string, type: BodySpec['type'], t: Vec3, half: Vec3): MechItem {
    return { id, asset: id, t, r: ID, s: v3(1, 1, 1), joints: [], bodies: [{
      id: 'body', type, rest: pose(), density: 100, friction: 0.6, restitution: 0,
      linearDamping: 0.1, angularDamping: 0.2, gravityScale: 1, ccd: false, surface: 'normal',
      colliders: [{ shape: 'cuboid', half, t: v3(0, 0, 0), r: ID }],
    }] }
  }
  m.items = [
    item('crane', 'kinematic', v3(-6, 3, 6), v3(2, 0.2, 0.2)),
    item('door', 'dynamic', v3(6, 1.5, 8), v3(1, 1.5, 0.15)),
    item('lever', 'dynamic', v3(5, 1, 2), v3(0.1, 0.5, 0.1)),
    item('piston', 'kinematic', v3(-6, 0.5, 9), v3(1, 0.3, 1)),
    item('plate', 'fixed', v3(0, 0.1, 1), v3(4.5, 0.1, 1)),
    item('seesaw', 'dynamic', v3(0, 0.3, 5), v3(4.5, 0.2, 1.5)),
    item('spring', 'dynamic', v3(6, 1, 5), v3(1, 0.2, 1)),
  ]
  function joint(id: string, kind: JointSpec['kind'], itemIndex: number, overrides: Partial<JointSpec> = {}): JointSpec {
    return { id, kind, a: { item: -1, body: -1 }, b: { item: itemIndex, body: 0 },
      anchorA: m.items[itemIndex].t, anchorB: v3(0, 0, 0), axis: v3(1, 0, 0),
      limits: null, stiffness: 0, damping: 0, length: 0, motor: null, ...overrides }
  }
  m.joints = [
    joint('door-hinge', 'hinge', 1, { axis: v3(0, 1, 0), limits: [0, 1.5] }),
    joint('lever-hinge', 'hinge', 2, { limits: [-0.7, 0.7], motor: {
      mode: 'target', speed: 0, target: 0.6, stiffness: 4000, damping: 400, maxForce: 2000, enabled: true,
    } }),
    joint('seesaw-hinge', 'hinge', 5, { limits: [-0.3, 0.3] }),
    joint('spring-guide', 'slider', 6, { axis: v3(0, 1, 0), limits: [-0.5, 0.5] }),
    joint('spring-joint', 'spring', 6, { anchorA: v3(6, 3, 5), length: 2, stiffness: 2000, damping: 100 }),
  ]
  m.switches = [{ id: 'plate', plate: { item: 4, body: 0 }, mode: 'weight',
    onKg: 50, offKg: 30, joint: -1, onM: 0, offM: 0 }]
  m.levers = [{ id: 'lever', handle: { item: 2, body: 0 }, joint: 1,
    onAngle: 0.4, offAngle: -0.2, grabRange: 1 }]
  m.logic = [
    { id: 'timer', op: 'timer', inputs: [0], ticks: 90, count: 0 },
    { id: 'toggle', op: 'toggle', inputs: [1], ticks: 0, count: 0 },
  ]
  m.signals = ['plate', 'lever', 'timer', 'toggle']
  m.animations = [
    { id: 'crane-loop', target: { item: 0, body: 0 }, easing: 'linear', loop: 'loop', autostart: true,
      keys: [{ tick: 0, t: v3(0, 0, 0), r: ID }, { tick: 120, t: v3(0, 1, 0), r: ID },
        { tick: 240, t: v3(0, 0, 0), r: ID }] },
    { id: 'piston-track', target: { item: 3, body: 0 }, easing: 'smooth', loop: 'pingpong', autostart: false,
      keys: [{ tick: 0, t: v3(0, 0, 0), r: ID }, { tick: 60, t: v3(0, 2, 0), r: ID }] },
  ]
  m.links = [
    { id: 'door-link', from: 2, to: { kind: 'door', joint: 0, openAngle: 1.2, closedAngle: 0 } },
    { id: 'piston-link', from: 3, to: { kind: 'animation', animation: 1, on: 'play', off: 'pause' } },
  ]
  return { ...RACE, id: 'mech-lab-inline', name: 'Inline mechanism lab', contentHash: 3, timeLimitS: 8,
    spawns: spawns().map(s => ({ ...s, t: v3(s.t.x, 0.3, s.t.z) })), mechanisms: m }
}

function mechanismSetup(): MatchSetup {
  return { ...SETUP, courses: [mechanismRace(), { ...SURVIVAL, timeLimitS: 2 }] }
}

it('mechanism sprint outcomes survive same-instance and fresh-instance forced rollbacks', () => {
  const setup = mechanismSetup()
  const plain = runMatchOffline(R, setup)
  assert.ok(plain.log.rounds.some(r => r.course === 'mech-lab-inline'))
  assert.ok(plain.log.rounds.some(r => r.kind === 'survival'))
  // Owner rule: compare observable outcomes, without adding hash-based proofs.
  const outcome = ({ finalHash: _hash, setupHash: _setupHash, ...log }: OfflineResult['log']) => log
  for (const forcedRollback of [{ every: 37, back: 9, fresh: false }, { every: 113, back: 15, fresh: true }]) {
    const replay = runMatchOffline(R, setup, { forcedRollback })
    assert.ok(replay.rollbacks > 0)
    assert.deepEqual(outcome(replay.log), outcome(plain.log))
    assert.equal(replay.ticks, plain.ticks)
  }
})

it('MatchSim exposes live mechanism poses, signals and events and clears them on course change', () => {
  const setup = mechanismSetup()
  const sim = createMatchSim(R, setup)
  const inputs = setup.humans.map(() => neutralInput())
  try {
    assert.equal(isMechanismView(sim), true)
    assert.equal(sim.signal('nope'), false)
    assert.equal(sim.mechanismItemCount(), 0)
    assert.equal(sim.mechanismBodyPose({ item: 0, body: 0 }, pose()), false)
    sim.step(inputs)
    assert.equal(sim.mechanismItemCount(), 7)
    assert.equal(sim.mechanismItem(0), setup.courses[0].mechanisms!.items[0])
    assert.equal(sim.mechanismBodyPose({ item: 0, body: 0 }, pose()), true)
    const start = sim.world.takeSnapshotBytes()
    const advance = () => {
      const frames = []
      for (let tick = 0; tick < 90; tick++) {
        sim.step(inputs)
        const poses = Array.from({ length: sim.mechanismItemCount() }, (_, item) => {
          const out = pose()
          assert.equal(sim.mechanismBodyPose({ item, body: 0 }, out), true)
          return out
        })
        const events: MechEvent[] = []
        assert.equal(sim.mechanismEvents(0, events), events.length)
        frames.push({ poses, events, signals: ['plate', 'lever', 'timer', 'toggle'].map(id => sim.signal(id)) })
      }
      return frames
    }
    const frames = advance()
    assert.ok(frames.some(f => f.signals[0]), 'players load the plate')
    assert.ok(frames.some(f => f.signals[2]), 'plate activates the timer')
    assert.ok(frames.some(f => f.signals[3]), 'lever activates the toggle')
    assert.ok(frames.some(f => f.events.some(e => e.kind === 'animStart')), 'toggle starts the piston')
    assert.notDeepEqual(frames[0].poses[0], frames[89].poses[0], 'crane tick track moves')
    sim.world.restoreSnapshotBytes(start)
    sim.beginResim()
    try { assert.deepEqual(advance(), frames) } finally { sim.endResim() }
    while (sim.course()?.kind === 'race' && !sim.done) sim.step(inputs)
    assert.equal(sim.course()?.kind, 'survival')
    assert.equal(sim.mechanismItemCount(), 0)
    assert.equal(sim.mechanismBodyPose({ item: 0, body: 0 }, pose()), false)
    assert.equal(sim.signal('toggle'), false)
    const events: MechEvent[] = []
    assert.equal(sim.mechanismEvents(0, events), 0)
  } finally { sim.free() }
})
