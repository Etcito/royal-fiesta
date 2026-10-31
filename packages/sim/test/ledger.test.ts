import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ShadowView } from '@gamesaloon/rollback/zones'
import type { SeatRecord } from '../src/season/qualify.ts'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { decodeFiestaEvent, decodeFiestaEvents, encodeFiestaEvents, MatchLedger } from '../src/zones/ledger.ts'
import type { FiestaEvent, MatchLedgerConfig } from '../src/zones/ledger.ts'

function payload(events: readonly FiestaEvent[]): Uint8Array {
  const writer = new SnapWriter()
  encodeFiestaEvents(writer, events)
  return writer.bytes().slice()
}

function finish(seat: number, tick: number): FiestaEvent {
  return { kind: 'finish', seat, tick, a: 0, b: 0 }
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
  assert.equal(decodeFiestaEvents(reader, finish(0, 0), event => decoded.push({ ...event })), true)
  assert.deepEqual(decoded, events)
  assert.equal(reader.remaining, 0)
})

test('the S15 codec rejects truncated headers, truncated entries and unknown codes', () => {
  const bytes = payload([finish(0, 0)])
  const entry = bytes.subarray(2)
  const scratch = finish(0, 0)
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
})

test('empty readers and zero-count payloads are valid empty event streams', () => {
  let visits = 0
  for (const bytes of [new Uint8Array(0), payload([])]) {
    const reader = new SnapReader(bytes)
    assert.equal(decodeFiestaEvents(reader, finish(0, 0), () => { visits++ }), true)
    assert.equal(reader.remaining, 0)
  }
  assert.equal(visits, 0)
})

const GLOBAL = { id: 0, kind: 'global' as const, cells: [], seats: [], replicas: [0] }

function ledger(config: Partial<MatchLedgerConfig> = {}): MatchLedger {
  return new MatchLedger(GLOBAL, 0, {
    seatCount: 4, kind: 'race', final: false, finalRule: null, target: 2, playoff: false,
    introTicks: 1, roundTicks: 3, overtimeTicks: 2, seed: 123, roundIndex: 7,
    teams: null, openingRanks: null, ...config,
  })
}

function step(match: MatchLedger, events: FiestaEvent[] = [], later: FiestaEvent[] = []): void {
  const links = [payload(events), payload(later)]
  const shadows: ShadowView = {
    count: links.length, fromDomain: i => i + 1, reader: i => new SnapReader(links[i]),
  }
  match.step([], shadows)
}

function event(kind: FiestaEvent['kind'], seat = 0, tick = 1, a = 0, b = 0): FiestaEvent {
  return { kind, seat, tick, a, b }
}

function record(match: MatchLedger, seat = 0): SeatRecord {
  return match.record(seat, {} as SeatRecord)
}

function restored(match: MatchLedger): MatchLedger {
  const w = new SnapWriter()
  match.snapshot(w)
  // Deliberately different config: restore must carry the schedule and roster too.
  const copy = ledger({ seatCount: 1, seed: 0, roundIndex: 0, roundTicks: 100 })
  const r = new SnapReader(w.bytes())
  copy.restore(r)
  assert.equal(r.remaining, 0)
  assert.equal(copy.tick, match.tick)
  assert.equal(copy.over, match.over)
  assert.equal(copy.overtime, match.overtime)
  assert.deepEqual(copy.result, match.result)
  return copy
}

test('SeatRecords apply the S15 fields in shadow order only inside the intro/current tick window', () => {
  const match = ledger({ kind: 'collection', roundTicks: 10, teams: new Uint8Array([0, 0, 1, 1]),
    openingRanks: new Uint16Array([4, 3, 2, 1]) })
  step(match, [event('score', 0, 0, 100)])
  step(match, [event('score', 0, 2, 100), event('gate', 0, 1, 2, 3),
    event('progress', 0, 1, 456), event('fall'), event('score', 0, 1, 7),
    event('possess', 0, 1, 1), event('match', 0, 1, 1, 840)], [event('gate', 0, 1, 4, 5)])
  assert.deepEqual(record(match), {
    seat: 0, status: PlayerStatus.alive, finishTick: -1, finishSub: 0, lap: 5, stage: 4,
    routeMm: 456, falls: 1, score: 7, lastScoreTick: 1, holdTicks: 1, possessing: true,
    lastAcquireTick: 1, matches: 1, crossTicks: 840, outTick: -1, outSub: 0, team: 0, openingRank: 4,
  })
  match.seatHost(0, 7, true)
  const copy = restored(match)
  for (let seat = 0; seat < 4; seat++) assert.deepEqual(record(copy, seat), record(match, seat))
  step(match, [event('possess', 0, 2, 0), event('eliminate', 1, 2, 123)])
  step(copy, [event('possess', 0, 2, 0), event('eliminate', 1, 2, 123)])
  while (!match.over) { step(match); step(copy) }
  assert.deepEqual(copy.result, match.result)
  restored(match)
  // Includes hosts/bots, the complete result and all config scalars, without hashing.
  const a = new SnapWriter(), b = new SnapWriter()
  match.snapshot(a); copy.snapshot(b)
  assert.deepEqual(b.bytes(), a.bytes())
})

