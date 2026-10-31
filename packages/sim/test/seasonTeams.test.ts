import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { legacyLevel } from '../src/course.ts'
import type { SpawnPoint } from '../src/course.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { RefusalError } from '../src/refusal.ts'
import { rankRound, seedOrder } from '../src/season/qualify.ts'
import type { SeatRecord } from '../src/season/qualify.ts'
import { respawnSlot } from '../src/season/respawn.ts'
import { homeSpawn, splitTeams, teamTie } from '../src/season/teams.ts'

const point = (x = 0): SpawnPoint => ({ t: { x, y: 2, z: 3 }, facing: { x: 0, z: 1 } })

describe('splitTeams', () => {
  it('assigns equal halves in seed order, indexed by input position', () => {
    const seats = Array.from({ length: 60 }, (_, i) => 59 - i)
    const teams = splitTeams(seats, 19, 3)
    assert.equal(teams.filter(team => team === 0).length, 30)
    assert.equal(teams.filter(team => team === 1).length, 30)
    const sorted = [...seats].sort((a, b) => seedOrder(19, 3, a) - seedOrder(19, 3, b) || a - b)
    for (const [i, seat] of sorted.entries()) assert.equal(teams[seats.indexOf(seat)], i < 30 ? 0 : 1)
    assert.deepEqual(splitTeams(seats, 19, 3), teams)
    assert.notDeepEqual(splitTeams(seats, 19, 4), teams)
  })

  it('refuses zero and odd counts with a fix', () => {
    for (const seats of [[], [2], [1, 2, 3]]) {
      assert.throws(() => splitTeams(seats, 0, 0), (error: unknown) =>
        error instanceof RefusalError && error.area === 'teams' && error.path === 'seats' &&
        error.reason.includes('even'))
    }
  })
})

describe('teamTie', () => {
  it('prioritizes score, overtime leader, opening sum, and seed in order', () => {
    assert.equal(teamTie([2, 3], 0, [1, 99], 0, 0), 1)
    assert.equal(teamTie([3, 3], 0, [99, 1], 0, 0), 0)
    assert.equal(teamTie([3, 3], -1, [5, 7], 0, 0), 0)
    assert.equal(teamTie([3, 3], -1, [5, 5], 0, 0), 1)
    assert.equal(teamTie([3, 3], -1, [5, 5], 1, 0), 0)
  })

  it('agrees with rankRound on the same teams and scores', () => {
    const seat = (id: number, team: number, openingRank: number): SeatRecord => ({
      seat: id, team, openingRank, status: PlayerStatus.alive, finishTick: -1, finishSub: 0,
      lap: 0, stage: 0, routeMm: 0, falls: 0, score: 0, lastScoreTick: 0,
      holdTicks: 0, possessing: false, lastAcquireTick: 0, matches: 0,
      crossTicks: 0, outTick: -1, outSub: 0,
    })
    const records = [seat(8, 0, 3), seat(2, 0, 4), seat(7, 1, 1), seat(1, 1, 9)]
    const scores = [7, 7]
    const ranking = rankRound('team', null, records, 0, 0, scores)
    assert.ok(Array.isArray(ranking))
    assert.equal(teamTie(scores, -1, [7, 10], 0, 0), records.find(r => r.seat === ranking[0])!.team)
  })
})

describe('homeSpawn', () => {
  it('cycles home anchors and advances the spread slot after each cycle', () => {
    const level = legacyLevel({ kind: 'race', timeLimitS: 60, checkpoints: [] })
    level.respawn = { mode: 'home', waitTicks: 0, protectTicks: 0, slots: 12, spacingM: 2 }
    const anchors = [point(10), point(20), point(30)]
    level.homes = [{ team: 1, box: { center: { x: 0, y: 0, z: 0 }, half: { x: 1, y: 1, z: 1 } }, respawn: anchors }]
    for (let k = 0; k < 7; k++) {
      const out = point()
      assert.equal(homeSpawn(level, 1, k, out), out)
      assert.deepEqual(out, respawnSlot(anchors[k % anchors.length], Math.floor(k / anchors.length), level.respawn, point()))
    }
    assert.notDeepEqual(homeSpawn(level, 1, 0, point()), homeSpawn(level, 1, 3, point()))
    assert.throws(() => homeSpawn(level, 0, 0, point()), (error: unknown) =>
      error instanceof RefusalError && error.area === 'teams' && error.reason.includes('add a home for team 0'))
  })
})
