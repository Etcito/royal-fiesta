import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'
import { readRepoText } from '../src/files.ts'

const PROBE_WORLD = 'qualification_probe'
const PUBLISH_WORLD = 'cumulative_publish_probe'
const LEDGER_WORLD = 'cumulative_ledger_probe'
const PROBE_FILE = 'probe/qualification.as.ts'
const PROBE_TEXT = `import { entityAt, entityCount, newRecord, readResource, setComponent, spawn } from 'ege'
import { ProbeOut, ProbeParamsRes } from '../components.gen'
import { rankShowSeats, resolveShowRound, showRoundPoints, showSeedOrder } from '../show/qualification.as'
import { splitShowTeams, resolveShowTeamTie } from '../show/teams.as'

function emit(code: u32, seq: u32, value: i32): void {
  const row = newRecord<ProbeOut>(ProbeOut.SIZE)
  row.code = code
  row.seq = seq
  row.value = value
  setComponent<ProbeOut>(spawn(), ProbeOut.ID, ProbeOut.SIZE, row)
}

function seatsOfWorld(): StaticArray<u32> {
  const count = <i32>entityCount()
  const seats = new StaticArray<u32>(count)
  for (let i: i32 = 0; i < count; i++) seats[i] = entityAt(<u32>i)
  return seats
}

function teamScoresOf(params: ProbeParamsRes): StaticArray<i32> {
  const count = <i32>params.team_count
  const scores = new StaticArray<i32>(count)
  if (count > 0) scores[0] = params.team0
  if (count > 1) scores[1] = params.team1
  return scores
}

function contains(values: StaticArray<i32>, value: i32): bool {
  for (let i: i32 = 0; i < values.length; i++) if (values[i] == value) return true
  return false
}

export function rf_qual_probe(): void {
  const params = readResource<ProbeParamsRes>(ProbeParamsRes.ID, ProbeParamsRes.SIZE)
  if (params.mode == 6) {
    emit(1, 0, <i32>showSeedOrder(params.seed, params.round_index, params.room_seat))
    return
  }
  if (params.mode == 3) {
    emit(1, 0, showRoundPoints(params.kind, params.entrants, params.qualified_flag != 0))
    return
  }
  if (params.mode == 5) {
    const scores = new StaticArray<i32>(<i32>params.team_count)
    if (params.team_count > 0) scores[0] = params.team0
    if (params.team_count > 1) scores[1] = params.team1
    const opens = new StaticArray<i32>(<i32>params.open_count)
    if (params.open_count > 0) opens[0] = params.open0
    if (params.open_count > 1) opens[1] = params.open1
    emit(1, 0, resolveShowTeamTie(scores, params.overtime_leader, opens, params.seed, params.round_index))
    return
  }
  const seats = seatsOfWorld()
  if (params.mode == 4) {
    const teams = splitShowTeams(seats, params.seed, params.round_index)
    for (let i: i32 = 0; i < teams.length; i++) emit(1, <u32>i, teams[i])
    return
  }
  const scores = teamScoresOf(params)
  if (params.mode == 1) {
    const ranking = rankShowSeats(params.kind, params.final_rule, seats, scores, params.seed, params.round_index)
    for (let i: i32 = 0; i < ranking.length; i++) emit(1, <u32>i, ranking[i])
    return
  }
  if (params.mode == 2) {
    const outcome = resolveShowRound(
      params.kind, params.final_rule, params.target, seats, scores, params.seed, params.round_index,
      params.playoff_round != 0,
    )
    for (let i: i32 = 0; i < outcome.ranking.length; i++) emit(1, <u32>i, outcome.ranking[i])
    for (let i: i32 = 0; i < outcome.qualified.length; i++) emit(2, <u32>i, outcome.qualified[i])
    for (let i: i32 = 0; i < outcome.eliminated.length; i++) emit(3, <u32>i, outcome.eliminated[i])
    if (outcome.playoff == null) {
      emit(4, 0, -1)
    } else {
      const playoff = outcome.playoff!
      for (let i: i32 = 0; i < playoff.length; i++) emit(4, <u32>i, playoff[i])
    }
    emit(5, 0, outcome.champion)
    emit(6, 0, outcome.teamWinner)
    for (let i: i32 = 0; i < outcome.ranking.length; i++) {
      emit(7, <u32>i, showRoundPoints(i + 1, params.entrants, contains(outcome.qualified, outcome.ranking[i])))
    }
  }
}
`

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
    name: 'probe_params',
    fields: [
      { name: 'mode', type: 'u32' },
      { name: 'seed', type: 'u32' },
      { name: 'round_index', type: 'i32' },
      { name: 'kind', type: 'i32' },
      { name: 'final_rule', type: 'i32' },
      { name: 'target', type: 'i32' },
      { name: 'playoff_round', type: 'u32' },
      { name: 'entrants', type: 'i32' },
      { name: 'team_count', type: 'u32' },
      { name: 'team0', type: 'i32' },
      { name: 'team1', type: 'i32' },
      { name: 'open_count', type: 'u32' },
      { name: 'open0', type: 'i32' },
      { name: 'open1', type: 'i32' },
      { name: 'overtime_leader', type: 'i32' },
      { name: 'room_seat', type: 'i32' },
      { name: 'qualified_flag', type: 'u32' },
    ],
  })
  schema.world_kinds.push({
    name: PROBE_WORLD,
    players: 8,
    schedule: [{
      system: 'rf.qual_probe',
      kind: 'script',
      reads: ['show_result_a', 'show_result_b', 'probe_params'],
      writes: ['probe_out'],
      emits: [],
    }],
  })
  schema.world_kinds.push({
    name: PUBLISH_WORLD,
    players: 8,
    schedule: [{
      system: 'rf.show.publish',
      kind: 'script',
      reads: ['show_result_a', 'show_result_b', 'show_seat_identity', 'show_team_contribution', 'ege.zone.id', 'ege.zone.outbox'],
      writes: ['ege.zone.id', 'ege.zone.outbox'],
      emits: [],
    }],
  })
  schema.world_kinds.push({
    name: LEDGER_WORLD,
    players: 0,
    schedule: [{
      system: 'rf.show.ledger',
      kind: 'script',
      reads: ['ege.zone.inbox', 'show_pending', 'show_publish', 'show_result_a', 'show_result_b', 'show_team_contribution'],
      writes: ['show_pending', 'show_publish', 'show_result_a', 'show_result_b', 'show_team_contribution'],
      emits: [],
    }],
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

interface ProbeParamsInput {
  mode: number
  seed?: number
  round_index?: number
  kind?: number
  final_rule?: number
  target?: number
  playoff_round?: number
  entrants?: number
  team_count?: number
  team0?: number
  team1?: number
  open_count?: number
  open0?: number
  open1?: number
  overtime_leader?: number
  room_seat?: number
  qualified_flag?: number
}

interface ProbeResult {
  faultCount: number
  faults: string[]
  error: string | null
  rows: { code: number; seq: number; value: number }[]
}

let moduleSeq = 0

async function runProbe(resources: ProbeParamsInput, entities: any[]): Promise<ProbeResult> {
  const { engine, layout, wasm } = await setup()
  const faults: string[] = []
  const name = `rf-qual-${moduleSeq++}`
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
    resources: { probe_params: { ...resources } },
    entities,
  }
  const world = engine.createWorld(JSON.stringify(scene))
  let error: string | null = null
  try {
    host.stepTick(world, Array(8).fill(0))
  } catch (caught) {
    error = String(caught)
  }
  const rows: { code: number; seq: number; value: number }[] = []
  try {
    const state = readWorldState(engine, world, layout)
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
  return { faultCount, faults, error, rows }
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

function seatEntity(room: number, over: { a?: any; b?: any } = {}): any {
  return {
    components: {
      show_result_a: {
        seat: room, status: 1, finish_tick: -1, finish_sub: -1, lap: 0, stage: -1,
        route_mm: 0, falls: 0, score: 0, last_score_tick: -1,
        ...(over.a ?? {}),
      },
      show_result_b: {
        hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 0,
        out_tick: -1, out_sub: -1, team: 0, opening_rank: 0,
        ...(over.b ?? {}),
      },
    },
  }
}

function mainSeats(): any[] {
  return [
    seatEntity(0, {
      a: {
        status: 3, finish_tick: 100, finish_sub: 10, lap: 2, stage: 4, route_mm: 0,
        falls: 0, score: 10, last_score_tick: 50,
      },
      b: {
        hold_ticks: 5, possessing: 0, last_acquire_tick: 7, matches: 1, cross_ticks: 5,
        out_tick: 95, out_sub: 0, team: 0, opening_rank: 2,
      },
    }),
    seatEntity(1, {
      a: {
        status: 2, finish_tick: 90, finish_sub: 20, lap: 2, stage: 4, route_mm: 0,
        falls: 0, score: 50, last_score_tick: 40,
      },
      b: {
        hold_ticks: 100, possessing: 1, last_acquire_tick: 10, matches: 3, cross_ticks: 2,
        out_tick: -1, out_sub: -1, team: 1, opening_rank: 1,
      },
    }),
    seatEntity(2, {
      a: {
        status: 3, finish_tick: -1, finish_sub: -1, lap: 2, stage: 3, route_mm: 500,
        falls: 2, score: 20, last_score_tick: 60,
      },
      b: {
        hold_ticks: 50, possessing: 0, last_acquire_tick: 5, matches: 2, cross_ticks: 7,
        out_tick: 80, out_sub: 0, team: 0, opening_rank: 3,
      },
    }),
    seatEntity(3, {
      a: {
        status: 0, finish_tick: -1, finish_sub: -1, lap: 1, stage: 2, route_mm: 100,
        falls: 1, score: 10, last_score_tick: 20,
      },
      b: {
        hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 0,
        out_tick: 70, out_sub: 5, team: 1, opening_rank: 4,
      },
    }),
    seatEntity(4, {
      a: {
        status: 3, finish_tick: -1, finish_sub: -1, lap: 2, stage: 2, route_mm: 50,
        falls: 0, score: 40, last_score_tick: 30,
      },
      b: {
        hold_ticks: 200, possessing: 1, last_acquire_tick: 30, matches: 4, cross_ticks: 9,
        out_tick: 60, out_sub: 1, team: 0, opening_rank: 5,
      },
    }),
    seatEntity(59, {
      a: {
        status: 0, finish_tick: -1, finish_sub: -1, lap: 0, stage: 1, route_mm: 2000,
        falls: 3, score: 0, last_score_tick: -1,
      },
      b: {
        hold_ticks: 10, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 4,
        out_tick: 50, out_sub: 0, team: 1, opening_rank: 0,
      },
    }),
  ]
}

test('show seed order is the gameplay fnv1a byte loop, unsigned and seat 59 included', async () => {
  const cases: [number, number, number, number][] = [
    [7, 0, 0, 1737953826],
    [7, 0, 1, 3083030835],
    [7, 0, 59, 2702745289],
    [0, 0, 0, 3795608245],
    [0xffffffff, -2, 59, 3793360359],
    [123456789, 3, 42, 3782619744],
  ]
  for (const [seed, roundIndex, roomSeat, expected] of cases) {
    const result = await runProbe({ mode: 6, seed, round_index: roundIndex, room_seat: roomSeat }, [])
    assert.equal(result.faultCount, 0, faultText(result))
    assert.deepEqual(values(result, 1).map(value => value >>> 0), [expected], `${seed}/${roundIndex}/${roomSeat}`)
    assert.equal(expected, referenceSeedOrder(seed, roundIndex, roomSeat))
  }
})

const KIND_CASES = [
  {
    name: 'race', kind: 0, finalRule: 0, target: 4, teams: [] as number[],
    ranking: [1, 0, 2, 4, 3, 59], qualified: [1, 0, 2, 4], eliminated: [3, 59],
    playoff: [-1], champion: -1, teamWinner: -1, points: [6, 5, 4, 3, 0, 0],
  },
  {
    name: 'survival', kind: 1, finalRule: 0, target: 2, teams: [] as number[],
    ranking: [1, 0, 2, 3, 4, 59], qualified: [1], eliminated: [0, 2, 3, 4, 59],
    playoff: [-1], champion: -1, teamWinner: -1, points: [6, 0, 0, 0, 0, 0],
  },
  {
    name: 'team', kind: 2, finalRule: 0, target: 3, teams: [10, 20],
    ranking: [59, 1, 3, 0, 2, 4], qualified: [59, 1, 3], eliminated: [0, 2, 4],
    playoff: [-1], champion: -1, teamWinner: 1, points: [6, 5, 4, 0, 0, 0],
  },
  {
    name: 'collection', kind: 3, finalRule: 0, target: 3, teams: [] as number[],
    ranking: [1, 4, 2, 3, 0, 59], qualified: [1, 4, 2], eliminated: [3, 0, 59],
    playoff: [-1], champion: -1, teamWinner: -1, points: [6, 5, 4, 0, 0, 0],
  },
  {
    name: 'hunt', kind: 4, finalRule: 0, target: 2, teams: [] as number[],
    ranking: [4, 1, 2, 59, 0, 3], qualified: [4, 1], eliminated: [2, 59, 0, 3],
    playoff: [-1], champion: -1, teamWinner: -1, points: [6, 5, 0, 0, 0, 0],
  },
  {
    name: 'logic', kind: 5, finalRule: 0, target: 5, teams: [] as number[],
    ranking: [4, 1, 2, 0, 3, 59], qualified: [4, 1, 2, 0, 3], eliminated: [59],
    playoff: [-1], champion: -1, teamWinner: -1, points: [6, 5, 4, 3, 2, 0],
  },
  {
    name: 'final crown', kind: 6, finalRule: 1, target: 1, teams: [] as number[],
    ranking: [1, 0, 2, 4, 3, 59], qualified: [1], eliminated: [0, 2, 4, 3, 59],
    playoff: [-1], champion: 1, teamWinner: -1, points: [6, 0, 0, 0, 0, 0],
  },
  {
    name: 'final last standing', kind: 6, finalRule: 2, target: 1, teams: [] as number[],
    ranking: [1, 0, 2, 3, 4, 59], qualified: [1], eliminated: [0, 2, 3, 4, 59],
    playoff: [-1], champion: 1, teamWinner: -1, points: [6, 0, 0, 0, 0, 0],
  },
]

test('every round kind resolves explicit ranks, seats, disputes and hand-derived points', async () => {
  for (const entry of KIND_CASES) {
    const result = await runProbe({
      mode: 2, seed: 7, round_index: 0, kind: entry.kind, final_rule: entry.finalRule,
      target: entry.target, entrants: 6, team_count: entry.teams.length,
      team0: entry.teams[0] ?? 0, team1: entry.teams[1] ?? 0,
    }, mainSeats())
    assert.equal(result.faultCount, 0, `${entry.name}: ${faultText(result)}`)
    assert.deepEqual(values(result, 1), entry.ranking, `${entry.name} ranking`)
    assert.deepEqual(values(result, 2), entry.qualified, `${entry.name} qualified`)
    assert.deepEqual(values(result, 3), entry.eliminated, `${entry.name} eliminated`)
    assert.deepEqual(values(result, 4), entry.playoff, `${entry.name} playoff`)
    assert.deepEqual(values(result, 5), [entry.champion], `${entry.name} champion`)
    assert.deepEqual(values(result, 6), [entry.teamWinner], `${entry.name} team winner`)
    assert.deepEqual(values(result, 7), entry.points, `${entry.name} points`)
  }
})

test('team scoring chooses the other winning team and its ranked members', async () => {
  const result = await runProbe({
    mode: 2, seed: 7, round_index: 0, kind: 2, final_rule: 0, target: 3,
    entrants: 6, team_count: 2, team0: 20, team1: 10,
  }, mainSeats())
  assert.equal(result.faultCount, 0, faultText(result))
  assert.deepEqual(values(result, 1), [0, 2, 4, 59, 1, 3])
  assert.deepEqual(values(result, 2), [0, 2, 4])
  assert.deepEqual(values(result, 3), [59, 1, 3])
  assert.deepEqual(values(result, 6), [0])
  assert.deepEqual(values(result, 7), [6, 5, 4, 0, 0, 0])
})

function seeded(rooms: number[], seed: number, roundIndex: number): number[] {
  return [...rooms].sort((a, b) =>
    referenceSeedOrder(seed, roundIndex, a) - referenceSeedOrder(seed, roundIndex, b) || a - b)
}

function survivalOut(rooms: number[]): any[] {
  return rooms.map(room => seatEntity(room, {
    a: { status: 0 },
    b: { out_tick: room == 59 ? 40 : 50, out_sub: 0 },
  }))
}

test('a survival tie across the quota boundary becomes a playoff instead of a presentation award', async () => {
  const rooms = [10, 11, 12, 59]
  const tieOrder = seeded([10, 11, 12], 7, 0)
  const result = await runProbe({ mode: 2, seed: 7, round_index: 0, kind: 1, final_rule: 0, target: 2, entrants: 4 }, survivalOut(rooms))
  assert.equal(result.faultCount, 0, faultText(result))
  assert.deepEqual(values(result, 1), [...tieOrder, 59])
  assert.deepEqual(values(result, 2), [])
  assert.deepEqual(values(result, 3), [59])
  assert.deepEqual(values(result, 4), tieOrder)
  assert.deepEqual(values(result, 5), [-1])
  assert.deepEqual(values(result, 6), [-1])
  assert.deepEqual(values(result, 7), [0, 0, 0, 0])
})

test('a replay settles a disputed survival place by positive opening rank then seed then seat', async () => {
  const entities = [10, 11, 12, 59].map(room => seatEntity(room, {
    a: { status: 0 },
    b: { out_tick: room == 59 ? 40 : 50, out_sub: 0, opening_rank: room == 10 ? 2 : room == 11 ? 1 : 0 },
  }))
  const result = await runProbe({
    mode: 2, seed: 7, round_index: 0, kind: 1, final_rule: 0, target: 2,
    entrants: 4, playoff_round: 1,
  }, entities)
  assert.equal(result.faultCount, 0, faultText(result))
  assert.deepEqual(values(result, 1), [11, 10, 12, 59])
  assert.deepEqual(values(result, 2), [11, 10])
  assert.deepEqual(values(result, 3), [12, 59])
  assert.deepEqual(values(result, 4), [-1])
  assert.deepEqual(values(result, 7), [4, 3, 0, 0])
})

function crownTie(rooms: number[], opening: Record<number, number>): any[] {
  return rooms.map(room => seatEntity(room, {
    a: { status: 1, finish_tick: 30, finish_sub: 5 },
    b: { opening_rank: opening[room] ?? 0 },
  }))
}

test('a crown tie becomes a playoff, and its replay crowns the positive opening rank', async () => {
  const rooms = [20, 59, 21]
  const tieOrder = seeded(rooms, 7, 0)
  const disputed = await runProbe({ mode: 2, seed: 7, round_index: 0, kind: 6, final_rule: 1, target: 1, entrants: 3 }, crownTie(rooms, {}))
  assert.equal(disputed.faultCount, 0, faultText(disputed))
  assert.deepEqual(values(disputed, 1), tieOrder)
  assert.deepEqual(values(disputed, 2), [])
  assert.deepEqual(values(disputed, 4), tieOrder)
  assert.deepEqual(values(disputed, 5), [-1])

  const replay = await runProbe({
    mode: 2, seed: 7, round_index: 0, kind: 6, final_rule: 1, target: 1, entrants: 3,
    playoff_round: 1,
  }, crownTie(rooms, { 20: 0, 59: 1, 21: 2 }))
  assert.equal(replay.faultCount, 0, faultText(replay))
  assert.deepEqual(values(replay, 1), [59, 21, 20])
  assert.deepEqual(values(replay, 2), [59])
  assert.deepEqual(values(replay, 3), [21, 20])
  assert.deepEqual(values(replay, 4), [-1])
  assert.deepEqual(values(replay, 5), [59])
  assert.deepEqual(values(replay, 7), [3, 0, 0])
})

test('a last-standing final with a simultaneous exit disputes the place and replays to a champion', async () => {
  const rooms = [30, 31, 59]
  const tieOrder = seeded([30, 31], 7, 0)
  const base = rooms.map(room => seatEntity(room, {
    a: { status: 0 },
    b: { out_tick: room == 59 ? 30 : 40, out_sub: 0, opening_rank: room == 31 ? 1 : 0 },
  }))
  const disputed = await runProbe({ mode: 2, seed: 7, round_index: 0, kind: 6, final_rule: 2, target: 1, entrants: 3 }, base)
  assert.equal(disputed.faultCount, 0, faultText(disputed))
  assert.deepEqual(values(disputed, 1), [...tieOrder, 59])
  assert.deepEqual(values(disputed, 4), tieOrder)
  assert.deepEqual(values(disputed, 5), [-1])

  const replay = await runProbe({
    mode: 2, seed: 7, round_index: 0, kind: 6, final_rule: 2, target: 1, entrants: 3,
    playoff_round: 1,
  }, base)
  assert.equal(replay.faultCount, 0, faultText(replay))
  assert.deepEqual(values(replay, 1), [31, 30, 59])
  assert.deepEqual(values(replay, 2), [31])
  assert.deepEqual(values(replay, 3), [30, 59])
  assert.deepEqual(values(replay, 5), [31])
  assert.deepEqual(values(replay, 7), [3, 0, 0])
})

test('empty ranking and resolution return empty arrays and absent winners without a fault', async () => {
  const ranked = await runProbe({ mode: 1, seed: 7, round_index: 0, kind: 0, final_rule: 0 }, [])
  assert.equal(ranked.faultCount, 0, faultText(ranked))
  assert.deepEqual(values(ranked, 1), [])

  const resolved = await runProbe({ mode: 2, seed: 7, round_index: 0, kind: 0, final_rule: 0, target: 0, entrants: 0 }, [])
  assert.equal(resolved.faultCount, 0, faultText(resolved))
  assert.deepEqual(values(resolved, 1), [])
  assert.deepEqual(values(resolved, 2), [])
  assert.deepEqual(values(resolved, 3), [])
  assert.deepEqual(values(resolved, 4), [-1])
  assert.deepEqual(values(resolved, 5), [-1])
  assert.deepEqual(values(resolved, 6), [-1])
  assert.deepEqual(values(resolved, 7), [])
})

test('team split assigns team 1 to the seeded second half, aligned with the entity array', async () => {
  const rooms = [0, 1, 2, 3, 4, 59]
  const order = rooms.map((room, index) => ({ room, index }))
    .sort((a, b) => referenceSeedOrder(7, 0, a.room) - referenceSeedOrder(7, 0, b.room) || a.room - b.room)
  const expected = Array(rooms.length).fill(0)
  for (let i = rooms.length / 2; i < order.length; i++) expected[order[i].index] = 1
  const result = await runProbe({ mode: 4, seed: 7, round_index: 0 }, mainSeats())
  assert.equal(result.faultCount, 0, faultText(result))
  assert.deepEqual(values(result, 1), expected)
  assert.equal(expected.filter(team => team === 0).length, 3)
  assert.equal(expected.filter(team => team === 1).length, 3)
})

test('a team overtime tie uses score, leadership, opening ranks, seed and team id in order', async () => {
  const cases: [ProbeParamsInput, number][] = [
    [{ mode: 5, seed: 7, round_index: 0, team_count: 2, team0: 5, team1: 5, open_count: 2, open0: 0, open1: 0, overtime_leader: 1 }, 1],
    [{ mode: 5, seed: 7, round_index: 0, team_count: 2, team0: 5, team1: 5, open_count: 2, open0: 2, open1: 1, overtime_leader: -1 }, 1],
    [{ mode: 5, seed: 7, round_index: 0, team_count: 2, team0: 3, team1: 7, open_count: 2, open0: 0, open1: 0, overtime_leader: -1 }, 1],
    [{ mode: 5, seed: 7, round_index: 0, team_count: 2, team0: 7, team1: 3, open_count: 2, open0: 0, open1: 0, overtime_leader: -1 }, 0],
    [{ mode: 5, seed: 7, round_index: 0, team_count: 2, team0: 5, team1: 5, open_count: 2, open0: 0, open1: 0, overtime_leader: -1 }, 0],
  ]
  for (const [params, expected] of cases) {
    const result = await runProbe(params, [])
    assert.equal(result.faultCount, 0, `${JSON.stringify(params)}: ${faultText(result)}`)
    assert.deepEqual(values(result, 1), [expected], JSON.stringify(params))
  }
})

test('qualified points are entrants minus one-based rank plus one, eliminated zero', async () => {
  const cases: [ProbeParamsInput, number][] = [
    [{ mode: 3, kind: 1, entrants: 6, qualified_flag: 1 }, 6],
    [{ mode: 3, kind: 5, entrants: 6, qualified_flag: 1 }, 2],
    [{ mode: 3, kind: 6, entrants: 6, qualified_flag: 1 }, 1],
    [{ mode: 3, kind: 3, entrants: 6, qualified_flag: 0 }, 0],
    [{ mode: 3, kind: 1, entrants: 1, qualified_flag: 1 }, 1],
  ]
  for (const [params, expected] of cases) {
    const result = await runProbe(params, [])
    assert.equal(result.faultCount, 0, `${JSON.stringify(params)}: ${faultText(result)}`)
    assert.deepEqual(values(result, 1), [expected], JSON.stringify(params))
  }
})

async function expectFault(params: ProbeParamsInput, entities: any[], expected: string): Promise<void> {
  const result = await runProbe(params, entities)
  const text = faultText(result)
  assert.ok(result.faultCount > 0 || result.error !== null, `expected a fault for ${expected}: ${text}`)
  assert.ok(text.includes(expected), `expected "${expected}", got ${text}`)
}

test('invalid kinds, final rules, targets and duplicate seats trap', async () => {
  await expectFault({ mode: 1, seed: 7, round_index: 0, kind: 7 }, mainSeats(), 'invalid show round kind')
  await expectFault({ mode: 1, seed: 7, round_index: 0, kind: 0, final_rule: 3 }, mainSeats(), 'invalid final rule')
  await expectFault({ mode: 1, seed: 7, round_index: 0, kind: 6, final_rule: 0 }, mainSeats(), 'a final requires crown or lastStanding')
  await expectFault({ mode: 2, seed: 7, round_index: 0, kind: 0, target: 0 }, mainSeats(), 'target must be 1..seats.length')
  await expectFault({ mode: 2, seed: 7, round_index: 0, kind: 0, target: 7 }, mainSeats(), 'target must be 1..seats.length')
  await expectFault({ mode: 1, seed: 7, round_index: 0, kind: 0 }, [seatEntity(5), seatEntity(5)], 'duplicate room seat')
})

test('missing result records and inconsistent team inputs trap', async () => {
  await expectFault({ mode: 1, seed: 7, round_index: 0, kind: 0 }, [{
    components: { show_result_a: { seat: 1 } },
  }], 'seat has no show_result_b record')
  await expectFault({ mode: 1, seed: 7, round_index: 0, kind: 0 }, [{
    components: { show_result_b: { team: 0 } },
  }], 'seat has no show_result_a record')
  await expectFault({ mode: 1, seed: 7, round_index: 0, kind: 2, team_count: 1, team0: 1 }, mainSeats(), 'team scores need one entry per team')
  await expectFault({ mode: 1, seed: 7, round_index: 0, kind: 2, team_count: 2, team0: 1, team1: 1 }, [
    seatEntity(0, { b: { team: 0 } }),
    seatEntity(1, { b: { team: 2 } }),
    seatEntity(2, { b: { team: 2 } }),
  ], 'team ids must be contiguous from zero')
  await expectFault({ mode: 4, seed: 7, round_index: 0 }, [], 'provide a nonzero even number of seats')
  await expectFault({ mode: 4, seed: 7, round_index: 0 }, [seatEntity(0), seatEntity(1), seatEntity(2)], 'provide a nonzero even number of seats')
  await expectFault({ mode: 5, seed: 7, round_index: 0, team_count: 0, open_count: 0 }, [], 'scores and opening rank sums need equal nonzero length')
  await expectFault({ mode: 5, seed: 7, round_index: 0, team_count: 1, open_count: 2, overtime_leader: -1 }, [], 'scores and opening rank sums need equal nonzero length')
  await expectFault({
    mode: 5, seed: 7, round_index: 0, team_count: 2, open_count: 2, overtime_leader: 2,
  }, [], 'overtime leader must be a team index or -1')
})

test('equal helper inputs produce equal ranks and points across independent worlds', async () => {
  const cases = [
    { mode: 2, seed: 7, round_index: 0, kind: 0, final_rule: 0, target: 4, entrants: 6 },
    { mode: 2, seed: 7, round_index: 0, kind: 2, final_rule: 0, target: 3, entrants: 6, team_count: 2, team0: 10, team1: 20 },
    { mode: 2, seed: 7, round_index: 0, kind: 6, final_rule: 1, target: 1, entrants: 6 },
  ]
  for (const params of cases) {
    const first = await runProbe(params, mainSeats())
    const second = await runProbe(params, mainSeats())
    assert.equal(first.faultCount, 0, faultText(first))
    assert.equal(second.faultCount, 0, faultText(second))
    assert.deepEqual(second.rows, first.rows)
    assert.ok(values(first, 1).includes(59), 'seat 59 is ranked')
  }
})

interface OutboxEntry { key: number; kind: number; value: number; tick: number }

function sceneOf(worldKind: string, entities: any[]): any {
  return { format: 'ege.scene', version: 1, world_kind: worldKind, seed: 1, entities }
}

async function worldHost(label: string) {
  const { engine, layout, wasm } = await setup()
  const faults: string[] = []
  const module = await loadScript(engine, wasm, {
    name: label,
    onFault: fault => faults.push(`${fault.system}: ${fault.message}`),
    onLog: line => faults.push(`log ${line}`),
  })
  return { engine, layout, module, host: new ScriptHost(module), faults }
}

function outboxOf(engine: Awaited<ReturnType<typeof loadEngine>>, world: number): OutboxEntry[] {
  const exportFn = (engine.exports as any).ege_zone_outbox as ((world: number) => number) | undefined
  assert.ok(exportFn, 'the engine build exports ege_zone_outbox')
  const len = engine.check(exportFn(world))
  const bytes = engine.resultBytes().slice()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(0, true)
  const entries: OutboxEntry[] = []
  for (let i = 0; i < count; i++) {
    const at = 2 + i * 16
    entries.push({
      key: view.getUint32(at, true),
      kind: view.getUint32(at + 4, true),
      value: view.getUint32(at + 8, true),
      tick: view.getUint32(at + 12, true),
    })
  }
  return entries
}

function rowsOf(state: any, name: string): any[] {
  return Object.values(state.components[name] ?? {}) as any[]
}

function showSeat(room: number, roundSeat: number, over: { a?: any; b?: any } = {}): any {
  const entity = seatEntity(room, over)
  entity.components.show_seat_identity = {
    room_seat: room, round_seat: roundSeat, input_slot: -1, bot: 1,
  }
  return entity
}

function seatBatch(room: number, tick: number, over: Record<number, number> = {}): OutboxEntry[] {
  const base = [room, 1, -1, -1, 0, -1, 0, 0, 0, -1, 0, 0, -1, 0, 0, -1, -1, -1, 0]
  return base.map((fallback, field) => ({
    key: 65536 + room * 32 + field,
    kind: field,
    value: (over[field] ?? fallback) >>> 0,
    tick,
  }))
}

function inboxEntities(entries: OutboxEntry[], source: number): any[] {
  return entries.map(entry => ({
    components: {
      'ege.zone.inbox': {
        source, key: entry.key, kind: entry.kind, value: entry.value, tick: entry.tick,
      },
    },
  }))
}

function ledgerWorld(engine: Awaited<ReturnType<typeof loadEngine>>, entries: OutboxEntry[], source = 3): number {
  return engine.createWorld(JSON.stringify(sceneOf(LEDGER_WORLD, inboxEntities(entries, source))))
}

function injectInbox(
  engine: Awaited<ReturnType<typeof loadEngine>>, layout: ReturnType<typeof schemaLayout>, world: number,
  entries: OutboxEntry[], source: number,
): void {
  const sourceWorld = ledgerWorld(engine, entries, source)
  try {
    const ids = readWorldState(engine, sourceWorld, layout).entities
    const bytes = engine.exportEntities(sourceWorld, ids, false)
    engine.importEntities(world, bytes)
  } finally {
    engine.freeWorld(sourceWorld)
  }
}

test('rf_show_publish writes complete nineteen-field seat batches and team contribution keys', async () => {
  const { engine, layout, host, faults } = await worldHost('rf-publish')
  const world = engine.createWorld(JSON.stringify(sceneOf(PUBLISH_WORLD, [
    showSeat(4, 2, {
      a: { status: 2, finish_tick: 90, finish_sub: 20, lap: 3, stage: 4, route_mm: 5, falls: 1, score: 55, last_score_tick: 40 },
      b: { hold_ticks: 12, possessing: 1, last_acquire_tick: 30, matches: 4, cross_ticks: 9, out_tick: -1, out_sub: -1, team: 1, opening_rank: 2 },
    }),
    showSeat(59, 0, {
      a: { status: 0, finish_tick: -1, finish_sub: -1, lap: 5, stage: 8, route_mm: 1200, falls: 2, score: -4, last_score_tick: 77 },
      b: { hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 3, out_tick: 9, out_sub: -1, team: 0, opening_rank: 0 },
    }),
    { components: { show_team_contribution: { owner: 0, feature: 3, team: 1, value: -7, tick: 4 } } },
  ])))
  try {
    host.stepTick(world, Array(8).fill(0))
    assert.deepEqual(faults, [])
    const entries = outboxOf(engine, world)
    assert.equal(entries.length, 39)
    const byKey = new Map(entries.map(entry => [entry.key, entry]))
    const state = readWorldState(engine, world, layout)
    const seats = [4, 59]
    for (const room of seats) {
      const index = seats.indexOf(room)
      const entity = state.entities[index]
      const a = state.components.show_result_a[entity]
      const b = state.components.show_result_b[entity]
      const expected = [
        room, a.status, a.finish_tick, a.finish_sub, a.lap, a.stage, a.route_mm, a.falls,
        a.score, a.last_score_tick, b.hold_ticks, b.possessing, b.last_acquire_tick, b.matches,
        b.cross_ticks, b.out_tick, b.out_sub, b.team, b.opening_rank,
      ]
      for (let field = 0; field < 19; field++) {
        const entry = byKey.get(65536 + room * 32 + field)
        assert.ok(entry, `seat ${room} field ${field}`)
        assert.equal(entry.kind, field)
        assert.equal(entry.value, Number(expected[field]) >>> 0, `seat ${room} field ${field}`)
        assert.equal(entry.tick, 0)
      }
    }
    const team = byKey.get(131072 + 3 * 32 + 1)
    assert.ok(team, 'team contribution key')
    assert.equal(team.kind, 1)
    assert.equal(team.value, (-7) >>> 0)
    assert.equal(team.tick, 0)
    host.stepTick(world, Array(8).fill(0))
    assert.deepEqual(faults, [])
    assert.deepEqual(outboxOf(engine, world), entries)
  } finally {
    engine.freeWorld(world)
  }
})

test('the ledger assembles out-of-order batches, retains incomplete ones and restores accepted state', async () => {
  const { engine, layout, host, faults } = await worldHost('rf-ledger-order')
  const complete5 = seatBatch(4, 5, { 2: 50, 8: 10 })
  const complete7 = seatBatch(4, 7, {
    2: 70, 3: 11, 4: 2, 5: 3, 6: 40, 7: 1, 8: 30, 9: 60,
    10: 5, 11: 1, 12: 55, 13: 2, 14: 7, 17: 0, 18: 1,
  })
  const partial9 = seatBatch(4, 9, { 2: 90, 8: 44, 13: 5 }).slice(0, 9)
  const shuffled = [...partial9, ...complete7.slice(10), ...complete5, ...complete7.slice(0, 10)]
  const world = ledgerWorld(engine, shuffled, 3)
  try {
    host.stepTick(world, [])
    assert.deepEqual(faults, [])
    let state = readWorldState(engine, world, layout)
    const seats = rowsOf(state, 'show_result_a')
    assert.equal(seats.length, 1, 'one stable seat identity')
    assert.equal(seats[0].seat, 4)
    assert.equal(seats[0].finish_tick, 70)
    assert.equal(seats[0].score, 30)
    assert.equal(seats[0].last_score_tick, 60)
    const publishes = rowsOf(state, 'show_publish')
    assert.equal(publishes.length, 19)
    for (const row of publishes) assert.equal(row.tick, 7)
    const partial = rowsOf(state, 'show_pending').filter(row => row.tick === 9)
    assert.equal(partial.length, 9, 'only the incomplete fields wait')
    assert.equal(partial.some(row => row.kind === 8), true)

    const rest = seatBatch(4, 9, {
      2: 90, 3: 12, 4: 3, 5: 4, 6: 10, 7: 2, 8: 44, 9: 80,
      10: 6, 11: 0, 12: -1, 13: 5, 14: 9, 17: 0, 18: 1,
    }).slice(9)
    injectInbox(engine, layout, world, rest, 4)
    host.stepTick(world, [])
    assert.deepEqual(faults, [])
    state = readWorldState(engine, world, layout)
    assert.equal(rowsOf(state, 'show_result_a')[0].finish_tick, 90)
    assert.equal(rowsOf(state, 'show_result_a')[0].score, 44)
    for (const row of rowsOf(state, 'show_publish')) assert.equal(row.tick, 9)

    host.stepTick(world, [])
    assert.deepEqual(faults, [])
    state = readWorldState(engine, world, layout)
    assert.equal(rowsOf(state, 'show_result_a')[0].finish_tick, 90)
    assert.equal(rowsOf(state, 'show_result_a')[0].score, 44)

    const snapshot = engine.snapshot(world).slice()
    const restored = engine.createWorld(JSON.stringify(sceneOf(LEDGER_WORLD, [])))
    try {
      engine.restore(restored, snapshot)
      let copy = readWorldState(engine, restored, layout)
      assert.equal(rowsOf(copy, 'show_result_a')[0].finish_tick, 90)
      for (const row of rowsOf(copy, 'show_publish')) assert.equal(row.tick, 9)
      host.stepTick(restored, [])
      assert.deepEqual(faults, [])
      copy = readWorldState(engine, restored, layout)
      assert.equal(rowsOf(copy, 'show_result_a')[0].finish_tick, 90)

      injectInbox(engine, layout, restored, seatBatch(4, 12, { 1: 2, 2: 120, 8: 88 }), 9)
      host.stepTick(restored, [])
      assert.deepEqual(faults, [])
      copy = readWorldState(engine, restored, layout)
      const changed = rowsOf(copy, 'show_result_a')
      assert.equal(changed.length, 1, 'a source-domain change keeps the stable seat')
      assert.equal(changed[0].finish_tick, 120)
      assert.equal(changed[0].score, 88)
      for (const row of rowsOf(copy, 'show_publish')) assert.equal(row.tick, 12)
    } finally {
      engine.freeWorld(restored)
    }
  } finally {
    engine.freeWorld(world)
  }
})

test('the ledger keeps signed team contributions once per publisher and restores them', async () => {
  const { engine, layout, host, faults } = await worldHost('rf-ledger-team')
  const firstKey = 131072 + 1 * 32 + 0
  const secondKey = 131072 + 2 * 32 + 1
  const world = ledgerWorld(engine, [
    { key: firstKey, kind: 0, value: (-5) >>> 0, tick: 4 },
    { key: secondKey, kind: 1, value: 7 >>> 0, tick: 4 },
    { key: firstKey, kind: 0, value: (-5) >>> 0, tick: 4 },
  ], 3)
  try {
    host.stepTick(world, [])
    assert.deepEqual(faults, [])
    let rows = rowsOf(readWorldState(engine, world, layout), 'show_team_contribution')
      .sort((a, b) => a.feature - b.feature)
    assert.equal(rows.length, 2, 'a repeated delivery is not a second publisher')
    assert.deepEqual(
      rows.map(row => [row.feature, row.team, row.value, row.tick]),
      [[1, 0, -5, 4], [2, 1, 7, 4]],
    )

    injectInbox(engine, layout, world, [{ key: firstKey, kind: 0, value: (-9) >>> 0, tick: 9 }], 6)
    host.stepTick(world, [])
    assert.deepEqual(faults, [])
    injectInbox(engine, layout, world, [{ key: firstKey, kind: 0, value: 100 >>> 0, tick: 5 }], 7)
    host.stepTick(world, [])
    assert.deepEqual(faults, [])
    rows = rowsOf(readWorldState(engine, world, layout), 'show_team_contribution')
      .sort((a, b) => a.feature - b.feature)
    assert.deepEqual(
      rows.map(row => [row.feature, row.team, row.value, row.tick]),
      [[1, 0, -9, 9], [2, 1, 7, 4]],
      'newer cumulative values replace and older ones change nothing',
    )

    const snapshot = engine.snapshot(world).slice()
    const restored = engine.createWorld(JSON.stringify(sceneOf(LEDGER_WORLD, [])))
    try {
      engine.restore(restored, snapshot)
      const copy = rowsOf(readWorldState(engine, restored, layout), 'show_team_contribution')
        .sort((a, b) => a.feature - b.feature)
      assert.deepEqual(
        copy.map(row => [row.feature, row.team, row.value, row.tick]),
        [[1, 0, -9, 9], [2, 1, 7, 4]],
      )
    } finally {
      engine.freeWorld(restored)
    }
  } finally {
    engine.freeWorld(world)
  }
})

test('conflicting complete values and team contributions refuse instead of awarding twice', async () => {
  const seatHost = await worldHost('rf-ledger-seat-conflict')
  const conflicting = [
    ...seatBatch(4, 7, { 8: 10 }),
    ...seatBatch(4, 7, { 8: 11 }),
  ]
  const seatWorld = ledgerWorld(seatHost.engine, conflicting, 3)
  try {
    seatHost.host.stepTick(seatWorld, [])
    assert.ok(seatHost.faults.some(fault => fault.includes('conflicting')), seatHost.faults.join(' | '))
    assert.equal(seatHost.module.faultCount > 0, true)
  } finally {
    seatHost.engine.freeWorld(seatWorld)
  }

  const teamHost = await worldHost('rf-ledger-team-conflict')
  const key = 131072 + 1 * 32 + 0
  const teamWorld = ledgerWorld(teamHost.engine, [
    { key, kind: 0, value: 5 >>> 0, tick: 4 },
    { key, kind: 0, value: 6 >>> 0, tick: 4 },
  ], 3)
  try {
    teamHost.host.stepTick(teamWorld, [])
    assert.ok(teamHost.faults.some(fault => fault.includes('conflicting')), teamHost.faults.join(' | '))
    assert.equal(teamHost.module.faultCount > 0, true)
  } finally {
    teamHost.engine.freeWorld(teamWorld)
  }
})
