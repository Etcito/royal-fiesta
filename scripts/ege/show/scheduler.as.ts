import { readColumn } from 'ege'
import { ShowCatalogEntry, ShowPlanEntry, ShowUsedMap } from '../components.gen'
import { showSeedOrder } from './qualification.as'

// packages/sim/src/season/plan.ts and scheduler.ts are the behavior specification. Everything here is
// pure within the tick: the cursor, plan, catalog, candidates, votes and used maps live in schema rows,
// and the only carried randomness is the mulberry32 state in show_season_cursor.rng_state.

export const KIND_RACE: i32 = 0
export const KIND_SURVIVAL: i32 = 1
export const KIND_TEAM: i32 = 2
export const KIND_COLLECTION: i32 = 3
export const KIND_HUNT: i32 = 4
export const KIND_LOGIC: i32 = 5
export const KIND_FINAL: i32 = 6

export const FINAL_NONE: i32 = 0
export const FINAL_CROWN: i32 = 1
export const FINAL_LAST_STANDING: i32 = 2

export const STAGE_R1: i32 = 0
export const STAGE_R2: i32 = 1
export const STAGE_R3: i32 = 2
export const STAGE_R4: i32 = 3
export const STAGE_FINAL: i32 = 4

export const FINAL_MIN: i32 = 2
export const FINAL_MAX: i32 = 12
export const CUT_TARGET: i32 = 12
export const DEFAULT_PLAN_LENGTH: i32 = 6
export const LONG_PLAN_LENGTH: i32 = 7
export const FINAL_STAGE_BIT: u32 = 16

// S12 committed season order: A B C1 C2 D E F G H I J K L M N O P Q.
const SEASON_D: i32 = 4
const SEASON_G: i32 = 7
const SEASON_H: i32 = 8
const SEASON_I: i32 = 9

function fail(message: string): void {
  abort(message, 'scripts/ege/show/scheduler.as.ts', 0, 0)
}

function defaultNominal(index: i32): i32 {
  if (index == 0) return 60
  if (index == 1) return 40
  if (index == 2) return 24
  if (index == 3) return 12
  if (index == 4) return 6
  if (index == 5) return 1
  return 1
}

function longNominal(index: i32): i32 {
  if (index == 0) return 60
  if (index == 1) return 48
  if (index == 2) return 36
  if (index == 3) return 24
  if (index == 4) return 12
  if (index == 5) return 6
  if (index == 6) return 1
  return 1
}

export function planNominal(longPlan: bool, index: i32): i32 {
  return longPlan ? longNominal(index) : defaultNominal(index)
}

export function planLength(longPlan: bool): i32 {
  return longPlan ? LONG_PLAN_LENGTH : DEFAULT_PLAN_LENGTH
}

// packages/sim/src/season/plan.ts:39-46: the long plan repeats R1 and keeps R2..final one step later.
export function stageOf(longPlan: bool, step: i32): i32 {
  const last = planLength(longPlan) - 1
  let at = step < 0 ? 0 : step
  if (at > last) at = last
  if (!longPlan) return at
  return at <= 1 ? STAGE_R1 : at - 1
}

export function stageBit(stage: i32): u32 {
  if (stage < 0 || stage > STAGE_FINAL) fail('invalid show stage')
  return <u32>1 << <u32>stage
}

// packages/sim/src/season/plan.ts:20-22.
export function nextTarget(n: i32, currentNominal: i32, nextNominal: i32): i32 {
  const nominal = currentNominal <= 0 ? 1 : currentNominal
  const scaled = <i32>Math.ceil(<f64>(n * nextNominal) / <f64>nominal)
  let target = scaled
  if (target > n - 1) target = n - 1
  if (target < 1) target = 1
  return target
}

export class RoundSlot {
  stage: i32 = 0
  final: bool = false
  cut: bool = false
  playoff: bool = false
  target: i32 = 0
  teamAllowed: bool = false
}

export class ScheduleState {
  finalMap: i32 = -1
  lastKind: i32 = -1
  previous: i32 = -1
  rngState: u32 = 0
}

export class SchedMap {
  index: i32 = 0
  course: u32 = 0
  kind: i32 = 0
  finalRule: i32 = 0
  stages: u32 = 0
  team: bool = false
  cut: bool = false
}

export class CursorAdvance {
  step: i32 = 0
  alive: i32 = 0
  teamRounds: i32 = 0
  roundIndex: i32 = 0
}

// gamesaloon-rollback:packages/core/src/rng.ts:30-36 mulberry32 transition, unsigned throughout.
export class Mulberry {
  state: u32 = 0

  constructor(state: u32) {
    this.state = state
  }

  nextUnit(): f64 {
    this.state = this.state + <u32>0x6d2b79f5
    let t: u32 = this.state
    t = (t ^ (t >>> 15)) * (t | 1)
    const mixed = (t >>> 7) * (t | 61)
    t = t ^ (t + mixed)
    return <f64>(t ^ (t >>> 14)) / 4294967296.0
  }

