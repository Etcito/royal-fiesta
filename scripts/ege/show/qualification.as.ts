import { Column, readColumn } from 'ege'
import { ShowResultA, ShowResultB } from '../components.gen'

// packages/sim/src/season/qualify.ts and points.ts are the behavior specification. The helpers are
// pure within the tick: they read the schema rows and return arena-backed scratch, never writing.

const KIND_RACE: i32 = 0
const KIND_SURVIVAL: i32 = 1
const KIND_TEAM: i32 = 2
const KIND_COLLECTION: i32 = 3
const KIND_HUNT: i32 = 4
const KIND_LOGIC: i32 = 5
const KIND_FINAL: i32 = 6

const FINAL_NONE: i32 = 0
const FINAL_CROWN: i32 = 1
const FINAL_LAST_STANDING: i32 = 2

const STATUS_ALIVE: i32 = 1
const STATUS_QUALIFIED: i32 = 2

const NO_OPENING_RANK: i32 = 0x7fffffff

function fail(message: string): void {
  abort(message, 'scripts/ege/show/qualification.as.ts', 0, 0)
}

// gamesaloon-rollback:packages/core/src/snap.ts:167-174 fnv1a32 semantics: the twelve little-endian bytes
// of seed, round index and room seat, folded with the byte-wise loop and wrapping u32 multiplication.
function seedHash(seed: u32, roundIndex: i32, roomSeat: i32): u32 {
  const bytes = new StaticArray<u8>(12)
  let word: u32 = seed
  for (let i: i32 = 0; i < 4; i++) {
    bytes[i] = <u8>(word & 0xff)
    word >>>= 8
  }
  word = <u32>roundIndex
  for (let i: i32 = 0; i < 4; i++) {
    bytes[4 + i] = <u8>(word & 0xff)
    word >>>= 8
  }
  word = <u32>roomSeat
  for (let i: i32 = 0; i < 4; i++) {
    bytes[8 + i] = <u8>(word & 0xff)
    word >>>= 8
  }
  let h: u32 = 0x811c9dc5
  for (let i: i32 = 0; i < 12; i++) {
    h ^= <u32>bytes[i]
    h = h * <u32>0x01000193
  }
  return h
}

export function showSeedOrder(seed: u32, roundIndex: i32, roomSeat: i32): u32 {
  return seedHash(seed, roundIndex, roomSeat)
}

/** The helper scratch handed back to the rules ledger: arrays are tick-local arena blocks. */
export class ShowRoundOutcome {
  ranking: StaticArray<i32> = new StaticArray<i32>(0)
  qualified: StaticArray<i32> = new StaticArray<i32>(0)
  eliminated: StaticArray<i32> = new StaticArray<i32>(0)
  playoff: StaticArray<i32> | null = null
  champion: i32 = -1
  teamWinner: i32 = -1
}

function checkKind(kind: i32): void {
  if (kind < KIND_RACE || kind > KIND_FINAL) fail('invalid show round kind')
}

function checkFinalRule(finalRule: i32): void {
  if (finalRule < FINAL_NONE || finalRule > FINAL_LAST_STANDING) fail('invalid final rule')
}

function isLiving(status: i32): bool {
  return status == STATUS_ALIVE || status == STATUS_QUALIFIED
}

class SeatTable {
  aColumn: Column<ShowResultA> = new Column<ShowResultA>()
  bColumn: Column<ShowResultB> = new Column<ShowResultB>()
  aRows: StaticArray<i32> = new StaticArray<i32>(0)
  bRows: StaticArray<i32> = new StaticArray<i32>(0)
  room: StaticArray<i32> = new StaticArray<i32>(0)
  count: i32 = 0
}

function aAt(table: SeatTable, index: i32): ShowResultA {
  return table.aColumn.at(<u32>table.aRows[index])
}

function bAt(table: SeatTable, index: i32): ShowResultB {
  return table.bColumn.at(<u32>table.bRows[index])
}

function loadTable(seats: StaticArray<u32>): SeatTable {
  const table = new SeatTable()
  const n = seats.length
  table.aColumn = readColumn<ShowResultA>(ShowResultA.ID, ShowResultA.SIZE)
  table.bColumn = readColumn<ShowResultB>(ShowResultB.ID, ShowResultB.SIZE)
  table.aRows = new StaticArray<i32>(n)
  table.bRows = new StaticArray<i32>(n)
  table.room = new StaticArray<i32>(n)
  table.count = n
  for (let i: i32 = 0; i < n; i++) {
    const entity = seats[<u32>i]
    const aRow = table.aColumn.find(entity)
    if (aRow < 0) fail('seat has no show_result_a record')
    const bRow = table.bColumn.find(entity)
    if (bRow < 0) fail('seat has no show_result_b record')
    table.aRows[i] = aRow
    table.bRows[i] = bRow
    const room = table.aColumn.at(<u32>aRow).seat
    for (let j: i32 = 0; j < i; j++) {
      if (table.room[j] == room) fail('duplicate room seat')
    }
    table.room[i] = room
  }
  return table
}

