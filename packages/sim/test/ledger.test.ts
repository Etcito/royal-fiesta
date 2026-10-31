import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ShadowView } from '@gamesaloon/rollback/zones'
import type { SeatRecord } from '../src/season/qualify.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { decodeFiestaEvent, decodeFiestaEvents, encodeFiestaEvents, MatchLedger } from '../src/zones/ledger.ts'
import type { FiestaEvent, LedgerReason, LedgerResult, MatchLedgerConfig } from '../src/zones/ledger.ts'

const GLOBAL = { id: 0, kind: 'global' as const, cells: [], seats: [], replicas: [0] }

function payload(events: readonly FiestaEvent[]): Uint8Array {
  const writer = new SnapWriter()
  encodeFiestaEvents(writer, events)
  return writer.bytes().slice()
}

function view(...domains: readonly (readonly FiestaEvent[])[]): ShadowView {
  const links = domains.map(payload)
  return { count: links.length, fromDomain: (i) => i + 1, reader: (i) => new SnapReader(links[i]) }
}

function event(kind: FiestaEvent['kind'], seat: number, tick: number, a = 0, b = 0): FiestaEvent {
  return { kind, seat, tick, a, b }
}

function step(match: MatchLedger, ...domains: readonly (readonly FiestaEvent[])[]): void {
  match.step([], view(...domains))
}

function ledger(config: Partial<MatchLedgerConfig> = {}): MatchLedger {
  return new MatchLedger(GLOBAL, 0, {
    seatCount: 4, kind: 'race', final: false, finalRule: null, target: 2, playoff: false,
    introTicks: 0, roundTicks: 100, overtimeTicks: 0, seed: 0, roundIndex: 0,
    teams: null, openingRanks: null, ...config,
  })
}

function runTo(match: MatchLedger, tick: number): void {
  while (match.tick < tick && !match.over) step(match)
}

function snapshot(match: MatchLedger): Uint8Array {
  const writer = new SnapWriter()
  match.snapshot(writer)
  return writer.bytes().slice()
}

function restore(bytes: Uint8Array): MatchLedger {
  const fresh = ledger({ seatCount: 1, kind: 'survival', target: 1, introTicks: 9, roundTicks: 99,
    overtimeTicks: 7, seed: 9, roundIndex: 9 })
  const reader = new SnapReader(bytes)
  fresh.restore(reader)
  assert.equal(reader.remaining, 0)
  return fresh
}

function record(match: MatchLedger, seat: number): SeatRecord {
  return match.record(seat, {} as SeatRecord)
}

interface Expected {
  reason: LedgerReason
  endTick: number
  ranking: readonly number[]
  qualified: readonly number[]
  eliminated: readonly number[]
  points: readonly number[]
  champion: number
  playoff?: readonly number[] | null
  teamScores?: readonly number[]
}

function settle(match: MatchLedger): LedgerResult {
  assert.equal(match.over, true)
  const result = match.result
  assert.ok(result)
  return result
}

function expectResult(match: MatchLedger, expected: Expected): LedgerResult {
  const result = settle(match)
  assert.equal(result.reason, expected.reason)
  assert.equal(result.endTick, expected.endTick)
  assert.deepEqual(result.ranking, expected.ranking)
  assert.deepEqual(result.qualified, expected.qualified)
  assert.deepEqual(result.eliminated, expected.eliminated)
  assert.deepEqual(result.points, expected.points)
  assert.equal(result.champion, expected.champion)
  assert.deepEqual(result.playoff, expected.playoff ?? null)
  assert.deepEqual(result.teamScores, expected.teamScores ?? [])
  return result
}

const eventKinds: FiestaEvent['kind'][] = [
  'finish', 'fall', 'eliminate', 'gate', 'progress', 'score', 'teamScore', 'possess', 'match', 'crown',
]

