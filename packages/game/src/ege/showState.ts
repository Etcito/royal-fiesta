import { schemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import type { RecordValues, WorldState } from '@etcito/game-engine/world-state'
import { ROUND_KINDS } from '@royal-fiesta/sim/season/kinds'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { EngineRoundResult, EngineShowConfig, EngineShowSnapshot } from './showTypes.ts'

const screens = ['vote', 'loading', 'intro', 'playing', 'overtime', 'results', 'podium', 'done'] as const
const reasons = ['target', 'timeCap', 'lastStanding', 'allFell', 'overtime', 'teamWin', 'score', 'crown', 'playoff'] as const
const required = ['show_season_cursor', 'show_presentation', 'show_roster_entry', 'show_candidate', 'show_round_result', 'show_result_seat', 'show_result_team']

function fail(path: string, problem: string): never {
  return refuse('ege-show-state', path, `${problem}; repair the authoritative rules world or its schema`)
}
function number(row: RecordValues, field: string, min = 0, max = 0xffffffff): number {
  const value = row[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(field, 'invalid stored integer')
  return value
}
function rows(state: WorldState, name: string): [number, RecordValues][] {
  const component = state.components[name]
  if (!component) fail(name, 'missing required component declaration')
  return Object.entries(component).map(([id, row]) => [Number(id), row])
}
function ordered<T>(entries: { position: number; value: T }[], count: number, path: string): T[] {
  if (entries.length !== count) fail(path, 'stored count does not match rows')
  const result = new Array<T>(count)
  const seen = new Set<number>()
  for (const { position, value } of entries) {
    if (position >= count || seen.has(position)) fail(path, 'positions must be unique and contiguous')
    seen.add(position)
    result[position] = value
  }
  return result
}
function seat(row: RecordValues, field: string): number { return number(row, field, 0, 59) }
function unique(values: number[], path: string): number[] {
  if (new Set(values).size !== values.length) fail(path, 'duplicate room seat')
  return values
}
function read(config: EngineShowConfig, world: number, confirmedTick: number) {
  if (!Number.isSafeInteger(confirmedTick) || confirmedTick < 0) fail('confirmedTick', 'expected a nonnegative integer')
  const layout = schemaLayout(config.engine)
  if (layout.key !== config.identity.schemaKey || config.identity.backend !== 'engine' || !config.identity.moduleKey) fail('identity', 'loaded schema does not match publication identity')
  for (const name of required) if (!layout.components.some(c => c.name === name && c.lane === 'simulation')) fail(name, 'missing required schema component')
  const bytes = config.engine.snapshot(world)
  const kind = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true)
  if (layout.world_kinds[kind]?.name !== 'show_rules') fail('world', 'expected a show_rules world')
  const state = readWorldState(config.engine, world, layout)
  const cursors = rows(state, 'show_season_cursor')
  const presentations = rows(state, 'show_presentation')
  if (cursors.length !== 1 || presentations.length !== 1) fail('show_presentation', 'expected one cursor and one presentation')
  const owner = cursors[0][0]
  const presentation = presentations[0][1]
  if (number(presentation, 'owner') !== owner) fail('show_presentation.owner', 'presentation does not belong to cursor')
  const round = number(presentation, 'round_index')
  const screen = screens[number(presentation, 'screen', 0, screens.length - 1)]
  const resultIndex = number(presentation, 'result_index', -1, 0x7fffffff)
  const rosterRows = rows(state, 'show_roster_entry').filter(([, r]) => number(r, 'owner') === owner)
  const roster = (list: number, count: number) => unique(ordered(rosterRows.filter(([, r]) => number(r, 'list', 0, 1) === list).map(([, r]) => ({ position: number(r, 'position'), value: seat(r, 'room_seat') })), count, 'show_roster_entry'), 'show_roster_entry')
  const seatOf = roster(0, number(presentation, 'seat_count', 0, 60))
  const alive = roster(1, number(presentation, 'alive_count', 0, 60))
  const candidateRows = rows(state, 'show_candidate').filter(([, r]) => number(r, 'owner') === owner && number(r, 'round_index') === round)
  const candidates = ordered(candidateRows.map(([, r]) => ({ position: number(r, 'index'), value: catalog(config, number(r, 'map')).id })), candidateRows.length, 'show_candidate')
  const resultRows = rows(state, 'show_round_result').filter(([, r]) => number(r, 'owner') === owner)
  const decoded = resultRows.map(([, r]) => decodeResult(config, state, owner, r)).sort((a, b) => a.index - b.index)
  if (new Set(decoded.map(r => r.index)).size !== decoded.length) fail('show_round_result.index', 'duplicate result index')
  if (resultIndex !== -1 && !decoded.some(r => r.index === resultIndex)) fail('show_presentation.result_index', 'current result is missing')
  return { tick: number(presentation, 'tick'), round, screen, seatOf, alive, candidates, decoded, resultIndex }
}
function catalog(config: EngineShowConfig, index: number) {
  const entry = config.season[index]
  if (!entry || typeof entry.id !== 'string' || !entry.id) fail('catalog', `invalid map index ${index}`)
  return entry
}
function decodeResult(config: EngineShowConfig, state: WorldState, owner: number, row: RecordValues): EngineRoundResult {
  const index = number(row, 'index')
  const map = catalog(config, number(row, 'map'))
  const courseIndex = number(row, 'course')
  const course = config.courses[courseIndex]
  if (!course || typeof course.id !== 'string' || !course.id || map.course !== courseIndex) fail('show_round_result.course', 'invalid or inconsistent course index')
  const kind = ROUND_KINDS[number(row, 'kind', 0, ROUND_KINDS.length - 1)]
  const reason = reasons[number(row, 'reason', 0, reasons.length - 1)]
  const final = number(row, 'final', 0, 1) === 1
  const playoff = number(row, 'playoff', 0, 1) === 1
  const childRows = rows(state, 'show_result_seat').filter(([, r]) => number(r, 'owner') === owner && number(r, 'result') === index)
  const list = (id: number, count: number) => ordered(childRows.filter(([, r]) => number(r, 'list', 0, 3) === id).map(([, r]) => ({ position: number(r, 'position'), value: { seat: seat(r, 'seat'), points: number(r, 'points', -0x80000000, 0x7fffffff) } })), count, 'show_result_seat')
  const ranking = list(0, number(row, 'ranking_count', 0, 60))
  const qualified = list(1, number(row, 'qualified_count', 0, 60))
  const eliminated = list(2, number(row, 'eliminated_count', 0, 60))
  const teamRows = rows(state, 'show_result_team').filter(([, r]) => number(r, 'owner') === owner && number(r, 'result') === index)
  const teamScores = ordered(teamRows.map(([, r]) => ({ position: number(r, 'team'), value: number(r, 'score', -0x80000000, 0x7fffffff) })), number(row, 'team_count', 0, 60), 'show_result_team')
  return { index, map: map.id, course: course.id, kind, final, playoff, endTick: number(row, 'end_tick', 0, 0x7fffffff), reason,
    ranking: unique(ranking.map(r => r.seat), 'ranking'), qualified: unique(qualified.map(r => r.seat), 'qualified'),
    eliminated: unique(eliminated.map(r => r.seat), 'eliminated'), points: ranking.map(r => r.points), teamScores,
    champion: number(row, 'champion', -1, 59) }
}

/**
 * G7-SHOW-STATE-API: copies authoritative rules records using the loaded layout.
 * Handoff: G7.1 Identity, inputs and world construction: prepare the usable show factory calls readShowState(config: EngineShowConfig, world: number, confirmedTick: number, faults: number) from rulesState with its global rules world, publication identity and catalog.
 * Handoff: G7.2 Rules, season and results: run the local authoritative show calls readShowState(config: EngineShowConfig, world: number, confirmedTick: number, faults: number) from snapshot with its global rules world, publication identity and catalog; readShowRoundResult uses the same state and keys.
 */
export function readShowState(config: EngineShowConfig, world: number, confirmedTick: number, faults: number): EngineShowSnapshot {
  if (!Number.isSafeInteger(faults) || faults < 0) fail('faults', 'expected a nonnegative integer')
  const data = read(config, world, confirmedTick)
  const results = data.decoded.filter(result => confirmedTick > result.endTick)
  const winner = [...results].reverse().find(result => result.champion !== -1)
  return { tick: data.tick, round: data.round, screen: data.screen, seatOf: data.seatOf, alive: data.alive, candidates: data.candidates, results, champion: winner?.champion ?? null, faults }
}

export function readShowRoundResult(config: EngineShowConfig, world: number, confirmedTick: number): EngineRoundResult | null {
  const data = read(config, world, confirmedTick)
  return data.decoded.find(result => result.index === data.resultIndex && confirmedTick > result.endTick) ?? null
}
