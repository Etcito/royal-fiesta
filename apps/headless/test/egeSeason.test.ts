import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { engineCodeOfS1 } from '@royal-fiesta/game/ege/inputCodes'
import { emitEngineScene } from '@royal-fiesta/game/ege/sceneEmitter'
import type { EmittedScene } from '@royal-fiesta/game/ege/sceneEmitter'
import { encodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'
import { loadEgeCourse } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

const PROBE_WORLD = 'season_probe'
const CLOCK_WORLD = 'show_clock_probe'
const HUB_WORLD = 'show_hub_probe'
const RULES_PROBE_WORLD = 'show_rules_probe'
const PROBE_FILE = 'probe/season.as.ts'
const PROBE_TEXT = `import { getComponent, isNull, newRecord, readColumn, readResource, setComponent, spawn, tick } from 'ege'
import { Character, EgeTransform, ProbeOut, SeasonParamsRes, ShowHubOccupant, ShowSeasonCursor, ShowVote } from '../components.gen'
import {
  Mulberry, RoundSlot, ScheduleState, advanceCursor, chooseCandidates, nextSlotForPlan, nextTarget,
  readCatalog, readPlan, readUsedMaps, resolveVote,
} from '../show/scheduler.as'
import { rf_show_season } from '../show/season.as'

function emit(code: u32, seq: u32, value: i32): void {
  const row = newRecord<ProbeOut>(ProbeOut.SIZE)
  row.code = code
  row.seq = seq
  row.value = value
  setComponent<ProbeOut>(spawn(), ProbeOut.ID, ProbeOut.SIZE, row)
}

function ownerOf(): u32 {
  const cursors = readColumn<ShowSeasonCursor>(ShowSeasonCursor.ID, ShowSeasonCursor.SIZE)
  if (cursors.count == 0) return 0xffffffff
  return cursors.entity(0)
}

function slotFrom(p: SeasonParamsRes): RoundSlot {
  const slot = new RoundSlot()
  slot.stage = p.stage
  slot.final = p.final != 0
  slot.cut = p.cut != 0
  slot.playoff = p.playoff != 0
  slot.target = p.target
  slot.teamAllowed = p.team_allowed != 0
  return slot
}

export function rf_season_probe(): void {
  const p = readResource<SeasonParamsRes>(SeasonParamsRes.ID, SeasonParamsRes.SIZE)
  if (p.mode == 1) {
    emit(1, 0, nextTarget(p.a, p.b, p.c))
    return
  }
  if (p.mode == 2) {
    const slot = nextSlotForPlan(readPlan(ownerOf()), p.a, p.b, p.c)
    if (slot == null) {
      emit(1, 0, -1)
      return
    }
    emit(1, 0, slot.stage)
    emit(2, 0, slot.target)
    emit(3, 0, slot.final ? 1 : 0)
    emit(4, 0, slot.cut ? 1 : 0)
    emit(5, 0, slot.teamAllowed ? 1 : 0)
    return
  }
  if (p.mode == 3) {
    const out = advanceCursor(p.a, p.b, p.c, slotFrom(p), p.qualified, p.was_team != 0)
    emit(1, 0, out.step)
    emit(2, 0, out.alive)
    emit(3, 0, out.teamRounds)
    emit(4, 0, out.roundIndex)
    return
  }
  if (p.mode == 4) {
    const owner = ownerOf()
    const cursors = readColumn<ShowSeasonCursor>(ShowSeasonCursor.ID, ShowSeasonCursor.SIZE)
    const cursor = cursors.at(0)
    const state = new ScheduleState()
    state.finalMap = cursor.final_map
    state.lastKind = cursor.last_kind
    state.previous = cursor.previous
    state.rngState = cursor.rng_state
    const ids = chooseCandidates(readCatalog(owner), slotFrom(p), state, readUsedMaps(owner), p.k)
    for (let i: i32 = 0; i < ids.length; i++) emit(1, <u32>i, ids[i])
    emit(2, 0, <i32>state.rngState)
    return
  }
  if (p.mode == 5) {
    const candidates = new StaticArray<i32>(<i32>p.candidate_count)
    if (p.candidate_count > 0) candidates[0] = p.candidate0
    if (p.candidate_count > 1) candidates[1] = p.candidate1
    if (p.candidate_count > 2) candidates[2] = p.candidate2
    const votes = new StaticArray<i32>(<i32>p.vote_count)
    if (p.vote_count > 0) votes[0] = p.vote0
    if (p.vote_count > 1) votes[1] = p.vote1
    if (p.vote_count > 2) votes[2] = p.vote2
    if (p.vote_count > 3) votes[3] = p.vote3
    emit(1, 0, resolveVote(candidates, votes, p.seed, p.round_index))
    return
  }
  if (p.mode == 6) {
    rf_show_season()
    return
  }
  if (p.mode == 7) {
    const rng = new Mulberry(p.seed)
    const value = rng.int(p.a, p.b)
    emit(1, 0, value)
    emit(2, 0, <i32>rng.state)
  }
  if (p.mode == 8) {
    const occupants = readColumn<ShowHubOccupant>(ShowHubOccupant.ID, ShowHubOccupant.SIZE)
    const row = occupants.find(<u32>p.a)
    if (row >= 0) {
      const occupant = occupants.at(<u32>row)
      occupant.active = (tick() & 1) == 0 ? 1 : 0
      occupants.write()
    }
  }
  if (p.mode == 9) {
    // Probe instrumentation: copy one seat's engine transform and character flags into sim-lane rows.
    const tr = getComponent<EgeTransform>(<u32>p.a, EgeTransform.ID, EgeTransform.SIZE)
    const characters = readColumn<Character>(Character.ID, Character.SIZE)
    const chRow = characters.find(<u32>p.a)
    if (!isNull<EgeTransform>(tr)) {
      emit(1, <u32>tick(), <i32>Math.round(<f64>tr.pos_2 * 1000.0))
      emit(2, <u32>tick(), <i32>Math.round(<f64>tr.pos_1 * 1000.0))
    }
    if (chRow >= 0) {
      emit(3, <u32>tick(), <i32>characters.at(<u32>chRow).placed)
      emit(4, <u32>tick(), <i32>characters.at(<u32>chRow).parked)
    }
  }
}

export function rf_vote_probe(): void {
  // Replaces one displayed-round vote each tick: an early choice 2, then choice 0 from tick 2.
  const p = readResource<SeasonParamsRes>(SeasonParamsRes.ID, SeasonParamsRes.SIZE)
  const votes = readColumn<ShowVote>(ShowVote.ID, ShowVote.SIZE)
  for (let i: u32 = 0; i < votes.count; i++) {
    const row = votes.at(i)
    if (<i32>row.round_index != 0 || <i32>row.seat != <u32>p.a) continue
    row.choice = tick() >= 2 ? 0 : 2
    votes.write()
    return
  }
  const row = newRecord<ShowVote>(ShowVote.SIZE)
  row.owner = 0
  row.round_index = 0
  row.seat = <u32>p.a
  row.choice = tick() >= 2 ? 0 : 2
  setComponent<ShowVote>(spawn(), ShowVote.ID, ShowVote.SIZE, row)
}
`

const STAGE = { R1: 1, R2: 2, R3: 4, R4: 8, final: 16 } as const
const KIND = { race: 0, survival: 1, team: 2, collection: 3, hunt: 4, logic: 5, final: 6 } as const

interface MapSpec { index: number; kind: number; stages: number; team: boolean; cut: boolean; finalRule: number; after?: number }

// The committed S12 season order A..Q; index is the map id, course mirrors it for the probe.
const CATALOG: MapSpec[] = [
  { index: 0, kind: KIND.team, stages: STAGE.R3, team: true, cut: false, finalRule: 0 },
  { index: 1, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3, team: false, cut: false, finalRule: 0 },
  { index: 2, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
  { index: 3, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
  { index: 4, kind: KIND.race, stages: STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
  { index: 5, kind: KIND.race, stages: STAGE.R1 | STAGE.R2, team: false, cut: true, finalRule: 0 },
  { index: 6, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3, team: false, cut: false, finalRule: 0 },
  { index: 7, kind: KIND.race, stages: STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0, after: 4 },
  { index: 8, kind: KIND.survival, stages: STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
  { index: 9, kind: KIND.survival, stages: STAGE.R3 | STAGE.R4 | STAGE.final, team: false, cut: false, finalRule: 2, after: 8 },
  { index: 10, kind: KIND.survival, stages: STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
  { index: 11, kind: KIND.survival, stages: STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
  { index: 12, kind: KIND.team, stages: STAGE.R3, team: true, cut: false, finalRule: 0 },
  { index: 13, kind: KIND.team, stages: STAGE.R3, team: true, cut: false, finalRule: 0 },
  { index: 14, kind: KIND.collection, stages: STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
  { index: 15, kind: KIND.hunt, stages: STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
  { index: 16, kind: KIND.logic, stages: STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: true, finalRule: 0 },
  { index: 17, kind: KIND.final, stages: STAGE.final, team: false, cut: false, finalRule: 1 },
]

const DEFAULT_PLAN = [60, 40, 24, 12, 6, 1]
const LONG_PLAN = [60, 48, 36, 24, 12, 6, 1]

function mulberryInt(state: number, lo: number, hi: number): { value: number; state: number } {
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  const next = (state + 0x6d2b79f5) >>> 0
  let t = next
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t >>> 7, t | 61)
  const out = (t ^ (t >>> 14)) >>> 0
  return { value: a + Math.floor((out / 4294967296) * (b - a + 1)), state: next }
}

function referenceSeedOrder(seed: number, roundIndex: number, roomSeat: number): number {
  const bytes = new Uint8Array(12)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, seed >>> 0, true)
  view.setUint32(4, roundIndex >>> 0, true)
  view.setUint32(8, roomSeat >>> 0, true)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function probeSchema(base: string): string {
  const schema = JSON.parse(base) as any
  schema.components.push({
    name: 'probe_out',
    fields: [
      { name: 'code', type: 'u32' },
      { name: 'seq', type: 'u32' },
      { name: 'value', type: 'i32' },
    ],
  })
  schema.resources.push({
    name: 'season_params',
    fields: [
      { name: 'mode', type: 'u32' },
      { name: 'a', type: 'i32' },
      { name: 'b', type: 'i32' },
      { name: 'c', type: 'i32' },
      { name: 'k', type: 'i32' },
      { name: 'stage', type: 'i32' },
      { name: 'final', type: 'u32' },
      { name: 'cut', type: 'u32' },
      { name: 'playoff', type: 'u32' },
      { name: 'team_allowed', type: 'u32' },
      { name: 'target', type: 'i32' },
      { name: 'seed', type: 'u32' },
      { name: 'round_index', type: 'i32' },
      { name: 'qualified', type: 'i32' },
      { name: 'was_team', type: 'u32' },
      { name: 'candidate_count', type: 'u32' },
      { name: 'candidate0', type: 'i32' },
      { name: 'candidate1', type: 'i32' },
      { name: 'candidate2', type: 'i32' },
      { name: 'vote_count', type: 'u32' },
      { name: 'vote0', type: 'i32' },
      { name: 'vote1', type: 'i32' },
      { name: 'vote2', type: 'i32' },
      { name: 'vote3', type: 'i32' },
    ],
  })
  schema.world_kinds.push({
    name: PROBE_WORLD,
    players: 8,
    schedule: [{
      system: 'rf.season_probe',
      kind: 'script',
      reads: [
        'show_season_cursor', 'show_plan_entry', 'show_catalog_entry', 'show_candidate', 'show_vote',
        'show_used_map', 'show_presentation', 'season_params',
      ],
      writes: ['show_season_cursor', 'show_candidate', 'show_used_map', 'probe_out'],
      emits: [],
    }],
  })
  // The production rules schedule with one probe that replaces the displayed vote each tick.
  const rules = schema.world_kinds.find((kind: any) => kind.name === 'show_rules')
  schema.world_kinds.push({
    name: RULES_PROBE_WORLD,
    players: 0,
    schedule: [
      ...structuredClone(rules.schedule),
      { system: 'rf.vote_probe', kind: 'script', reads: ['show_vote', 'season_params'], writes: ['show_vote'], emits: [] },
    ],
  })
  // Test-local show schedules: only the systems this card implements plus the existing character
  // and physics steps, so the show clock and hub run without G6 round closure.
  const round = schema.world_kinds.find((kind: any) => kind.name === 'round').schedule
  const entry = (system: string) => structuredClone(round.find((row: any) => row.system === system))
  schema.world_kinds.push({
    name: CLOCK_WORLD,
    players: 8,
    schedule: [{
      system: 'rf.show.clock',
      kind: 'script',
      reads: ['round', 'show_clock'],
      writes: ['show_clock', 'round', 'seat', 'character', 'ege.transform', 'ege.velocity'],
      emits: [],
    }],
  })
  schema.world_kinds.push({
    name: HUB_WORLD,
    players: 1,
    schedule: [
      { system: 'ege.movers', kind: 'engine' },
      {
        system: 'rf.show.hub',
        kind: 'script',
        reads: [
          'course', 'seat', 'character', 'ege.transform', 'show_seat_identity', 'show_control',
          'show_hub_state', 'show_hub_occupant',
        ],
        writes: [
          'show_control', 'show_hub_state', 'show_hub_occupant', 'seat', 'character',
          'ege.transform', 'ege.velocity',
        ],
        emits: [],
      },
      entry('rf.character.pre'),
      { system: 'ege.body.props', kind: 'engine' },
      { system: 'ege.box.collider', kind: 'engine' },
      { system: 'ege.physics', kind: 'engine' },
      { system: 'ege.contact.track', kind: 'engine' },
      entry('rf.character.post'),
      {
        system: 'rf.season_probe',
        kind: 'script',
        reads: ['season_params', 'show_hub_occupant', 'ege.transform', 'character'],
        writes: ['show_hub_occupant', 'probe_out'],
        emits: [],
      },
    ],
  })
  return JSON.stringify(schema)
}

interface ProbeSetup {
  engine: Awaited<ReturnType<typeof loadEngine>>
  layout: ReturnType<typeof schemaLayout>
  wasm: Uint8Array
  schema: string
}

let probeSetup: Promise<ProbeSetup> | null = null

function setup(): Promise<ProbeSetup> {
  probeSetup ??= (async () => {
    const schema = probeSchema(await readRepoText(RF_EGE_SCHEMA))
    const files = [...collectRfScripts(), { name: PROBE_FILE, text: PROBE_TEXT }]
      .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    const result = await (await rfCompiler()).compile(files, schema)
    const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
    assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
    assert.ok(result.wasm)
    const engine = await loadEngine()
    engine.setSchema(schema)
    return { engine, layout: schemaLayout(engine), wasm: result.wasm as Uint8Array, schema }
  })()
  return probeSetup
}

interface SeasonParamsResInput {
  mode: number
  a?: number
  b?: number
  c?: number
  k?: number
  stage?: number
  final?: number
  cut?: number
  playoff?: number
  team_allowed?: number
  target?: number
  seed?: number
  round_index?: number
  qualified?: number
  was_team?: number
  candidate_count?: number
  candidate0?: number
  candidate1?: number
  candidate2?: number
  vote_count?: number
  vote0?: number
  vote1?: number
  vote2?: number
  vote3?: number
}

interface ProbeResult {
  faultCount: number
  faults: string[]
  error: string | null
  rows: { code: number; seq: number; value: number }[]
  state: any | null
}

let moduleSeq = 0

async function runProbe(
  resources: SeasonParamsResInput, entities: any[], ticks = 1,
): Promise<ProbeResult> {
  const { engine, layout, wasm } = await setup()
  const faults: string[] = []
  const name = `rf-season-${moduleSeq++}`
  const module = await loadScript(engine, wasm, {
    name,
    onFault: fault => faults.push(`${fault.system}: ${fault.message}`),
    onLog: line => faults.push(`log ${line}`),
  })
  const host = new ScriptHost(module)
  const scene = {
    format: 'ege.scene',
    version: 1,
    world_kind: PROBE_WORLD,
    seed: 9,
    resources: { season_params: { ...resources } },
    entities,
  }
  const world = engine.createWorld(JSON.stringify(scene))
  let error: string | null = null
  try {
    for (let i = 0; i < ticks; i++) host.stepTick(world, Array(8).fill(0))
  } catch (caught) {
    error = String(caught)
  }
  const rows: { code: number; seq: number; value: number }[] = []
  let state: any = null
  try {
    state = readWorldState(engine, world, layout)
    const output = (state.components as any).probe_out ?? {}
    for (const row of Object.values(output) as any[]) {
      rows.push({ code: Number(row.code), seq: Number(row.seq), value: Number(row.value) })
    }
  } catch (caught) {
    error ??= String(caught)
  }
  const faultCount = module.faultCount
  engine.freeWorld(world)
  module.dispose()
  return { faultCount, faults, error, rows, state }
}

function values(result: ProbeResult, code: number): number[] {
  return result.rows
    .filter(row => row.code === code)
    .sort((a, b) => a.seq - b.seq)
    .map(row => row.value)
}

function faultText(result: ProbeResult): string {
  return [result.error ?? '', ...result.faults].join(' | ')
}

function cursorEntity(over: Record<string, number> = {}): any {
  return {
    components: {
      show_season_cursor: {
        owner: 0, step: 0, alive: 60, team_rounds: 0, round_index: 0, rng_state: 7,
        final_map: -1, last_kind: -1, previous: -1,
        ...over,
      },
    },
  }
}

function planEntities(nominals: number[]): any[] {
  return nominals.map((nominal, index) => ({ components: { show_plan_entry: { owner: 0, index, nominal } } }))
}

function catalogEntities(catalog: MapSpec[] = CATALOG): any[] {
  return catalog.map(map => ({
    components: {
      show_catalog_entry: {
        owner: 0, index: map.index, course: map.index, kind: map.kind,
        final_rule: map.finalRule, stages: map.stages, team: map.team ? 1 : 0, cut: (map.cut ? 1 : 0) | (((map.after ?? -1) + 1) << 8),
      },
    },
  }))
}

function usedEntities(maps: number[]): any[] {
  return maps.map((map, index) => ({ components: { show_used_map: { owner: 0, index, map } } }))
}

function seasonScene(over: Record<string, number> = {}, used: number[] = [], catalog = CATALOG): any[] {
  return [cursorEntity(over), ...planEntities(DEFAULT_PLAN), ...catalogEntities(catalog), ...usedEntities(used)]
}

function componentRows(state: any, name: string): any[] {
  return Object.values(state?.components?.[name] ?? {}) as any[]
}

function candidateIds(state: any): number[] {
  return componentRows(state, 'show_candidate')
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map(row => Number(row.map))
}

function usedIds(state: any): number[] {
  return componentRows(state, 'show_used_map')
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map(row => Number(row.map))
}

function cursorOf(state: any): any {
  return componentRows(state, 'show_season_cursor')[0]
}

function stageBitOf(stage: number): number {
  return 1 << stage
}

interface PoolOptions {
  rngState: number
  stage: number
  final: boolean
  cut: boolean
  playoff: boolean
  teamAllowed: boolean
  finalMap: number
  lastKind: number
  previous: number
  used: number[]
}

function forbidden(previous: number, map: number): boolean {
  const after = CATALOG[map].after ?? -1
  return after >= 0 && previous === after
}

function explicitPool(options: PoolOptions): number[] {
  return CATALOG.filter(map => {
    if (options.cut ? !map.cut : (map.stages & stageBitOf(options.stage)) === 0) return false
    if (options.final ? map.index !== options.finalMap : map.index === options.finalMap) return false
    if (map.team && !options.teamAllowed) return false
    if (forbidden(options.previous, map.index)) return false
    return true
  }).map(map => map.index)
}

function expectedCandidates(options: PoolOptions, k: number): { ids: number[]; state: number } {
  const pool = explicitPool(options)
  assert.ok(pool.length > 0)
  const unused = pool.filter(id => !options.used.includes(id))
  let eligible = unused.filter(id => CATALOG[id].kind !== options.lastKind)
  if (eligible.length === 0) eligible = [...unused]
  if (eligible.length === 0) eligible = [...pool]
  let state = options.rngState
  for (let i = eligible.length - 1; i > 0; i--) {
    const draw = mulberryInt(state, 0, i)
    state = draw.state
    const swap = eligible[i]
    eligible[i] = eligible[draw.value]
    eligible[draw.value] = swap
  }
  const count = options.final || options.cut || options.playoff ? 1 : Math.min(k, eligible.length)
  return { ids: eligible.slice(0, count), state }
}

test('nextTarget scales the nominal cut and clamps it to a legal head count', async () => {
  const cases: [number, number, number, number][] = [
    [60, 60, 40, 40], [40, 40, 24, 24], [60, 60, 48, 48], [26, 24, 12, 13],
    [13, 12, 6, 7], [10, 12, 6, 5], [6, 6, 1, 1], [1, 6, 1, 1], [24, 24, 12, 12],
  ]
  for (const [n, current, next, expected] of cases) {
    const result = await runProbe({ mode: 1, a: n, b: current, c: next }, [])
    assert.equal(result.faultCount, 0, faultText(result))
    assert.deepEqual(values(result, 1), [expected], `${n}/${current}/${next}`)
  }
})

async function slotOf(step: number, alive: number, teamRounds: number, plan = DEFAULT_PLAN): Promise<number[]> {
  const result = await runProbe(
    { mode: 2, a: step, b: alive, c: teamRounds }, [cursorEntity(), ...planEntities(plan)],
  )
  assert.equal(result.faultCount, 0, faultText(result))
  if (values(result, 2).length === 0) return [-1]
  return [...values(result, 1), ...values(result, 2), ...values(result, 3), ...values(result, 4), ...values(result, 5)]
}

test('default and long plans walk the nominal steps, cut oversized finals and gate team rounds', async () => {
  assert.deepEqual(await slotOf(0, 60, 0), [0, 40, 0, 0, 0])
  assert.deepEqual(await slotOf(1, 40, 0), [1, 24, 0, 0, 0])
  assert.deepEqual(await slotOf(2, 24, 0), [2, 12, 0, 0, 1])
  assert.deepEqual(await slotOf(2, 24, 1), [2, 12, 0, 0, 0])
  assert.deepEqual(await slotOf(2, 25, 0), [2, 13, 0, 0, 0])
  assert.deepEqual(await slotOf(4, 14, 0), [-1, 12, 0, 1, 0])
  assert.deepEqual(await slotOf(4, 12, 0), [4, 1, 1, 0, 0])
  assert.deepEqual(await slotOf(0, 1, 0), [-1])
  assert.deepEqual(await slotOf(0, 0, 0), [-1])
  assert.deepEqual(await slotOf(0, 60, 0, LONG_PLAN), [0, 48, 0, 0, 0])
  assert.deepEqual(await slotOf(1, 48, 0, LONG_PLAN), [0, 36, 0, 0, 0])
  assert.deepEqual(await slotOf(2, 36, 0, LONG_PLAN), [1, 24, 0, 0, 0])
  assert.deepEqual(await slotOf(5, 6, 0, LONG_PLAN), [4, 1, 1, 0, 0])
})

async function advanced(step: number, teamRounds: number, roundIndex: number, slot: Omit<SeasonParamsResInput, 'mode'>,
  qualified: number, wasTeam: boolean): Promise<number[]> {
  const result = await runProbe({
    mode: 3, a: step, b: teamRounds, c: roundIndex, ...slot, qualified, was_team: wasTeam ? 1 : 0,
  }, [])
  assert.equal(result.faultCount, 0, faultText(result))
  return [...values(result, 1), ...values(result, 2), ...values(result, 3), ...values(result, 4)]
}

test('a cut and a playoff keep the nominal step while a normal round advances it', async () => {
  assert.deepEqual(await advanced(0, 0, 0, { stage: 0, target: 40 }, 40, false), [1, 40, 0, 1])
  assert.deepEqual(await advanced(4, 0, 5, { stage: -1, cut: 1, target: 12 }, 12, false), [4, 12, 0, 6])
  assert.deepEqual(await advanced(2, 0, 3, { stage: 2, playoff: 1, target: 2 }, 2, false), [2, 2, 0, 4])
  assert.deepEqual(await advanced(2, 0, 0, { stage: 2, target: 12, team_allowed: 1 }, 12, true), [3, 12, 1, 1])
  assert.deepEqual(await advanced(2, 1, 1, { stage: 2, target: 6 }, 6, true), [3, 6, 2, 2])
})

async function candidatesFor(
  options: PoolOptions, k: number, catalog: MapSpec[] = CATALOG,
): Promise<number[]> {
  const scene = [
    cursorEntity({
      final_map: options.finalMap, last_kind: options.lastKind, previous: options.previous,
      rng_state: options.rngState,
    }),
    ...catalogEntities(catalog),
    ...usedEntities(options.used),
  ]
  const result = await runProbe({
    mode: 4, k, stage: options.stage, final: options.final ? 1 : 0, cut: options.cut ? 1 : 0,
    playoff: options.playoff ? 1 : 0, team_allowed: options.teamAllowed ? 1 : 0, target: 12,
  }, scene)
  assert.equal(result.faultCount, 0, faultText(result))
  const ids = values(result, 1)
  assert.deepEqual(ids, expectedCandidates(options, k).ids)
  return ids
}

function pool(over: Partial<PoolOptions> = {}): PoolOptions {
  return {
    rngState: 7, stage: 2, final: false, cut: false, playoff: false, teamAllowed: false,
    finalMap: 17, lastKind: -1, previous: -1, used: [], ...over,
  }
}

test('candidate eligibility filters stage, reserved final, team, cut and adjacency explicitly', async () => {
  const ordinary = await candidatesFor(pool(), 99)
  assert.equal(ordinary.length, 13)
  assert.ok(!ordinary.includes(0) && !ordinary.includes(12) && !ordinary.includes(13))
  assert.ok(!ordinary.includes(5) && !ordinary.includes(17))
  assert.ok(ordinary.includes(1) && ordinary.includes(9) && ordinary.includes(16))

  const withTeams = await candidatesFor(pool({ teamAllowed: true }), 99)
  for (const team of [0, 12, 13]) assert.ok(withTeams.includes(team), `team map ${team}`)
  const finalCrown = await candidatesFor(pool({ stage: 4, final: true, finalMap: 17 }), 99)
  assert.deepEqual(finalCrown, [17])
  const finalLastStanding = await candidatesFor(pool({ stage: 4, final: true, finalMap: 9 }), 99)
  assert.deepEqual(finalLastStanding, [9])

  const cut = await candidatesFor(pool({ stage: 0, cut: true }), 99)
  assert.equal(cut.length, 1)
  assert.ok(cut[0] === 5 || cut[0] === 16, `cut map ${cut[0]}`)
  const playoff = await candidatesFor(pool({ stage: 2, playoff: true }), 99)
  assert.equal(playoff.length, 1, 'a playoff replay offers one candidate')

  const afterH = await candidatesFor(pool({ stage: 3, previous: 8 }), 99)
  assert.ok(!afterH.includes(9), 'H -> I is forbidden')
  assert.ok(afterH.includes(8))
  const afterD = await candidatesFor(pool({ stage: 3, previous: 4 }), 99)
  assert.ok(!afterD.includes(7), 'D -> G is forbidden')

  const playable: MapSpec[] = [
    { index: 0, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
    { index: 1, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
    { index: 2, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
    { index: 3, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
    { index: 4, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: true, finalRule: 0 },
    { index: 5, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0 },
    { index: 6, kind: KIND.race, stages: STAGE.R1 | STAGE.R2 | STAGE.R3 | STAGE.R4, team: false, cut: false, finalRule: 0, after: 3 },
    { index: 7, kind: KIND.survival, stages: STAGE.final, team: false, cut: false, finalRule: 2 },
    { index: 8, kind: KIND.final, stages: STAGE.final, team: false, cut: false, finalRule: 1 },
  ]
  const finalAfterE = await runProbe({ mode: 4, k: 99, stage: 4, final: 1, cut: 0, playoff: 0, team_allowed: 0, target: 12 },
    [cursorEntity({ final_map: 7, last_kind: -1, previous: 4, rng_state: 7 }), ...catalogEntities(playable), ...usedEntities([])])
  assert.equal(finalAfterE.faultCount, 0, faultText(finalAfterE))
  assert.deepEqual(values(finalAfterE, 1), [7], 'E -> I stays allowed in the playable catalog')
  const afterDPlayable = await runProbe({ mode: 4, k: 99, stage: 3, final: 0, cut: 0, playoff: 0, team_allowed: 0, target: 12 },
    [cursorEntity({ final_map: 8, last_kind: -1, previous: 3, rng_state: 7 }), ...catalogEntities(playable), ...usedEntities([])])
  assert.equal(afterDPlayable.faultCount, 0, faultText(afterDPlayable))
  assert.ok(!values(afterDPlayable, 1).includes(6), 'D -> G is forbidden')

  const used = CATALOG.map(map => map.index).filter(index => index !== 1 && index !== 8)
  const kindPreferred = await candidatesFor(pool({ lastKind: KIND.race, used }), 99)
  assert.deepEqual(kindPreferred, [8])
  const sameKind = await candidatesFor(
    pool({ lastKind: KIND.race, used: CATALOG.map(map => map.index).filter(index => index !== 1 && index !== 6) }), 99,
  )
  assert.deepEqual([...sameKind].sort((a, b) => a - b), [1, 6])
  const repeated = await candidatesFor(pool({ used: CATALOG.map(map => map.index) }), 99)
  assert.equal(repeated.length, 13)
})


test('vote ties follow the seeded candidate order and ignore abstentions', async () => {
  const base: SeasonParamsResInput = {
    mode: 5, candidate_count: 3, candidate0: 10, candidate1: 20, candidate2: 30, seed: 7, round_index: 2,
  }
  const majority = await runProbe({ ...base, vote_count: 4, vote0: 0, vote1: 1, vote2: 1, vote3: 2 }, [])
  assert.equal(majority.faultCount, 0, faultText(majority))
  assert.deepEqual(values(majority, 1), [20])

  for (let seed = 0; seed < 12; seed++) {
    for (let round = 0; round < 4; round++) {
      const order = [0, 1, 2].sort((a, b) =>
        referenceSeedOrder(seed, round, a) - referenceSeedOrder(seed, round, b) || a - b)
      const abstain = await runProbe({
        ...base, seed, round_index: round, vote_count: 2, vote0: -1, vote1: -1,
      }, [])
      assert.equal(abstain.faultCount, 0, faultText(abstain))
      assert.deepEqual(values(abstain, 1), [[10, 20, 30][order[0]]], `abstain ${seed}/${round}`)

      const tied = order.filter(index => index !== 0)
      const tie = await runProbe({
        ...base, seed, round_index: round, vote_count: 2, vote0: 1, vote1: 2,
      }, [])
      assert.equal(tie.faultCount, 0, faultText(tie))
      assert.deepEqual(values(tie, 1), [[10, 20, 30][tied[0]]], `tie ${seed}/${round}`)
    }
  }

  const single = await runProbe({
    ...base, candidate_count: 1, vote_count: 2, vote0: -1, vote1: 0,
  }, [])
  assert.equal(single.faultCount, 0, faultText(single))
  assert.deepEqual(values(single, 1), [10])

  const empty = await runProbe({ ...base, candidate_count: 0, vote_count: 0 }, [])
  assert.ok(empty.faultCount > 0 || empty.error !== null, 'empty candidate list traps')
  assert.ok(faultText(empty).includes('provide at least one candidate'), faultText(empty))
})

test('the mulberry32 port matches the documented transition and state', async () => {
  const cases: [number, number, number][] = [
    [0, 0, 59], [7, 0, 3], [0xffffffff, 5, 5], [123456789, 0, 1], [42, 2, 9],
  ]
  for (const [seed, lo, hi] of cases) {
    const result = await runProbe({ mode: 7, seed, a: lo, b: hi }, [])
    assert.equal(result.faultCount, 0, faultText(result))
    const expected = mulberryInt(seed, lo, hi)
    assert.deepEqual(values(result, 1), [expected.value], `value ${seed}/${lo}/${hi}`)
    assert.deepEqual(values(result, 2).map(value => value >>> 0), [expected.state], `state ${seed}`)
  }
})

test('the season script reserves a final, offers seeded candidates and restores its rng', async () => {
  const first = await runProbe({ mode: 6 }, seasonScene())
  assert.equal(first.faultCount, 0, faultText(first))
  const cursor = cursorOf(first.state)
  const ids = candidateIds(first.state)
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3)
  assert.deepEqual(usedIds(first.state), [])

  const finalPick = mulberryInt(7, 0, 1)
  const finalMap = [9, 17][finalPick.value]
  assert.equal(cursor.final_map, finalMap)
  const expected = expectedCandidates(pool({ stage: 0, finalMap, rngState: finalPick.state }), 3)
  assert.deepEqual(ids, expected.ids)
  assert.equal(Number(cursor.rng_state) >>> 0, expected.state)
  assert.ok(!ids.includes(finalMap), 'the reserved final is not offered in an ordinary round')
  for (const id of ids) assert.ok(explicitPool(pool({ stage: 0, finalMap })).includes(id))

  const second = await runProbe({ mode: 6 }, seasonScene())
  assert.deepEqual(candidateIds(second.state), ids)
  assert.equal(Number(cursorOf(second.state).rng_state) >>> 0, Number(cursor.rng_state) >>> 0)

  const twice = await runProbe({ mode: 6 }, seasonScene(), 2)
  assert.deepEqual(candidateIds(twice.state), ids, 'a second tick does not duplicate candidates')
  assert.equal(Number(cursorOf(twice.state).rng_state) >>> 0, Number(cursor.rng_state) >>> 0)

  const selected = ids[0]
  const map = CATALOG[selected]
  const savedState = Number(cursor.rng_state) >>> 0
  const restored = await runProbe({ mode: 6 }, seasonScene({
    step: 1, alive: 40, round_index: 1, rng_state: savedState, final_map: finalMap,
    last_kind: map.kind, previous: selected,
  }, [selected]))
  assert.equal(restored.faultCount, 0, faultText(restored))
  const expectedRestored = expectedCandidates(pool({
    stage: 1, finalMap, rngState: savedState, lastKind: map.kind, previous: selected, used: [selected],
  }), 3)
  assert.deepEqual(candidateIds(restored.state), expectedRestored.ids)
  assert.equal(Number(cursorOf(restored.state).rng_state) >>> 0, expectedRestored.state)
})

async function expectFault(
  params: SeasonParamsResInput, entities: any[], expected: string,
): Promise<void> {
  const result = await runProbe(params, entities)
  const text = faultText(result)
  assert.ok(result.faultCount > 0 || result.error !== null, `expected a fault for ${expected}: ${text}`)
  assert.ok(text.includes(expected), `expected "${expected}", got ${text}`)
}

test('invalid season inputs trap with an actionable message', async () => {
  await expectFault({ mode: 6 }, [cursorEntity(), ...catalogEntities()], 'needs show_plan_entry rows')
  await expectFault({ mode: 6 }, [cursorEntity(), ...planEntities(DEFAULT_PLAN)], 'needs show_catalog_entry rows')
  await expectFault(
    { mode: 4, k: 99, stage: 4, final: 1 },
    [cursorEntity({ final_map: 9, previous: 8 }), ...catalogEntities([CATALOG[9]])],
    'no eligible map',
  )
  await expectFault(
    { mode: 6 },
    [cursorEntity(), cursorEntity(), ...planEntities(DEFAULT_PLAN), ...catalogEntities()],
    'one show_season_cursor row',
  )
})

interface ShowDoc {
  engine: Awaited<ReturnType<typeof loadEngine>>
  layout: ReturnType<typeof schemaLayout>
  wasm: Uint8Array
  scene: EmittedScene
  doc: any
}

async function showDocument(
  worldKind: 'show_field' | 'show_hub', world: string, seatOf: number[], inputSlots: number[], humans: boolean[],
): Promise<ShowDoc> {
  const { engine, layout, wasm } = await setup()
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  copy.sim!.features = []
  const scene = emitEngineScene(engine, {
    course: copy, assets, setup: { profile: 'sprint', seed: 7 },
    show: { worldKind, seatOf, inputSlots, humans },
  })
  const doc = JSON.parse(scene.text)
  doc.world_kind = world
  doc.resources ??= {}
  doc.resources.season_params = { mode: 0 }
  return { engine, layout, wasm, scene, doc }
}

function showRows(state: any, name: string): any[] {
  return Object.values(state?.components?.[name] ?? {}) as any[]
}

async function showHost(rig: ShowDoc): Promise<{ world: number; host: ScriptHost; module: import('@etcito/game-engine/script').ScriptModule; faults: string[] }> {
  const faults: string[] = []
  const module = await loadScript(rig.engine, rig.wasm, {
    name: `rf-season-show-${moduleSeq++}`,
    onFault: fault => faults.push(`${fault.system}: ${fault.message}`),
    onLog: line => faults.push(`log ${line}`),
  })
  const world = rig.engine.createWorld(JSON.stringify(rig.doc))
  return { world, host: new ScriptHost(module), module, faults }
}

function stepShow(
  rig: { host: ScriptHost; world: number; module: { faultCount: number }; faults: string[] }, code: number, players = 1,
): void {
  rig.host.stepTick(rig.world, Array(players).fill(code))
  assert.equal(rig.module.faultCount, 0, rig.faults.join(' | '))
}

function lastProbe(state: any, code: number): number {
  const rows = showRows(state, 'probe_out')
    .filter(row => Number(row.code) === code)
    .sort((a, b) => Number(a.seq) - Number(b.seq))
  return rows.length ? Number(rows[rows.length - 1].value) : Number.NaN
}

const MOVE_FORWARD = encodeInput({ moveX: 0, moveZ: 1, jump: false, dive: false, grab: false })

test('the show clock owns its timer and walks intro, playing, overtime and ended phases', async () => {
  const seats = [0, 1, 2, 3]
  const rig = await showDocument('show_field', CLOCK_WORLD, seats, seats.map(() => -1), seats.map(() => false))
  rig.doc.entities.push({ components: { show_clock: {
    owner: 0, start_tick: -1, end_tick: -1, overtime_end_tick: -1, phase: 0, frozen: 0,
    intro_ticks: 2, round_ticks: 4, overtime_ticks: 2,
  } } })
  const clockEntity = rig.doc.entities.length - 1
  const { world, host, module, faults } = await showHost(rig)
  try {
    const phases: number[] = []
    const frozen: number[] = []
    const roundPhases: number[] = []
    for (let i = 0; i < 9; i++) {
      stepShow({ host, world, module, faults }, NEUTRAL_CODE, 8)
      const state = readWorldState(rig.engine, world, rig.layout)
      const clock = state.components.show_clock[String(clockEntity)] as any
      phases.push(Number(clock.phase))
      frozen.push(Number(clock.frozen))
      roundPhases.push(Number((state.resources.round as any).phase))
    }
    assert.deepEqual(phases, [0, 0, 1, 1, 1, 1, 2, 2, 3])
    assert.deepEqual(frozen, [1, 1, 0, 0, 0, 0, 0, 0, 1])
    assert.deepEqual(roundPhases, phases)
    const state = readWorldState(rig.engine, world, rig.layout)
    const clock = state.components.show_clock[String(clockEntity)] as any
    assert.equal(Number(clock.start_tick), 0)
    assert.equal(Number(clock.end_tick), 6)
    assert.equal(Number(clock.overtime_end_tick), 8)
    assert.equal(Number((state.resources.round as any).intro_ticks), 2)
    assert.equal(Number((state.resources.round as any).round_ticks), 4)
    assert.equal(Number((state.resources.round as any).overtime_ticks), 2)
    for (let seat = 0; seat < seats.length; seat++) {
      const character = state.components.character[String(rig.scene.seatEntities[seat])] as any
      assert.equal(Number(character.placed), 1, `seat ${seat} placed`)
      assert.equal(Number(character.frozen), 1, `seat ${seat} frozen after the end`)
    }
  } finally {
    rig.engine.freeWorld(world)
  }
})

test('the show clock seeds missing durations from the round and ignores an absent clock', async () => {
  const seats = [0, 1]
  const rig = await showDocument('show_field', CLOCK_WORLD, seats, seats.map(() => -1), seats.map(() => false))
  rig.doc.entities.push({ components: { show_clock: {
    owner: 0, start_tick: -1, end_tick: -1, overtime_end_tick: -1, phase: 0, frozen: 0,
    intro_ticks: 0, round_ticks: 0, overtime_ticks: 0,
  } } })
  const clockEntity = rig.doc.entities.length - 1
  const { world, host, module, faults } = await showHost(rig)
  try {
    stepShow({ host, world, module, faults }, NEUTRAL_CODE, 8)
    const state = readWorldState(rig.engine, world, rig.layout)
    const clock = state.components.show_clock[String(clockEntity)] as any
    const round = state.resources.round as any
    assert.equal(Number(clock.intro_ticks), Number(round.intro_ticks))
    assert.equal(Number(clock.round_ticks), Number(round.round_ticks))
    assert.equal(Number(clock.overtime_ticks), Number(round.overtime_ticks))
    assert.equal(Number(clock.end_tick), Number(clock.start_tick) + Number(clock.intro_ticks) + Number(clock.round_ticks))
  } finally {
    rig.engine.freeWorld(world)
  }
  const noClock = await showDocument('show_field', CLOCK_WORLD, seats, seats.map(() => -1), seats.map(() => false))
  const absent = await showHost(noClock)
  try {
    stepShow({ host: absent.host, world: absent.world, module: absent.module, faults: absent.faults }, NEUTRAL_CODE, 8)
    const state = readWorldState(noClock.engine, absent.world, noClock.layout)
    assert.equal(showRows(state, 'show_clock').length, 0)
  } finally {
    noClock.engine.freeWorld(absent.world)
  }
})

test('the hub drives local control and moves the human forward', async () => {
  const rig = await showDocument('show_hub', HUB_WORLD, [0], [0], [true])
  rig.doc.entities.push({ components: { show_hub_state: {
    owner: 0, occupants: 0, humans: 0, bots: 0, tick: 0, rng_state: 7,
  } } })
  const seat = rig.scene.seatEntities[0]
  rig.doc.resources.season_params = { mode: 9, a: seat }
  const { world, host, module, faults } = await showHost(rig)
  try {
    stepShow({ host, world, module, faults }, 0)
    const neutral = readWorldState(rig.engine, world, rig.layout)
    assert.equal(Number((neutral.components.show_control as any)[String(seat)].code), NEUTRAL_CODE)
    const start = lastProbe(neutral, 1)
    const forward = engineCodeOfS1(MOVE_FORWARD)
    stepShow({ host, world, module, faults }, forward)
    const firstForward = readWorldState(rig.engine, world, rig.layout)
    assert.equal(Number((firstForward.components.show_control as any)[String(seat)].code), MOVE_FORWARD)
    for (let i = 0; i < 29; i++) stepShow({ host, world, module, faults }, forward)
    const moved = readWorldState(rig.engine, world, rig.layout)
    const end = lastProbe(moved, 1)
    assert.ok(end > start + 1000, `local forward movement ${start}mm -> ${end}mm`)
    assert.equal(Number((moved.components.seat as any)[String(seat)].status), 1, 'hub seats stay alive')
  } finally {
    rig.engine.freeWorld(world)
  }
})

test('the hub recovers a fallen local character without eliminating it', async () => {
  const rig = await showDocument('show_hub', HUB_WORLD, [0], [0], [true])
  rig.doc.entities.push({ components: { show_hub_state: { owner: 0, occupants: 1, humans: 1, bots: 0, tick: 0, rng_state: 7 } } })
  rig.doc.entities.push({ components: { show_hub_occupant: {
    owner: 0, room_seat: 0, round_seat: 0, kind: 0, emote: 0, active: 1,
    wander_x: 0, wander_z: 0, wander_tick: 120, rng_state: 9,
  } } })
  const seat = rig.scene.seatEntities[0]
  const spawn = rig.doc.entities[seat].components['ege.transform'].pos
  rig.doc.entities[seat].components['ege.transform'].pos = [spawn[0], -20, spawn[2]]
  rig.doc.resources.season_params = { mode: 9, a: seat }
  const { world, host, module, faults } = await showHost(rig)
  try {
    stepShow({ host, world, module, faults }, NEUTRAL_CODE)
    const state = readWorldState(rig.engine, world, rig.layout)
    const height = lastProbe(state, 2)
    assert.ok(height > -2000, `recovered height ${height}mm`)
    assert.equal(lastProbe(state, 3), 1, 'the recovered character is placed')
    assert.equal(lastProbe(state, 4), 0, 'the recovered character is not parked')
    assert.equal(Number((state.components.seat as any)[String(seat)].status), 1, 'a hub fall is not an elimination')
  } finally {
    rig.engine.freeWorld(world)
  }
})

test('hub occupancy follows queue entry and exit without closing the show', async () => {
  const rig = await showDocument('show_hub', HUB_WORLD, [0], [0], [true])
  rig.doc.entities.push({ components: { show_hub_state: { owner: 0, occupants: 0, humans: 0, bots: 0, tick: 0, rng_state: 7 } } })
  rig.doc.entities.push({ components: { show_hub_occupant: {
    owner: 0, room_seat: 0, round_seat: 0, kind: 0, emote: 0, active: 0,
    wander_x: 0, wander_z: 0, wander_tick: 120, rng_state: 9,
  } } })
  const human = rig.doc.entities.length - 1
  rig.doc.entities.push({ components: { show_hub_occupant: {
    owner: 0, room_seat: 1, round_seat: 0, kind: 1, emote: 0, active: 1,
    wander_x: 0, wander_z: 0, wander_tick: 120, rng_state: 11,
  } } })
  rig.doc.resources.season_params = { mode: 8, a: human }
  const { world, host, module, faults } = await showHost(rig)
  try {
    const humans: number[] = []
    const occupants: number[] = []
    for (let i = 0; i < 6; i++) {
      stepShow({ host, world, module, faults }, NEUTRAL_CODE)
      const state = readWorldState(rig.engine, world, rig.layout)
      const hub = showRows(state, 'show_hub_state')[0]
      humans.push(Number(hub.humans))
      occupants.push(Number(hub.occupants))
      assert.equal(Number(hub.bots), 1, 'the active bot stays queued')
      assert.equal(Number((state.resources.round as any).phase), 0, 'the hub never closes a round')
      const seat = (state.components.seat as any)[String(rig.scene.seatEntities[0])]
      assert.equal(Number(seat.status), 1, 'no competitive status')
    }
    assert.deepEqual([...new Set(humans)].sort((a, b) => a - b), [0, 1], `queue entry/exit humans ${humans}`)
    assert.deepEqual([...new Set(occupants)].sort((a, b) => a - b), [1, 2], `queue occupancy ${occupants}`)
  } finally {
    rig.engine.freeWorld(world)
  }
})

test('hub wandering keeps its seeded target and rng in schema state across restore', async () => {
  const rig = await showDocument('show_hub', HUB_WORLD, [0], [0], [true])
  rig.doc.entities.push({ components: { show_hub_state: { owner: 0, occupants: 1, humans: 0, bots: 1, tick: 0, rng_state: 7 } } })
  rig.doc.entities.push({ components: { show_hub_occupant: {
    owner: 0, room_seat: 1, round_seat: 0, kind: 1, emote: 0, active: 1,
    wander_x: 0, wander_z: 0, wander_tick: 0, rng_state: 0x1234,
  } } })
  const bot = rig.doc.entities.length - 1
  const { world, host, module, faults } = await showHost(rig)
  try {
    stepShow({ host, world, module, faults }, NEUTRAL_CODE)
    const first = readWorldState(rig.engine, world, rig.layout)
    const firstBot = (first.components.show_hub_occupant as any)[String(bot)]
    assert.ok(Number(firstBot.wander_x) !== 0 || Number(firstBot.wander_z) !== 0, 'the bot picked a wander target')
    assert.equal(Number(firstBot.wander_tick), 120)
    const saved = rig.engine.snapshot(world).slice()
    for (let i = 0; i < 5; i++) stepShow({ host, world, module, faults }, NEUTRAL_CODE)
    const later = readWorldState(rig.engine, world, rig.layout)
    const laterBot = (later.components.show_hub_occupant as any)[String(bot)]

    const restored = rig.engine.createWorld(JSON.stringify(rig.doc))
    rig.engine.restore(restored, saved)
    stepShow({ host, world: restored, module, faults }, NEUTRAL_CODE)
    const replay = readWorldState(rig.engine, restored, rig.layout)
    const replayBot = (replay.components.show_hub_occupant as any)[String(bot)]
    assert.equal(Number(replayBot.wander_x), Number(firstBot.wander_x))
    assert.equal(Number(replayBot.wander_z), Number(firstBot.wander_z))
    assert.equal(Number(replayBot.rng_state), Number(firstBot.rng_state))
    assert.equal(Number(replayBot.wander_tick), Number(firstBot.wander_tick))
    for (let i = 0; i < 4; i++) stepShow({ host, world: restored, module, faults }, NEUTRAL_CODE)
    const replayLater = readWorldState(rig.engine, restored, rig.layout)
    const replayLaterBot = (replayLater.components.show_hub_occupant as any)[String(bot)]
    assert.equal(Number(replayLaterBot.wander_x), Number(laterBot.wander_x))
    assert.equal(Number(replayLaterBot.wander_z), Number(laterBot.wander_z))
    assert.equal(Number(replayLaterBot.rng_state), Number(laterBot.rng_state))
    rig.engine.freeWorld(restored)
  } finally {
    rig.engine.freeWorld(world)
  }
})

function posOf(state: any, seat: number): number[] {
  const t = (state.components['ege.transform'] as any)[String(seat)]
  return Array.isArray(t.pos) ? t.pos.map(Number) : [Number(t.pos_0), Number(t.pos_1), Number(t.pos_2)]
}

function horizontalDistance(state: any, seat: number, x: number, z: number): number {
  const p = posOf(state, seat)
  return Math.hypot(p[0] - x, p[2] - z)
}

function wanderTargetOf(state: any, occupant: number): { x: number; z: number } {
  const row = (state.components.show_hub_occupant as any)[String(occupant)]
  return { x: Number(row.wander_x), z: Number(row.wander_z) }
}

function showCodeOf(state: any, seat: number): number {
  return Number((state.components.show_control as any)[String(seat)].code)
}

test('hub lobby bots walk toward their wander targets', async () => {
  const rig = await showDocument('show_hub', HUB_WORLD, [0, 1], [0, -1], [true, false])
  rig.doc.entities.push({ components: { show_hub_state: { owner: 0, occupants: 1, humans: 0, bots: 1, tick: 0, rng_state: 7 } } })
  rig.doc.entities.push({ components: { show_hub_occupant: {
    owner: 0, room_seat: 1, round_seat: 1, kind: 1, emote: 0, active: 1,
    wander_x: 0, wander_z: 0, wander_tick: 0, rng_state: 0x1234,
  } } })
  const occupant = rig.doc.entities.length - 1
  const human = rig.scene.seatEntities[0]
  const bot = rig.scene.seatEntities[1]
  rig.doc.resources.season_params = { mode: 9, a: human }
  const { world, host, module, faults } = await showHost(rig)
  try {
    stepShow({ host, world, module, faults }, 0)
    const first = readWorldState(rig.engine, world, rig.layout)
    const target = wanderTargetOf(first, occupant)
    const start = horizontalDistance(first, bot, target.x, target.z)
    if (start > 0.5) assert.notEqual(showCodeOf(first, bot), 32639, 'the bot steers toward its target')
    const saved = rig.engine.snapshot(world).slice()
    for (let i = 2; i <= 119; i++) stepShow({ host, world, module, faults }, 0)
    const live = readWorldState(rig.engine, world, rig.layout)
    assert.ok(horizontalDistance(live, bot, target.x, target.z) <= start - 0.5, 'the live bot walks toward its target')
    assert.equal(showCodeOf(live, human), 32639, 'the human seat stays neutral')

    const restored = rig.engine.createWorld(JSON.stringify(rig.doc))
    rig.engine.restore(restored, saved)
    for (let i = 2; i <= 119; i++) stepShow({ host, world: restored, module, faults }, 0)
    const replay = readWorldState(rig.engine, restored, rig.layout)
    const replayTarget = wanderTargetOf(replay, occupant)
    assert.equal(replayTarget.x, target.x)
    assert.equal(replayTarget.z, target.z)
    assert.ok(horizontalDistance(replay, bot, target.x, target.z) <= start - 0.5, 'the restored bot walks toward its target')
    rig.engine.freeWorld(restored)
  } finally {
    rig.engine.freeWorld(world)
  }
})

test('hub human neutral input stores S1 neutral and does not drift', async () => {
  const rig = await showDocument('show_hub', HUB_WORLD, [0], [0], [true])
  rig.doc.entities.push({ components: { show_hub_state: { owner: 0, occupants: 0, humans: 0, bots: 0, tick: 0, rng_state: 7 } } })
  const seat = rig.scene.seatEntities[0]
  rig.doc.resources.season_params = { mode: 9, a: seat }
  const { world, host, module, faults } = await showHost(rig)
  try {
    for (let i = 0; i < 30; i++) stepShow({ host, world, module, faults }, 0)
    const settled = posOf(readWorldState(rig.engine, world, rig.layout), seat)
    for (let i = 0; i < 60; i++) {
      stepShow({ host, world, module, faults }, 0)
      const state = readWorldState(rig.engine, world, rig.layout)
      assert.equal(showCodeOf(state, seat), 32639, `neutral S1 at settle tick ${i}`)
    }
    const end = posOf(readWorldState(rig.engine, world, rig.layout), seat)
    const drift = Math.hypot(end[0] - settled[0], end[2] - settled[2])
    assert.ok(drift < 0.05, `human horizontal drift ${drift}m`)
  } finally {
    rig.engine.freeWorld(world)
  }
})

test('hub human axes and buttons reach show_control as S1', async () => {
  const rig = await showDocument('show_hub', HUB_WORLD, [0], [0], [true])
  rig.doc.entities.push({ components: { show_hub_state: { owner: 0, occupants: 0, humans: 0, bots: 0, tick: 0, rng_state: 7 } } })
  const seat = rig.scene.seatEntities[0]
  rig.doc.resources.season_params = { mode: 9, a: seat }
  const { world, host, module, faults } = await showHost(rig)
  try {
    const inputs = [
      { moveX: 1, moveZ: -1, jump: true, dive: false, grab: false },
      { moveX: -1, moveZ: 1, jump: false, dive: true, grab: true },
    ]
    for (const input of inputs) {
      const s1 = encodeInput(input)
      stepShow({ host, world, module, faults }, engineCodeOfS1(s1))
      const state = readWorldState(rig.engine, world, rig.layout)
      assert.equal(showCodeOf(state, seat), s1, `S1 code for ${JSON.stringify(input)}`)
    }
  } finally {
    rig.engine.freeWorld(world)
  }
})

// ---- production show_rules presentation lifecycle (Q7) -------------------------------------------

const RULES_WORLD = 'show_rules'
const SCREEN = { vote: 0, loading: 1, intro: 2, playing: 3, overtime: 4, results: 5, podium: 6, done: 7 } as const

function rosterEntities(list: number, seats: number[]): any[] {
  return seats.map((room, position) => ({
    components: { show_roster_entry: { owner: 0, list, position, room_seat: room } },
  }))
}

function rulesResult(over: Record<string, number> = {}): any {
  return {
    components: {
      show_round_result: {
        owner: 0, index: 0, map: 0, course: 0, kind: 0, final: 0, playoff: 0, end_tick: 4,
        reason: 0, champion: -1, ranking_count: 1, qualified_count: 1, eliminated_count: 0, team_count: 0,
        ...over,
      },
    },
  }
}

interface RulesOptions {
  presentation?: Record<string, number>
  lifecycle?: Record<string, number>
  clock?: Record<string, number>
  cursor?: Record<string, number>
  used?: number[]
  votes?: { seat: number; choice: number }[]
  roster?: number[]
  next?: number[]
  plan?: number[]
  results?: any[]
  extra?: any[]
}

function rulesScene(options: RulesOptions = {}): any[] {
  const roster = options.roster ?? Array.from({ length: 60 }, (_, room) => room)
  const next = options.next ?? roster
  return [
    cursorEntity({ round_index: 0, alive: roster.length, ...(options.cursor ?? {}) }),
    ...planEntities(options.plan ?? DEFAULT_PLAN),
    ...catalogEntities(),
    ...usedEntities(options.used ?? []),
    {
      components: {
        show_presentation: {
          owner: 0, tick: 0, round_index: 0, screen: SCREEN.vote, entered_tick: 0, result_index: -1,
          seat_count: roster.length, alive_count: next.length,
          vote_ticks: 300, results_ticks: 90, podium_ticks: 150,
          ...(options.presentation ?? {}),
        },
      },
    },
    {
      components: {
        show_lifecycle_input: { owner: 0, ready_round: -1, confirmed_tick: 0, ...(options.lifecycle ?? {}) },
      },
    },
    {
      components: {
        show_clock: {
          owner: 0, start_tick: -1, end_tick: -1, overtime_end_tick: -1, phase: 0, frozen: 0,
          intro_ticks: 1, round_ticks: 10, overtime_ticks: 1,
          ...(options.clock ?? {}),
        },
      },
    },
    ...rosterEntities(0, roster),
    ...rosterEntities(1, next),
    ...(options.votes ?? []).map(vote => ({
      components: { show_vote: { owner: 0, round_index: 0, seat: vote.seat, choice: vote.choice } },
    })),
    ...(options.results ?? []),
    ...(options.extra ?? []),
  ]
}

interface RulesRig {
  engine: Awaited<ReturnType<typeof loadEngine>>
  layout: ReturnType<typeof schemaLayout>
  module: import('@etcito/game-engine/script').ScriptModule
  host: ScriptHost
  faults: string[]
  doc: any
  world: number
}

async function rulesRig(options: RulesOptions = {}, worldKind = RULES_WORLD): Promise<RulesRig> {
  const { engine, layout, wasm } = await setup()
  const faults: string[] = []
  const module = await loadScript(engine, wasm, {
    name: `rf-rules-${moduleSeq++}`,
    onFault: fault => faults.push(`${fault.system}: ${fault.message}`),
    onLog: line => faults.push(`log ${line}`),
  })
  const doc: any = {
    format: 'ege.scene', version: 1, world_kind: worldKind, seed: 1, entities: rulesScene(options),
  }
  if (worldKind === RULES_PROBE_WORLD) doc.resources = { season_params: { mode: 10, a: 0 } }
  const world = engine.createWorld(JSON.stringify(doc))
  return { engine, layout, module, host: new ScriptHost(module), faults, doc, world }
}

function rulesRows(state: any, name: string): any[] {
  return Object.values(state?.components?.[name] ?? {}) as any[]
}

function presentationOf(state: any): any {
  const rows = rulesRows(state, 'show_presentation')
  assert.equal(rows.length, 1, 'one show_presentation row')
  return rows[0]
}

function rosterOf(state: any, list: number): number[] {
  return rulesRows(state, 'show_roster_entry')
    .filter(row => Number(row.list) === list)
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map(row => Number(row.room_seat))
}

function rulesState(rig: RulesRig, world = rig.world): any {
  return readWorldState(rig.engine, world, rig.layout)
}

function stepRules(rig: RulesRig, world = rig.world): any {
  rig.host.stepTick(world, [])
  assert.equal(rig.module.faultCount, 0, rig.faults.join(' | '))
  return rulesState(rig, world)
}

test('the rules world votes to its deadline, loads, and advances the authored clock', async () => {
  const roster = Array.from({ length: 60 }, (_, room) => room)
  const rig = await rulesRig({
    presentation: { vote_ticks: 1 },
    lifecycle: { ready_round: 0 },
    clock: { intro_ticks: 1, round_ticks: 10, overtime_ticks: 1 },
    votes: [{ seat: 0, choice: 1 }],
    roster,
  })
  try {
    let state = rulesState(rig)
    assert.equal(presentationOf(state).screen, SCREEN.vote)
    assert.deepEqual(rosterOf(state, 0), roster)
    assert.deepEqual(rosterOf(state, 1), roster)
    assert.equal(rulesRows(state, 'show_used_map').length, 0, 'nothing is committed before the deadline')

    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.vote, 'the candidates are offered during vote')
    assert.equal(rulesRows(state, 'show_candidate').length, 3, 'the ordinary round offers three candidates')
    assert.equal(rulesRows(state, 'show_used_map').length, 0, 'nothing is committed before the deadline')

    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.loading, 'the deadline commits the voted map and loads')
    assert.equal(rulesRows(state, 'show_used_map').length, 1)
    assert.equal(presentationOf(state).round_index, 0, 'the displayed round is separate from the cursor')

    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.intro, 'matching readiness starts the round clock')
    const clock = rulesRows(state, 'show_clock')[0]
    assert.equal(Number(clock.start_tick), 2)
    assert.equal(Number(clock.end_tick), 2 + 1 + 10)
    assert.equal(Number(clock.overtime_end_tick), 2 + 1 + 10 + 1)

    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.playing)
    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.playing)
    assert.equal(rulesRows(state, 'show_used_map').length, 1, 'no duplicate candidate commitment')
    assert.equal(rulesRows(state, 'show_candidate').length, 3, 'no duplicate candidate rows')
    assert.equal(rulesRows(state, 'show_round_result').length, 0, 'no closure during play')
  } finally {
    rig.engine.freeWorld(rig.world)
  }
})

test('a replaced vote before the deadline decides the committed map', async () => {
  const rig = await rulesRig({ presentation: { vote_ticks: 3 }, lifecycle: { ready_round: 0 } }, RULES_PROBE_WORLD)
  try {
    let state = stepRules(rig)
    const candidates = rulesRows(state, 'show_candidate')
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map(row => Number(row.map))
    assert.equal(candidates.length, 3)
    state = stepRules(rig)
    assert.equal(rulesRows(state, 'show_used_map').length, 0, 'the early choice is not committed')
    state = stepRules(rig)
    assert.equal(rulesRows(state, 'show_used_map').length, 0, 'the replacement is still before its deadline')
    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.loading)
    const used = rulesRows(state, 'show_used_map').sort((a, b) => Number(a.index) - Number(b.index))
    assert.deepEqual(used.map(row => Number(row.map)), [candidates[0]], 'the replacement choice wins at the deadline')
    assert.notEqual(candidates[0], candidates[2])
  } finally {
    rig.engine.freeWorld(rig.world)
  }
})

test('a round clock past its cap shows overtime until the ledger closes it', async () => {
  const rig = await rulesRig({
    presentation: { screen: SCREEN.playing },
    clock: { start_tick: 0, end_tick: 1, overtime_end_tick: 3, intro_ticks: 0, round_ticks: 1, overtime_ticks: 2 },
  })
  try {
    let state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.playing)
    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.overtime)
    assert.equal(Number(rulesRows(state, 'show_clock')[0].phase), 2)
    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.overtime)
    assert.equal(Number(rulesRows(state, 'show_clock')[0].phase), 2)
    state = stepRules(rig)
    assert.equal(Number(rulesRows(state, 'show_clock')[0].phase), 3, 'the overtime boundary freezes the clock')
    assert.equal(presentationOf(state).screen, SCREEN.overtime, 'overtime stays until a result exists')
  } finally {
    rig.engine.freeWorld(rig.world)
  }
})

function finishedSeat(room: number, finished: boolean): any {
  return {
    components: {
      show_result_a: {
        seat: room, status: finished ? 2 : 1, finish_tick: finished ? 5 + room : -1, finish_sub: -1,
        lap: 0, stage: -1, route_mm: 0, falls: 0, score: 0, last_score_tick: -1,
      },
      show_result_b: {
        hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 0,
        out_tick: -1, out_sub: -1, team: 0, opening_rank: 0,
      },
    },
  }
}

test('the production rules schedule closes a played round and installs its qualified roster', async () => {
  const roster = [0, 1, 2, 3]
  const rig = await rulesRig({
    presentation: { vote_ticks: 1, results_ticks: 1 },
    lifecycle: { ready_round: 0, confirmed_tick: 1000 },
    clock: { intro_ticks: 1, round_ticks: 5, overtime_ticks: 1 },
    plan: [4, 2, 1],
    roster,
    next: roster,
    extra: [0, 1, 2, 3].map(room => finishedSeat(room, room < 2)),
  })
  try {
    stepRules(rig)
    stepRules(rig)
    stepRules(rig)
    let state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.playing)
    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.results, 'the ledger closes the played round')
    assert.equal(rulesRows(state, 'show_round_result').length, 1)
    assert.equal(Number(rulesRows(state, 'show_round_result')[0].reason), 0, 'the target closes the race')
    assert.equal(presentationOf(state).result_index, 0)
    assert.deepEqual(rosterOf(state, 0), [0, 1, 2, 3], 'the played roster is frozen')
    assert.deepEqual(rosterOf(state, 1), [0, 1], 'the qualified seats are the next roster')
    state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.vote)
    assert.equal(presentationOf(state).round_index, 1)
    assert.equal(presentationOf(state).result_index, -1)
    assert.deepEqual(rosterOf(state, 0), [0, 1], 'the next contest installs the qualified roster')
    assert.deepEqual(rosterOf(state, 1), [0, 1])
    assert.equal(rulesRows(state, 'show_result_a').length, 0, 'the next contest starts from fresh publishers')
    assert.equal(rulesRows(state, 'show_round_result').length, 1, 'history is preserved')
  } finally {
    rig.engine.freeWorld(rig.world)
  }
})