function progressOrder(table: SeatTable, a: i32, b: i32): i32 {
  const left = aAt(table, a)
  const right = aAt(table, b)
  let value = right.lap - left.lap
  if (value != 0) return value
  value = right.stage - left.stage
  if (value != 0) return value
  value = left.route_mm - right.route_mm
  if (value != 0) return value
  return left.falls - right.falls
}

function finishOrder(table: SeatTable, a: i32, b: i32): i32 {
  const left = aAt(table, a)
  const right = aAt(table, b)
  const leftFinished = left.finish_tick >= 0
  const rightFinished = right.finish_tick >= 0
  if (leftFinished != rightFinished) return leftFinished ? -1 : 1
  if (!leftFinished) return progressOrder(table, a, b)
  let value = left.finish_tick - right.finish_tick
  if (value != 0) return value
  return left.finish_sub - right.finish_sub
}

function survivalOrder(table: SeatTable, a: i32, b: i32): i32 {
  const left = aAt(table, a)
  const right = aAt(table, b)
  const leftLiving = isLiving(left.status)
  const rightLiving = isLiving(right.status)
  if (leftLiving != rightLiving) return leftLiving ? -1 : 1
  if (leftLiving) return 0
  const leftExit = bAt(table, a)
  const rightExit = bAt(table, b)
  let value = rightExit.out_tick - leftExit.out_tick
  if (value != 0) return value
  return rightExit.out_sub - leftExit.out_sub
}

function collectionOrder(table: SeatTable, a: i32, b: i32): i32 {
  const left = aAt(table, a)
  const right = aAt(table, b)
  let value = right.score - left.score
  if (value != 0) return value
  return left.last_score_tick - right.last_score_tick
}

function huntOrder(table: SeatTable, a: i32, b: i32): i32 {
  const leftB = bAt(table, a)
  const rightB = bAt(table, b)
  let value = rightB.hold_ticks - leftB.hold_ticks
  if (value != 0) return value
  value = <i32>rightB.possessing - <i32>leftB.possessing
  if (value != 0) return value
  return leftB.last_acquire_tick - rightB.last_acquire_tick
}

function logicOrder(table: SeatTable, a: i32, b: i32): i32 {
  const left = bAt(table, a)
  const right = bAt(table, b)
  let value = right.matches - left.matches
  if (value != 0) return value
  return left.cross_ticks - right.cross_ticks
}

function seededOrder(table: SeatTable, a: i32, b: i32, seed: u32, roundIndex: i32): i32 {
  const left = seedHash(seed, roundIndex, table.room[a])
  const right = seedHash(seed, roundIndex, table.room[b])
  if (left < right) return -1
  if (left > right) return 1
  return table.room[a] - table.room[b]
}

function uniqueTeamCount(table: SeatTable): i32 {
  const teams = new StaticArray<i32>(table.count)
  let used: i32 = 0
  for (let i: i32 = 0; i < table.count; i++) {
    const team = bAt(table, i).team
    let found = false
    for (let j: i32 = 0; j < used; j++) {
      if (teams[j] == team) {
        found = true
        break
      }
    }
    if (!found) {
      teams[used] = team
      used++
    }
  }
  return used
}

function teamOrder(
  a: i32, b: i32, scores: StaticArray<i32>, opening: StaticArray<i32>, seed: u32, roundIndex: i32,
): i32 {
  let value = scores[b] - scores[a]
  if (value != 0) return value
  value = opening[a] - opening[b]
  if (value != 0) return value
  const left = seedHash(seed, roundIndex, a)
  const right = seedHash(seed, roundIndex, b)
  if (left < right) return -1
  if (left > right) return 1
  return a - b
}

function teamPlaces(table: SeatTable, teamScores: StaticArray<i32>, seed: u32, roundIndex: i32): StaticArray<i32> {
  const count = teamScores.length
  if (count == 0 || count != uniqueTeamCount(table)) fail('team scores need one entry per team')
  const opening = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < table.count; i++) {
    const team = bAt(table, i).team
    if (team < 0 || team >= count) fail('team ids must be contiguous from zero')
    opening[team] += bAt(table, i).opening_rank
  }
  const order = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) order[i] = i
  for (let i: i32 = 1; i < count; i++) {
    const key = order[i]
    let j = i - 1
    while (j >= 0 && teamOrder(key, order[j], teamScores, opening, seed, roundIndex) < 0) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
  const places = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) places[order[i]] = i
  return places
}

