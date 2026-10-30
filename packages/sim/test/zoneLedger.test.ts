import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ShadowView } from '@gamesaloon/rollback/zones'
import { PlayerStatus } from '../src/match/roundSystem.ts'
import { planRound, qualifyTarget } from '../src/match/rules.ts'
import { encodeFiestaEvents, MatchLedger } from '../src/zones/ledger.ts'
import type { FiestaEvent } from '../src/zones/ledger.ts'

const GLOBAL = { id: 0, kind: 'global' as const, cells: [], seats: [], replicas: [0] }

function ledger(seatCount: number, kind: 'race' | 'survival', introTicks = 0, roundTicks = 600): MatchLedger {
  return new MatchLedger(GLOBAL, 0, { seatCount, kind, introTicks, roundTicks })
}

function payload(events: readonly FiestaEvent[]): Uint8Array {
  const writer = new SnapWriter()
  encodeFiestaEvents(writer, events)
  return writer.bytes().slice()
}

function view(links: readonly { from: number; bytes: Uint8Array }[]): ShadowView {
  return {
    count: links.length,
    fromDomain: (i) => links[i].from,
    reader: (i) => new SnapReader(links[i].bytes),
  }
}

function finish(seat: number, tick: number): FiestaEvent {
  return { kind: 'finish', seat, tick }
}

function eliminate(seat: number, tick: number): FiestaEvent {
  return { kind: 'eliminate', seat, tick }
}

test('a zero-length shadow is skipped and nothing is read', () => {
  const match = ledger(4, 'race')
  match.step([], view([
    { from: 1, bytes: new Uint8Array(0) },
    { from: 2, bytes: new Uint8Array(0) },
  ]))
  assert.equal(match.over, false)
  assert.equal(match.result, null)
  for (let seat = 0; seat < 4; seat++) assert.equal(match.status(seat), PlayerStatus.alive)
  assert.equal(match.tick, 1)
})

test('race finishes from two domains qualify in domain then payload order and end at target', () => {
  const seats = 5
  const target = qualifyTarget(seats)
  assert.equal(planRound(0, seats).target, target)
  const match = ledger(seats, 'race')
  match.step([], view([
    { from: 1, bytes: payload([finish(4, match.tick), finish(2, match.tick)]) },
    { from: 2, bytes: payload([finish(0, match.tick)]) },
  ]))
  assert.equal(match.over, true)
  assert.equal(match.result?.reason, 'target')
  assert.equal(match.result?.endTick, 0)
  assert.deepEqual(match.result?.qualified, [4, 2, 0])
  assert.equal(match.result?.qualified.length, target)
  assert.deepEqual(match.result?.eliminated, [1, 3])
  for (const seat of [4, 2, 0]) assert.equal(match.status(seat), PlayerStatus.qualified)
  for (const seat of [1, 3]) assert.equal(match.status(seat), PlayerStatus.eliminated)
})

test('survival eliminations end the round when alive reaches target', () => {
  const seats = 4
  const target = qualifyTarget(seats)
  const match = ledger(seats, 'survival')
  match.step([], view([{ from: 1, bytes: payload([eliminate(3, match.tick)]) }]))
  assert.equal(match.over, false)
  assert.equal(match.status(3), PlayerStatus.eliminated)
  match.step([], view([{ from: 1, bytes: payload([eliminate(1, match.tick)]) }]))
  assert.equal(match.over, true)
  assert.equal(seats - 2, target)
  assert.equal(match.result?.reason, 'target')
  assert.equal(match.result?.endTick, 1)
  assert.deepEqual(match.result?.eliminated, [3, 1])
  assert.deepEqual(match.result?.qualified, [0, 2])
})

test('the time cap ends the round with timeCap', () => {
  const introTicks = 10
  const roundTicks = 20
  const match = ledger(4, 'race', introTicks, roundTicks)
  while (!match.over && match.tick < introTicks + roundTicks + 5) match.step([], view([]))
  assert.equal(match.over, true)
  assert.equal(match.result?.reason, 'timeCap')
  assert.equal(match.result?.endTick, introTicks + roundTicks + 1)
  assert.deepEqual(match.result?.qualified, [])
  assert.deepEqual(match.result?.eliminated, [0, 1, 2, 3])
})

test('a duplicate finish is ignored', () => {
  const match = ledger(4, 'race')
  match.step([], view([
    { from: 1, bytes: payload([finish(2, match.tick), finish(2, match.tick)]) },
    { from: 2, bytes: payload([finish(2, match.tick)]) },
  ]))
  const before = match.result
  assert.equal(match.over, false)
  assert.equal(before, null)
  assert.equal(match.status(2), PlayerStatus.qualified)
  match.step([], view([{ from: 1, bytes: payload([finish(0, match.tick)]) }]))
  assert.equal(match.over, true)
  assert.deepEqual(match.result?.qualified, [2, 0])
  assert.equal(match.result?.reason, 'target')
})