test('the vote deadline resolves abstentions with no human vote', async () => {
  const rig = await rulesRig({ presentation: { vote_ticks: 1 }, lifecycle: { ready_round: 0 } })
  try {
    stepRules(rig)
    const state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.loading)
    assert.equal(rulesRows(state, 'show_used_map').length, 1)
  } finally {
    rig.engine.freeWorld(rig.world)
  }
})

test('stale readiness keeps loading and a matching round starts intro', async () => {
  const stale = await rulesRig({ presentation: { screen: SCREEN.loading }, lifecycle: { ready_round: 7 } })
  try {
    let state = stepRules(stale)
    state = stepRules(stale)
    assert.equal(presentationOf(state).screen, SCREEN.loading, 'a stale acknowledgement cannot release loading')
    assert.equal(Number(rulesRows(state, 'show_clock')[0].start_tick), -1, 'the round clock is not initialized')
  } finally {
    stale.engine.freeWorld(stale.world)
  }
  const matching = await rulesRig({ presentation: { screen: SCREEN.loading }, lifecycle: { ready_round: 0 } })
  try {
    const state = stepRules(matching)
    assert.equal(presentationOf(state).screen, SCREEN.intro)
    assert.equal(Number(rulesRows(state, 'show_clock')[0].start_tick), 0)
  } finally {
    matching.engine.freeWorld(matching.world)
  }
})

