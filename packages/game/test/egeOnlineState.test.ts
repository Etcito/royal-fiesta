import assert from 'node:assert/strict'
import test from 'node:test'
import type { Roster } from '@gamesaloon/rollback/zones'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { onlineRoster } from '../src/net/onlineMatch.ts'
import { EngineVoteBarrier, engineOnlineStats, onlineMeasurements, onlineSeatMap, registerEngineOnlineStats } from '../src/ege/onlineState.ts'
import type { EngineOnlineStats } from '../src/ege/onlineState.ts'
import type { EngineShowRuntime } from '../src/ege/showTypes.ts'

const AREA = 'ege-online'

function refuses(run: () => unknown, path: string): void {
  assert.throws(run, error => error instanceof RefusalError && error.area === AREA && error.path === path)
}

function humansAt(seatCount: number, ...humanSeats: number[]): boolean[] {
  const humans = new Array<boolean>(seatCount).fill(false)
  for (const seat of humanSeats) humans[seat] = true
  return humans
}

function handRoster(seatCount: number, owner: (seat: number) => number): Roster {
  const seats = new Map<number, number[]>()
  for (let seat = 0; seat < seatCount; seat++) {
    const peer = owner(seat)
    if (peer < 0) continue
    const list = seats.get(peer) ?? []
    list.push(seat)
    seats.set(peer, list)
  }
  return { seatCount, peers: [...seats].map(([peer, list]) => ({ peer, seats: list })), live: [...seats.keys()].map(() => true) }
}

test('onlineRoster(2, 60) maps the two human seats and peer 0 seats', () => {
  const roster = onlineRoster(2, 60)
  const map = onlineSeatMap(humansAt(60, 0, 1), roster, 0)
  assert.equal(map.inputSlotOf[0], 0)
  assert.equal(map.inputSlotOf[1], 1)
  for (let seat = 2; seat < 60; seat++) assert.equal(map.inputSlotOf[seat], -1)
  assert.deepEqual(map.localSeats, roster.peers[0].seats)
  assert.deepEqual(map.localSeats, [...roster.peers[0].seats].sort((a, b) => a - b))
  assert.deepEqual(map.localHumanSeats, [0])
  assert.equal(map.peerOfSeat[2], 0)
  assert.equal(map.peerOfSeat[59], 1)
})

test('a hand-built roster maps room seats 3 and 41 to input slots 0 and 1', () => {
  const roster = handRoster(60, seat => (seat === 41 ? 1 : 0))
  const map = onlineSeatMap(humansAt(60, 3, 41), roster, 0)
  assert.equal(map.inputSlotOf[3], 0)
  assert.equal(map.inputSlotOf[41], 1)
  for (let seat = 0; seat < 60; seat++) if (seat !== 3 && seat !== 41) assert.equal(map.inputSlotOf[seat], -1)
  assert.equal(map.peerOfSeat[3], 0)
  assert.equal(map.peerOfSeat[41], 1)
  assert.deepEqual(map.localHumanSeats, [3])
})

test('onlineSeatMap refuses invalid rosters and local peers', () => {
  refuses(() => onlineSeatMap(new Array<boolean>(59).fill(false), onlineRoster(2, 60), 0), 'network.roster.seatCount')
  refuses(() => onlineSeatMap(new Array<boolean>(9).fill(true), handRoster(9, () => 0), 0), 'config.humans')
  const doubly: Roster = {
    seatCount: 60,
    peers: [{ peer: 0, seats: [...Array(60).keys()] }, { peer: 1, seats: [5] }],
    live: [true, true],
  }
  refuses(() => onlineSeatMap(new Array<boolean>(60).fill(false), doubly, 0), 'network.roster.peers/1')
  const unowned: Roster = {
    seatCount: 60,
    peers: [{ peer: 0, seats: [...Array(60).keys()].filter(seat => seat !== 7) }],
    live: [true],
  }
  refuses(() => onlineSeatMap(new Array<boolean>(60).fill(false), unowned, 0), 'network.roster.peers/-1')
  refuses(() => onlineSeatMap(new Array<boolean>(60).fill(false), handRoster(60, () => 0), 5), 'network.localPeer')
})

test('onlineMeasurements gives every peer the shared values', () => {
  const roster = onlineRoster(2, 60)
  const measurements = onlineMeasurements(roster)
  assert.deepEqual(Object.keys(measurements), ['0', '1'])
  for (const entry of roster.peers) {
    assert.deepEqual(measurements[entry.peer], { cpuMs: 2, bandwidthKbps: 4096, latencyMs: 30, spareSlots: 3 })
  }
})

test('EngineVoteBarrier completes only when every peer offers', () => {
  const barrier = new EngineVoteBarrier([1, 0])
  assert.equal(barrier.complete(3), false)
  barrier.offer(3, 1, 2)
  assert.equal(barrier.complete(3), false)
  barrier.offer(3, 0, 0)
  assert.equal(barrier.complete(3), true)
  assert.deepEqual(barrier.choices(3), [{ peer: 0, choice: 0 }, { peer: 1, choice: 2 }])
})

test('EngineVoteBarrier ignores repeats and marks dropped peers', () => {
  const barrier = new EngineVoteBarrier([2, 0, 1])
  barrier.offer(0, 0, 4)
  barrier.offer(0, 2, 5)
  barrier.offer(0, 0, 9)
  barrier.drop(1)
  assert.equal(barrier.complete(0), true)
  assert.deepEqual(barrier.choices(0), [{ peer: 0, choice: 4 }, { peer: 1, choice: -1 }, { peer: 2, choice: 5 }])
  barrier.offer(1, 0, 1)
  barrier.offer(1, 2, 2)
  assert.equal(barrier.complete(1), true)
  assert.deepEqual(barrier.choices(1), [{ peer: 0, choice: 1 }, { peer: 1, choice: -1 }, { peer: 2, choice: 2 }])
})

test('EngineVoteBarrier refuses unknown peers, bad choices and incomplete rounds', () => {
  const barrier = new EngineVoteBarrier([0, 1])
  refuses(() => barrier.offer(0, 9, 0), 'vote.peer')
  refuses(() => barrier.offer(0, 0, -2), 'vote.choice')
  refuses(() => barrier.choices(0), 'vote.round')
})

test('the stats registry copies a registered runtime and refuses a second registration', () => {
  const runtime = {} as EngineShowRuntime
  const stats: EngineOnlineStats = { desyncs: 1, confirmedTick: 4, peers: 2, livePeers: 1, spectator: false }
  assert.equal(engineOnlineStats({} as EngineShowRuntime), null)
  registerEngineOnlineStats(runtime, () => stats)
  const copy = engineOnlineStats(runtime)
  assert.deepEqual(copy, stats)
  assert.notEqual(copy, stats)
  assert.notEqual(engineOnlineStats(runtime), copy)
  refuses(() => registerEngineOnlineStats(runtime, () => stats), 'registerEngineOnlineStats')
})