test('race closes at target or exactly at the cap and fills remaining places by progress', () => {
  const match = ledger()
  step(match)
  step(match, [event('finish', 0, 1, 20, 1)], [event('finish', 1, 1, 10, 1)])
  assert.equal(match.result?.reason, 'target')
  assert.deepEqual(match.result?.qualified, [1, 0])
  assert.deepEqual(match.result?.points, [4, 3, 0, 0])
  const capped = ledger()
  step(capped)
  step(capped, [event('gate', 3, 1, 2, 1), event('gate', 2, 1, 1, 1)])
  while (!capped.over) step(capped)
  assert.equal(capped.result?.reason, 'timeCap')
  assert.equal(capped.result?.endTick, 4)
  assert.deepEqual(capped.result?.qualified, [3, 2])
})

test('survival processes the entire exit batch and retains all survivors after overtime', () => {
  const match = ledger({ kind: 'survival' })
  step(match)
  step(match, [event('eliminate', 0, 1, 30), event('eliminate', 1, 1, 20)],
    [event('eliminate', 2, 1, 10), event('eliminate', 3, 1, 40)])
  assert.equal(match.result?.reason, 'allFell')
  assert.deepEqual(match.result?.qualified, [3, 0])
  const capped = ledger({ kind: 'survival' })
  while (capped.tick <= 4) step(capped)
  assert.equal(capped.over, false)
  assert.equal(capped.overtime, true)
  const copy = restored(capped)
  while (!capped.over) { step(capped); step(copy) }
  assert.equal(capped.result?.reason, 'overtime')
  assert.equal(capped.result?.endTick, 6)
  assert.equal(capped.result?.qualified.length, 4)
  assert.deepEqual(copy.result, capped.result)
})

test('team scores close at the cap or the first overtime score change and winners share rank 1 points', () => {
  for (const scoreTick of [1, 5, -1]) {
    const match = ledger({ kind: 'team', teams: new Uint8Array([0, 1, 0, 1]),
      openingRanks: new Uint16Array([4, 1, 3, 2]) })
    while (match.tick <= 4) step(match, match.tick === scoreTick ? [event('teamScore', 0, scoreTick, 1)] : [])
    const copy = restored(match)
    while (!match.over) {
      const events = match.tick === scoreTick ? [event('teamScore', 0, scoreTick, 1)] : []
      step(match, events); step(copy, events)
    }
    assert.equal(match.result?.reason, scoreTick < 0 ? 'overtime' : 'teamWin')
    assert.deepEqual(match.result?.qualified, scoreTick < 0 ? [1, 3] : [2, 0])
    assert.deepEqual(match.result?.points, [4, 4, 0, 0])
    assert.deepEqual(match.result?.teamScores, scoreTick < 0 ? [0, 0] : [1, 0])
    assert.deepEqual(copy.result, match.result)
  }
})

test('collection, hunt and logic close with score at the cap', () => {
  for (const kind of ['collection', 'hunt', 'logic'] as const) {
    const match = ledger({ kind })
    step(match)
    step(match, [event('score', 2, 1, 4), event('possess', 2, 1, 1), event('match', 2, 1, 1, 25)])
    while (!match.over) step(match)
    assert.equal(match.result?.reason, 'score')
    assert.equal(match.result?.endTick, 4)
    assert.equal(match.result?.ranking[0], 2)
  }
})

test('finals resolve sub-ticks, exact ties and the lastStanding overtime cap', () => {
  for (const finalRule of ['crown', 'lastStanding'] as const) {
    for (const tied of [false, true]) {
      const match = ledger({ kind: 'final', final: true, finalRule, target: 1 })
      step(match)
      if (finalRule === 'crown') {
        step(match, [event('crown', 0, 1, 10)], [event('crown', 1, 1, tied ? 10 : 20)])
      } else {
        step(match, [event('eliminate', 0, 1, 30), event('eliminate', 1, 1, tied ? 30 : 20)],
          [event('eliminate', 2, 1, 10), event('eliminate', 3, 1, 10)])
      }
      assert.equal(match.result?.reason, tied ? 'playoff' : finalRule === 'crown' ? 'crown' : 'lastStanding')
      assert.equal(match.result?.champion, tied ? -1 : 0)
      assert.deepEqual(match.result?.playoff?.slice().sort(), tied ? [0, 1] : undefined)
      restored(match)
    }
  }
  const crown = ledger({ kind: 'final', final: true, finalRule: 'crown', target: 1 })
  step(crown)
  step(crown, [event('finish', 0, 1, 10, 1)])
  assert.equal(crown.over, false)
  step(crown, [event('crown', 0, 2, 10)])
  assert.equal(crown.result?.reason, 'crown')
  // The factory's legacy survival final must also use final resolution.
  const match = ledger({ kind: 'survival', final: true, finalRule: 'lastStanding', target: 1 })
  while (!match.over) step(match)
  assert.equal(match.result?.endTick, 6)
  assert.equal(match.result?.reason, 'playoff')
  assert.equal(match.result?.playoff?.length, 4)
})
