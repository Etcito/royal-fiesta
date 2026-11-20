import { newRecord, readColumn, setComponent, spawn, tick } from 'ege'
import { ShowCandidate, ShowPresentation, ShowSeasonCursor, ShowUsedMap, ShowVote } from '../components.gen'
import {
  Mulberry, ScheduleState, chooseCandidates, commitMap, hasFinal, nextSlotForPlan, readCatalog, readPlan,
  readUsedMaps, reserveFinal, resolveVote,
} from './scheduler.as'

// The season script keeps only the scheduling half of G7.2 alive: it preselects the final once, offers
// this round's candidates, commits the voted map and leaves round closure to the ledger share. All state
// is in show_season_cursor, show_plan_entry, show_catalog_entry, show_candidate, show_vote and
// show_used_map rows.

function fail(message: string): void {
  abort(message, 'scripts/ege/show/season.as.ts', 0, 0)
}

function readCandidates(owner: u32, roundIndex: i32): StaticArray<i32> {
  const rows = readColumn<ShowCandidate>(ShowCandidate.ID, ShowCandidate.SIZE)
  const order = new StaticArray<i32>(<i32>rows.count)
  let count = 0
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner != owner || <i32>row.round_index != roundIndex) continue
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
  const candidates = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) candidates[i] = <i32>rows.at(<u32>order[i]).map
  return candidates
}

function readVotes(owner: u32, roundIndex: i32): StaticArray<i32> {
  const rows = readColumn<ShowVote>(ShowVote.ID, ShowVote.SIZE)
  const order = new StaticArray<i32>(<i32>rows.count)
  let count = 0
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner != owner || <i32>row.round_index != roundIndex) continue
    order[count++] = <i32>i
  }
  for (let i: i32 = 1; i < count; i++) {
    const key = order[i]
    let j = i - 1
    while (j >= 0 && rows.at(<u32>order[j]).seat > rows.at(<u32>key).seat) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = key
  }
  const votes = new StaticArray<i32>(count)
  for (let i: i32 = 0; i < count; i++) votes[i] = rows.at(<u32>order[i]).choice
  return votes
}

function writeCandidates(owner: u32, roundIndex: i32, ids: StaticArray<i32>): void {
  for (let i: i32 = 0; i < ids.length; i++) {
    const row = newRecord<ShowCandidate>(ShowCandidate.SIZE)
    row.owner = owner
    row.round_index = <u32>roundIndex
    row.index = <u32>i
    row.map = <u32>ids[i]
    setComponent<ShowCandidate>(spawn(), ShowCandidate.ID, ShowCandidate.SIZE, row)
  }
}

function writeUsedMap(owner: u32, index: i32, map: i32): void {
  const row = newRecord<ShowUsedMap>(ShowUsedMap.SIZE)
  row.owner = owner
  row.index = <u32>index
  row.map = <u32>map
  setComponent<ShowUsedMap>(spawn(), ShowUsedMap.ID, ShowUsedMap.SIZE, row)
}

/**
 * Handoff: G7.2 Rules, season and results: close every round kind (#9079) and G7.2 Rules, season and
 * results: implement show clocks and hub scripts (#9081) call `rf_show_season` once per rules tick after
 * their own state exists. It reads the single `show_season_cursor` row with its `show_plan_entry`, `show_catalog_entry`,
 * `show_candidate`, `show_vote` and `show_used_map` children, reserves the seeded final on the first
 * tick, writes up to three candidate rows per ordinary round, commits a one-candidate final/cut or the
 * vote winner into the next used-map row, and stores every RNG transition in `rng_state`. It does not
 * write `show_round_result`; `advanceCursor` and `chooseCandidates` in scripts/ege/show/scheduler.as.ts
 * are the pure entries the ledger uses to settle a round and plan a playoff.
 */
export function rf_show_season(): void {
  const cursors = readColumn<ShowSeasonCursor>(ShowSeasonCursor.ID, ShowSeasonCursor.SIZE)
  if (cursors.count == 0) return
  if (cursors.count > 1) fail('a rules world has one show_season_cursor row')
  const owner = cursors.entity(0)
  const cursor = cursors.at(0)
  const plan = readPlan(owner)
  if (plan.length == 0) fail('a show season needs show_plan_entry rows')
  const catalog = readCatalog(owner)
  if (catalog.length == 0) fail('a show season needs show_catalog_entry rows')
  const roundIndex = <i32>cursor.round_index
  const used = readUsedMaps(owner)
  const presentations = readColumn<ShowPresentation>(ShowPresentation.ID, ShowPresentation.SIZE)
  if (presentations.count > 1) fail('a rules world has one show_presentation row')
  // With a presentation row, the season only plans the displayed round while it shows vote.
  // The scheduler cursor may already describe a later round during results, so it is not enough.
  if (presentations.count == 1) {
    const shown = presentations.at(0)
    if (shown.screen != 0) return
    if (<i32>shown.round_index != roundIndex) return
  }

  if (cursor.final_map < 0 && roundIndex == 0 && cursor.step == 0 && used.length == 0 &&
      readCandidates(owner, roundIndex).length == 0 && hasFinal(catalog)) {
    const rng = new Mulberry(cursor.rng_state)
    cursor.final_map = reserveFinal(catalog, rng)
    cursor.rng_state = rng.state
    cursors.write()
  }

  const slot = nextSlotForPlan(plan, <i32>cursor.step, <i32>cursor.alive, <i32>cursor.team_rounds)
  if (slot == null) return
  if (used.length > roundIndex) return

  const candidates = readCandidates(owner, roundIndex)
  if (candidates.length == 0) {
    const state = new ScheduleState()
    state.finalMap = cursor.final_map
    state.lastKind = cursor.last_kind
    state.previous = cursor.previous
    state.rngState = cursor.rng_state
    const ids = chooseCandidates(catalog, slot, state, used, 3)
    writeCandidates(owner, roundIndex, ids)
    cursor.rng_state = state.rngState
    cursors.write()
    return
  }

  let selected = candidates[0]
  if (candidates.length > 1) {
    const votes = readVotes(owner, roundIndex)
    if (presentations.count == 1) {
      // Replacement votes stay open until the stored deadline; abstentions resolve like votes.
      const shown = presentations.at(0)
      if (<i32>tick() < <i32>(shown.entered_tick + shown.vote_ticks)) return
    } else if (votes.length == 0) {
      return
    }
    selected = resolveVote(candidates, votes, cursor.rng_state, roundIndex)
  }

  let mapRow = -1
  for (let i: i32 = 0; i < catalog.length; i++) {
    if (catalog[i].index == selected) {
      mapRow = i
      break
    }
  }
  if (mapRow < 0) fail('a show candidate is missing from show_catalog_entry')
  const state = new ScheduleState()
  state.lastKind = cursor.last_kind
  state.previous = cursor.previous
  commitMap(state, selected, catalog[mapRow].kind)
  cursor.last_kind = state.lastKind
  cursor.previous = state.previous
  writeUsedMap(owner, used.length, selected)
  cursors.write()
}
