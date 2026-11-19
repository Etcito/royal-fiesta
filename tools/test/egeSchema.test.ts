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
  'rf.feature.swim_volume.pre',
  'ege.body.props',
  'ege.physics',
  'ege.contact.track',
  'ege.mech.watch',
  'rf.character.post',
  'rf.feature.marker.post',
  'rf.feature.launch_pad.post',
  'rf.feature.catch_volume.post',
  'rf.feature.tile_field.post',
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
