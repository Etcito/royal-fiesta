import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadEngine } from '@etcito/game-engine'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import { collectRfScripts, rfCompiler } from '../egeScripts.ts'

const SCHEMA = fileURLToPath(new URL('../../ege.schema.json', import.meta.url))

const SCHEDULE = [
  'ege.movers',
  'ege.road',
  'ege.mech.logic',
  'ege.mech.joints',
  'rf.round.clock',
  'rf.character.pre',
  'rf.feature.boost_lane.pre',
  'rf.feature.launch_pad.pre',
  'rf.feature.catch_volume.pre',
  'rf.feature.rolling_log.pre',
  'rf.feature.door_bank.pre',
  'rf.feature.swim_volume.pre',
  'rf.feature.carry_item.pre',
  'rf.feature.hex_field.pre',
  'rf.feature.memory_tiles.pre',
  'rf.feature.annulus.pre',
  'rf.feature.sweep.pre',
  'rf.feature.rising_kill.pre',
  'rf.feature.collectible.pre',
  'rf.feature.tail_set.pre',
  'ege.body.props',
  'ege.box.collider',
  'ege.physics',
  'ege.contact.track',
  'ege.mech.watch',
  'rf.character.post',
  'rf.feature.marker.post',
  'rf.feature.launch_pad.post',
  'rf.feature.catch_volume.post',
  'rf.feature.rolling_log.post',
  'rf.feature.tile_field.post',
  'rf.feature.hex_field.post',
  'rf.feature.memory_tiles.post',
  'rf.feature.sweep.post',
  'rf.feature.rising_kill.post',
  'rf.feature.ball.post',
  'rf.feature.collectible.post',
  'rf.feature.bank.post',
  'rf.feature.capture_zone.post',
  'rf.feature.tail_set.post',
  'rf.feature.crown.post',
  'rf.seat.rules',
]

async function layoutOf() {
  const engine = await loadEngine()
  engine.setSchema(readFileSync(SCHEMA, 'utf8'))
  return schemaLayout(engine)
}

test('input layout packs move_x, move_z and the three buttons', async () => {
  const input = (await layoutOf()).input
  assert.deepEqual(
    input.axes.map((axis) => [axis.name, axis.shift, axis.bits]),
    [
      ['move_x', 0, 8],
      ['move_z', 8, 8],
    ],
  )
  assert.equal(input.button_shift, 16)
  assert.deepEqual(input.buttons, ['jump', 'dive', 'grab'])
})

test('collision groups carry the E3 masks', async () => {
  const groups = (await layoutOf()).collision_groups
  assert.deepEqual(
    groups.map((group) => [group.name, group.memberships, group.filter]),
    [
      ['static', 1, 28],
      ['moving', 2, 28],
      ['char', 4, 7],
      ['debris', 8, 11],
      ['probe', 16, 3],
    ],
  )
})

test('world kind round has 8 players and the schedule in rank order', async () => {
  const layout = await layoutOf()
  const round = layout.world_kinds.find((kind) => kind.name === 'round')
  assert.ok(round, 'world kind round is declared')
  assert.equal(round.players, 8)
  assert.deepEqual(
    round.schedule.map((entry) => entry.system),
    SCHEDULE,
  )
  for (const entry of round.schedule) {
    if (entry.kind === 'script') assert.ok(entry.system.startsWith('rf.'), entry.system)
  }
  const sourceSchema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
    world_kinds: { name: string; schedule: { system: string; reads?: string[] }[] }[]
  }
  const sourceRound = sourceSchema.world_kinds.find((kind) => kind.name === 'round')
  assert.ok(sourceRound)
  const characterPre = sourceRound.schedule.find((entry) => entry.system === 'rf.character.pre')
  assert.ok(characterPre)
  assert.ok(characterPre.reads?.includes('show_control'))
})

test('seat, character and feature components are declared', async () => {
  const names = (await layoutOf()).components.map((component) => component.name)
  for (const name of ['seat', 'character', 'feature']) assert.ok(names.includes(name), name)
})

test('box collider has the engine-provided three-float layout', async () => {
  const component = (await layoutOf()).components.find((entry) => entry.name === 'ege.box_collider')
  assert.ok(component, 'engine component ege.box_collider is declared')
  const field = component.fields.find((entry) => entry.name === 'half_extents')
  assert.ok(field, 'half_extents field is declared')
  assert.equal(component.size, 12)
  assert.deepEqual([field.type, field.count, field.offset], ['f32', 3, 0])
  assert.deepEqual(Array.from({ length: field.count }, (_, index) => field.offset + index * 4), [0, 4, 8])
})

type Layout = Awaited<ReturnType<typeof layoutOf>>

function declared(layout: Layout, list: 'components' | 'events', name: string) {
  const entry = layout[list].find((decl) => decl.name === name)
  assert.ok(entry, `${name} is declared`)
  return {
    size: entry.size,
    fields: entry.fields.map((field) => [field.name, field.type, field.count]),
    offsets: entry.fields.map((field) => [field.name, field.offset]),
  }
}

test('memory tiles root record carries the contract fields within 256 bytes', async () => {
  const root = declared(await layoutOf(), 'components', 'feature_memory_tiles')
  assert.deepEqual(root.fields, [
    ['origin', 'f64', 3],
    ['cols', 'u32', 1],
    ['rows', 'u32', 1],
    ['cell_m', 'f64', 1],
    ['symbols', 'u32', 1],
    ['cycles', 'u32', 1],
    ['reveal_s', 'f64', 1],
    ['hide_s', 'f64', 1],
    ['choice_s', 'f64', 1],
    ['penalty_s', 'f64', 1],
    ['target', 'u32', 1],
    ['cycle', 'i32', 1],
    ['phase', 'u32', 1],
    ['choice_start_tick', 'i32', 1],
    ['finalized', 'u32', 1],
    ['placed', 'u32', 1],
  ])
  assert.ok(root.size <= 256, `feature_memory_tiles is ${root.size} bytes`)
})

