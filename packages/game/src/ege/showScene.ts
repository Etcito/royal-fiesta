import type { EgeScene } from '@etcito/game-engine'
import { assemblyScene, buildAssembly } from '@etcito/game-engine/formats'
import { schemaLayout } from '@etcito/game-engine/script'
import type { ZoneGrid } from '@etcito/game-engine/zones'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { legacyLevel } from '@royal-fiesta/sim/course'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { refuse } from '@royal-fiesta/sim/refusal'
import { ROUND_KINDS, STAGE_IDS } from '@royal-fiesta/sim/season/kinds'
import { NO_BACK_TO_BACK } from '@royal-fiesta/sim/season/scheduler'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import type { CourseV1 } from '../courseV1.ts'
import { emitEngineScene, SHOW_ROOM_SEAT_LAST } from './sceneEmitter.ts'
import type { EmittedScene } from './sceneEmitter.ts'
import type { EngineShowConfig } from './showTypes.ts'

export interface ShowPhysicsScenes {
  seat: EmittedScene
  field: EmittedScene
  grid: ZoneGrid
}

// The show uses the sprint profile: G7 keeps the fixed 60 Hz cadence and the existing intro ticks.
const SHOW_PROFILE: ProfileName = 'sprint'
const DEFAULT_PLAN = [60, 40, 24, 12, 6, 1] as const
const DEFAULT_VOTE_TICKS = 300
const DEFAULT_RESULTS_TICKS = 90
const DEFAULT_PODIUM_TICKS = 150
const FINAL_RULE_RANK = { none: 0, crown: 1, lastStanding: 2 } as const
const FINAL_RULES = ['crown', 'lastStanding'] as const
const SHOW_WORLD_KINDS = ['show_seat', 'show_field', 'show_hub', 'show_rules'] as const
type ShowWorldKind = (typeof SHOW_WORLD_KINDS)[number]

/** Packed show_catalog_entry.cut: bit 0 = cut flag, bits 8.. = (index of the banned predecessor) + 1. */
export function catalogCutField(season: readonly SchedMap[], index: number): number {
  const map = season[index]
  let predecessor = -1
  for (const [before, after] of NO_BACK_TO_BACK) {
    if (after !== map.id) continue
    const at = season.findIndex(entry => entry.id === before)
    if (at < 0) continue
    if (predecessor >= 0) fail(`season/${index}`, 'has two banned predecessors; keep at most one NO_BACK_TO_BACK pair per map')
    predecessor = at
  }
  return ((map.cut ? 1 : 0) | ((predecessor + 1) << 8)) >>> 0
}

function fail(path: string, problem: string): never {
  return refuse('ege-show-scene', path, problem)
}

function requireEngine(config: EngineShowConfig, kinds: readonly ShowWorldKind[]): void {
  if (config.identity.backend !== 'engine' || !config.identity.moduleKey) {
    fail('identity', 'expected an engine publication identity with a module key; load the compiled engine build')
  }
  if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) {
    fail('seed', `invalid seed ${config.seed}; use an integer in 0..4294967295`)
  }
  let layout
  try {
    layout = schemaLayout(config.engine)
  } catch {
    fail('engine', 'the engine holds no schema; load the show schema before constructing scenes')
  }
  if (layout.key !== config.identity.schemaKey) {
    fail('identity.schemaKey', `loaded schema key ${layout.key} differs from the publication key ${config.identity.schemaKey}; load the matching schema`)
  }
  for (const kind of kinds) {
    if (!layout.world_kinds.some(entry => entry.name === kind)) {
      fail('schema', `the loaded schema has no '${kind}' world kind; regenerate the engine schema`)
    }
  }
}

function resolveCourse(config: EngineShowConfig, course: CourseV1): ResolvedCourse {
  if (!config.courses.includes(course)) {
    fail('course', `course '${course.id}' is not part of the show configuration; pass a resolved config.courses entry`)
  }
  if (course.sim === null) {
    fail(`courses/${course.id}.course.json`, 'has no simulation or content data; pass a playable show course')
  }
  return course.sim
}

function requireAssets(config: EngineShowConfig, course: CourseV1): void {
  for (const assetId of course.assetIds) {
    if (!config.assets.has(assetId)) {
      fail(`courses/${course.id}.course.json#/assets/${assetId}`, `missing the resolved asset '${assetId}'; resolve every course asset before construction`)
    }
  }
}

