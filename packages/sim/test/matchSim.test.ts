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
import { v3 } from '../src/vec.ts'
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