test('memory tiles cell record splits its twenty cycle symbols into two fields at fixed offsets', async () => {
  const cell = declared(await layoutOf(), 'components', 'feature_memory_tiles_cell')
  assert.deepEqual(cell.fields, [
    ['owner', 'u32', 1],
    ['index', 'u32', 1],
    ['t', 'f64', 3],
    ['half', 'f64', 3],
    ['state', 'u32', 1],
    ['timer', 'u32', 1],
    ['symbol', 'u32', 1],
    ['cycle_symbols', 'u32', 16],
    ['cycle_symbols_tail', 'u32', 4],
  ])
  assert.deepEqual(cell.offsets, [
    ['owner', 0],
    ['index', 4],
    ['t', 8],
    ['half', 32],
    ['state', 56],
    ['timer', 60],
    ['symbol', 64],
    ['cycle_symbols', 68],
    ['cycle_symbols_tail', 132],
  ])
  assert.equal(cell.size, 152)
})

test('memory tiles cycle, seat and marker children carry their fields within 256 bytes', async () => {
  const layout = await layoutOf()
  const cycle = declared(layout, 'components', 'feature_memory_tiles_cycle')
  assert.deepEqual(cycle.fields, [
    ['owner', 'u32', 1],
    ['index', 'u32', 1],
    ['target', 'u32', 1],
  ])
  assert.ok(cycle.size <= 256, `feature_memory_tiles_cycle is ${cycle.size} bytes`)
  const seat = declared(layout, 'components', 'feature_memory_tiles_seat')
  assert.deepEqual(seat.fields, [
    ['owner', 'u32', 1],
    ['seat', 'u32', 1],
    ['first_correct_tick', 'i32', 1],
  ])
  assert.ok(seat.size <= 256, `feature_memory_tiles_seat is ${seat.size} bytes`)
  const marker = declared(layout, 'components', 'feature_memory_tiles_marker')
  assert.deepEqual(marker.fields, [
    ['owner', 'u32', 1],
    ['index', 'u32', 1],
  ])
  assert.ok(marker.size <= 256, `feature_memory_tiles_marker is ${marker.size} bytes`)
})

test('match event carries seat, a and b after the nine original events', async () => {
  const layout = await layoutOf()
  assert.deepEqual(
    layout.events.map((event) => event.name).filter((name) => !name.startsWith('ege.')),
    ['finish', 'fall', 'eliminate', 'gate', 'progress', 'score', 'team_score', 'possess', 'crown', 'match'],
  )
  assert.deepEqual(declared(layout, 'events', 'match').fields, [
    ['seat', 'u32', 1],
    ['a', 'i32', 1],
    ['b', 'i32', 1],
  ])
})

const SHOW_RECORDS = [
  'show_seat_identity',
  'show_control',
  'show_character_ref',
  'show_result_a',
  'show_result_b',
  'show_publish',
  'show_pending',
]

async function showProbe(scene: unknown) {
  // A test-local world kind whose schedule copies the G6 round entries verbatim: only systems that
  // already exist, so this card introduces no schedule reference of its own.
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
    world_kinds: { name: string; players: number; schedule: unknown[] }[]
  }
  const round = schema.world_kinds.find((kind) => kind.name === 'round')
  assert.ok(round, 'the G6 round world kind is declared')
  schema.world_kinds.push({
    name: 'show_probe',
    players: 8,
    schedule: JSON.parse(JSON.stringify(round.schedule)),
  })
  const engine = await loadEngine()
  engine.setSchema(JSON.stringify(schema))
  const layout = schemaLayout(engine)
  const world = engine.createWorld(JSON.stringify(scene))
  return { engine, layout, world }
}

function fieldType(fields: (string | number)[][], name: string): string {
  const field = fields.find(([field]) => field === name)
  assert.ok(field, `${name} is declared`)
  assert.equal(typeof field[1], 'string')
  return field[1] as string
}

test('show seat identity and control records separate seats from entity references', async () => {
  const layout = await layoutOf()
  const identity = declared(layout, 'components', 'show_seat_identity')
  assert.deepEqual(identity.fields, [
    ['room_seat', 'u32', 1],
    ['round_seat', 'u32', 1],
    ['input_slot', 'i32', 1],
    ['bot', 'u32', 1],
  ])
  assert.deepEqual(identity.offsets, [
    ['room_seat', 0],
    ['round_seat', 4],
    ['input_slot', 8],
    ['bot', 12],
  ])
  assert.equal(identity.size, 16)
  const control = declared(layout, 'components', 'show_control')
  assert.deepEqual(control.fields, [['code', 'u32', 1]])
  assert.equal(control.size, 4)
})

test('show character references use entity fields and fit one transferable record', async () => {
  const layout = await layoutOf()
  const refs = declared(layout, 'components', 'show_character_ref')
  assert.deepEqual(refs.fields, [
    ['owner', 'entity', 1],
    ['target', 'entity', 1],
    ['lever', 'entity', 1],
    ['carry', 'entity', 1],
  ])
  assert.deepEqual(refs.offsets, [['owner', 0], ['target', 4], ['lever', 8], ['carry', 12]])
  assert.equal(refs.size, 16)
})

test('round character pre access tolerates absent show_control with the implemented script', async () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
    world_kinds: { name: string; players: number; schedule: { system: string }[] }[]
  }
  const round = schema.world_kinds.find((kind) => kind.name === 'round')
  assert.ok(round)
  const characterPre = round.schedule.find((entry) => entry.system === 'rf.character.pre')
  assert.ok(characterPre)
  schema.world_kinds.push({
    name: 'character_optional_probe',
    players: 8,
    schedule: [JSON.parse(JSON.stringify(characterPre))],
  })

  const compiled = await (await rfCompiler()).compile(collectRfScripts(), JSON.stringify(schema))
  assert.equal(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length, 0)
  assert.ok(compiled.wasm)
  const engine = await loadEngine()
  engine.setSchema(JSON.stringify(schema))
  const module = await loadScript(engine, compiled.wasm, { name: 'rf-scripts' })
  const layout = schemaLayout(engine)
  const world = engine.createWorld(JSON.stringify({
    format: 'ege.scene',
    version: 1,
    world_kind: 'character_optional_probe',
    seed: 1,
    entities: [],
  }))
  assert.deepEqual(readWorldState(engine, world, layout).components.show_control, {})
  new ScriptHost(module).stepTick(world, Array(8).fill(0))
  assert.equal(module.faultCount, 0)
})

