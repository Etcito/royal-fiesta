import assert from 'node:assert/strict'
import test from 'node:test'
import { Rng } from '@gamesaloon/rollback'
import type { Roster } from '@gamesaloon/rollback/zones'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import type { LedgerResult } from '@royal-fiesta/sim/zones/ledger'
import {
  decodeRoundResult, encodeRoundResult, nextAlive, planZoneRound, roundResultOf, roundRoster, sameRoundResult,
} from '../src/net/zoneRounds.ts'

// Only the fields coursePool and the result codec read; the real resolver fills the rest.
const COURSES = [
  { id: 'race-a', kind: 'race', profiles: ['sprint'] },
  { id: 'race-b', kind: 'race', profiles: ['sprint'] },
  { id: 'survival-a', kind: 'survival', profiles: ['sprint'] },
  { id: 'survival-b', kind: 'survival', profiles: ['sprint'] },
] as unknown as readonly ResolvedCourse[]

const seats = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

test('planZoneRound follows the 60 -> 40 -> 4 -> 3 round chain', () => {
  const rng = new Rng(11)
  const first = planZoneRound(COURSES, 0, seats(60), -1, rng)
  assert.equal(first.kind, 'race')
  assert.equal(first.final, false)
  assert.equal(first.target, 40)
  assert.ok(first.courseIndex < 2, `race pool was ${first.courseIndex}`)
  assert.equal(COURSES[first.courseIndex].kind, 'race')
  assert.ok(COURSES[first.courseIndex].profiles.includes('sprint'))

  const second = planZoneRound(COURSES, 1, seats(40), first.courseIndex, rng)
  assert.equal(second.kind, 'survival')
  assert.equal(second.final, false)
  assert.equal(second.target, 26)
  assert.ok(second.courseIndex >= 2, `survival pool was ${second.courseIndex}`)
  assert.equal(COURSES[second.courseIndex].kind, 'survival')

  const third = planZoneRound(COURSES, 2, seats(4), second.courseIndex, rng)
  assert.equal(third.kind, 'race')
  assert.equal(third.final, false)
  assert.equal(third.target, 2)

  const fourth = planZoneRound(COURSES, 3, seats(3), third.courseIndex, rng)
  assert.equal(fourth.kind, 'survival')
  assert.equal(fourth.final, true)
  assert.equal(fourth.target, 1)
})

test('planZoneRound refuses an empty course pool', () => {
  const standardOnly = [{ id: 'race-a', kind: 'race', profiles: ['standard'] }] as unknown as readonly ResolvedCourse[]
  assert.throws(
    () => planZoneRound(standardOnly, 0, seats(60), -1, new Rng(1)),
    (e: unknown) => isRefusal(e) && e.area === 'zones' && e.path === 'planZoneRound.courses',
  )
})

test('roundRoster densely renumbers alive room seats and drops the peer with none', () => {
  const room: Roster = {
    seatCount: 5,
    peers: [
      { peer: 0, seats: [0, 1] },
      { peer: 1, seats: [2] },
      { peer: 2, seats: [3, 4] },
    ],
    live: [true, true, true],
  }
  const { roster, seatOf } = roundRoster(room, [4, 1, 3])
  assert.deepEqual(seatOf, [1, 3, 4])
  assert.equal(roster.seatCount, 3)
  assert.deepEqual(roster.peers, [
    { peer: 0, seats: [0] },
    { peer: 2, seats: [1, 2] },
  ])
  assert.deepEqual(roster.live, [true, false, true])
  const owned = roster.peers.flatMap(p => p.seats).sort((a, b) => a - b)
  assert.deepEqual(owned, [0, 1, 2])
  for (const p of roster.peers) assert.ok(p.seats.length >= 1 && p.seats.length <= 4)
})

test('round results map through seatOf, survive a round trip, and fail closed on truncation', () => {
  const { seatOf } = roundRoster({
    seatCount: 5,
    peers: [
      { peer: 0, seats: [0, 1] },
      { peer: 1, seats: [2] },
      { peer: 2, seats: [3, 4] },
    ],
    live: [true, true, true],
  }, [1, 3, 4])
  const plan = planZoneRound(COURSES, 1, seats(40), -1, new Rng(5))
  const ledger: LedgerResult = { endTick: 4242, qualified: [2, 0], eliminated: [1], reason: 'timeCap' }
  const result = roundResultOf(plan, ledger, seatOf)
  assert.equal(result.index, 1)
  assert.equal(result.course, plan.course.id)
  assert.equal(result.kind, 'survival')
  assert.equal(result.final, false)
  assert.equal(result.endTick, 4242)
  assert.equal(result.reason, 'timeCap')
  assert.deepEqual(result.qualified, [4, 1])
  assert.deepEqual(result.eliminated, [3])

  const bytes = encodeRoundResult(result)
  const decoded = decodeRoundResult(bytes)
  assert.ok(decoded)
  assert.deepEqual(decoded, result)
  assert.ok(sameRoundResult(result, decoded))
  assert.equal(sameRoundResult(result, { ...result, endTick: result.endTick + 1 }), false)

  for (let n = 0; n < bytes.length; n++) {
    assert.equal(decodeRoundResult(bytes.subarray(0, n)), null, `truncated at ${n}`)
  }
  const kindAt = 2 + bytes[1]
  const badKind = bytes.slice()
  badKind[kindAt] = 9
  assert.equal(decodeRoundResult(badKind), null)
  const badReason = bytes.slice()
  badReason[kindAt + 6] = 9
  assert.equal(decodeRoundResult(badReason), null)
})

test('nextAlive returns the qualified room seats ascending without touching the result', () => {
  const result = { qualified: [5, 2, 9] }
  assert.deepEqual(nextAlive(result), [2, 5, 9])
  assert.deepEqual(result.qualified, [5, 2, 9])
})
