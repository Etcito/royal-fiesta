import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { RefusalError } from '../src/refusal.ts'
import { ROUND_KINDS } from '../src/season/kinds.ts'
import type { FinalRule, RoundKind } from '../src/season/kinds.ts'
import { rankRound, resolveRound, seedOrder } from '../src/season/qualify.ts'
import type { SeatRecord } from '../src/season/qualify.ts'

function seat(id: number, fields: Partial<SeatRecord> = {}): SeatRecord {
  return {
    seat: id, status: PlayerStatus.alive, finishTick: -1, finishSub: 0,
    lap: 0, stage: 0, routeMm: 0, falls: 0, score: 0, lastScoreTick: 0,
    holdTicks: 0, possessing: false, lastAcquireTick: 0, matches: 0,
    crossTicks: 0, outTick: -1, outSub: 0, team: 0, openingRank: 1,
    ...fields,
  }
}

interface Context {
  finalRule?: FinalRule | null
  target?: number
  teamScores?: readonly number[]
  seed?: number
  roundIndex?: number
}

// Every fixture checks resolution against the independently specified ranking.
// Repeat with reversed input and frozen data to catch index and mutation errors.
function check(
  kind: RoundKind, records: readonly SeatRecord[], expected: number[], context: Context = {},
) {
  const { finalRule = null, target = 1, teamScores, seed = 0, roundIndex = 0 } = context
  let result: ReturnType<typeof resolveRound> | undefined
  for (const order of [records, [...records].reverse()]) {
    const input = Object.freeze(order.map(r => Object.freeze({ ...r })))
    const scores = teamScores === undefined ? undefined : Object.freeze([...teamScores])
    const ranking = rankRound(kind, finalRule, input, seed, roundIndex, scores)
    assert.deepEqual(ranking, expected)
    const outcome = resolveRound(kind, finalRule, target, input, scores ?? [], seed, roundIndex)
    assert.deepEqual(outcome.ranking, expected)
    if (outcome.qualified.length) assert.equal(outcome.qualified[0], expected[0])
    if (outcome.champion !== -1) assert.equal(outcome.champion, expected[0])
    if (kind === 'team') {
      const winner = records.find(r => r.seat === expected[0])!.team
      assert.equal(outcome.teamWinner, winner)
      assert.deepEqual(outcome.qualified, expected.filter(id => records.find(r => r.seat === id)!.team === winner))
    } else {
      assert.equal(outcome.teamWinner, -1)
    }
    const retained = [...outcome.qualified, ...(outcome.playoff ?? [])]
    assert.equal(new Set(retained).size, retained.length)
    assert.deepEqual(outcome.eliminated, expected.filter(id => !retained.includes(id)))
    if (result) assert.deepEqual(outcome, result)
    result = outcome
  }
  return result!
}

interface TieCase {
  name: string
  best: Partial<SeatRecord>
  other: Partial<SeatRecord>
}

// At (seed=0, roundIndex=0), seat 9 precedes 42 in seed order. Each
// non-seed rule must therefore overcome both seed order and conflicting fields.
const raceCases: TieCase[] = [
  { name: 'finishers precede all progress-fill seats',
    best: { finishTick: 9000 }, other: { lap: 9, stage: 9 } },
  { name: 'earlier finish tick precedes finish sub-tick',
    best: { finishTick: 100, finishSub: 65535 }, other: { finishTick: 101, finishSub: 0 } },
  { name: 'earlier finish sub-tick breaks a tick tie',
    best: { finishTick: 100, finishSub: 12, falls: 9 }, other: { finishTick: 100, finishSub: 13 } },
  { name: 'higher lap precedes stage, distance and falls',
    best: { lap: 2, stage: 0, routeMm: 9000, falls: 9 }, other: { lap: 1, stage: 9 } },
  { name: 'higher stage precedes distance and falls',
    best: { stage: 2, routeMm: 9000, falls: 9 }, other: { stage: 1 } },
  { name: 'shorter distance to the next gate precedes falls',
    best: { routeMm: 10, falls: 9 }, other: { routeMm: 11 } },
  { name: 'fewer falls breaks a progress tie',
    best: { falls: 1 }, other: { falls: 2 } },
]