test('show result records split the cumulative seat counters into two fixed records', async () => {
  const layout = await layoutOf()
  const a = declared(layout, 'components', 'show_result_a')
  assert.deepEqual(a.fields, [
    ['seat', 'i32', 1],
    ['status', 'i32', 1],
    ['finish_tick', 'i32', 1],
    ['finish_sub', 'i32', 1],
    ['lap', 'i32', 1],
    ['stage', 'i32', 1],
    ['route_mm', 'i32', 1],
    ['falls', 'i32', 1],
    ['score', 'i32', 1],
    ['last_score_tick', 'i32', 1],
  ])
  assert.equal(a.size, 40)
  const b = declared(layout, 'components', 'show_result_b')
  assert.deepEqual(b.fields, [
    ['hold_ticks', 'i32', 1],
    ['possessing', 'u32', 1],
    ['last_acquire_tick', 'i32', 1],
    ['matches', 'i32', 1],
    ['cross_ticks', 'i32', 1],
    ['out_tick', 'i32', 1],
    ['out_sub', 'i32', 1],
    ['team', 'i32', 1],
    ['opening_rank', 'i32', 1],
  ])
  assert.equal(b.size, 36)
  for (const record of [a, b]) assert.ok(record.size <= 256, `${record.size} bytes`)
})

test('show result records keep absent ticks, stage and team signed', async () => {
  const layout = await layoutOf()
  const a = declared(layout, 'components', 'show_result_a').fields
  const b = declared(layout, 'components', 'show_result_b').fields
  for (const name of ['finish_tick', 'finish_sub', 'last_score_tick', 'stage']) {
    assert.equal(fieldType(a, name), 'i32', name)
  }
  for (const name of ['last_acquire_tick', 'out_tick', 'out_sub', 'team']) {
    assert.equal(fieldType(b, name), 'i32', name)
  }
  assert.equal(fieldType(b, 'opening_rank'), 'i32')
  assert.equal(fieldType(b, 'possessing'), 'u32')
})

test('show publication and pending records own their seat entity', async () => {
  const layout = await layoutOf()
  const publish = declared(layout, 'components', 'show_publish')
  assert.deepEqual(publish.fields, [
    ['owner', 'entity', 1],
    ['seat', 'u32', 1],
    ['field', 'u32', 1],
    ['value', 'i32', 1],
    ['tick', 'i32', 1],
  ])
  assert.equal(publish.offsets[0][1], 0)
  assert.equal(publish.size, 20)
  const pending = declared(layout, 'components', 'show_pending')
  assert.deepEqual(pending.fields, [
    ['owner', 'entity', 1],
    ['source', 'u32', 1],
    ['key', 'u32', 1],
    ['kind', 'u32', 1],
    ['value', 'i32', 1],
    ['tick', 'i32', 1],
  ])
  assert.equal(pending.offsets[0][1], 0)
  assert.equal(pending.size, 24)
})

test('show records use scalar fields so arrays above sixteen stay child records', async () => {
  const layout = await layoutOf()
  for (const name of SHOW_RECORDS) {
    const entry = layout.components.find((component) => component.name === name)
    assert.ok(entry, `${name} is declared`)
    for (const field of entry.fields) assert.equal(field.count, 1, `${name}.${field.name}`)
    assert.ok(entry.size <= 256, `${name} is ${entry.size} bytes`)
  }
})

test('show records initialize absence to -1 in a constructed world and keep child ownership', async () => {
  const { engine, layout, world } = await showProbe({
    format: 'ege.scene',
    version: 1,
    world_kind: 'show_probe',
    seed: 1,
    entities: [
      { components: { show_publish: { owner: 1, seat: 59, field: 0, value: -1, tick: 0 } } },
      {
        components: {
          show_seat_identity: { room_seat: 59, round_seat: 0, input_slot: -1, bot: 4 },
          show_control: { code: 32639 },
          show_character_ref: { owner: 1, target: 0, lever: 0, carry: 0 },
          show_result_a: {
            seat: 59,
            status: 1,
            finish_tick: -1,
            finish_sub: -1,
            lap: 0,
            stage: -1,
            route_mm: 0,
            falls: 0,
            score: 0,
            last_score_tick: -1,
          },
          show_result_b: {
            hold_ticks: 0,
            possessing: 0,
            last_acquire_tick: -1,
            matches: 0,
            cross_ticks: 0,
            out_tick: -1,
            out_sub: -1,
            team: -1,
            opening_rank: 0,
          },
        },
      },
      {
        components: {
          show_pending: { owner: 1, source: 3, key: 59, kind: 0, value: -1, tick: 0 },
        },
      },
    ],
  })
  const state = readWorldState(engine, world, layout)
  const seat = state.entities[1]
  assert.equal(seat, 1)
  const identity = state.components.show_seat_identity[seat]
  assert.deepEqual(identity, { room_seat: 59, round_seat: 0, input_slot: -1, bot: 4 })
  assert.deepEqual(state.components.show_control[seat], { code: 32639 })
  assert.deepEqual(state.components.show_character_ref[seat], {
    owner: seat, target: 0, lever: 0, carry: 0,
  })
  const a = state.components.show_result_a[seat]
  assert.equal(a.status, 1)
  for (const name of ['finish_tick', 'finish_sub', 'last_score_tick', 'stage']) {
    assert.equal(a[name], -1, name)
  }
  for (const name of ['lap', 'route_mm', 'falls', 'score']) assert.equal(a[name], 0, name)
  const b = state.components.show_result_b[seat]
  for (const name of ['last_acquire_tick', 'out_tick', 'out_sub', 'team']) {
    assert.equal(b[name], -1, name)
  }
  for (const name of ['hold_ticks', 'possessing', 'matches', 'cross_ticks', 'opening_rank']) {
    assert.equal(b[name], 0, name)
  }
  const publish = state.components.show_publish[state.entities[0]]
  assert.equal(publish.owner, seat)
  assert.equal(publish.seat, 59)
  assert.equal(publish.value, -1)
  const pending = state.components.show_pending[state.entities[2]]
  assert.equal(pending.owner, seat)
  assert.equal(pending.source, 3)
  assert.equal(pending.value, -1)
})