  // gamesaloon-rollback:packages/core/src/rng.ts:39-43 int(a, b), inclusive.
  int(lo: i32, hi: i32): i32 {
    let a = lo
    let b = hi
    if (a > b) {
      const swap = a
      a = b
      b = swap
    }
    const span = b - a + 1
    return a + <i32>Math.floor(this.nextUnit() * <f64>span)
  }
}

// packages/sim/src/season/scheduler.ts:7 no H -> I or D -> G back-to-back in the committed season order.
export function forbiddenAdjacency(previous: i32, map: i32): bool {
  if (previous == SEASON_H && map == SEASON_I) return true
  if (previous == SEASON_D && map == SEASON_G) return true
  return false
}

export function hasFinal(catalog: StaticArray<SchedMap>): bool {
  for (let i: i32 = 0; i < catalog.length; i++) {
    const map = catalog[i]
    if (map.finalRule != FINAL_NONE && (map.stages & FINAL_STAGE_BIT) != 0) return true
  }
  return false
}

// packages/sim/src/season/scheduler.ts:27-31: reserve one seeded final before any ordinary draw.
export function reserveFinal(catalog: StaticArray<SchedMap>, rng: Mulberry): i32 {
  const finals = new StaticArray<i32>(catalog.length)
  let count = 0
  for (let i: i32 = 0; i < catalog.length; i++) {
    const map = catalog[i]
    if (map.finalRule != FINAL_NONE && (map.stages & FINAL_STAGE_BIT) != 0) finals[count++] = i
  }
  if (count == 0) return -1
  return catalog[finals[rng.int(0, count - 1)]].index
}

export function findCatalog(catalog: StaticArray<SchedMap>, map: i32): i32 {
  for (let i: i32 = 0; i < catalog.length; i++) if (catalog[i].index == map) return i
  return -1
}

function isUsed(used: StaticArray<i32>, map: i32): bool {
  for (let i: i32 = 0; i < used.length; i++) if (used[i] == map) return true
  return false
}

// packages/sim/src/season/plan.ts:48-57.
export function nextSlotForPlan(
  plan: StaticArray<u32>, step: i32, alive: i32, teamRounds: i32,
): RoundSlot | null {
  if (alive <= 1) return null
  const current = step >= 0 && step < plan.length ? <i32>plan[step] : 1
  const next = step + 1 >= 0 && step + 1 < plan.length ? <i32>plan[step + 1] : 1
  const target = nextTarget(alive, current, next)
  const wouldBeFinal = next == 1 || target < 2
  const slot = new RoundSlot()
  if (wouldBeFinal) {
    if (alive > FINAL_MAX) {
      slot.stage = -1
      slot.cut = true
      slot.target = CUT_TARGET
    } else {
      slot.stage = STAGE_FINAL
      slot.final = true
      slot.target = 1
    }
    return slot
  }
  const longPlan = plan.length == LONG_PLAN_LENGTH
  slot.stage = stageOf(longPlan, step)
  slot.target = target
  slot.teamAllowed = alive % 2 == 0 && target == alive / 2 && teamRounds < 1
  return slot
}

// packages/sim/src/season/plan.ts:59-69: a cut or playoff keeps the nominal step.
export function advanceCursor(
  step: i32, teamRounds: i32, roundIndex: i32, slot: RoundSlot, qualified: i32, wasTeam: bool,
): CursorAdvance {
  const out = new CursorAdvance()
  const stay = slot.playoff || slot.cut
  out.step = stay ? step : step + 1
  out.alive = qualified
  out.teamRounds = teamRounds + (wasTeam ? 1 : 0)
  out.roundIndex = roundIndex + 1
  return out
}

// packages/sim/src/season/scheduler.ts:33-61.
export function chooseCandidates(
  catalog: StaticArray<SchedMap>, slot: RoundSlot, state: ScheduleState, used: StaticArray<i32>, k: i32,
): StaticArray<i32> {
  const pool = new StaticArray<i32>(catalog.length)
  let pooled = 0
  for (let i: i32 = 0; i < catalog.length; i++) {
    const map = catalog[i]
    if (slot.cut) {
      if (!map.cut) continue
    } else if ((map.stages & stageBit(slot.stage)) == 0) continue
    if (slot.final ? map.index != state.finalMap : map.index == state.finalMap) continue
    if (map.team && !slot.teamAllowed) continue
    if (forbiddenAdjacency(state.previous, map.index)) continue
    pool[pooled++] = i
  }
  if (pooled == 0) fail('no eligible map for this show slot; build or load a map of that stage')

  const unused = new StaticArray<i32>(pooled)
  let unusedCount = 0
  for (let i: i32 = 0; i < pooled; i++) {
    if (!isUsed(used, catalog[pool[i]].index)) unused[unusedCount++] = pool[i]
  }
  const eligible = new StaticArray<i32>(pooled)
  let eligibleCount = 0
  for (let i: i32 = 0; i < unusedCount; i++) {
    if (catalog[unused[i]].kind != state.lastKind) eligible[eligibleCount++] = unused[i]
  }
  if (eligibleCount == 0) {
    for (let i: i32 = 0; i < unusedCount; i++) eligible[eligibleCount++] = unused[i]
  }
  if (eligibleCount == 0) {
    for (let i: i32 = 0; i < pooled; i++) eligible[eligibleCount++] = pool[i]
  }

  const rng = new Mulberry(state.rngState)
  for (let i: i32 = eligibleCount - 1; i > 0; i--) {
    const j = rng.int(0, i)
    const swap = eligible[i]
    eligible[i] = eligible[j]
    eligible[j] = swap
  }
  state.rngState = rng.state

  let count = k
  if (slot.final || slot.cut || slot.playoff) count = 1
  if (count > eligibleCount) count = eligibleCount
  if (count < 1) count = 1
  const chosen = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) chosen[i] = catalog[eligible[i]].index
  return chosen
}