function gridOf(config: EngineShowConfig, course: CourseV1): ZoneGrid {
  const zones = config.zones.get(course.id)
  if (!zones) {
    fail(`courses/${course.id}.zones.json`, 'missing the validated zone sidecar; add it before constructing show worlds')
  }
  const { origin, cell, cols, rows } = zones.grid
  const cellSize = cell[0]
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1 ||
      !Number.isFinite(cellSize) || cellSize <= 0 || !Number.isFinite(cell[1]) || cell[1] <= 0 ||
      !Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) {
    fail(`courses/${course.id}.zones.json#/grid`, 'invalid grid; provide positive integer cols/rows, positive metre cells and finite origins')
  }
  if (cell[0] !== cell[1]) {
    fail(`courses/${course.id}.zones.json#/grid/cell`, `non-square cells ${cell[0]}x${cell[1]}; the engine grid takes one metre cell size`)
  }
  return { cols, rows, cellSize, originX: origin[0], originZ: origin[1] }
}

function humansOf(config: EngineShowConfig): readonly boolean[] {
  const humans = config.humans
  if (!Array.isArray(humans) || humans.length < 1 || humans.length > SHOW_ROOM_SEAT_LAST + 1) {
    fail('humans', `has ${humans?.length ?? 0} entries; pass one boolean per configured room seat (1..${SHOW_ROOM_SEAT_LAST + 1})`)
  }
  for (let i = 0; i < humans.length; i++) {
    if (typeof humans[i] !== 'boolean') fail(`humans/${i}`, 'must be a boolean; mark each configured room seat human or bot')
  }
  return humans
}

function requireHuman(config: EngineShowConfig, roomSeat: number): void {
  humansOf(config)
  if (!Number.isInteger(roomSeat) || roomSeat < 0 || roomSeat > SHOW_ROOM_SEAT_LAST || roomSeat >= config.humans.length) {
    fail('roomSeat', `invalid room seat ${roomSeat}; use a configured integer in 0..${config.humans.length - 1}`)
  }
  if (config.humans[roomSeat] !== true) {
    fail(`humans/${roomSeat}`, `room seat ${roomSeat} is not a configured human; select a configured human seat`)
  }
}

function validateRoster(config: EngineShowConfig, seatOf: readonly number[], inputSlots: readonly number[]): void {
  humansOf(config)
  if (seatOf.length === 0) fail('seatOf', 'the show roster is empty; provide the ascending surviving seats')
  if (inputSlots.length !== seatOf.length) {
    fail('inputSlots', `has ${inputSlots.length} entries for ${seatOf.length} seats; give one slot per seat`)
  }
  const slots = new Set<number>()
  let previous = -1
  for (let roundSeat = 0; roundSeat < seatOf.length; roundSeat++) {
    const roomSeat = seatOf[roundSeat]
    const slot = inputSlots[roundSeat]
    if (!Number.isInteger(roomSeat) || roomSeat < 0 || roomSeat > SHOW_ROOM_SEAT_LAST || roomSeat <= previous) {
      fail(`seatOf/${roundSeat}`, 'invalid or unordered room seat; provide unique ascending seats in 0..59')
    }
    if (roomSeat >= config.humans.length) {
      fail(`seatOf/${roundSeat}`, `room seat ${roomSeat} has no configured human flag; extend config.humans`)
    }
    const human = config.humans[roomSeat] === true
    if (human) {
      if (!Number.isInteger(slot) || slot < 0 || slot > 7 || slots.has(slot)) {
        fail(`inputSlots/${roundSeat}`, 'invalid or duplicate human slot; use unique slots 0..7 for configured humans')
      }
      slots.add(slot)
    } else if (slot !== -1) {
      fail(`inputSlots/${roundSeat}`, `room seat ${roomSeat} is a bot; use input slot -1`)
    }
    previous = roomSeat
  }
}

