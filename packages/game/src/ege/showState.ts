import { schemaLayout } from '@etcito/game-engine/script'
import { decodeRecord, readWorldState } from '@etcito/game-engine/world-state'
import type { RecordValues, WorldState } from '@etcito/game-engine/world-state'
import type { EngineInstance } from '@etcito/game-engine/loader'
import type { SchemaLayout } from '@etcito/game-engine/script'
import { levelOf } from '@royal-fiesta/sim/course'
import type { LevelSpec, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { CourseV1 } from '../courseV1.ts'
import { ROUND_KINDS, STAGE_IDS } from '@royal-fiesta/sim/season/kinds'
import type { FinalRule, RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { EngineRoundResult, EngineShowConfig, EngineShowSnapshot } from './showTypes.ts'

const screens = ['vote', 'loading', 'intro', 'playing', 'overtime', 'results', 'podium', 'done'] as const
const reasons = ['target', 'timeCap', 'lastStanding', 'allFell', 'overtime', 'teamWin', 'score', 'crown', 'playoff'] as const
const required = ['show_season_cursor', 'show_presentation', 'show_roster_entry', 'show_candidate', 'show_round_result', 'show_result_seat', 'show_result_team']
// Every component the decode below reads; the rest of the rules world is not decoded.
const decodedComponents: ReadonlySet<string> = new Set([...required, 'show_used_map', 'show_catalog_entry'])
type ComponentRows = Pick<WorldState, 'components'>

function fail(path: string, problem: string): never {
  return refuse('ege-show-state', path, `${problem}; repair the authoritative rules world or its schema`)
}
function number(row: RecordValues, field: string, min = 0, max = 0xffffffff): number {
  const value = row[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(field, 'invalid stored integer')
  return value
}
function rows(state: ComponentRows, name: string): [number, RecordValues][] {
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

const layouts = new WeakMap<EngineInstance, SchemaLayout>()

/**
 * The engine's parsed schema layout, parsed once per engine instance. An engine holds one schema for its
 * lifetime (a schema change is a deliberate restart with a new engine), so the cached layout cannot go stale.
 */
export function showSchemaLayout(engine: EngineInstance): SchemaLayout {
  let layout = layouts.get(engine)
  if (layout === undefined) {
    layout = schemaLayout(engine)
    layouts.set(engine, layout)
  }
  return layout
}

type ShowData = ReturnType<typeof decode>
const memos = new WeakMap<EngineShowConfig, { world: number; bytes: Uint8Array; data: ShowData }>()

/** Byte equality of two buffers; whole words are compared where both views are word aligned. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let at = 0
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const words = a.length >>> 2
    const x = new Uint32Array(a.buffer, a.byteOffset, words)
    const y = new Uint32Array(b.buffer, b.byteOffset, words)
    for (let i = 0; i < words; i++) if (x[i] !== y[i]) return false
    at = words * 4
  }
  for (let i = at; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** An independent copy of one decoded result: callers never share storage with the memo or with each other. */
function copyResult(result: EngineRoundResult): EngineRoundResult {
  return {
    ...result, ranking: [...result.ranking], qualified: [...result.qualified], eliminated: [...result.eliminated],
    points: [...result.points], teamScores: [...result.teamScores],
  }
}

/** Forgets the memoized rules decode of one show configuration; the next read decodes the world again. */
export function dropShowStateMemo(config: EngineShowConfig): void {
  memos.delete(config)
}

/**
 * The decoded rules world, memoized per show configuration against the world's own snapshot bytes: a step,
 * vote, host patch, rollback, resimulation or a reused world handle changes those bytes and drops the memo,
 * so a memoized read always equals a fresh decode. The memo stays private: every public read returns copies.
 */
function read(config: EngineShowConfig, world: number, confirmedTick: number): ShowData {
  if (!Number.isSafeInteger(confirmedTick) || confirmedTick < 0) fail('confirmedTick', 'expected a nonnegative integer')
  const layout = showSchemaLayout(config.engine)
  if (layout.key !== config.identity.schemaKey || config.identity.backend !== 'engine' || !config.identity.moduleKey) fail('identity', 'loaded schema does not match publication identity')
  const bytes = config.engine.snapshot(world)
  const memo = memos.get(config)
  if (memo !== undefined && memo.world === world && sameBytes(memo.bytes, bytes)) return memo.data
  memos.delete(config)
  const copy = bytes.slice()
  const data = decode(config, world, layout, copy)
  memos.set(config, { world, bytes: copy, data })
  return data
}

/**
 * The rows of the components this reader uses, decoded from an EGW1 snapshot with the same block walk and
 * record decoder as the engine's readWorldState (simulation-lane components sorted by id). A snapshot the walk
 * does not recognise returns null and the caller uses readWorldState, which reports the format error.
 */
function readComponents(bytes: Uint8Array, layout: SchemaLayout): ComponentRows | null {
  if (bytes.byteLength < 48 || bytes[0] !== 0x45 || bytes[1] !== 0x47 || bytes[2] !== 0x57 || bytes[3] !== 0x31) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const components: WorldState['components'] = {}
  let at = 48 + view.getUint32(24, true) * 4
  for (const decl of layout.components.filter(c => c.lane === 'simulation').sort((a, b) => a.id - b.id)) {
    if (at + 8 > bytes.byteLength) return null
    const count = view.getUint32(at, true)
    const recordSize = view.getUint32(at + 4, true)
    const first = at + 8 + count * 4
    if (recordSize !== decl.size || first + count * recordSize > bytes.byteLength) return null
    if (decodedComponents.has(decl.name)) {
      const block: Record<string, RecordValues> = {}
      for (let i = 0; i < count; i++) {
        const start = first + i * recordSize
        block[String(view.getUint32(at + 8 + i * 4, true))] = decodeRecord(decl, bytes.subarray(start, start + recordSize))
      }
      components[decl.name] = block
    }
    at = first + count * recordSize
  }
  return { components }
}

function decode(config: EngineShowConfig, world: number, layout: SchemaLayout, bytes: Uint8Array) {
  for (const name of required) if (!layout.components.some(c => c.name === name && c.lane === 'simulation')) fail(name, 'missing required schema component')
  const kind = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true)
  if (layout.world_kinds[kind]?.name !== 'show_rules') fail('world', 'expected a show_rules world')
  const state = readComponents(bytes, layout) ?? readWorldState(config.engine, world, layout)
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
  const used = new Map<number, number>()
  for (const [, row] of rows(state, 'show_used_map').filter(([, r]) => number(r, 'owner') === owner)) {
    const index = number(row, 'index')
    if (used.has(index)) fail('show_used_map.index', 'duplicate committed map index')
    used.set(index, number(row, 'map'))
  }
  const committed = new Map<number, RecordValues>()
  for (const [, row] of rows(state, 'show_catalog_entry').filter(([, r]) => number(r, 'owner') === owner)) {
    const index = number(row, 'index')
    if (committed.has(index)) fail('show_catalog_entry.index', 'duplicate committed catalog index')
    committed.set(index, row)
  }
  return { tick: number(presentation, 'tick'), round, screen, seatOf, alive, candidates, decoded, resultIndex, used, committed }
}
function catalog(config: EngineShowConfig, index: number) {
  const entry = config.season[index]
  if (!entry || typeof entry.id !== 'string' || !entry.id) fail('catalog', `invalid map index ${index}`)
  return entry
}
function decodeResult(config: EngineShowConfig, state: ComponentRows, owner: number, row: RecordValues): EngineRoundResult {
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
  const results = data.decoded.filter(result => confirmedTick > result.endTick).map(copyResult)
  const winner = [...results].reverse().find(result => result.champion !== -1)
  return { tick: data.tick, round: data.round, screen: data.screen, seatOf: [...data.seatOf], alive: [...data.alive], candidates: [...data.candidates], results, champion: winner?.champion ?? null, faults }
}

export function readShowRoundResult(config: EngineShowConfig, world: number, confirmedTick: number): EngineRoundResult | null {
  const data = read(config, world, confirmedTick)
  const result = data.decoded.find(entry => entry.index === data.resultIndex && confirmedTick > entry.endTick)
  return result === undefined ? null : copyResult(result)
}

/** The script-committed map/course selection of one round, decoded from the rules world only. */
export interface EngineShowSelection {
  readonly round: number
  readonly mapIndex: number
  readonly mapId: string
  readonly map: SchedMap
  readonly courseIndex: number
  readonly course: CourseV1
  readonly courseData: ResolvedCourse
  readonly level: LevelSpec
  readonly kind: RoundKind
  readonly finalRule: FinalRule | null
}

const FINAL_RULE_RANK = { none: 0, crown: 1, lastStanding: 2 } as const

function finalRank(rule: SchedMap['finalRule']): number {
  return rule === null ? FINAL_RULE_RANK.none : FINAL_RULE_RANK[rule]
}

function stageMask(stages: readonly string[]): number {
  let mask = 0
  for (const stage of stages) mask |= 1 << STAGE_IDS.indexOf(stage as (typeof STAGE_IDS)[number])
  return mask >>> 0
}

function committedMap(config: EngineShowConfig, data: ReturnType<typeof read>, round: number): EngineShowSelection {
  const mapIndex = data.used.get(round)
  if (mapIndex === undefined) {
    fail(`show_used_map/${round}`, 'the round has no committed map selection; let the season script commit it before loading')
  }
  const map = catalog(config, mapIndex)
  const entry = data.committed.get(mapIndex)
  if (!entry) fail(`show_catalog_entry/${mapIndex}`, 'the committed map is missing from the catalog; repair the rules scene')
  const courseIndex = number(entry, 'course')
  if (courseIndex !== map.course) fail(`show_catalog_entry/${mapIndex}/course`, 'committed course differs from the season catalog')
  if (number(entry, 'kind') !== ROUND_KINDS.indexOf(map.kind)) fail(`show_catalog_entry/${mapIndex}/kind`, 'committed kind differs from the season catalog')
  if (number(entry, 'final_rule') !== finalRank(map.finalRule)) fail(`show_catalog_entry/${mapIndex}/final_rule`, 'committed final rule differs from the season catalog')
  if (number(entry, 'stages') !== stageMask(map.stages)) fail(`show_catalog_entry/${mapIndex}/stages`, 'committed stages differ from the season catalog')
  if (number(entry, 'team', 0, 1) !== (map.team ? 1 : 0)) fail(`show_catalog_entry/${mapIndex}/team`, 'committed team flag differs from the season catalog')
  if (number(entry, 'cut', 0, 1) !== (map.cut ? 1 : 0)) fail(`show_catalog_entry/${mapIndex}/cut`, 'committed cut flag differs from the season catalog')
  const course = config.courses[courseIndex]
  if (!course) fail(`courses/${courseIndex}`, 'the selected course is not part of the show configuration; add it to config.courses')
  if (course.sim === null) fail(`courses/${course.id}.course.json`, 'the selected course has no simulation data; select a playable course')
  return {
    round, mapIndex, mapId: map.id, map, courseIndex, course,
    courseData: course.sim, level: levelOf(course.sim), kind: map.kind, finalRule: map.finalRule,
  }
}

/**
 * G7-RUNTIME-PRESENTATION selection reader: decodes the round's script-committed `show_used_map` row and
 * its `show_catalog_entry` record, cross-checks both against the configured season catalog and refuses a
 * missing or inconsistent selection. It never derives a choice from candidates and never falls back to the
 * first configured map.
 */
export function readShowSelection(config: EngineShowConfig, world: number, confirmedTick: number, round: number): EngineShowSelection {
  const data = read(config, world, confirmedTick)
  return committedMap(config, data, round)
}