const exitCases: TieCase[] = [
  { name: 'a survivor precedes an exited seat',
    best: {}, other: { status: PlayerStatus.eliminated, outTick: 9999, outSub: 65535 } },
  { name: 'later exit tick precedes exit sub-tick',
    best: { status: PlayerStatus.out, outTick: 101, outSub: 0 },
    other: { status: PlayerStatus.eliminated, outTick: 100, outSub: 65535 } },
  { name: 'later exit sub-tick breaks a tick tie',
    best: { status: PlayerStatus.out, outTick: 100, outSub: 13 },
    other: { status: PlayerStatus.out, outTick: 100, outSub: 12 } },
]

const soloCases: { kind: RoundKind; finalRule: FinalRule | null; cases: TieCase[] }[] = [
  { kind: 'race', finalRule: null, cases: raceCases },
  { kind: 'survival', finalRule: null, cases: exitCases },
  { kind: 'collection', finalRule: null, cases: [
    { name: 'more points precedes last scoring tick',
      best: { score: 10, lastScoreTick: 900 }, other: { score: 9, lastScoreTick: 1 } },
    { name: 'earliest last scoring tick breaks a points tie',
      best: { score: 10, lastScoreTick: 99 }, other: { score: 10, lastScoreTick: 100 } },
  ] },
  { kind: 'hunt', finalRule: null, cases: [
    { name: 'more hold ticks precedes possession and acquisition',
      best: { holdTicks: 101, lastAcquireTick: 900 },
      other: { holdTicks: 100, possessing: true, lastAcquireTick: 1 } },
    { name: 'current possession precedes latest acquisition tick',
      best: { possessing: true, lastAcquireTick: 900 }, other: { lastAcquireTick: 1 } },
    { name: 'earliest latest acquisition breaks a hold and possession tie',
      best: { possessing: true, lastAcquireTick: 99 }, other: { possessing: true, lastAcquireTick: 100 } },
  ] },
  { kind: 'logic', finalRule: null, cases: [
    { name: 'more correct matches precedes total crossing ticks',
      best: { matches: 3, crossTicks: 2000 }, other: { matches: 2, crossTicks: 1 } },
    { name: 'fewer crossing ticks breaks a matches tie, including the 840-tick failed cycle',
      best: { matches: 2, crossTicks: 839 }, other: { matches: 2, crossTicks: 840 } },
  ] },
  { kind: 'final', finalRule: 'crown', cases: raceCases.slice(0, 3) },
  { kind: 'final', finalRule: 'lastStanding', cases: exitCases },
]

for (const { kind, finalRule, cases } of soloCases) {
  describe(`${kind}${finalRule ? ` ${finalRule}` : ''} S14 tie order`, () => {
    for (const { name, best, other } of cases) {
      it(name, () => {
        const result = check(kind, [seat(9, other), seat(42, best)], [42, 9], { finalRule })
        assert.deepEqual(result.qualified, [42])
        assert.equal(result.playoff, null)
        assert.equal(result.champion, kind === 'final' ? 42 : -1)
      })
    }
  })
}

describe('race time-cap resolution', () => {
  it('keeps finishers first and fills the quota by the complete progress order', () => {
    const records = [
      seat(42, { finishTick: 100, finishSub: 20 }),
      seat(17, { finishTick: 100, finishSub: 10 }),
      seat(9, { lap: 2 }),
      seat(3, { lap: 1, stage: 2 }),
      seat(2, { lap: 1, stage: 1, routeMm: 10, falls: 1 }),
      seat(1, { lap: 1, stage: 1, routeMm: 10, falls: 2 }),
      seat(0, { lap: 1, stage: 1, routeMm: 11 }),
    ]
    const result = check('race', records, [17, 42, 9, 3, 2, 1, 0], { target: 5 })
    assert.deepEqual(result.qualified, [17, 42, 9, 3, 2])
    assert.deepEqual(result.eliminated, [1, 0])
    assert.equal(result.playoff, null)
  })
})

