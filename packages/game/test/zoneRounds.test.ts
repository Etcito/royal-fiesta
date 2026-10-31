import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { advanceCursor, nextSlot } from '@royal-fiesta/sim/season/plan'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import { levelOf } from '@royal-fiesta/sim/course'
import { parseSeason } from '../src/season.ts'
import { Rng } from '@gamesaloon/rollback'
import type { Roster } from '@gamesaloon/rollback/zones'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import type { LedgerResult } from '@royal-fiesta/sim/zones/ledger'
import {
  decodeRoundResult, encodeRoundResult, nextAlive, newShow, roundCandidates, showMaps, planZoneRound, roundResultOf, roundRoster, sameRoundResult,
} from '../src/net/zoneRounds.ts'
import type { ZoneRoundResult } from '../src/net/zoneRounds.ts'

// Minimal fixture courses; levelOf supplies their legacy levels.
const COURSES = [
  { id: 'race-a', kind: 'race', profiles: ['sprint'], timeLimitS: 60, checkpoints: [] },
  { id: 'race-b', kind: 'race', profiles: ['sprint'], timeLimitS: 60, checkpoints: [] },
  { id: 'survival-a', kind: 'survival', profiles: ['sprint'], timeLimitS: 60, checkpoints: [] },
  { id: 'survival-b', kind: 'survival', profiles: ['sprint'], timeLimitS: 60, checkpoints: [] },
] as unknown as readonly ResolvedCourse[]

const seats = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

const MAPS: SchedMap[] = [
  { id: 'opening', course: 0, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: true },
  { id: 'second', course: 2, kind: 'survival', finalRule: null, stages: ['R2'], team: false, cut: false },
  { id: 'third', course: 1, kind: 'race', finalRule: null, stages: ['R3'], team: false, cut: true },
  { id: 'fourth', course: 3, kind: 'survival', finalRule: null, stages: ['R4'], team: false, cut: false },
  { id: 'crown', course: 2, kind: 'survival', finalRule: 'lastStanding', stages: ['R1', 'R2', 'R3', 'R4', 'final'], team: false, cut: false },
]

test('60-seat season follows 60 -> 40 -> 24 -> 12 -> 6 -> final without repeated maps', () => {
  const show = newShow(MAPS, 60, 11)
  const rng = new Rng(show.schedule.rngState)
  assert.deepEqual(show.rounds, [])
  assert.deepEqual([...show.openingRanks], seats(60).map(() => 0))
  for (const target of [40, 24, 12, 6, 1]) {
    const plan = planZoneRound(COURSES, show, seats(show.cursor.alive), null, rng)
    assert.equal(plan.target, target)
    assert.equal(plan.final, target === 1)
    assert.equal(plan.kind, target === 1 ? 'final' : MAPS.find(map => map.id === plan.map)!.kind)
    show.cursor = advanceCursor(show.cursor, plan.slot, target, plan.teams !== null)
  }
  assert.equal(new Set(show.schedule.used).size, 5)
  assert.equal(nextSlot(show.cursor), null)
  assert.deepEqual(roundCandidates(show, rng), [])
})

test('final is reserved before the opening draw and only offered for the final', () => {
  const show = newShow(MAPS, 60, 4)
  const rng = new Rng(show.schedule.rngState)
  assert.equal(show.schedule.finalMap, 'crown')
  assert.ok(!roundCandidates(show, rng).includes('crown'))
  show.cursor = { ...show.cursor, step: 4, alive: 6 }
  assert.deepEqual(roundCandidates(show, rng), ['crown'])
  show.cursor = { ...show.cursor, alive: 14 }
  assert.equal(roundCandidates(show, rng).length, 1)
})

test('showMaps maps legacy and explicit levels without a season', () => {
  const maps = showMaps(COURSES)
  assert.deepEqual(maps[0], { id: 'race-a', course: 0, kind: 'race', finalRule: null,
    stages: ['R1', 'R2', 'R3', 'R4', 'final'], team: false, cut: true })
  assert.equal(maps[2].finalRule, 'lastStanding')
  assert.equal(maps[2].cut, false)
  const team = { ...COURSES[0], level: { ...levelOf(COURSES[0]), kind: 'team' as const,
    teams: { count: 2 as const, maxPerTeam: 30 } } }
  assert.equal(showMaps([team], null)[0].team, true)
})

test('showMaps uses built, loaded season maps and season cut rules', () => {
  const season = parseSeason(JSON.parse(readFileSync(new URL('../../../courses/season.json', import.meta.url), 'utf8')), 'season')
  const selected = season.maps.filter(map => ['A', 'E', 'P', 'Q'].includes(map.id))
  for (const map of selected) map.status = 'built'
  const courses = selected.map(map => ({ ...COURSES[0], id: map.course }))
  const maps = showMaps(courses, season)
  assert.deepEqual(maps.map(map => map.id), selected.map(map => map.id))
  for (let i = 0; i < maps.length; i++) {
    assert.equal(maps[i].course, i)
    assert.equal(maps[i].team, selected[i].teams !== null)
    assert.equal(maps[i].cut, season.rules.cutMaps.includes(maps[i].id))
    assert.equal(maps[i].kind, selected[i].kind)
    assert.equal(maps[i].finalRule, selected[i].finalRule)
    assert.deepEqual(maps[i].stages, selected[i].stages)
  }
  assert.deepEqual(showMaps([], season), [])
})

