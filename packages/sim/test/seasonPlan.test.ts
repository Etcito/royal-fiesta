import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CUT_TARGET, DEFAULT_PLAN, FINAL_MAX, FINAL_MIN, LONG_PLAN,
  advanceCursor, newCursor, nextSlot, nextTarget, stageOf,
} from '../src/season/plan.ts'
import type { ShowCursor } from '../src/season/plan.ts'
import { roundPoints } from '../src/season/points.ts'

function cursor(step: number, alive: number, teamRounds = 0): ShowCursor {
  return { plan: DEFAULT_PLAN, step, alive, teamRounds, roundIndex: step }
}

describe('season plan constants', () => {
  it('exposes the S14 plans and final bounds', () => {
    assert.deepEqual(DEFAULT_PLAN, [60, 40, 24, 12, 6, 1])
    assert.deepEqual(LONG_PLAN, [60, 48, 36, 24, 12, 6, 1])
    assert.equal(FINAL_MIN, 2)
    assert.equal(FINAL_MAX, 12)
    assert.equal(CUT_TARGET, 12)
  })
})

describe('nextTarget', () => {
  it('scales the nominal cut and clamps it', () => {
    assert.equal(nextTarget(60, 60, 40), 40)
    assert.equal(nextTarget(40, 40, 24), 24)
    assert.equal(nextTarget(60, 60, 48), 48)
    assert.equal(nextTarget(26, 24, 12), 13)
    assert.equal(nextTarget(13, 12, 6), 7)
    assert.equal(nextTarget(10, 12, 6), 5)
    assert.equal(nextTarget(6, 6, 1), 1)
    assert.equal(nextTarget(1, 6, 1), 1)
  })
})

describe('nextSlot and advanceCursor', () => {
  it('walks the default 60 -> 40 -> 24 -> 12 -> 6 -> 1 chain', () => {
    const expected = [
      { target: 40, stage: 'R1', final: false },
      { target: 24, stage: 'R2', final: false },
      { target: 12, stage: 'R3', final: false },
      { target: 6, stage: 'R4', final: false },
      { target: 1, stage: 'final', final: true },
    ]
    let c = newCursor(DEFAULT_PLAN, 60)
    for (const step of expected) {
      const slot = nextSlot(c)
      assert.ok(slot !== null)
      assert.equal(slot.target, step.target)
      assert.equal(slot.stage, step.stage)
      assert.equal(slot.final, step.final)
      assert.equal(slot.playoff, false)
      c = advanceCursor(c, slot, step.final ? 1 : step.target, false)
    }
    assert.equal(c.alive, 1)
    assert.equal(c.roundIndex, 5)
    assert.equal(nextSlot(c), null)
  })

  it('marks the 24 -> 12 slot as team-allowed', () => {
    const slot = nextSlot(cursor(2, 24))
    assert.ok(slot !== null)
    assert.equal(slot.target, 12)
    assert.equal(slot.teamAllowed, true)
  })

  it('maps long plan steps to R1 R1 R2 R3 R4 final', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].map((step) => stageOf(LONG_PLAN, step)),
      ['R1', 'R1', 'R2', 'R3', 'R4', 'final'],
    )
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((step) => stageOf(DEFAULT_PLAN, step)),
      ['R1', 'R2', 'R3', 'R4', 'final'],
    )
    let c = newCursor(LONG_PLAN, 60)
    const seen: string[] = []
    const targets: number[] = []
    while (true) {
      const slot = nextSlot(c)
      if (slot === null) break
      seen.push(slot.stage)
      targets.push(slot.target)
      c = advanceCursor(c, slot, slot.final ? 1 : slot.target, false)
    }
    assert.deepEqual(seen, ['R1', 'R1', 'R2', 'R3', 'R4', 'final'])
    assert.deepEqual(targets, [48, 36, 24, 12, 6, 1])
  })

  it('recomputes adaptive heads from the README examples', () => {
    let c = newCursor(DEFAULT_PLAN, 60)
    c = advanceCursor(c, nextSlot(c)!, 40, false)
    c = advanceCursor(c, nextSlot(c)!, 26, false)
    assert.equal(c.step, 2)
    assert.equal(c.alive, 26)
    const first = nextSlot(c)
    assert.ok(first !== null)
    assert.equal(first.target, 13)
    assert.equal(first.stage, 'R3')
    c = advanceCursor(c, first, 13, false)
    const second = nextSlot(c)
    assert.ok(second !== null)
    assert.equal(second.target, 7)
    assert.equal(second.stage, 'R4')

    c = newCursor(DEFAULT_PLAN, 60)
    c = advanceCursor(c, nextSlot(c)!, 40, false)
    c = advanceCursor(c, nextSlot(c)!, 24, false)
    c = advanceCursor(c, nextSlot(c)!, 10, false)
    assert.equal(c.step, 3)
    const fifth = nextSlot(c)
    assert.ok(fifth !== null)
    assert.equal(fifth.target, 5)
    assert.equal(fifth.stage, 'R4')
  })

  it('forbids a team slot for an odd head count or a second team round', () => {
    const odd = nextSlot(cursor(2, 25))
    assert.ok(odd !== null)
    assert.equal(odd.target, 13)
    assert.equal(odd.teamAllowed, false)

    const c = cursor(2, 24)
    const first = nextSlot(c)
    assert.ok(first !== null)
    assert.equal(first.teamAllowed, true)
    const afterTeam = advanceCursor(c, first, 12, true)
    assert.equal(afterTeam.teamRounds, 1)
    const second = nextSlot(afterTeam)
    assert.ok(second !== null)
    assert.equal(second.target, 6)
    assert.equal(second.teamAllowed, false)
  })

  it('inserts one cut to 12 before the final when 14 remain', () => {
    const c = cursor(4, 14)
    const cut = nextSlot(c)
    assert.ok(cut !== null)
    assert.equal(cut.stage, 'cut')
    assert.equal(cut.target, CUT_TARGET)
    assert.equal(cut.final, false)
    const afterCut = advanceCursor(c, cut, 12, false)
    assert.equal(afterCut.step, 4)
    assert.equal(afterCut.alive, 12)
    assert.equal(afterCut.roundIndex, c.roundIndex + 1)
    const final = nextSlot(afterCut)
    assert.ok(final !== null)
    assert.equal(final.stage, 'final')
    assert.equal(final.target, 1)
    assert.equal(final.final, true)
  })

  it('crowns a lone survivor immediately', () => {
    assert.equal(nextSlot(newCursor(DEFAULT_PLAN, 1)), null)
    assert.equal(nextSlot(newCursor(DEFAULT_PLAN, 0)), null)
  })
})

describe('roundPoints', () => {
  it('awards qualified seats by rank and nothing to eliminated seats', () => {
    assert.equal(roundPoints(1, 24, true), 24)
    assert.equal(roundPoints(12, 24, true), 13)
    assert.equal(roundPoints(24, 24, true), 1)
    assert.equal(roundPoints(1, 24, false), 0)
    assert.equal(roundPoints(24, 24, false), 0)
    assert.equal(roundPoints(1, 6, true), 6)
  })
})