describe('survival resolution', () => {
  it('retains an underfilled simultaneous batch without reviving anyone', () => {
    const result = check('survival', [
      seat(42), seat(9, { status: PlayerStatus.out, outTick: 100 }),
      seat(17, { status: PlayerStatus.out, outTick: 99 }),
    ], [42, 9, 17], { target: 2 })
    assert.deepEqual(result.qualified, [42])
    assert.equal(result.playoff, null)
  })

  it('advances all remaining survivors after overtime even above the quota', () => {
    const result = check('survival', [seat(0), seat(1), seat(2)], [2, 1, 0])
    assert.deepEqual(result.qualified, [2, 1, 0])
    assert.deepEqual(result.eliminated, [])
    assert.equal(result.playoff, null)
  })

  it('uses sub-ticks for an all-fall batch and never fills from an earlier tick', () => {
    const result = check('survival', [
      seat(42, { status: PlayerStatus.out, outTick: 100, outSub: 400 }),
      seat(9, { status: PlayerStatus.out, outTick: 100, outSub: 300 }),
      seat(17, { status: PlayerStatus.out, outTick: 99, outSub: 65535 }),
    ], [42, 9, 17], { target: 3 })
    assert.deepEqual(result.qualified, [42, 9])
    assert.deepEqual(result.eliminated, [17])
    assert.equal(result.playoff, null)
  })

  it('replays exactly the tied batch crossing the quota, preserving undisputed places', () => {
    const result = check('survival', [
      seat(42, { status: PlayerStatus.out, outTick: 100, outSub: 400 }),
      seat(9, { status: PlayerStatus.out, outTick: 100, outSub: 300 }),
      seat(17, { status: PlayerStatus.out, outTick: 100, outSub: 300 }),
      seat(3, { status: PlayerStatus.out, outTick: 100, outSub: 200 }),
      seat(2, { status: PlayerStatus.out, outTick: 99, outSub: 65535 }),
    ], [42, 9, 17, 3, 2], { target: 2 })
    assert.deepEqual(result.qualified, [42])
    assert.deepEqual(result.playoff, [9, 17])
    assert.deepEqual(result.eliminated, [3, 2])
  })

  it('does not replay an exact exit tie that fits wholly within the quota', () => {
    const result = check('survival', [
      seat(42, { status: PlayerStatus.out, outTick: 100, outSub: 300 }),
      seat(9, { status: PlayerStatus.out, outTick: 100, outSub: 300 }),
      seat(17, { status: PlayerStatus.out, outTick: 100, outSub: 200 }),
    ], [9, 42, 17], { target: 2 })
    assert.deepEqual(result.qualified, [9, 42])
    assert.equal(result.playoff, null)
  })
})

describe('final resolution', () => {
  it('replays simultaneous crown grabs instead of awarding the seeded first seat', () => {
    const result = check('final', [
      seat(42, { finishTick: 100, finishSub: 12 }),
      seat(9, { finishTick: 100, finishSub: 12 }),
      seat(17, { finishTick: 100, finishSub: 13 }),
    ], [9, 42, 17], { finalRule: 'crown' })
    assert.deepEqual(result.playoff, [9, 42])
    assert.deepEqual(result.qualified, [])
    assert.deepEqual(result.eliminated, [17])
    assert.equal(result.champion, -1)
  })

  it('restarts every finalist from CP1 when nobody has grabbed the crown', () => {
    const result = check('final', [seat(0), seat(1), seat(2)], [2, 1, 0], { finalRule: 'crown' })
    assert.deepEqual(result.playoff, [2, 1, 0])
    assert.deepEqual(result.qualified, [])
    assert.deepEqual(result.eliminated, [])
    assert.equal(result.champion, -1)
  })

  it('replays an exact lastStanding exit tie on the last tick only', () => {
    const result = check('final', [
      seat(42, { status: PlayerStatus.out, outTick: 100, outSub: 12 }),
      seat(9, { status: PlayerStatus.out, outTick: 100, outSub: 12 }),
      seat(17, { status: PlayerStatus.out, outTick: 99, outSub: 65535 }),
    ], [9, 42, 17], { finalRule: 'lastStanding' })
    assert.deepEqual(result.playoff, [9, 42])
    assert.deepEqual(result.qualified, [])
    assert.equal(result.champion, -1)
  })

  it('requires another lastStanding attempt if several finalists are still alive', () => {
    const result = check('final', [seat(0), seat(1), seat(2)], [2, 1, 0], { finalRule: 'lastStanding' })
    assert.deepEqual(result.playoff, [2, 1, 0])
    assert.deepEqual(result.qualified, [])
    assert.equal(result.champion, -1)
  })

  it('uses finalRule to give identical records different rankings and champions', () => {
    const records = [
      seat(42, { status: PlayerStatus.out, finishTick: 100, outTick: 200 }),
      seat(9, { status: PlayerStatus.out, finishTick: 200, outTick: 300 }),
    ]
    const crown = check('final', records, [42, 9], { finalRule: 'crown' })
    const standing = check('final', records, [9, 42], { finalRule: 'lastStanding' })
    assert.equal(crown.champion, 42)
    assert.equal(standing.champion, 9)
  })
})