const SEASON_RECORDS = [
  'show_season_cursor',
  'show_plan_entry',
  'show_catalog_entry',
  'show_candidate',
  'show_vote',
  'show_used_map',
  'show_opening_rank',
  'show_round_result',
  'show_result_seat',
  'show_result_team',
  'show_team_contribution',
  'show_result_pending',
  'show_clock',
  'show_hub_state',
  'show_hub_occupant',
]

test('season cursor keeps the plan in child rows and carries the schedule rng', async () => {
  const layout = await layoutOf()
  const cursor = declared(layout, 'components', 'show_season_cursor')
  assert.deepEqual(cursor.fields, [
    ['owner', 'entity', 1],
    ['step', 'u32', 1],
    ['alive', 'u32', 1],
    ['team_rounds', 'u32', 1],
    ['round_index', 'u32', 1],
    ['rng_state', 'u32', 1],
    ['final_map', 'i32', 1],
    ['last_kind', 'i32', 1],
    ['previous', 'i32', 1],
  ])
  assert.deepEqual(cursor.offsets, [
    ['owner', 0],
    ['step', 4],
    ['alive', 8],
    ['team_rounds', 12],
    ['round_index', 16],
    ['rng_state', 20],
    ['final_map', 24],
    ['last_kind', 28],
    ['previous', 32],
  ])
  assert.equal(cursor.size, 36)
  const plan = declared(layout, 'components', 'show_plan_entry')
  assert.deepEqual(plan.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['nominal', 'u32', 1],
  ])
  assert.equal(plan.size, 12)
})

test('season catalog, candidate, vote and used-map rows retain committed order', async () => {
  const layout = await layoutOf()
  const catalog = declared(layout, 'components', 'show_catalog_entry')
  assert.deepEqual(catalog.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['course', 'u32', 1],
    ['kind', 'u32', 1],
    ['final_rule', 'u32', 1],
    ['stages', 'u32', 1],
    ['team', 'u32', 1],
    ['cut', 'u32', 1],
  ])
  assert.equal(catalog.size, 32)
  const candidate = declared(layout, 'components', 'show_candidate')
  assert.deepEqual(candidate.fields, [
    ['owner', 'entity', 1],
    ['round_index', 'u32', 1],
    ['index', 'u32', 1],
    ['map', 'u32', 1],
  ])
  assert.equal(candidate.size, 16)
  const vote = declared(layout, 'components', 'show_vote')
  assert.deepEqual(vote.fields, [
    ['owner', 'entity', 1],
    ['round_index', 'u32', 1],
    ['seat', 'u32', 1],
    ['choice', 'i32', 1],
  ])
  assert.equal(vote.size, 16)
  const used = declared(layout, 'components', 'show_used_map')
  assert.deepEqual(used.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['map', 'u32', 1],
  ])
  assert.equal(used.size, 12)
})

test('opening ranks and round results keep their seat lists in owned child rows', async () => {
  const layout = await layoutOf()
  const opening = declared(layout, 'components', 'show_opening_rank')
  assert.deepEqual(opening.fields, [
    ['owner', 'entity', 1],
    ['seat', 'u32', 1],
    ['rank', 'i32', 1],
  ])
  assert.equal(opening.size, 12)
  const result = declared(layout, 'components', 'show_round_result')
  assert.deepEqual(result.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['map', 'u32', 1],
    ['course', 'u32', 1],
    ['kind', 'u32', 1],
    ['final', 'u32', 1],
    ['playoff', 'u32', 1],
    ['end_tick', 'i32', 1],
    ['reason', 'u32', 1],
    ['champion', 'i32', 1],
    ['ranking_count', 'u32', 1],
    ['qualified_count', 'u32', 1],
    ['eliminated_count', 'u32', 1],
    ['team_count', 'u32', 1],
  ])
  assert.equal(result.size, 56)
  const seat = declared(layout, 'components', 'show_result_seat')
  assert.deepEqual(seat.fields, [
    ['owner', 'entity', 1],
    ['result', 'u32', 1],
    ['list', 'u32', 1],
    ['position', 'u32', 1],
    ['seat', 'u32', 1],
    ['points', 'i32', 1],
  ])
  assert.equal(seat.size, 24)
  const team = declared(layout, 'components', 'show_result_team')
  assert.deepEqual(team.fields, [
    ['owner', 'entity', 1],
    ['result', 'u32', 1],
    ['team', 'u32', 1],
    ['score', 'i32', 1],
  ])
  assert.equal(team.size, 16)
})