test('teams follow opening-rank snake order, indexed by dense round seat', () => {
  const team: SchedMap = { ...MAPS[0], id: 'team', kind: 'team', team: true }
  const show = newShow([team, MAPS[4]], 10, 3, [8, 4, 1])
  show.openingRanks.set([8, 0, 2, 7, 3, 0, 6, 4, 5, 1])
  const plan = planZoneRound(COURSES, show, [9, 8, 7, 6, 4, 3, 2, 0], null, new Rng(3))
  // Ranked room seats: 9,2,4,7,8,6,3,0; snake: 0,1,1,0,0,1,1,0.
  assert.deepEqual([...plan.teams!], [0, 1, 1, 1, 1, 0, 0, 0])
})

test('votes choose the majority map and missing courses are refused before commit', () => {
  const show = newShow(MAPS, 60, 5)
  const plan = planZoneRound(COURSES, show, seats(60), { candidates: ['opening', 'third'], votes: [1, 1, 0] }, new Rng(5))
  assert.equal(plan.map, 'third')
  const broken = newShow([{ ...MAPS[0], course: 99 }, MAPS[4]], 60, 5)
  assert.throws(() => planZoneRound(COURSES, broken, seats(60), null, new Rng(5)),
    (e: unknown) => isRefusal(e) && e.path === 'planZoneRound.courses')
  assert.deepEqual(broken.schedule.used, [])
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

const utf8Length = (value: string): number => new TextEncoder().encode(value).length

function fixtureResult(overrides: Partial<ZoneRoundResult> = {}): ZoneRoundResult {
  return {
    index: 1,
    map: 'second',
    course: 'survival-a',
    kind: 'survival',
    final: false,
    playoff: false,
    endTick: 4242,
    reason: 'timeCap',
    ranking: [4, 1, 3],
    qualified: [4, 1],
    eliminated: [3],
    points: [3, 2, 0],
    teamScores: [],
    champion: -1,
    ...overrides,
  }
}

test('round results map ranking, seats, points and champion through seatOf', () => {
  const { seatOf } = roundRoster({
    seatCount: 5,
    peers: [
      { peer: 0, seats: [0, 1] },
      { peer: 1, seats: [2] },
      { peer: 2, seats: [3, 4] },
    ],
    live: [true, true, true],
  }, [1, 3, 4])
  const show = newShow(MAPS, 40, 5)
  show.cursor = { ...show.cursor, step: 1, roundIndex: 1 }
  const plan = planZoneRound(COURSES, show, seats(40), null, new Rng(5))
  const ledger: LedgerResult = {
    endTick: 4242, qualified: [2, 0], eliminated: [1], reason: 'timeCap',
    ranking: [2, 0, 1], points: [3, 2, 0], teamScores: [], playoff: null, champion: 2,
  }
  const result = roundResultOf(plan, ledger, seatOf)
  assert.equal(result.index, 1)
  assert.equal(result.map, plan.map)
  assert.equal(result.course, plan.course.id)
  assert.equal(result.kind, 'survival')
  assert.equal(result.final, false)
  assert.equal(result.playoff, false)
  assert.equal(result.endTick, 4242)
  assert.equal(result.reason, 'timeCap')
  assert.deepEqual(result.ranking, [4, 1, 3])
  assert.deepEqual(result.qualified, [4, 1])
  assert.deepEqual(result.eliminated, [3])
  assert.deepEqual(result.points, [3, 2, 0])
  assert.deepEqual(result.teamScores, [])
  assert.equal(result.champion, 4)
})

test('round results survive an encode/decode round trip', () => {
  const result = fixtureResult({
    index: 3, map: 'crown', course: 'crown-confection', kind: 'final', final: true, playoff: true,
    endTick: -12, reason: 'crown', ranking: [4, 1, 3, 6], qualified: [4, 1], eliminated: [3, 6],
    points: [5, 3, 1, 0], teamScores: [12, 9], champion: 4,
  })
  const decoded = decodeRoundResult(encodeRoundResult(result))
  assert.ok(decoded)
  assert.ok(sameRoundResult(result, decoded))
  assert.deepEqual(decoded, result)
})

test('every truncated round result decodes to null', () => {
  const bytes = encodeRoundResult(fixtureResult())
  for (let n = 0; n < bytes.length; n++) {
    assert.equal(decodeRoundResult(bytes.subarray(0, n)), null, `truncated at ${n}`)
  }
})

test('an unknown kind or reason byte decodes to null', () => {
  const result = fixtureResult()
  const bytes = encodeRoundResult(result)
  const kindAt = 3 + utf8Length(result.map) + utf8Length(result.course)
  const reasonAt = kindAt + 7
  const badKind = bytes.slice()
  badKind[kindAt] = 7
  assert.equal(decodeRoundResult(badKind), null)
  const badReason = bytes.slice()
  badReason[reasonAt] = 9
  assert.equal(decodeRoundResult(badReason), null)
})

test('sameRoundResult detects a changed points entry', () => {
  const result = fixtureResult()
  assert.ok(sameRoundResult(result, { ...result }))
  assert.equal(sameRoundResult(result, { ...result, points: [4, 2, 0] }), false)
  assert.equal(sameRoundResult(result, { ...result, teamScores: [1] }), false)
  assert.equal(sameRoundResult(result, { ...result, champion: 0 }), false)
})

test('nextAlive returns the qualified room seats ascending without touching the result', () => {
  const result = { qualified: [5, 2, 9] }
  assert.deepEqual(nextAlive(result), [2, 5, 9])
  assert.deepEqual(result.qualified, [5, 2, 9])
})