test('results wait for a strictly confirmed result and a winning champion reaches terminal done', async () => {
  const result = () => rulesResult({ end_tick: 3, champion: 0, ranking_count: 1, qualified_count: 1 })
  const atBoundary = await rulesRig({
    presentation: { screen: SCREEN.results, entered_tick: 0, result_index: 0, results_ticks: 1 },
    lifecycle: { confirmed_tick: 3 },
    results: [result()],
  })
  try {
    let state = stepRules(atBoundary)
    state = stepRules(atBoundary)
    assert.equal(presentationOf(state).screen, SCREEN.results, 'confirmedTick == endTick never releases results')
    assert.equal(Number(rulesRows(state, 'show_round_result')[0].champion), 0)
  } finally {
    atBoundary.engine.freeWorld(atBoundary.world)
  }
  const afterBoundary = await rulesRig({
    presentation: {
      screen: SCREEN.results, entered_tick: 0, result_index: 0, results_ticks: 1, podium_ticks: 1,
    },
    lifecycle: { confirmed_tick: 4 },
    results: [result()],
  })
  try {
    let state = stepRules(afterBoundary)
    state = stepRules(afterBoundary)
    assert.equal(presentationOf(state).screen, SCREEN.podium, 'confirmedTick == endTick + 1 releases results')
    state = stepRules(afterBoundary)
    assert.equal(presentationOf(state).screen, SCREEN.done, 'the winning champion ends the show')
    state = stepRules(afterBoundary)
    assert.equal(presentationOf(state).screen, SCREEN.done, 'done is terminal')
  } finally {
    afterBoundary.engine.freeWorld(afterBoundary.world)
  }
})