test('team contributions, pending results and clock state stay bounded', async () => {
  const layout = await layoutOf()
  const contribution = declared(layout, 'components', 'show_team_contribution')
  assert.deepEqual(contribution.fields, [
    ['owner', 'entity', 1],
    ['feature', 'u32', 1],
    ['team', 'u32', 1],
    ['value', 'i32', 1],
    ['tick', 'i32', 1],
  ])
  assert.equal(contribution.size, 20)
  const pending = declared(layout, 'components', 'show_result_pending')
  assert.deepEqual(pending.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['end_tick', 'i32', 1],
    ['reason', 'u32', 1],
    ['confirmed', 'u32', 1],
  ])
  assert.equal(pending.size, 20)
  const clock = declared(layout, 'components', 'show_clock')
  assert.deepEqual(clock.fields, [
    ['owner', 'entity', 1],
    ['start_tick', 'i32', 1],
    ['end_tick', 'i32', 1],
    ['overtime_end_tick', 'i32', 1],
    ['phase', 'u32', 1],
    ['frozen', 'u32', 1],
    ['intro_ticks', 'u32', 1],
    ['round_ticks', 'u32', 1],
    ['overtime_ticks', 'u32', 1],
  ])
  assert.equal(clock.size, 36)
})

test('hub occupancy and wandering state split the root counts from occupant rows', async () => {
  const layout = await layoutOf()
  const hub = declared(layout, 'components', 'show_hub_state')
  assert.deepEqual(hub.fields, [
    ['owner', 'entity', 1],
    ['occupants', 'u32', 1],
    ['humans', 'u32', 1],
    ['bots', 'u32', 1],
    ['tick', 'i32', 1],
    ['rng_state', 'u32', 1],
  ])
  assert.equal(hub.size, 24)
  const occupant = declared(layout, 'components', 'show_hub_occupant')
  assert.deepEqual(occupant.fields, [
    ['owner', 'entity', 1],
    ['room_seat', 'u32', 1],
    ['round_seat', 'u32', 1],
    ['kind', 'u32', 1],
    ['emote', 'u32', 1],
    ['active', 'u32', 1],
    ['wander_x', 'f64', 1],
    ['wander_z', 'f64', 1],
    ['wander_tick', 'i32', 1],
    ['rng_state', 'u32', 1],
  ])
  assert.deepEqual(occupant.offsets, [
    ['owner', 0],
    ['room_seat', 4],
    ['round_seat', 8],
    ['kind', 12],
    ['emote', 16],
    ['active', 20],
    ['wander_x', 24],
    ['wander_z', 32],
    ['wander_tick', 40],
    ['rng_state', 44],
  ])
  assert.equal(occupant.size, 48)
})

test('season records are scalar simulation-lane snapshot state within 256 bytes', async () => {
  const layout = await layoutOf()
  for (const name of SEASON_RECORDS) {
    const entry = layout.components.find((component) => component.name === name)
    assert.ok(entry, `${name} is declared`)
    assert.equal(entry.lane, 'simulation', `${name} is snapshot state`)
    for (const field of entry.fields) assert.equal(field.count, 1, `${name}.${field.name}`)
    assert.ok(entry.size <= 256, `${name} is ${entry.size} bytes`)
  }
})

test('season records construct in a world and leave undeclared fields at zero', async () => {
  const { engine, layout, world } = await showProbe({
    format: 'ege.scene',
    version: 1,
    world_kind: 'show_probe',
    seed: 3,
    entities: [
      {
        components: {
          show_season_cursor: {
            owner: 0, step: 2, alive: 24, team_rounds: 0, round_index: 2, rng_state: 99,
            final_map: 4, last_kind: 1, previous: 3,
          },
          show_plan_entry: { owner: 0, index: 2, nominal: 24 },
          show_catalog_entry: { owner: 0, index: 4, course: 2, kind: 0, final_rule: 1, stages: 31, team: 0, cut: 1 },
          show_candidate: { owner: 0, round_index: 2, index: 0, map: 4 },
          show_vote: { owner: 0, round_index: 2, seat: 59, choice: 0 },
          show_used_map: { owner: 0, index: 0, map: 4 },
          show_opening_rank: { owner: 0, seat: 59, rank: 1 },
          show_round_result: {
            owner: 0, index: 2, map: 4, course: 2, kind: 0, final: 0, playoff: 0, end_tick: 1800,
            reason: 0, champion: -1, ranking_count: 24, qualified_count: 12, eliminated_count: 12,
            team_count: 0,
          },
          show_result_seat: { owner: 0, result: 2, list: 0, position: 0, seat: 59, points: 24 },
          show_result_team: { owner: 0, result: 2, team: 0, score: 3 },
          show_team_contribution: { owner: 0, feature: 1, team: 0, value: 7, tick: 900 },
          show_result_pending: { owner: 0, index: 2, end_tick: 1800, reason: 0, confirmed: 0 },
          show_clock: {
            owner: 0, start_tick: 60, end_tick: 1800, overtime_end_tick: 2400, phase: 1, frozen: 0,
            intro_ticks: 60, round_ticks: 1740, overtime_ticks: 600,
          },
          show_hub_state: { owner: 0, occupants: 2, humans: 1, bots: 1, tick: 30, rng_state: 5 },
          show_hub_occupant: {
            owner: 0, room_seat: 0, round_seat: 0, kind: 0, emote: 2, active: 1,
            wander_x: 1.5, wander_z: -2.5, wander_tick: 120, rng_state: 7,
          },
        },
      },
      {
        components: {
          show_season_cursor: { owner: 0 },
          show_clock: { owner: 0 },
          show_hub_occupant: { owner: 0 },
        },
      },
    ],
  })
  const state = readWorldState(engine, world, layout)
  const root = state.entities[0]
  const seat = state.entities[1]
  const cursor = state.components.show_season_cursor[root]
  assert.equal(cursor.owner, root)
  assert.equal(cursor.step, 2)
  assert.equal(cursor.alive, 24)
  assert.equal(cursor.rng_state, 99)
  assert.equal(cursor.final_map, 4)
  assert.equal(state.components.show_plan_entry[root].nominal, 24)
  assert.equal(state.components.show_catalog_entry[root].stages, 31)
  assert.equal(state.components.show_candidate[root].map, 4)
  assert.equal(state.components.show_vote[root].choice, 0)
  assert.equal(state.components.show_used_map[root].map, 4)
  assert.equal(state.components.show_opening_rank[root].rank, 1)
  const result = state.components.show_round_result[root]
  assert.equal(result.champion, -1)
  assert.equal(result.ranking_count, 24)
  const resultSeat = state.components.show_result_seat[root]
  assert.equal(resultSeat.owner, root)
  assert.equal(resultSeat.points, 24)
  assert.equal(state.components.show_result_team[root].score, 3)
  assert.equal(state.components.show_team_contribution[root].value, 7)
  assert.equal(state.components.show_result_pending[root].confirmed, 0)
  assert.equal(state.components.show_clock[root].overtime_ticks, 600)
  assert.equal(state.components.show_hub_state[root].occupants, 2)
  const occupant = state.components.show_hub_occupant[root]
  assert.equal(occupant.wander_x, 1.5)
  assert.equal(occupant.wander_z, -2.5)
  assert.equal(occupant.emote, 2)
  const sparse = state.components.show_season_cursor[seat]
  assert.equal(sparse.owner, root)
  for (const name of ['step', 'alive', 'team_rounds', 'round_index', 'rng_state']) {
    assert.equal(sparse[name], 0, name)
  }
  assert.equal(state.components.show_clock[seat].round_ticks, 0)
  assert.equal(state.components.show_hub_occupant[seat].wander_x, 0)
})