function seatOrder(
  table: SeatTable, leftIndex: i32, rightIndex: i32, kind: i32, finalRule: i32,
  places: StaticArray<i32>, seed: u32, roundIndex: i32,
): i32 {
  let value: i32 = 0
  if (kind == KIND_RACE) value = finishOrder(table, leftIndex, rightIndex)
  else if (kind == KIND_SURVIVAL) value = survivalOrder(table, leftIndex, rightIndex)
  else if (kind == KIND_COLLECTION) value = collectionOrder(table, leftIndex, rightIndex)
  else if (kind == KIND_HUNT) value = huntOrder(table, leftIndex, rightIndex)
  else if (kind == KIND_LOGIC) value = logicOrder(table, leftIndex, rightIndex)
  else if (kind == KIND_FINAL) {
    if (finalRule == FINAL_CROWN) value = finishOrder(table, leftIndex, rightIndex)
    else value = survivalOrder(table, leftIndex, rightIndex)
  } else {
    const left = bAt(table, leftIndex)
    const right = bAt(table, rightIndex)
    value = places[left.team] - places[right.team]
    if (value == 0) value = left.opening_rank - right.opening_rank
  }
  if (value != 0) return value
  return seededOrder(table, leftIndex, rightIndex, seed, roundIndex)
}

function sortOrder(
  table: SeatTable, kind: i32, finalRule: i32, places: StaticArray<i32>, seed: u32, roundIndex: i32,
): StaticArray<i32> {
  const count = table.count
  const order = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) order[i] = i
  for (let i: i32 = 1; i < count; i++) {
    const key = order[i]
    let j = i - 1
    while (j >= 0 && seatOrder(table, key, order[j], kind, finalRule, places, seed, roundIndex) < 0) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
  return order
}

class ExitResult {
  qualifiedCount: i32 = 0
  playoffCount: i32 = 0
  hasPlayoff: bool = false
}

function takeExits(
  table: SeatTable, batch: StaticArray<i32>, batchCount: i32, count: i32,
  qualified: StaticArray<i32>, playoff: StaticArray<i32>,
): ExitResult {
  const outcome = new ExitResult()
  let take = count
  if (take > batchCount) take = batchCount
  if (take <= 0) return outcome
  const boundary = batch[take - 1]
  const outTick = bAt(table, boundary).out_tick
  const outSub = bAt(table, boundary).out_sub
  const tied = new StaticArray<i32>(batchCount)
  let tiedCount: i32 = 0
  for (let i: i32 = 0; i < batchCount; i++) {
    const index = batch[i]
    if (bAt(table, index).out_tick == outTick && bAt(table, index).out_sub == outSub) {
      tied[tiedCount] = index
      tiedCount++
    }
  }
  let dispute = false
  if (take < batchCount) {
    const next = batch[take]
    if (bAt(table, next).out_tick == outTick && bAt(table, next).out_sub == outSub) dispute = true
  }
  if (!dispute) {
    for (let i: i32 = 0; i < take; i++) qualified[i] = batch[i]
    outcome.qualifiedCount = take
    return outcome
  }
  outcome.hasPlayoff = true
  outcome.playoffCount = tiedCount
  for (let i: i32 = 0; i < tiedCount; i++) playoff[i] = tied[i]
  let kept: i32 = 0
  for (let i: i32 = 0; i < take; i++) {
    const index = batch[i]
    let disputed = false
    for (let t: i32 = 0; t < tiedCount; t++) {
      if (tied[t] == index) {
        disputed = true
        break
      }
    }
    if (!disputed) {
      qualified[kept] = index
      kept++
    }
  }
  outcome.qualifiedCount = kept
  return outcome
}

function disputedOrder(table: SeatTable, a: i32, b: i32, seed: u32, roundIndex: i32): i32 {
  const left = bAt(table, a).opening_rank
  const right = bAt(table, b).opening_rank
  const leftOpening = left > 0 ? left : NO_OPENING_RANK
  const rightOpening = right > 0 ? right : NO_OPENING_RANK
  let value = leftOpening - rightOpening
  if (value != 0) return value
  return seededOrder(table, a, b, seed, roundIndex)
}