test('the S15 codec preserves every kind and signed payload in wire order', () => {
  const events = eventKinds.map((kind, code): FiestaEvent => ({
    kind, seat: 0xffff - code, tick: -123456, a: -0x80000000 + code, b: 0x7fffffff - code,
  }))
  const bytes = payload(events)
  assert.equal(bytes.length, 2 + 15 * events.length)
  const wire = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(wire.getUint16(0, true), events.length)
  for (let code = 0; code < events.length; code++) {
    const offset = 2 + 15 * code
    assert.equal(wire.getUint8(offset), code)
    assert.equal(wire.getUint16(offset + 1, true), events[code].seat)
    assert.equal(wire.getInt32(offset + 3, true), events[code].tick)
    assert.equal(wire.getInt32(offset + 7, true), events[code].a)
    assert.equal(wire.getInt32(offset + 11, true), events[code].b)
  }
  const decoded: FiestaEvent[] = []
  const reader = new SnapReader(bytes)
  assert.equal(decodeFiestaEvents(reader, event('fall', 0, 0), e => decoded.push({ ...e })), true)
  assert.deepEqual(decoded, events)
  assert.equal(reader.remaining, 0)
})

test('the S15 codec rejects truncated headers, truncated entries and unknown codes', () => {
  const bytes = payload([event('finish', 0, 0)])
  const entry = bytes.subarray(2)
  const scratch = event('fall', 0, 0)
  for (let length = 0; length < 15; length++) {
    assert.equal(decodeFiestaEvent(new SnapReader(entry.subarray(0, length)), scratch), false)
  }
  let visits = 0
  const visit = (): void => { visits++ }
  for (let length = 1; length < bytes.length; length++) {
    assert.equal(decodeFiestaEvents(new SnapReader(bytes.subarray(0, length)), scratch, visit), false)
  }
  for (let code = 10; code <= 0xff; code++) {
    bytes[2] = code
    assert.equal(decodeFiestaEvent(new SnapReader(entry), scratch), false)
    assert.equal(decodeFiestaEvents(new SnapReader(bytes), scratch, visit), false)
  }
  assert.equal(visits, 0)
  for (const empty of [new Uint8Array(0), payload([])]) {
    const reader = new SnapReader(empty)
    assert.equal(decodeFiestaEvents(reader, scratch, visit), true)
    assert.equal(reader.remaining, 0)
  }
})

test('every S15 field lands on its SeatRecord in shadow order inside the tick window', () => {
  const match = ledger({ kind: 'collection', roundTicks: 10,
    teams: new Uint8Array([0, 0, 1, 1]), openingRanks: new Uint16Array([4, 3, 2, 1]) })
  step(match, [event('score', 0, 0, 100)])
  step(match, [
    event('score', 0, 2, 100),
    event('gate', 0, 1, 2, 3),
    event('progress', 0, 1, 456),
    event('fall', 0, 1),
    event('score', 0, 1, 7),
    event('possess', 0, 1, 1),
    event('match', 0, 1, 1, 840),
  ], [event('gate', 0, 1, 4, 5)])
  assert.deepEqual(record(match, 0), {
    seat: 0, status: PlayerStatus.alive, finishTick: -1, finishSub: 0, lap: 5, stage: 4,
    routeMm: 456, falls: 1, score: 107, lastScoreTick: 1, holdTicks: 1, possessing: true,
    lastAcquireTick: 1, matches: 1, crossTicks: 840, outTick: -1, outSub: 0, team: 0, openingRank: 4,
  })
})

test('race qualifies in domain order and fills the timeCap places by gate and progress', () => {
  const target = ledger({ target: 2 })
  step(target, [event('finish', 3, 0, 5, 1), event('progress', 0, 0, 100)],
    [event('finish', 1, 0, 1, 1), event('progress', 0, 0, 50)])
  expectResult(target, {
    reason: 'target', endTick: 0, ranking: [1, 3, 2, 0], qualified: [1, 3],
    eliminated: [2, 0], points: [4, 3, 0, 0], champion: -1,
  })
  assert.equal(record(target, 0).routeMm, 50)

  const capped = ledger({ target: 2, introTicks: 1, roundTicks: 3 })
  runTo(capped, 1)
  step(capped, [
    event('gate', 0, 1, 2, 1),
    event('gate', 1, 1, 1, 1),
    event('progress', 1, 1, 100),
    event('gate', 2, 1, 1, 1),
    event('progress', 2, 1, 50),
    event('progress', 3, 1, 10),
  ])
  runTo(capped, 5)
  expectResult(capped, {
    reason: 'timeCap', endTick: 4, ranking: [0, 2, 1, 3], qualified: [0, 2],
    eliminated: [1, 3], points: [4, 3, 0, 0], champion: -1,
  })
})