const BOT_RECORDS = [
  'bot_behaviour',
  'bot_rule',
  'show_nav_region',
  'show_nav_edge',
  'show_nav_node',
  'bot_seat',
  'bot_skill',
  'bot_memory',
  'bot_route',
  'bot_route_region',
  'bot_route_edge',
  'bot_route_waypoint',
  'bot_reaction',
  'bot_reaction_chunk',
  'show_feature_membership',
  'show_feature_cooldown',
]

const REACTION_CODE_SLOTS = 16
const REACTION_MAX_DELAY_TICKS = 120
const REACTION_CHUNKS = 8

test('authored bot behaviour and rule rows serialize the validated v0 values', async () => {
  const layout = await layoutOf()
  const behaviour = declared(layout, 'components', 'bot_behaviour')
  assert.deepEqual(behaviour.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['decision_ticks', 'u32', 1],
    ['reaction_ticks', 'u32', 1],
    ['wobble_ticks', 'u32', 1],
    ['stuck_ticks', 'u32', 1],
    ['preference', 'u32', 1],
    ['advance_m', 'f64', 1],
    ['arrive_m', 'f64', 1],
    ['rule_count', 'u32', 1],
  ])
  assert.ok(behaviour.size <= 256, `bot_behaviour is ${behaviour.size} bytes`)
  const rule = declared(layout, 'components', 'bot_rule')
  assert.deepEqual(rule.fields, [
    ['owner', 'entity', 1],
    ['behaviour', 'entity', 1],
    ['index', 'u32', 1],
    ['predicate', 'u32', 1],
    ['action', 'u32', 1],
    ['has_phase', 'u32', 1],
    ['phase_from', 'i32', 1],
    ['phase_to', 'i32', 1],
    ['has_distance', 'u32', 1],
    ['distance_m', 'f64', 1],
  ])
  assert.ok(rule.size <= 256, `bot_rule is ${rule.size} bytes`)
  assert.equal(fieldType(rule.fields, 'behaviour'), 'entity')
})

test('authored navigation rows keep regions, adjacency and wait/pull nodes', async () => {
  const layout = await layoutOf()
  const region = declared(layout, 'components', 'show_nav_region')
  assert.deepEqual(region.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['region', 'i32', 1],
    ['center', 'f64', 3],
    ['half', 'f64', 3],
    ['adjacent_count', 'u32', 1],
  ])
  assert.ok(region.size <= 256, `show_nav_region is ${region.size} bytes`)
  const edge = declared(layout, 'components', 'show_nav_edge')
  assert.deepEqual(edge.fields, [
    ['owner', 'entity', 1],
    ['region_index', 'u32', 1],
    ['edge_index', 'u32', 1],
    ['adjacent', 'i32', 1],
  ])
  assert.ok(edge.size <= 256, `show_nav_edge is ${edge.size} bytes`)
  const node = declared(layout, 'components', 'show_nav_node')
  assert.deepEqual(node.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['p', 'f64', 3],
    ['jump', 'u32', 1],
    ['dive', 'u32', 1],
    ['region', 'i32', 1],
    ['wait_signal', 'i32', 1],
    ['pull_signal', 'i32', 1],
  ])
  assert.ok(node.size <= 256, `show_nav_node is ${node.size} bytes`)
})

test('bot initialization, skill, memory and route plan stay on transferable seat records', async () => {
  const layout = await layoutOf()
  const seat = declared(layout, 'components', 'bot_seat')
  assert.deepEqual(seat.fields, [
    ['owner', 'entity', 1],
    ['character', 'entity', 1],
    ['behaviour', 'entity', 1],
  ])
  assert.equal(seat.size, 12)
  const skill = declared(layout, 'components', 'bot_skill')
  assert.deepEqual(skill.fields, [
    ['owner', 'entity', 1],
    ['reaction_ticks', 'u32', 1],
    ['aim_error', 'f64', 1],
    ['jump_lead', 'f64', 1],
    ['dive_chance', 'f64', 1],
  ])
  assert.ok(skill.size <= 256, `bot_skill is ${skill.size} bytes`)
  const memory = declared(layout, 'components', 'bot_memory')
  assert.deepEqual(memory.fields, [
    ['owner', 'entity', 1],
    ['rng_state', 'u32', 1],
    ['ticks', 'u32', 1],
    ['wait_ticks', 'u32', 1],
    ['path_index', 'u32', 1],
    ['stuck_ticks', 'u32', 1],
    ['last_x', 'f64', 1],
    ['last_z', 'f64', 1],
    ['wobble', 'f64', 1],
  ])
  assert.ok(memory.size <= 256, `bot_memory is ${memory.size} bytes`)
  assert.equal(fieldType(memory.fields, 'rng_state'), 'u32')
  const route = declared(layout, 'components', 'bot_route')
  assert.deepEqual(route.fields, [
    ['owner', 'entity', 1],
    ['preference', 'u32', 1],
    ['seed', 'u32', 1],
    ['plan_tick', 'i32', 1],
    ['next_plan_tick', 'i32', 1],
    ['cost', 'f64', 1],
    ['reachable', 'u32', 1],
    ['region_count', 'u32', 1],
    ['edge_count', 'u32', 1],
    ['waypoint_count', 'u32', 1],
  ])
  assert.ok(route.size <= 256, `bot_route is ${route.size} bytes`)
  assert.equal(fieldType(route.fields, 'cost'), 'f64')
})