// packages/sim/src/season/scheduler.ts:63-77.
export function resolveVote(
  candidates: StaticArray<i32>, votes: StaticArray<i32>, seed: u32, roundIndex: i32,
): i32 {
  const count = candidates.length
  if (count == 0) fail('provide at least one candidate before resolving a vote')
  const counts = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < votes.length; i++) {
    const choice = votes[i]
    if (choice >= 0 && choice < count) counts[choice] = counts[choice] + 1
  }
  let winner = 0
  for (let i: i32 = 1; i < count; i++) {
    if (counts[i] > counts[winner] ||
        (counts[i] == counts[winner] &&
         showSeedOrder(seed, roundIndex, i) < showSeedOrder(seed, roundIndex, winner))) {
      winner = i
    }
  }
  return candidates[winner]
}

// packages/sim/src/season/scheduler.ts:79-81.
export function commitMap(state: ScheduleState, mapIndex: i32, mapKind: i32): void {
  state.lastKind = mapKind
  state.previous = mapIndex
}

// Plan and catalog state stay in indexed schema child rows; the row index is the committed order.
export function readPlan(owner: u32): StaticArray<u32> {
  const rows = readColumn<ShowPlanEntry>(ShowPlanEntry.ID, ShowPlanEntry.SIZE)
  const order = new StaticArray<i32>(<i32>rows.count)
  let count = 0
  for (let i: u32 = 0; i < rows.count; i++) {
    if (rows.at(i).owner != owner) continue
    order[count++] = <i32>i
  }
  for (let i: i32 = 1; i < count; i++) {
    const key = order[i]
    let j = i - 1
    while (j >= 0 && rows.at(<u32>order[j]).index > rows.at(<u32>key).index) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
  const plan = new StaticArray<u32>(count)
  for (let i: i32 = 0; i < count; i++) {
    const row = rows.at(<u32>order[i])
    if (i > 0 && row.index == rows.at(<u32>order[i - 1]).index) fail('duplicate show_plan_entry index')
    plan[i] = row.nominal
  }
  return plan
}

export function readCatalog(owner: u32): StaticArray<SchedMap> {
  const rows = readColumn<ShowCatalogEntry>(ShowCatalogEntry.ID, ShowCatalogEntry.SIZE)
  const order = new StaticArray<i32>(<i32>rows.count)
  let count = 0
  for (let i: u32 = 0; i < rows.count; i++) {
    if (rows.at(i).owner != owner) continue
    order[count++] = <i32>i
  }
  for (let i: i32 = 1; i < count; i++) {
    const key = order[i]
    let j = i - 1
    while (j >= 0 && rows.at(<u32>order[j]).index > rows.at(<u32>key).index) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
  const catalog = new StaticArray<SchedMap>(count)
  for (let i: i32 = 0; i < count; i++) {
    const row = rows.at(<u32>order[i])
    if (i > 0 && row.index == rows.at(<u32>order[i - 1]).index) fail('duplicate show_catalog_entry index')
    const map = new SchedMap()
    map.index = <i32>row.index
    map.course = row.course
    map.kind = <i32>row.kind
    map.finalRule = <i32>row.final_rule
    map.stages = row.stages
    map.team = row.team != 0
    map.cut = row.cut != 0
    catalog[i] = map
  }
  return catalog
}

export function readUsedMaps(owner: u32): StaticArray<i32> {
  const rows = readColumn<ShowUsedMap>(ShowUsedMap.ID, ShowUsedMap.SIZE)
  const order = new StaticArray<i32>(<i32>rows.count)
  let count = 0
  for (let i: u32 = 0; i < rows.count; i++) {
    if (rows.at(i).owner != owner) continue
    order[count++] = <i32>i
  }
  for (let i: i32 = 1; i < count; i++) {
    const key = order[i]
    let j = i - 1
    while (j >= 0 && rows.at(<u32>order[j]).index > rows.at(<u32>key).index) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
  const used = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) used[i] = <i32>rows.at(<u32>order[i]).map
  return used
}