function validateSeason(config: EngineShowConfig): readonly SchedMap[] {
  if (!Array.isArray(config.season) || config.season.length === 0) {
    fail('season', 'the show catalog is empty; provide the committed season maps')
  }
  const ids = new Set<string>()
  for (let index = 0; index < config.season.length; index++) {
    const map = config.season[index]
    if (typeof map?.id !== 'string' || map.id.length === 0 || ids.has(map.id)) {
      fail(`season/${index}/id`, 'invalid or duplicate catalog id; give every season map a unique nonempty id')
    }
    ids.add(map.id)
    if (!Number.isInteger(map.course) || map.course < 0 || map.course >= config.courses.length) {
      fail(`season/${index}/course`, `invalid course index ${map.course}; use an index into config.courses`)
    }
    if (!ROUND_KINDS.includes(map.kind)) fail(`season/${index}/kind`, `invalid round kind '${map.kind}'; use a declared round kind`)
    if (map.finalRule !== null && !FINAL_RULES.includes(map.finalRule)) {
      fail(`season/${index}/finalRule`, 'invalid final rule; use null, crown or lastStanding')
    }
    if (!Array.isArray(map.stages) || map.stages.some((stage: string) => !(STAGE_IDS as readonly string[]).includes(stage))) {
      fail(`season/${index}/stages`, 'invalid stage list; use declared stage ids')
    }
    if (typeof map.team !== 'boolean' || typeof map.cut !== 'boolean') {
      fail(`season/${index}`, 'team and cut must be booleans; repair the catalog entry')
    }
  }
  return config.season
}

function planOf(config: EngineShowConfig): readonly number[] {
  const plan = config.plan ?? DEFAULT_PLAN
  if (!Array.isArray(plan) || plan.length === 0) fail('plan', 'the show plan is empty; provide the nominal seat targets')
  for (let i = 0; i < plan.length; i++) {
    if (!Number.isInteger(plan[i]) || plan[i] < 1) fail(`plan/${i}`, `invalid nominal ${plan[i]}; use a positive integer seat target`)
  }
  return plan
}

/**
 * The selected course with the committed season round kind and final rule applied. Authored geometry and
 * every other gameplay setting stay those of the course; only the round variant comes from the catalog.
 */
function roundCourse(course: CourseV1, sim: ResolvedCourse, map: Pick<SchedMap, 'kind' | 'finalRule'>): CourseV1 {
  const level = sim.level ?? legacyLevel(sim)
  return { ...course, sim: { ...sim, level: { ...level, kind: map.kind, finalRule: map.finalRule } } }
}

/**
 * Handoff: G7.1 Identity, inputs and world construction: prepare the usable show factory calls
 * buildShowPhysicsScenes(config, course, seatOf, inputSlots): ShowPhysicsScenes, buildShowRulesScene(
 * config): EgeScene and buildShowHubScene(config, course, roomSeat): EmittedScene from here, then creates
 * the live seat/field/global/hub worlds through the generic EngineDomainFactory. State/keys: the returned
 * ShowPhysicsScenes.seat and ShowPhysicsScenes.field scene templates (EmittedScene.text plus
 * EmittedScene.show metadata), the show-rules EgeScene text, the show_hub EmittedScene and the ZoneGrid
 * built from the selected course's validated sidecar; template entity indices are resolved to live world
 * identities by the factory and never reused as enduring handles.
 */
export function buildShowPhysicsScenes(
  config: EngineShowConfig,
  course: CourseV1,
  seatOf: readonly number[],
  inputSlots: readonly number[],
  round?: Pick<SchedMap, 'kind' | 'finalRule'>,
): ShowPhysicsScenes {
  requireEngine(config, ['show_seat', 'show_field'])
  const sim = resolveCourse(config, course)
  validateRoster(config, seatOf, inputSlots)
  requireAssets(config, course)
  const grid = gridOf(config, course)
  const selected = round === undefined ? course : roundCourse(course, sim, round)
  const seats = seatOf.slice()
  const slots = inputSlots.slice()
  const humans = seats.map(roomSeat => config.humans[roomSeat] === true)
  const setup = { profile: SHOW_PROFILE, seed: config.seed >>> 0 }
  const seat = emitEngineScene(config.engine, {
    course: selected, assets: config.assets, setup,
    show: { worldKind: 'show_seat', seatOf: seats, inputSlots: slots, humans },
  })
  const field = emitEngineScene(config.engine, {
    course: selected, assets: config.assets, setup,
    show: { worldKind: 'show_field', seatOf: seats, inputSlots: slots, humans },
  })
  return { seat, field, grid }
}