test('bot route lists keep regions, edges and waypoints in owned entity child rows', async () => {
  const layout = await layoutOf()
  const region = declared(layout, 'components', 'bot_route_region')
  assert.deepEqual(region.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['region', 'i32', 1],
  ])
  const edge = declared(layout, 'components', 'bot_route_edge')
  assert.deepEqual(edge.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['from_region', 'i32', 1],
    ['to_region', 'i32', 1],
  ])
  const waypoint = declared(layout, 'components', 'bot_route_waypoint')
  assert.deepEqual(waypoint.fields, [
    ['owner', 'entity', 1],
    ['index', 'u32', 1],
    ['node', 'u32', 1],
  ])
  for (const record of [region, edge, waypoint]) {
    assert.ok(record.size <= 256, `${record.size} bytes`)
    assert.equal(record.fields[0][0], 'owner')
    assert.equal(record.fields[0][1], 'entity')
  }
})

test('reaction chunks hold sixteen codes and eight linked chunks cover the 120 tick delay', async () => {
  const layout = await layoutOf()
  const reaction = declared(layout, 'components', 'bot_reaction')
  assert.deepEqual(reaction.fields, [
    ['owner', 'entity', 1],
    ['chunk_head', 'entity', 1],
    ['chunk_tail', 'entity', 1],
    ['code_count', 'u32', 1],
    ['delay_ticks', 'u32', 1],
  ])
  assert.equal(reaction.size, 20)
  const chunk = declared(layout, 'components', 'bot_reaction_chunk')
  assert.deepEqual(chunk.fields, [
    ['owner', 'entity', 1],
    ['next_chunk', 'entity', 1],
    ['chunk_index', 'u32', 1],
    ['code_count', 'u32', 1],
    ['codes', 'u32', REACTION_CODE_SLOTS],
  ])
  assert.equal(chunk.size, 80)
  assert.ok(REACTION_CHUNKS * REACTION_CODE_SLOTS >= REACTION_MAX_DELAY_TICKS + 1)
  assert.ok((REACTION_CHUNKS - 1) * REACTION_CODE_SLOTS < REACTION_MAX_DELAY_TICKS + 1)
})

test('scene construction links reaction chunks, resolves ownership and preserves chunk boundaries', async () => {
  const chunks = Array.from({ length: REACTION_CHUNKS }, (_, index) => ({
    components: {
      bot_reaction_chunk: {
        owner: 1,
        next_chunk: index + 1 < REACTION_CHUNKS ? 4 + index + 1 : 0,
        chunk_index: index,
        code_count: REACTION_CODE_SLOTS,
        codes: Array.from(
          { length: REACTION_CODE_SLOTS },
          (_, slot) => index * REACTION_CODE_SLOTS + slot,
        ),
      },
    },
  }))
  const { engine, layout, world } = await showProbe({
    format: 'ege.scene',
    version: 1,
    world_kind: 'show_probe',
    seed: 7,
    entities: [
      {},
      {
        components: {
          show_seat_identity: { room_seat: 59, round_seat: 0, input_slot: -1, bot: 4 },
          bot_seat: { owner: 1, character: 2, behaviour: 3 },
          bot_skill: {
            owner: 1, reaction_ticks: 7, aim_error: 0.125, jump_lead: 0.25, dive_chance: 0.375,
          },
          bot_memory: {
            owner: 1, rng_state: 99, ticks: 12, wait_ticks: 3, path_index: 2, stuck_ticks: 1,
            last_x: 1.5, last_z: -2.5, wobble: 0.5,
          },
          bot_route: {
            owner: 1, preference: 1, seed: 7, plan_tick: 0, next_plan_tick: 30, cost: 24000048,
            reachable: 1, region_count: 2, edge_count: 1, waypoint_count: 3,
          },
          bot_reaction: {
            owner: 1,
            chunk_head: 4,
            chunk_tail: 4 + REACTION_CHUNKS - 1,
            code_count: REACTION_CHUNKS * REACTION_CODE_SLOTS,
            delay_ticks: REACTION_MAX_DELAY_TICKS,
          },
        },
      },
      {},
      {
        components: {
          bot_behaviour: {
            owner: 3, index: 0, decision_ticks: 30, reaction_ticks: 120, wobble_ticks: 45,
            stuck_ticks: 30, preference: 1, advance_m: 1.5, arrive_m: 0.5, rule_count: 1,
          },
          bot_rule: {
            owner: 3, behaviour: 3, index: 0, predicate: 3, action: 0, has_phase: 0,
            phase_from: 0, phase_to: 0, has_distance: 0, distance_m: 0,
          },
        },
      },
      ...chunks,
      {},
      {
        components: {
          show_feature_membership: { owner: 12, feature: 12, character: 2, index: 0, inside: 1 },
        },
      },
      {
        components: {
          show_feature_cooldown: {
            owner: 12, feature: 12, character: 2, index: 0, ready_at: 90, boost_until: 30,
          },
        },
      },
    ],
  })
  const state = readWorldState(engine, world, layout)
  const seat = state.entities[1]
  const bot = state.components.bot_seat[seat]
  assert.equal(bot.owner, seat)
  assert.equal(bot.character, 2)
  assert.equal(bot.behaviour, 3)
  assert.equal(state.components.bot_skill[seat].reaction_ticks, 7)
  assert.equal(state.components.bot_skill[seat].aim_error, 0.125)
  const memory = state.components.bot_memory[seat]
  assert.equal(memory.rng_state, 99)
  assert.equal(memory.path_index, 2)
  assert.equal(memory.last_x, 1.5)
  assert.equal(memory.last_z, -2.5)
  assert.equal(state.components.bot_route[seat].cost, 24000048)
  assert.equal(state.components.bot_route[seat].next_plan_tick, 30)
  const behaviour = state.components.bot_behaviour[3]
  assert.equal(behaviour.reaction_ticks, 120)
  assert.equal(behaviour.rule_count, 1)
  const rule = state.components.bot_rule[3]
  assert.equal(rule.owner, 3)
  assert.equal(rule.behaviour, 3)
  assert.equal(rule.predicate, 3)
  const member = state.components.show_feature_membership[state.entities[13]]
  assert.equal(member.owner, state.entities[12])
  assert.equal(member.feature, state.entities[12])
  assert.equal(member.character, state.entities[2])
  assert.equal(member.inside, 1)
  const cooldown = state.components.show_feature_cooldown[state.entities[14]]
  assert.equal(cooldown.feature, state.entities[12])
  assert.equal(cooldown.character, state.entities[2])
  assert.equal(cooldown.ready_at, 90)
  assert.equal(cooldown.boost_until, 30)
  const reaction = state.components.bot_reaction[seat]
  assert.equal(reaction.chunk_head, 4)
  assert.equal(reaction.chunk_tail, 4 + REACTION_CHUNKS - 1)
  assert.equal(reaction.code_count, REACTION_CHUNKS * REACTION_CODE_SLOTS)
  assert.equal(reaction.delay_ticks, REACTION_MAX_DELAY_TICKS)
  assert.ok(typeof reaction.chunk_head === 'number')
  let entity = reaction.chunk_head
  let seen = 0
  while (entity !== 0 && seen < REACTION_CHUNKS) {
    const chunk = state.components.bot_reaction_chunk[entity]
    assert.equal(chunk.owner, seat)
    assert.equal(chunk.chunk_index, seen)
    assert.equal(chunk.code_count, REACTION_CODE_SLOTS)
    const codes = chunk.codes
    assert.ok(Array.isArray(codes), 'codes is an array')
    assert.equal(codes.length, REACTION_CODE_SLOTS)
    assert.equal(codes[0], seen * REACTION_CODE_SLOTS)
    assert.equal(
      codes[REACTION_CODE_SLOTS - 1],
      seen * REACTION_CODE_SLOTS + REACTION_CODE_SLOTS - 1,
    )
    const next = chunk.next_chunk
    assert.ok(typeof next === 'number')
    entity = next
    seen++
  }
  assert.equal(seen, REACTION_CHUNKS)
  assert.equal(entity, 0)
})