describe('team ranking and resolution', () => {
  const records = [
    seat(42, { team: 0, openingRank: 3 }), seat(17, { team: 0, openingRank: 4 }),
    seat(9, { team: 1, openingRank: 1 }), seat(3, { team: 1, openingRank: 9 }),
  ]

  it('changes the winning team when only teamScores changes, ahead of opening ranks and seed', () => {
    const zero = check('team', records, [42, 17, 9, 3], { teamScores: [2, 1] })
    const one = check('team', records, [9, 3, 42, 17], { teamScores: [1, 2] })
    assert.equal(zero.teamWinner, 0)
    assert.equal(one.teamWinner, 1)
    // The target is one, but the entire winning team must advance.
    assert.deepEqual(zero.qualified, [42, 17])
    assert.deepEqual(one.qualified, [9, 3])
    assert.equal(zero.playoff, null)
    assert.equal(one.playoff, null)
    assert.equal(zero.champion, -1)
    assert.equal(one.champion, -1)
  })

  it('breaks a score tie by the lower sum of opening ranks, ahead of seed and best individual rank', () => {
    const result = check('team', records, [42, 17, 9, 3], { teamScores: [7, 7] })
    assert.equal(result.teamWinner, 0) // 3 + 4 < 1 + 9; seed alone favors team 1.
    assert.deepEqual(result.qualified, [42, 17])
  })

  it('orders seats inside each team by opening rank, then seed', () => {
    check('team', records, [42, 17, 9, 3], { teamScores: [1, 0] })
    check('team', records.map(r => ({ ...r, openingRank: 1 })), [9, 3, 17, 42], { teamScores: [0, 1] })
  })

  it('breaks tied team scores and opening sums by team seed, using seed and roundIndex', () => {
    // Team identities deliberately oppose their seats' seed order.
    const tied = [seat(9, { team: 0 }), seat(42, { team: 1 })]
    assert.equal(check('team', tied, [42, 9], { teamScores: [4, 4] }).teamWinner, 1)
    assert.equal(check('team', tied, [9, 42], { teamScores: [4, 4], seed: 1 }).teamWinner, 0)
    assert.equal(check('team', tied, [9, 42], { teamScores: [4, 4], roundIndex: 1 }).teamWinner, 0)
  })

  for (const scores of [undefined, [], [1], [1, 2, 3]]) {
    it(`refuses ${scores === undefined ? 'missing' : `${scores.length}-entry`} teamScores for two teams`, () => {
      const refusal = rankRound('team', null, records, 0, 0, scores)
      assert.ok(refusal instanceof RefusalError)
      assert.equal(refusal.area, 'season-rules')
      assert.equal(refusal.path, 'teamScores')
      assert.ok(refusal.reason.length > 0)
      assert.throws(
        () => resolveRound('team', null, 2, records, scores ?? [], 0, 0),
        (error: unknown) => error instanceof RefusalError &&
          error.area === 'season-rules' && error.path === 'teamScores',
      )
    })
  }
})

