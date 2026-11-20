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

test('sweep root, phase and part records carry their declared fields within 256 bytes', async () => {
  const components = (await layoutOf()).components
  const layout = (name: string) => {
    const component = components.find((entry) => entry.name === name)
    assert.ok(component, `${name} is declared`)
    return {
      size: component.size,
      fields: component.fields.map((field) => [field.name, field.type, field.count]),
    }
  }
  const sweep = layout('feature_sweep')
  assert.deepEqual(sweep.fields, [
    ['center', 'f64', 3],
    ['length_m', 'f64', 1],
    ['telegraph_s', 'f64', 1],
    ['phase_count', 'u32', 1],
    ['part_count', 'u32', 1],
    ['overtime_ticks', 'u32', 1],
    ['active', 'u32', 1],
    ['effective', 'f64', 1],
    ['live', 'u32', 1],
    ['just_live', 'u32', 1],
    ['cos', 'f64', 1],
    ['sin', 'f64', 1],
    ['slide', 'f64', 1],
    ['placed', 'u32', 1],
  ])
  assert.ok(sweep.size <= 256, `feature_sweep is ${sweep.size} bytes`)
  const phase = layout('feature_sweep_phase')
  assert.deepEqual(phase.fields, [
    ['owner', 'u32', 1],
    ['index', 'u32', 1],
    ['at_s', 'f64', 1],
    ['pattern', 'u32', 1],
    ['height_m', 'f64', 1],
    ['gap_m', 'f64', 1],
    ['speed_deg_s', 'f64', 1],
    ['speed_mps', 'f64', 1],
  ])
  assert.ok(phase.size <= 256, `feature_sweep_phase is ${phase.size} bytes`)
  const part = layout('feature_sweep_part')
  assert.deepEqual(part.fields, [
    ['owner', 'u32', 1],
    ['index', 'u32', 1],
    ['half', 'f64', 3],
  ])
  assert.ok(part.size <= 256, `feature_sweep_part is ${part.size} bytes`)
})
