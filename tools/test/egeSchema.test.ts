import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'

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