test('survival target, all-fall sub-ticks and the exact-tie playoff', () => {
  const target = ledger({ seatCount: 3, kind: 'survival', target: 1 })
  step(target, [event('eliminate', 2, 0, 10), event('eliminate', 1, 0, 20)])
  expectResult(target, {
    reason: 'target', endTick: 0, ranking: [0, 1, 2], qualified: [0], eliminated: [1, 2],
    points: [3, 0, 0], champion: -1,
  })

  const allFell = ledger({ kind: 'survival', target: 1 })
  step(allFell, [
    event('eliminate', 0, 0, 30),
    event('eliminate', 1, 0, 10),
    event('eliminate', 2, 0, 20),
    event('eliminate', 3, 0, 40),
  ])
  expectResult(allFell, {
    reason: 'allFell', endTick: 0, ranking: [3, 0, 2, 1], qualified: [3], eliminated: [0, 2, 1],
    points: [4, 0, 0, 0], champion: -1,
  })

  const tied = ledger({ kind: 'survival', target: 1 })
  step(tied, [
    event('eliminate', 0, 0, 10),
    event('eliminate', 1, 0, 50),
    event('eliminate', 2, 0, 50),
    event('eliminate', 3, 0, 5),
  ])
  expectResult(tied, {
    reason: 'playoff', endTick: 0, ranking: [2, 1, 0, 3], qualified: [], eliminated: [0, 3],
    points: [0, 0, 0, 0], champion: -1, playoff: [2, 1],
  })
})

test('survival overtime keeps every survivor when the cap passes', () => {
  const match = ledger({ kind: 'survival', target: 2, roundTicks: 3, overtimeTicks: 2 })
  runTo(match, 3)
  step(match)
  assert.equal(match.overtime, true)
  assert.equal(match.over, false)
  const copy = restore(snapshot(match))
  assert.equal(copy.overtime, true)
  runTo(match, 6)
  runTo(copy, 6)
  const expected: Expected = {
    reason: 'overtime', endTick: 5, ranking: [3, 2, 1, 0], qualified: [3, 2, 1, 0],
    eliminated: [], points: [4, 3, 2, 1], champion: -1,
  }
  const a = expectResult(match, expected)
  const b = expectResult(copy, expected)
  assert.deepEqual(b, a)
  assert.deepEqual(snapshot(copy), snapshot(match))
})

function team(config: Partial<MatchLedgerConfig> = {}): MatchLedger {
  return ledger({ kind: 'team', target: 2, roundTicks: 3, overtimeTicks: 2,
    teams: new Uint8Array([0, 1, 0, 1]), openingRanks: new Uint16Array([1, 4, 3, 2]), ...config })
}

test('team wins at the cap, in overtime by a teamScore, or by openingRanks', () => {
  const capWin = team()
  step(capWin, [event('teamScore', 0, 0, 1)])
  const capCopy = restore(snapshot(capWin))
  runTo(capWin, 3)
  step(capWin)
  runTo(capCopy, 3)
  step(capCopy)
  const capExpected: Expected = {
    reason: 'teamWin', endTick: 3, ranking: [0, 2, 3, 1], qualified: [0, 2], eliminated: [3, 1],
    points: [4, 4, 0, 0], champion: -1, teamScores: [1, 0],
  }
  assert.deepEqual(expectResult(capCopy, capExpected), expectResult(capWin, capExpected))
  assert.deepEqual(snapshot(capCopy), snapshot(capWin))

  const overtimeWin = team()
  runTo(overtimeWin, 3)
  step(overtimeWin)
  assert.equal(overtimeWin.overtime, true)
  step(overtimeWin, [event('teamScore', 1, 4, 1)])
  expectResult(overtimeWin, {
    reason: 'teamWin', endTick: 4, ranking: [3, 1, 0, 2], qualified: [3, 1], eliminated: [0, 2],
    points: [4, 4, 0, 0], champion: -1, teamScores: [0, 1],
  })

  const tieBreak = team()
  runTo(tieBreak, 6)
  expectResult(tieBreak, {
    reason: 'overtime', endTick: 5, ranking: [0, 2, 3, 1], qualified: [0, 2], eliminated: [3, 1],
    points: [4, 4, 0, 0], champion: -1, teamScores: [0, 0],
  })
})