test('leaving results installs the sparse next roster and clears the previous cumulative rows', async () => {
  const stale = [
    { components: { show_result_a: { seat: 31, status: 1 } } },
    { components: { show_team_contribution: { owner: 0, feature: 1, team: 0, value: 9, tick: 1 } } },
  ]
  const rig = await rulesRig({
    presentation: { screen: SCREEN.results, entered_tick: 0, result_index: 0, results_ticks: 1 },
    lifecycle: { confirmed_tick: 6 },
    next: [31, 59],
    results: [rulesResult({ end_tick: 5 })],
    extra: stale,
  })
  try {
    let state = stepRules(rig)
    assert.equal(presentationOf(state).screen, SCREEN.results)
    state = stepRules(rig)
    const presentation = presentationOf(state)
    assert.equal(presentation.screen, SCREEN.vote)
    assert.equal(presentation.round_index, 1)
    assert.equal(presentation.result_index, -1)
    assert.equal(presentation.seat_count, 2)
    assert.equal(presentation.alive_count, 2)
    assert.deepEqual(rosterOf(state, 0), [31, 59])
    assert.deepEqual(rosterOf(state, 0), rosterOf(state, 1))
    assert.equal(rulesRows(state, 'show_result_a').length, 0, 'stale cumulative rows are cleared')
    assert.equal(rulesRows(state, 'show_team_contribution').length, 0)
    assert.equal(rulesRows(state, 'show_season_cursor')[0].round_index, 0, 'the cursor is not advanced by the screen')
  } finally {
    rig.engine.freeWorld(rig.world)
  }
})