export function rankShowSeats(
  kind: i32, finalRule: i32, seats: StaticArray<u32>, teamScores: StaticArray<i32>, seed: u32, roundIndex: i32,
): StaticArray<i32> {
  checkKind(kind)
  checkFinalRule(finalRule)
  const count = seats.length
  const ranking = new StaticArray<i32>(count)
  if (count == 0) return ranking
  if (kind == KIND_FINAL && finalRule == FINAL_NONE) fail('a final requires crown or lastStanding')
  const table = loadTable(seats)
  let places = new StaticArray<i32>(0)
  if (kind == KIND_TEAM) places = teamPlaces(table, teamScores, seed, roundIndex)
  const order = sortOrder(table, kind, finalRule, places, seed, roundIndex)
  for (let i: i32 = 0; i < count; i++) ranking[i] = table.room[order[i]]
  return ranking
}

/**
 * Handoff: G7.2 Rules, season and results: close every round kind: `resolveShowRound(kind:i32, finalRule:i32,
 * target:i32, seats:StaticArray<u32>, teamScores:StaticArray<i32>, seed:u32, roundIndex:i32,
 * playoffRound:bool):ShowRoundOutcome` exported by scripts/ege/show/qualification.as.ts resolves a complete
 * nonempty entity-handle seat list into ranking, qualified, eliminated, disputed playoff and champion or team
 * winner, settling a replayed dispute by positive opening rank then seed then seat. The ledger attaches it after
 * cumulative ingestion with live seat handles and copies the outcome into schema rows before the tick ends; the
 * same boundary uses `rankShowSeats`, `showRoundPoints` and, from scripts/ege/show/teams.as.ts, `splitShowTeams`
 * and `resolveShowTeamTie`. State/keys: show_result_a and show_result_b rows keyed by the seat entity handle,
 * with the world seed and round index.
 */