test('collection ranks by points then earliest last score at the cap', () => {
  const match = ledger({ kind: 'collection', roundTicks: 3 })
  runTo(match, 1)
  step(match, [event('score', 0, 1, 5)])
  runTo(match, 2)
  step(match, [event('score', 1, 2, 5), event('score', 2, 2, 7)])
  runTo(match, 4)
  expectResult(match, {
    reason: 'score', endTick: 3, ranking: [2, 0, 1, 3], qualified: [2, 0], eliminated: [1, 3],
    points: [4, 3, 0, 0], champion: -1,
  })
})

test('hunt ranks by hold, then possession, then the earliest latest acquisition at the cap', () => {
  const possession = ledger({ seatCount: 2, kind: 'hunt', target: 1, introTicks: 2, roundTicks: 2 })
  runTo(possession, 2)
  step(possession, [event('possess', 0, 2, 1)])
  step(possession, [event('possess', 1, 3, 1)])
  step(possession, [event('possess', 0, 4, 0)])
  expectResult(possession, {
    reason: 'score', endTick: 4, ranking: [1, 0], qualified: [1], eliminated: [0],
    points: [2, 0], champion: -1,
  })
  assert.equal(record(possession, 0).holdTicks, 2)
  assert.equal(record(possession, 1).holdTicks, 2)

  const acquisition = ledger({ seatCount: 2, kind: 'hunt', target: 1, introTicks: 2, roundTicks: 2 })
  runTo(acquisition, 2)
  step(acquisition, [event('possess', 0, 2, 1), event('possess', 1, 2, 1)])
  step(acquisition, [event('possess', 0, 3, 0), event('possess', 0, 3, 1)])
  runTo(acquisition, 5)
  expectResult(acquisition, {
    reason: 'score', endTick: 4, ranking: [1, 0], qualified: [1], eliminated: [0],
    points: [2, 0], champion: -1,
  })
  assert.equal(record(acquisition, 0).holdTicks, 3)
  assert.equal(record(acquisition, 1).holdTicks, 3)
})

test('logic ranks by correct matches then total crossing ticks at the cap', () => {
  const match = ledger({ kind: 'logic', roundTicks: 3 })
  runTo(match, 1)
  step(match, [
    event('match', 0, 1, 1, 100),
    event('match', 1, 1, 1, 50),
    event('match', 2, 1, 1, 200),
  ])
  runTo(match, 4)
  expectResult(match, {
    reason: 'score', endTick: 3, ranking: [1, 0, 2, 3], qualified: [1, 0], eliminated: [2, 3],
    points: [4, 3, 0, 0], champion: -1,
  })
})

test('final crown gives the win to the first grab and a playoff to a simultaneous one', () => {
  const first = ledger({ seatCount: 2, kind: 'final', final: true, finalRule: 'crown', target: 1 })
  step(first, [event('crown', 1, 0, 10)], [event('crown', 0, 0, 20)])
  expectResult(first, {
    reason: 'crown', endTick: 0, ranking: [1, 0], qualified: [1], eliminated: [0],
    points: [2, 0], champion: 1,
  })

  const tie = ledger({ seatCount: 2, kind: 'final', final: true, finalRule: 'crown', target: 1 })
  step(tie, [event('crown', 0, 0, 50)], [event('crown', 1, 0, 50)])
  expectResult(tie, {
    reason: 'playoff', endTick: 0, ranking: [1, 0], qualified: [], eliminated: [],
    points: [0, 0], champion: -1, playoff: [1, 0],
  })
})

