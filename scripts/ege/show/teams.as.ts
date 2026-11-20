import { readColumn } from 'ege'
import { ShowResultA } from '../components.gen'
import { showSeedOrder } from './qualification.as'

// packages/sim/src/season/teams.ts is the behavior specification: split an even roster by the
// gameplay seed order and settle an overtime tie by score, overtime leadership, opening ranks.

function fail(message: string): void {
  abort(message, 'scripts/ege/show/teams.as.ts', 0, 0)
}

export function splitShowTeams(seats: StaticArray<u32>, seed: u32, roundIndex: i32): StaticArray<i32> {
  const count = seats.length
  if (count == 0 || count % 2 != 0) fail('provide a nonzero even number of seats')
  const results = readColumn<ShowResultA>(ShowResultA.ID, ShowResultA.SIZE)
  const room = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) {
    const row = results.find(seats[<u32>i])
    if (row < 0) fail('seat has no show_result_a record')
    room[i] = results.at(<u32>row).seat
  }
  const order = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) order[i] = i
  for (let i: i32 = 1; i < count; i++) {
    const key = order[i]
    let j = i - 1
    while (j >= 0 && seededFirst(seed, roundIndex, room[key], room[order[j]]) < 0) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
  const teams = new StaticArray<i32>(count)
  const half = count / 2
  for (let i: i32 = half; i < count; i++) teams[order[i]] = 1
  return teams
}

function seededFirst(seed: u32, roundIndex: i32, leftSeat: i32, rightSeat: i32): i32 {
  const left = showSeedOrder(seed, roundIndex, leftSeat)
  const right = showSeedOrder(seed, roundIndex, rightSeat)
  if (left < right) return -1
  if (left > right) return 1
  return leftSeat - rightSeat
}

function teamCompare(
  a: i32, b: i32, scores: StaticArray<i32>, overtimeLeader: i32, openingRankSums: StaticArray<i32>,
  seed: u32, roundIndex: i32,
): i32 {
  let value = scores[b] - scores[a]
  if (value != 0) return value
  const leftLeader = a == overtimeLeader
  const rightLeader = b == overtimeLeader
  if (leftLeader != rightLeader) return leftLeader ? -1 : 1
  value = openingRankSums[a] - openingRankSums[b]
  if (value != 0) return value
  const left = showSeedOrder(seed, roundIndex, a)
  const right = showSeedOrder(seed, roundIndex, b)
  if (left < right) return -1
  if (left > right) return 1
  return a - b
}

export function resolveShowTeamTie(
  scores: StaticArray<i32>, overtimeLeader: i32, openingRankSums: StaticArray<i32>, seed: u32, roundIndex: i32,
): i32 {
  const count = scores.length
  if (count == 0 || openingRankSums.length != count) fail('scores and opening rank sums need equal nonzero length')
  if (overtimeLeader < -1 || overtimeLeader >= count) fail('overtime leader must be a team index or -1')
  const order = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) order[i] = i
  for (let i: i32 = 1; i < count; i++) {
    const key = order[i]
    let j = i - 1
    while (j >= 0 && teamCompare(key, order[j], scores, overtimeLeader, openingRankSums, seed, roundIndex) < 0) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
  return order[0]
}