function stageMask(stages: readonly string[]): number {
  let mask = 0
  for (const stage of stages) mask |= 1 << STAGE_IDS.indexOf(stage as (typeof STAGE_IDS)[number])
  return mask >>> 0
}

function finalRank(rule: SchedMap['finalRule']): number {
  return rule === null ? FINAL_RULE_RANK.none : FINAL_RULE_RANK[rule]
}

export function buildShowRulesScene(config: EngineShowConfig): EgeScene {
  requireEngine(config, ['show_rules'])
  const humans = humansOf(config)
  const season = validateSeason(config)
  const plan = planOf(config)
  const cursor = 0
  const entities: unknown[] = [
    {
      name: 'show/cursor',
      components: {
        show_season_cursor: {
          owner: cursor, step: 0, alive: humans.length, team_rounds: 0, round_index: 0,
          rng_state: config.seed >>> 0, final_map: -1, last_kind: -1, previous: -1,
        },
      },
    },
  ]
  for (let index = 0; index < plan.length; index++) {
    entities.push({ name: `show/plan/${index}`, components: { show_plan_entry: { owner: cursor, index, nominal: plan[index] } } })
  }
  for (let index = 0; index < season.length; index++) {
    const map = season[index]
    entities.push({
      name: `show/catalog/${index}`,
      components: {
        show_catalog_entry: {
          owner: cursor, index, course: map.course, kind: ROUND_KINDS.indexOf(map.kind),
          final_rule: finalRank(map.finalRule), stages: stageMask(map.stages),
          team: map.team ? 1 : 0, cut: catalogCutField(config.season, index),
        },
      },
    })
  }
  entities.push({
    name: 'show/presentation',
    components: {
      show_presentation: {
        owner: cursor, tick: 0, round_index: 0, screen: 0, entered_tick: 0, result_index: -1,
        seat_count: humans.length, alive_count: humans.length,
        vote_ticks: config.testMode ? 1 : DEFAULT_VOTE_TICKS,
        results_ticks: config.testMode ? 1 : DEFAULT_RESULTS_TICKS,
        podium_ticks: config.testMode ? 1 : DEFAULT_PODIUM_TICKS,
      },
    },
  })
  entities.push({
    name: 'show/lifecycle',
    components: { show_lifecycle_input: { owner: cursor, ready_round: -1, confirmed_tick: 0 } },
  })
  entities.push({
    name: 'show/clock',
    components: {
      show_clock: {
        // The runtime writes the selected course's authored round and overtime caps before acknowledging
        // readiness; the scene only seeds the shared intro duration and never a first-map fallback.
        owner: cursor, start_tick: -1, end_tick: -1, overtime_end_tick: -1, phase: 0, frozen: 0,
        intro_ticks: PROFILES[SHOW_PROFILE].introTicks, round_ticks: 0, overtime_ticks: 0,
      },
    },
  })
  for (const list of [0, 1]) {
    for (let position = 0; position < humans.length; position++) {
      entities.push({
        name: `show/roster/${list}/${position}`,
        components: { show_roster_entry: { owner: cursor, list, position, room_seat: position } },
      })
    }
  }
  const built = assemblyScene(config.engine, buildAssembly({ worldKind: 'show_rules', seed: config.seed >>> 0, entities }))
  return built.scene
}

export function buildShowHubScene(config: EngineShowConfig, course: CourseV1, roomSeat: number): EmittedScene {
  requireEngine(config, ['show_hub'])
  resolveCourse(config, course)
  if (course.kind !== 'hub') {
    fail(`courses/${course.id}.course.json#/kind`, `course '${course.id}' is not a hub course; pass a hub course for the show hub world`)
  }
  requireHuman(config, roomSeat)
  requireAssets(config, course)
  const roster = Array.from({ length: config.humans.length }, (_, index) => index)
  const inputSlots = roster.map(room => (room === roomSeat ? 0 : -1))
  const humans = roster.map(room => room === roomSeat)
  return emitEngineScene(config.engine, {
    course, assets: config.assets, setup: { profile: SHOW_PROFILE, seed: config.seed >>> 0 },
    show: { worldKind: 'show_hub', seatOf: roster, inputSlots, humans },
  })
}