test('a rules snapshot resumes the same deadlines, screen, roster order and result', async () => {
  const scenarios: { name: string; options: RulesOptions }[] = [
    { name: 'vote', options: { presentation: { vote_ticks: 2 }, votes: [{ seat: 0, choice: 2 }] } },
    { name: 'loading', options: { presentation: { screen: SCREEN.loading }, lifecycle: { ready_round: 0 } } },
    {
      name: 'results',
      options: {
        presentation: { screen: SCREEN.results, entered_tick: 0, result_index: 0, results_ticks: 1 },
        lifecycle: { confirmed_tick: 6 },
        next: [31, 59],
        results: [rulesResult({ end_tick: 5 })],
      },
    },
    { name: 'podium', options: { presentation: { screen: SCREEN.podium, entered_tick: 0, podium_ticks: 2 } } },
  ]
  for (const scenario of scenarios) {
    const rig = await rulesRig(scenario.options)
    const restored = rig.engine.createWorld(JSON.stringify(rig.doc))
    try {
      const saved = rig.engine.snapshot(rig.world).slice()
      rig.engine.restore(restored, saved)
      assert.equal(rulesState(rig, restored).tick, rulesState(rig).tick, scenario.name)
      let original = rulesState(rig)
      let replay = rulesState(rig, restored)
      for (let tick = 0; tick < 3; tick++) {
        original = stepRules(rig)
        rig.host.stepTick(restored, [])
        assert.equal(rig.module.faultCount, 0, rig.faults.join(' | '))
        replay = rulesState(rig, restored)
        assert.deepEqual(
          [presentationOf(replay).screen, presentationOf(replay).round_index,
            presentationOf(replay).entered_tick, presentationOf(replay).result_index],
          [presentationOf(original).screen, presentationOf(original).round_index,
            presentationOf(original).entered_tick, presentationOf(original).result_index],
          `${scenario.name} tick ${tick}`,
        )
        assert.deepEqual(rosterOf(replay, 0), rosterOf(original, 0), `${scenario.name} roster ${tick}`)
        assert.deepEqual(rosterOf(replay, 1), rosterOf(original, 1), `${scenario.name} next roster ${tick}`)
        const used = (state: any) => rulesRows(state, 'show_used_map').map(row => Number(row.map))
        assert.deepEqual(used(replay), used(original), `${scenario.name} maps ${tick}`)
        assert.deepEqual(
          rulesRows(replay, 'show_round_result').map(row => Number(row.champion)),
          rulesRows(original, 'show_round_result').map(row => Number(row.champion)),
          `${scenario.name} results ${tick}`,
        )
        assert.equal(
          Number(rulesRows(replay, 'show_season_cursor')[0].rng_state),
          Number(rulesRows(original, 'show_season_cursor')[0].rng_state),
          `${scenario.name} candidate rng ${tick}`,
        )
        assert.deepEqual(
          rulesRows(replay, 'show_candidate').map(row => Number(row.map)),
          rulesRows(original, 'show_candidate').map(row => Number(row.map)),
          `${scenario.name} candidates ${tick}`,
        )
      }
      const savedClock = JSON.stringify(rulesRows(rulesState(rig), 'show_clock').map(row => ({
        start: row.start_tick, end: row.end_tick, overtime: row.overtime_end_tick,
      })))
      const replayClock = JSON.stringify(rulesRows(replay, 'show_clock').map(row => ({
        start: row.start_tick, end: row.end_tick, overtime: row.overtime_end_tick,
      })))
      assert.equal(replayClock, savedClock, `${scenario.name} clock deadlines`)
    } finally {
      rig.engine.freeWorld(restored)
      rig.engine.freeWorld(rig.world)
    }
  }
})