test('show feature membership and cooldown rows replace the eight-seat arrays on the show path', async () => {
  const layout = await layoutOf()
  const member = declared(layout, 'components', 'show_feature_membership')
  assert.deepEqual(member.fields, [
    ['owner', 'entity', 1],
    ['feature', 'entity', 1],
    ['character', 'entity', 1],
    ['index', 'u32', 1],
    ['inside', 'u32', 1],
  ])
  assert.ok(member.size <= 256, `show_feature_membership is ${member.size} bytes`)
  const cooldown = declared(layout, 'components', 'show_feature_cooldown')
  assert.deepEqual(cooldown.fields, [
    ['owner', 'entity', 1],
    ['feature', 'entity', 1],
    ['character', 'entity', 1],
    ['index', 'u32', 1],
    ['ready_at', 'i32', 1],
    ['boost_until', 'i32', 1],
  ])
  assert.ok(cooldown.size <= 256, `show_feature_cooldown is ${cooldown.size} bytes`)
  assert.equal(fieldType(member.fields, 'feature'), 'entity')
  assert.equal(fieldType(member.fields, 'character'), 'entity')
  assert.equal(fieldType(cooldown.fields, 'feature'), 'entity')
  assert.equal(fieldType(cooldown.fields, 'character'), 'entity')
  const boost = declared(layout, 'components', 'feature_boost_lane')
  for (const name of ['boost_until', 'ready_at']) {
    const field = boost.fields.find(([fieldName]) => fieldName === name)
    assert.ok(field, name)
    assert.equal(field[2], 8, `G6 ${name} keeps its eight-seat array`)
  }
  const catchVolume = declared(layout, 'components', 'feature_catch_volume')
  const catchInside = catchVolume.fields.find(([name]) => name === 'inside')
  assert.ok(catchInside)
  assert.equal(catchInside[2], 8)
  const swimVolume = declared(layout, 'components', 'feature_swim_volume')
  const swimInside = swimVolume.fields.find(([name]) => name === 'inside')
  assert.ok(swimInside)
  assert.equal(swimInside[2], 8)
})

test('bot and feature records are simulation-lane snapshot state within 256 bytes', async () => {
  const layout = await layoutOf()
  for (const name of BOT_RECORDS) {
    const entry = layout.components.find((component) => component.name === name)
    assert.ok(entry, `${name} is declared`)
    assert.equal(entry.lane, 'simulation', `${name} is snapshot state`)
    assert.ok(entry.size <= 256, `${name} is ${entry.size} bytes`)
    for (const field of entry.fields) {
      assert.ok(field.count >= 1 && field.count <= 16, `${name}.${field.name} count`)
      if (field.count > 1) {
        const allowed = (name === 'bot_reaction_chunk' && field.name === 'codes') ||
          (name.startsWith('show_nav_') && ['center', 'half', 'p'].includes(field.name))
        assert.ok(allowed, `${name}.${field.name} must stay a small authored array`)
      }
    }
  }
})