test('final lastStanding crowns the last survivor', () => {
  const match = ledger({ kind: 'final', final: true, finalRule: 'lastStanding', target: 1 })
  step(match, [event('eliminate', 0, 0, 10), event('eliminate', 1, 0, 20), event('eliminate', 2, 0, 30)])
  expectResult(match, {
    reason: 'lastStanding', endTick: 0, ranking: [3, 2, 1, 0], qualified: [3], eliminated: [2, 1, 0],
    points: [4, 0, 0, 0], champion: 3,
  })
})

test('events outside introTicks..tick are ignored', () => {
  const match = ledger({ seatCount: 2, kind: 'survival', target: 1, introTicks: 2, roundTicks: 10 })
  step(match, [
    event('eliminate', 0, 0, 5),
    event('fall', 1, 0),
    event('gate', 1, 0, 3, 4),
    event('progress', 1, 0, 99),
  ])
  step(match, [event('fall', 1, 1)])
  assert.equal(record(match, 0).status, PlayerStatus.alive)
  assert.equal(record(match, 1).falls, 0)
  assert.equal(record(match, 1).stage, 0)
  assert.equal(record(match, 1).routeMm, 0)
  step(match, [
    event('eliminate', 0, 5, 7),
    event('gate', 1, 3, 2, 2),
    event('progress', 1, 1, 50),
    event('eliminate', 0, 2, 9),
  ])
  assert.equal(record(match, 0).outTick, 2)
  assert.equal(record(match, 0).outSub, 9)
  assert.equal(record(match, 1).stage, 0)
  assert.equal(record(match, 1).routeMm, 0)
  expectResult(match, {
    reason: 'target', endTick: 2, ranking: [1, 0], qualified: [1], eliminated: [0],
    points: [2, 0], champion: -1,
  })
})

test('a mid-round snapshot restores into a fresh ledger and reruns to identical bytes and result', () => {
  const live = ledger({ target: 2, roundTicks: 5, seed: 7 })
  step(live, [event('finish', 0, 0, 10, 1)])
  live.seatHost(2, 5, true)
  assert.equal(live.over, false)
  const bytes = snapshot(live)
  const copy = restore(bytes)
  assert.equal(copy.tick, live.tick)
  assert.equal(copy.over, false)
  assert.equal(copy.result, null)
  for (let seat = 0; seat < 4; seat++) assert.deepEqual(record(copy, seat), record(live, seat))
  assert.deepEqual(snapshot(copy), bytes)

  const gate = [event('gate', 2, 1, 1, 1)]
  step(live, gate)
  step(copy, gate)
  const later = [event('finish', 1, 2, 20, 1)]
  const more = [event('finish', 3, 2, 5, 1)]
  step(live, later, more)
  step(copy, later, more)
  const expected: Expected = {
    reason: 'target', endTick: 2, ranking: [0, 3, 1, 2], qualified: [0, 3], eliminated: [1, 2],
    points: [4, 3, 0, 0], champion: -1,
  }
  const a = expectResult(live, expected)
  const b = expectResult(copy, expected)
  assert.deepEqual(b, a)
  assert.deepEqual(snapshot(copy), snapshot(live))
})

test('a closed result survives a rebuild through restore', () => {
  const match = ledger({ seatCount: 2, kind: 'final', final: true, finalRule: 'crown', target: 1 })
  step(match, [event('crown', 1, 0, 10)], [event('crown', 0, 0, 20)])
  const closed = expectResult(match, {
    reason: 'crown', endTick: 0, ranking: [1, 0], qualified: [1], eliminated: [0],
    points: [2, 0], champion: 1,
  })
  const bytes = snapshot(match)
  const rebuilt = restore(bytes)
  assert.equal(rebuilt.over, true)
  assert.deepEqual(rebuilt.result, closed)
  assert.deepEqual(snapshot(rebuilt), bytes)
  step(rebuilt, [event('crown', 0, 1, 1)])
  assert.deepEqual(rebuilt.result, closed)
})
