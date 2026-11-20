import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'

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
  'rf.feature.hex_field.pre',
  'rf.feature.memory_tiles.pre',
  'rf.feature.annulus.pre',
  'rf.feature.sweep.pre',
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