export function resolveShowRound(
  kind: i32, finalRule: i32, target: i32, seats: StaticArray<u32>, teamScores: StaticArray<i32>,
  seed: u32, roundIndex: i32, playoffRound: bool,
): ShowRoundOutcome {
  checkKind(kind)
  checkFinalRule(finalRule)
  const count = seats.length
  const outcome = new ShowRoundOutcome()
  if (count == 0) return outcome
  if (target < 1 || target > count) fail('target must be 1..seats.length')
  if (kind == KIND_FINAL && finalRule == FINAL_NONE) fail('a final requires crown or lastStanding')
  const table = loadTable(seats)
  let places = new StaticArray<i32>(0)
  if (kind == KIND_TEAM) places = teamPlaces(table, teamScores, seed, roundIndex)
  const order = sortOrder(table, kind, finalRule, places, seed, roundIndex)
  const qualified = new StaticArray<i32>(count)
  let qualifiedCount: i32 = 0
  const playoff = new StaticArray<i32>(count)
  let playoffCount: i32 = 0
  let hasPlayoff = false
  let champion: i32 = -1
  let teamWinner: i32 = -1

  if (kind == KIND_TEAM) {
    teamWinner = bAt(table, order[0]).team
    for (let i: i32 = 0; i < count; i++) {
      const index = order[i]
      if (bAt(table, index).team == teamWinner) {
        qualified[qualifiedCount] = index
        qualifiedCount++
      }
    }
  } else if (kind == KIND_FINAL && finalRule == FINAL_CROWN) {
    let first: i32 = -1
    for (let i: i32 = 0; i < count; i++) {
      if (aAt(table, order[i]).finish_tick >= 0) {
        first = order[i]
        break
      }
    }
    if (first >= 0) {
      const finishTick = aAt(table, first).finish_tick
      const finishSub = aAt(table, first).finish_sub
      for (let i: i32 = 0; i < count; i++) {
        const index = order[i]
        const row = aAt(table, index)
        if (row.finish_tick == finishTick && row.finish_sub == finishSub) {
          playoff[playoffCount] = index
          playoffCount++
        }
      }
      if (playoffCount > 1) {
        hasPlayoff = true
      } else {
        qualified[0] = playoff[0]
        qualifiedCount = 1
        playoffCount = 0
      }
    } else {
      for (let i: i32 = 0; i < count; i++) playoff[i] = order[i]
      playoffCount = count
      hasPlayoff = true
    }
  } else if (kind == KIND_SURVIVAL || (kind == KIND_FINAL && finalRule == FINAL_LAST_STANDING)) {
    const alive = new StaticArray<i32>(count)
    let aliveCount: i32 = 0
    for (let i: i32 = 0; i < count; i++) {
      const index = order[i]
      if (isLiving(aAt(table, index).status)) {
        alive[aliveCount] = index
        aliveCount++
      }
    }
    if (kind == KIND_FINAL) {
      if (aliveCount == 1) {
        qualified[0] = alive[0]
        qualifiedCount = 1
      } else if (aliveCount > 1) {
        for (let i: i32 = 0; i < aliveCount; i++) playoff[i] = alive[i]
        playoffCount = aliveCount
        hasPlayoff = true
      } else {
        const result = takeExits(table, order, count, 1, qualified, playoff)
        qualifiedCount = result.qualifiedCount
        playoffCount = result.playoffCount
        hasPlayoff = result.hasPlayoff
      }
    } else if (aliveCount > 0) {
      for (let i: i32 = 0; i < aliveCount; i++) qualified[i] = alive[i]
      qualifiedCount = aliveCount
    } else {
      const outTick = bAt(table, order[0]).out_tick
      const batch = new StaticArray<i32>(count)
      let batchCount: i32 = 0
      for (let i: i32 = 0; i < count; i++) {
        const index = order[i]
        if (bAt(table, index).out_tick == outTick) {
          batch[batchCount] = index
          batchCount++
        }
      }
      const result = takeExits(table, batch, batchCount, target, qualified, playoff)
      qualifiedCount = result.qualifiedCount
      playoffCount = result.playoffCount
      hasPlayoff = result.hasPlayoff
    }
  } else {
    let take = target
    if (take > count) take = count
    for (let i: i32 = 0; i < take; i++) qualified[i] = order[i]
    qualifiedCount = take
  }

  if (playoffRound && hasPlayoff) {
    const positions = new StaticArray<i32>(playoffCount)
    for (let i: i32 = 0; i < playoffCount; i++) {
      const index = playoff[i]
      let position: i32 = -1
      for (let p: i32 = 0; p < count; p++) {
        if (order[p] == index) {
          position = p
          break
        }
      }
      positions[i] = position
    }
    for (let i: i32 = 1; i < playoffCount; i++) {
      const key = positions[i]
      let j = i - 1
      while (j >= 0 && positions[j] > key) {
        positions[j + 1] = positions[j]
        j--
      }
      positions[j + 1] = key
    }
    for (let i: i32 = 1; i < playoffCount; i++) {
      const key = playoff[i]
      let j = i - 1
      while (j >= 0 && disputedOrder(table, key, playoff[j], seed, roundIndex) < 0) {
        playoff[j + 1] = playoff[j]
        j--
      }
      playoff[j + 1] = key
    }
    const disputedCount = playoffCount
    for (let i: i32 = 0; i < disputedCount; i++) order[positions[i]] = playoff[i]
    let open = (kind == KIND_FINAL ? 1 : target) - qualifiedCount
    if (open < 0) open = 0
    if (open > disputedCount) open = disputedCount
    for (let i: i32 = 0; i < open; i++) qualified[qualifiedCount + i] = playoff[i]
    qualifiedCount += open
    hasPlayoff = false
    playoffCount = 0
  }

  const ranking = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) ranking[i] = table.room[order[i]]
  outcome.ranking = ranking

  const qualifiedOut = new StaticArray<i32>(qualifiedCount)
  for (let i: i32 = 0; i < qualifiedCount; i++) qualifiedOut[i] = table.room[qualified[i]]
  outcome.qualified = qualifiedOut

  if (hasPlayoff) {
    const playoffOut = new StaticArray<i32>(playoffCount)
    for (let i: i32 = 0; i < playoffCount; i++) playoffOut[i] = table.room[playoff[i]]
    outcome.playoff = playoffOut
  } else {
    outcome.playoff = null
  }

  const keep = new StaticArray<bool>(count)
  for (let i: i32 = 0; i < qualifiedCount; i++) keep[qualified[i]] = true
  if (hasPlayoff) {
    for (let i: i32 = 0; i < playoffCount; i++) keep[playoff[i]] = true
  }
  let eliminatedCount: i32 = 0
  for (let i: i32 = 0; i < count; i++) {
    if (!keep[order[i]]) eliminatedCount++
  }
  const eliminated = new StaticArray<i32>(eliminatedCount)
  let eliminatedIndex: i32 = 0
  for (let i: i32 = 0; i < count; i++) {
    const index = order[i]
    if (keep[index]) continue
    eliminated[eliminatedIndex] = table.room[index]
    eliminatedIndex++
  }
  outcome.eliminated = eliminated

  if (kind == KIND_FINAL && qualifiedCount == 1 && !hasPlayoff) champion = table.room[qualified[0]]
  outcome.champion = champion
  outcome.teamWinner = teamWinner
  return outcome
}

export function showRoundPoints(rank: i32, entrants: i32, qualified: bool): i32 {
  return qualified ? entrants - rank + 1 : 0
}
