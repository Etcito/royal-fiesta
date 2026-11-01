import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_PLAN, nextTarget } from '@royal-fiesta/sim/season/plan'
import { runRound } from '../src/roundRun.ts'

const CPUS = Math.max(1, Math.floor(Number(process.env.NMC_CPUS ?? 1)) || 1)
const SEATS = 8
const TARGET = nextTarget(SEATS, DEFAULT_PLAN[0], DEFAULT_PLAN[1])
const COURSES = ['test-flat-race', 'test-flat-survival'] as const

describe('roundRun', { concurrency: CPUS }, () => {
  for (const course of COURSES) {
    it(`${course}: 8 sprint seats play one round inside the quota`, { timeout: 300_000 }, async () => {
      const report = await runRound({
        course, dir: 'fixtures/test-courses', seats: SEATS, peers: 2, profile: 'sprint',
      })
      assert.equal(report.ok, true, report.problems.join('\n'))
      assert.equal(report.rounds.length, 1)
      const round = report.rounds[0]
      if (round.kind === 'race') {
        assert.equal(round.qualified.length, TARGET, `race qualified ${round.qualified.length} of ${TARGET}`)
      } else {
        assert.equal(round.kind, 'survival')
        assert.ok(round.qualified.length >= 1, `survival qualified ${round.qualified.length}`)
        assert.ok(round.qualified.length <= TARGET || round.reason === 'overtime',
          `survival qualified ${round.qualified.length} of ${TARGET} with reason ${round.reason}`)
      }
      assert.ok(report.champion >= 0, `champion ${report.champion}`)
    })
  }

  it('a standalone probe plays a map scheduled for later show stages', { timeout: 300_000 }, async () => {
    // G is an R2-R4 race, so the probe's first slot (R1) has to use the map's own stage.
    const report = await runRound({
      course: 's1-g-cloudstack-tower', dir: 'courses', seats: SEATS, peers: 2, profile: 'sprint',
    })
    assert.equal(report.ok, true, report.problems.join('\n'))
    assert.equal(report.rounds.length, 1)
    assert.equal(report.rounds[0].kind, 'race')
    assert.equal(report.rounds[0].qualified.length, TARGET)
    assert.ok(report.champion >= 0, `champion ${report.champion}`)
  })

  it('a final that ties into a playoff plays the playoff and crowns its winner', { timeout: 300_000 }, async () => {
    // Seed 1: two bots grab the crown on the same tick, so the first round settles as a playoff.
    const report = await runRound({
      course: 's1-q-crown-confection', dir: 'courses', seats: 12, peers: 2, profile: 'season', target: 1,
    })
    assert.equal(report.ok, true, report.problems.join('\n'))
    assert.equal(report.rounds.length, 2)
    const [tie, playoff] = report.rounds
    assert.equal(tie.kind, 'final')
    assert.equal(tie.reason, 'playoff')
    assert.equal(tie.qualified.length, 0)
    assert.equal(playoff.playoff, true)
    assert.notEqual(playoff.reason, 'playoff')
    assert.deepEqual(playoff.qualified, [playoff.champion])
    assert.equal(report.champion, playoff.champion)
    assert.ok(tie.ranking.includes(report.champion) && !tie.eliminated.includes(report.champion))
  })
})