describe('seed context and irrelevant arguments', () => {
  const contexts = [
    { seed: 0, roundIndex: 0, expected: [2, 1, 0] },
    { seed: 1, roundIndex: 0, expected: [0, 1, 2] },
    { seed: 0, roundIndex: 1, expected: [2, 0, 1] },
  ]

  for (const { kind, finalRule } of soloCases) {
    it(`${kind} ${finalRule ?? ''} uses seed and roundIndex only after its other tie rules`, () => {
      const records = [0, 1, 2].map(id => seat(id, {
        status: PlayerStatus.out, finishTick: 100, finishSub: 12, outTick: 100, outSub: 12,
      }))
      // Literal orders exercise S14's ascending FNV word order independently of
      // the production comparator; the same records change under each context.
      for (const { seed, roundIndex, expected } of contexts) {
        assert.deepEqual(
          [0, 1, 2].sort((a, b) => seedOrder(seed, roundIndex, a) - seedOrder(seed, roundIndex, b)),
          expected,
        )
        const result = check(kind, records, expected, { finalRule, seed, roundIndex })
        if (kind === 'final' || kind === 'survival') {
          assert.deepEqual(result.playoff, expected)
          assert.deepEqual(result.qualified, [])
          assert.equal(result.champion, -1)
        } else {
          assert.deepEqual(result.qualified, expected.slice(0, 1))
          assert.equal(result.playoff, null)
        }
      }
    })

    it(`${kind} ${finalRule ?? ''} ignores teamScores, even when their length or values are invalid for teams`, () => {
      const records = [seat(0), seat(1), seat(2)]
      const omitted = check(kind, records, [2, 1, 0], { finalRule })
      for (const teamScores of [[], [999], [NaN, Infinity]]) {
        assert.deepEqual(check(kind, records, [2, 1, 0], { finalRule, teamScores }), omitted)
      }
    })
  }

  for (const kind of ROUND_KINDS.filter(kind => kind !== 'final')) {
    it(`${kind} ignores finalRule`, () => {
      const records = kind === 'team'
        ? [0, 1, 2, 3].map(id => seat(id, { team: id % 2 }))
        : [seat(0), seat(1), seat(2)]
      const context = kind === 'team' ? { teamScores: [1, 0] } : {}
      const expected = kind === 'team' ? [2, 0, 3, 1] : [2, 1, 0]
      const crown = check(kind, records, expected, { ...context, finalRule: 'crown' })
      const standing = check(kind, records, expected, { ...context, finalRule: 'lastStanding' })
      assert.deepEqual(crown, standing)
    })
  }
})

describe('season qualify: a playoff that ties again is settled, never replayed', () => {
  const tied = [0, 1, 2, 3, 4, 5].map(id => seat(id, { openingRank: 6 - id }))

  for (const finalRule of ['lastStanding', 'crown'] as const) {
    it(`gives one champion for a fully tied 6-seat ${finalRule} final`, () => {
      const first = resolveRound('final', finalRule, 1, tied, [], 7, 4)
      assert.equal(first.playoff?.length, 6)
      assert.equal(first.champion, -1)
      for (const order of [tied, [...tied].reverse()]) {
        const replay = resolveRound('final', finalRule, 1, order, [], 7, 5, true)
        assert.equal(replay.playoff, null)
        assert.deepEqual(replay.qualified, [5])
        assert.equal(replay.champion, 5)
        assert.equal(replay.ranking[0], 5)
        assert.deepEqual(replay.eliminated, [...replay.ranking.slice(1)])
        assert.equal(new Set(replay.ranking).size, 6)
      }
    })
  }

  it('uses seed order when opening ranks tie too', () => {
    const even = [0, 1, 2, 3, 4, 5].map(id => seat(id))
    const replay = resolveRound('final', 'lastStanding', 1, even, [], 7, 5, true)
    const expected = [...even].sort((a, b) => seedOrder(7, 5, a.seat) - seedOrder(7, 5, b.seat) || a.seat - b.seat)[0].seat
    assert.equal(replay.champion, expected)
    assert.equal(replay.playoff, null)
  })

  it('fills the open survival places from a repeated exit tie', () => {
    const exits = [0, 1, 2].map(id => seat(id, { status: PlayerStatus.out, outTick: 50, outSub: 3, openingRank: id + 1 }))
    const replay = resolveRound('survival', null, 2, exits, [], 1, 3, true)
    assert.equal(replay.playoff, null)
    assert.deepEqual(replay.qualified, [0, 1])
    assert.deepEqual(replay.eliminated, [2])
  })
})
