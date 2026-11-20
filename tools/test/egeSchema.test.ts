import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadEngine } from '@etcito/game-engine'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { decodeEvents, readWorldState } from '@etcito/game-engine/world-state'
import { generateComponents } from '@etcito/game-engine-compile'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../egeScripts.ts'

const SCHEMA = fileURLToPath(new URL('../../ege.schema.json', import.meta.url))
const NO_ENTITY = 0xffffffff

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

// The rf.character.pre access lists of the round world: the G6 lists, plus show_control (read) and
// show_character_ref (read and write). The probe below copies the production entry itself.
const CHARACTER_PRE_READS = [
  'seat',
  'ege.transform',
  'ege.mover',
  'surface',
  'ege.mech.lever',
  'show_control',
  'show_character_ref',
]
const CHARACTER_PRE_WRITES = ['character', 'ege.velocity', 'ege.body_props', 'ege.mech.grab', 'show_character_ref']

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
  const names = new Map(layout.components.map((component): [number, string] => [component.id, component.name]))
  const loadedPre = round.schedule.find((entry) => entry.system === 'rf.character.pre')
  assert.ok(loadedPre)
  assert.deepEqual(loadedPre.reads.map((id) => names.get(id)), CHARACTER_PRE_READS)
  assert.deepEqual(loadedPre.writes.map((id) => names.get(id)), CHARACTER_PRE_WRITES)
  const sourceSchema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
    world_kinds: { name: string; schedule: { system: string; reads?: string[]; writes?: string[] }[] }[]
  }
  const sourceRound = sourceSchema.world_kinds.find((kind) => kind.name === 'round')
  assert.ok(sourceRound)
  const characterPre = sourceRound.schedule.find((entry) => entry.system === 'rf.character.pre')
  assert.ok(characterPre)
  assert.deepEqual(characterPre.reads, CHARACTER_PRE_READS)
  assert.deepEqual(characterPre.writes, CHARACTER_PRE_WRITES)
})

test('show physics worlds track zones and the zero-input rules world tallies them', async () => {
  const layout = await layoutOf()
  for (const [name, players] of [['show_seat', 8], ['show_field', 8], ['show_hub', 1]] as const) {
    const kind = layout.world_kinds.find(kind => kind.name === name)
    assert.ok(kind, name)
    assert.equal(kind.players, players)
    const systems = kind.schedule.map(entry => entry.system)
    const physics = systems.indexOf('ege.physics')
    assert.ok(physics >= 0 && systems.indexOf('ege.zone.track') > physics, name)
  }
  const rules = layout.world_kinds.find(kind => kind.name === 'show_rules')
  assert.ok(rules)
  assert.equal(rules.players, 0)
  assert.ok(rules.schedule.some(entry => entry.system === 'ege.zone.tally'))
  assert.ok(rules.schedule.every(entry => entry.system !== 'ege.physics'))
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

test('generated show character reference class carries its id, size and entity fields', async () => {
  const layout = await layoutOf()
  const decl = layout.components.find((component) => component.name === 'show_character_ref')
  assert.ok(decl, 'show_character_ref is declared')
  const source = generateComponents(layout)
  const start = source.indexOf('export class ShowCharacterRef {')
  assert.ok(start >= 0, 'components.gen declares class ShowCharacterRef')
  const body = source.slice(start, source.indexOf('\n}', start))
  for (const field of ['owner', 'target', 'lever', 'carry']) {
    assert.ok(body.includes(`  ${field}: u32;`), `${field} is an entity-typed u32 field`)
  }
  assert.ok(body.includes(`static readonly ID: u32 = ${decl.id};`), body)
  assert.ok(body.includes(`static readonly SIZE: u32 = ${decl.size};`), body)
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

// The test-local probe script. An absent show_character_ref is a null lookup and is skipped; a present one is
// read (target) and written (carry). It is compiled with the production scripts and runs under a copy of the
// production rf.character.pre access lists, so the write needs the writes entry.
const CHARACTER_REF_PROBE = `import { entityAt, entityCount, getComponent, isNull, setComponent } from 'ege'
import { ShowCharacterRef } from '../components.gen'

export function rf_probe_character_ref(): void {
  const count = entityCount()
  for (let i: u32 = 0; i < count; i++) {
    const entity = entityAt(i)
    const ref = getComponent<ShowCharacterRef>(entity, ShowCharacterRef.ID, ShowCharacterRef.SIZE)
    if (isNull<ShowCharacterRef>(ref)) continue
    ref.carry = ref.target
    setComponent<ShowCharacterRef>(entity, ShowCharacterRef.ID, ShowCharacterRef.SIZE, ref)
  }
}
`

test('show character reference lookup is optional and writable under the copied character access lists', async () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
    world_kinds: { name: string; players: number; schedule: { system: string }[] }[]
  }
  const round = schema.world_kinds.find((kind) => kind.name === 'round')
  assert.ok(round)
  const characterPre = round.schedule.find((entry) => entry.system === 'rf.character.pre')
  assert.ok(characterPre)
  // The probe's entry is a copy of the production entry (its reads and writes) under the probe's own system name.
  const probe = { ...JSON.parse(JSON.stringify(characterPre)), system: 'rf.probe.character_ref' }
  schema.world_kinds.push({ name: 'character_ref_probe', players: 8, schedule: [probe] })

  const files = [...collectRfScripts(), { name: 'probe/character_ref.as.ts', text: CHARACTER_REF_PROBE }]
  const compiled = await (await rfCompiler()).compile(files, JSON.stringify(schema))
  assert.deepEqual(compiled.diagnostics.filter((d) => d.severity === 'error').map(formatRfDiagnostic), [])
  assert.ok(compiled.wasm)
  const engine = await loadEngine()
  engine.setSchema(JSON.stringify(schema))
  const module = await loadScript(engine, compiled.wasm, { name: 'rf-scripts' })
  const layout = schemaLayout(engine)
  const world = engine.createWorld(JSON.stringify({
    format: 'ege.scene',
    version: 1,
    world_kind: 'character_ref_probe',
    seed: 1,
    entities: [
      // Entity 0 has no show_character_ref: the optional lookup is null and nothing is written.
      { components: { show_control: { code: 32639 } } },
      // Entity 1 targets entity 0 and has no carry yet: the probe reads target and writes it into carry.
      { components: { show_character_ref: { owner: 1, target: 0, lever: NO_ENTITY, carry: NO_ENTITY } } },
    ],
  }))
  const host = new ScriptHost(module)
  host.stepTick(world, Array(8).fill(0))
  host.stepTick(world, Array(8).fill(0))
  assert.equal(module.faultCount, 0, module.faults.map((fault) => fault.message).join('; '))
  const state = readWorldState(engine, world, layout)
  assert.equal(state.components.show_character_ref[0], undefined)
  assert.deepEqual(state.components.show_character_ref[1], { owner: 1, target: 0, lever: NO_ENTITY, carry: 0 })
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

const MEMBERSHIP_READS = ['feature', 'show_seat_identity', 'show_feature_membership', 'ege.zone.id']
const MEMBERSHIP_WRITES = ['show_feature_membership', 'ege.zone.id']
const CATCH_ACCESS = {
  reads: ['seat', 'gate', ...MEMBERSHIP_READS],
  writes: ['feature_catch_volume', 'character', 'ege.transform', 'ege.velocity', 'ege.mech.grab', ...MEMBERSHIP_WRITES],
}
/**
 * Handoff: G7.1 Identity, inputs and world construction: install complete show schedules: MEMBERSHIP_ACCESS pins the
 * access lists ege.schema.json grants today to the shared rf.feature.catch_volume.pre/.post and
 * rf.feature.swim_volume.pre entries of round, show_seat, show_field and show_hub: the existing grants first, then
 * reads of feature, show_seat_identity, show_feature_membership and ege.zone.id and writes of
 * show_feature_membership and ege.zone.id for seat-anchored membership creation. The schedule order is unchanged.
 */
const MEMBERSHIP_ACCESS: Record<string, { reads: string[]; writes: string[] }> = {
  'rf.feature.catch_volume.pre': CATCH_ACCESS,
  'rf.feature.catch_volume.post': CATCH_ACCESS,
  'rf.feature.swim_volume.pre': {
    reads: ['seat', 'ege.transform', ...MEMBERSHIP_READS],
    writes: ['feature_swim_volume', 'character', 'ege.velocity', ...MEMBERSHIP_WRITES],
  },
}
const MEMBERSHIP_WORLDS = ['round', 'show_seat', 'show_field', 'show_hub']

type AccessSchema = { world_kinds: { name: string; players: number; schedule: { system: string; kind: string; reads?: string[]; writes?: string[]; emits?: string[] }[] }[] }

test('shared catch and swim entries grant membership creation and zone identity access in every world', async () => {
  const layout = await layoutOf()
  const names = new Map(layout.components.map((component): [number, string] => [component.id, component.name]))
  const source = JSON.parse(readFileSync(SCHEMA, 'utf8')) as AccessSchema
  for (const world of MEMBERSHIP_WORLDS) {
    const loaded = layout.world_kinds.find((kind) => kind.name === world)
    const authored = source.world_kinds.find((kind) => kind.name === world)
    assert.ok(loaded && authored, world)
    for (const [system, access] of Object.entries(MEMBERSHIP_ACCESS)) {
      const entry: AccessSchema['world_kinds'][number]['schedule'][number] | undefined =
        authored.schedule.find((candidate) => candidate.system === system)
      const loadedEntry: Layout['world_kinds'][number]['schedule'][number] | undefined =
        loaded.schedule.find((candidate) => candidate.system === system)
      assert.ok(entry, `${world} ${system}`)
      assert.ok(loadedEntry, `${world} ${system}`)
      assert.deepEqual({ reads: entry.reads, writes: entry.writes }, access, `${world} ${system}`)
      assert.deepEqual(loadedEntry.reads.map((id: number) => names.get(id)), access.reads, `${world} ${system}`)
      assert.deepEqual(loadedEntry.writes.map((id: number) => names.get(id)), access.writes, `${world} ${system}`)
    }
  }
  const round = source.world_kinds.find((kind) => kind.name === 'round')
  assert.deepEqual(round?.schedule.map((entry) => entry.system), SCHEDULE)
})

// The focused access probe: under one copied production entry it creates a show_feature_membership row for each
// seat and feature on demand, attaches its ege.zone.id {0x40000000 + index*64 + room_seat, anchor owner, anchor
// group} immediately and reuses an existing row by feature index plus character.
const MEMBERSHIP_ACCESS_PROBE = `import { getComponent, isNull, newRecord, readColumn, setComponent, spawn } from 'ege'
import { EgeZoneId, Feature, ShowFeatureMembership, ShowSeatIdentity } from '../components.gen'

function probe(): void {
  const seats = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)
  const features = readColumn<Feature>(Feature.ID, Feature.SIZE)
  const rows = readColumn<ShowFeatureMembership>(ShowFeatureMembership.ID, ShowFeatureMembership.SIZE)
  for (let s: u32 = 0; s < seats.count; s++) {
    const character = seats.entity(s)
    const room = seats.at(s).room_seat
    const anchor = getComponent<EgeZoneId>(character, EgeZoneId.ID, EgeZoneId.SIZE)
    if (isNull<EgeZoneId>(anchor)) continue
    for (let f: u32 = 0; f < features.count; f++) {
      const index = features.at(f).index
      let found = false
      for (let r: u32 = 0; r < rows.count; r++) {
        const row = rows.at(r)
        if (row.index != index || row.character != character) continue
        row.inside = row.inside + 1
        found = true
      }
      if (found || index > 16777215 || room > 59) continue
      const entity = spawn()
      const row = newRecord<ShowFeatureMembership>(ShowFeatureMembership.SIZE)
      row.owner = character
      row.feature = features.entity(f)
      row.character = character
      row.index = index
      row.inside = 1
      setComponent<ShowFeatureMembership>(entity, ShowFeatureMembership.ID, ShowFeatureMembership.SIZE, row)
      const zone = newRecord<EgeZoneId>(EgeZoneId.SIZE)
      zone.id = <u32>(<u64>0x40000000 + <u64>index * 64 + <u64>room)
      zone.owner = anchor.owner
      zone.group = anchor.group
      setComponent<EgeZoneId>(entity, EgeZoneId.ID, EgeZoneId.SIZE, zone)
    }
  }
  rows.write()
}

export function rf_probe_membership_catch_pre(): void { probe() }
export function rf_probe_membership_catch_post(): void { probe() }
export function rf_probe_membership_swim_pre(): void { probe() }
`

test('a membership probe creates rows and zone identities under each copied production access list', async () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as AccessSchema
  const showSeat = schema.world_kinds.find((kind) => kind.name === 'show_seat')
  assert.ok(showSeat)
  const probes: [string, string][] = [
    ['rf.feature.catch_volume.pre', 'rf.probe.membership_catch_pre'],
    ['rf.feature.catch_volume.post', 'rf.probe.membership_catch_post'],
    ['rf.feature.swim_volume.pre', 'rf.probe.membership_swim_pre'],
  ]
  for (const [system, probe] of probes) {
    const entry = showSeat.schedule.find((candidate) => candidate.system === system)
    assert.ok(entry, system)
    schema.world_kinds.push({ name: probe.replace('rf.probe.', 'probe_'), players: 8, schedule: [{ ...JSON.parse(JSON.stringify(entry)), system: probe }] })
  }
  const files = [...collectRfScripts(), { name: 'probe/membership_access.as.ts', text: MEMBERSHIP_ACCESS_PROBE }]
  const compiled = await (await rfCompiler()).compile(files, JSON.stringify(schema))
  assert.deepEqual(compiled.diagnostics.filter((d) => d.severity === 'error').map(formatRfDiagnostic), [])
  assert.ok(compiled.wasm)
  const engine = await loadEngine()
  engine.setSchema(JSON.stringify(schema))
  const module = await loadScript(engine, compiled.wasm, { name: 'rf-scripts' })
  const layout = schemaLayout(engine)
  for (const [, probe] of probes) {
    const world = engine.createWorld(JSON.stringify({
      format: 'ege.scene',
      version: 1,
      world_kind: probe.replace('rf.probe.', 'probe_'),
      seed: 1,
      entities: [
        // Entity 0: room seat 59 at round seat 1, its physical anchor identity {60, 1, 60}.
        { components: { show_seat_identity: { room_seat: 59, round_seat: 1, input_slot: -1, bot: 1 }, 'ege.zone.id': { id: 60, owner: 1, group: 60 } } },
        // Entity 1: authored feature index 5.
        { components: { feature: { kind: 3, index: 5, salt: 0x103 } } },
      ],
    }))
    try {
      const host = new ScriptHost(module)
      host.stepTick(world, Array(8).fill(0))
      host.stepTick(world, Array(8).fill(0))
      assert.equal(module.faultCount, 0, module.faults.map((fault) => fault.message).join('; '))
      const state = readWorldState(engine, world, layout)
      const rows = Object.entries(state.components.show_feature_membership)
      assert.equal(rows.length, 1, probe)
      const [entity, row] = rows[0]
      assert.deepEqual(row, { owner: 0, feature: 1, character: 0, index: 5, inside: 2 })
      assert.deepEqual(state.components['ege.zone.id'][entity], { id: 0x40000000 + 5 * 64 + 59, owner: 1, group: 60 })
    } finally {
      engine.freeWorld(world)
    }
  }
})

/**
 * Handoff: G7.3 Bots and cumulative domain messages: transfer memory-tile crossing state: MEMORY_TILES_READS
 * pins the access lists ege.schema.json grants to rf.feature.memory_tiles.post in round, show_seat, show_field
 * and show_hub: the existing grants first, then show_result_a and show_result_b, which recordShowEvent reads
 * unconditionally and updates for match events (matches and cross_ticks). The schedule order and the emitted
 * match event are unchanged.
 */
const MEMORY_TILES_READS = [
  'round', 'feature', 'feature_memory_tiles', 'feature_memory_tiles_cell', 'feature_memory_tiles_cycle',
  'feature_memory_tiles_seat', 'feature_memory_tiles_marker', 'seat', 'character', 'ege.transform',
  'show_result_a', 'show_result_b',
]
const MEMORY_TILES_WRITES = [
  'feature_memory_tiles', 'feature_memory_tiles_cell', 'feature_memory_tiles_seat', 'ege.body_props',
  'ege.render', 'ege.transform', 'show_result_a', 'show_result_b',
]
const MEMORY_TILES_WORLDS = ['round', 'show_seat', 'show_field', 'show_hub']

test('memory tiles post entries grant cumulative show result access in every world', async () => {
  const layout = await layoutOf()
  // Resource grants are encoded as resource id + 0x8000, component grants as component ids.
  const componentNames = new Map(layout.components.map((decl): [number, string] => [decl.id, decl.name]))
  const resourceNames = new Map(layout.resources.map((decl): [number, string] => [decl.id, decl.name]))
  const resolve = (id: number): string | undefined =>
    id >= 0x8000 ? resourceNames.get(id - 0x8000) : componentNames.get(id)
  const source = JSON.parse(readFileSync(SCHEMA, 'utf8')) as AccessSchema
  for (const world of MEMORY_TILES_WORLDS) {
    const authored = source.world_kinds.find((kind) => kind.name === world)
    const loaded = layout.world_kinds.find((kind) => kind.name === world)
    assert.ok(authored && loaded, world)
    const entries = authored.schedule.filter((entry) => entry.system === 'rf.feature.memory_tiles.post')
    assert.equal(entries.length, 1, world)
    assert.deepEqual(entries[0].reads, MEMORY_TILES_READS, world)
    assert.deepEqual(entries[0].writes, MEMORY_TILES_WRITES, world)
    assert.deepEqual(entries[0].emits, ['match'], world)
    const loadedEntry = loaded.schedule.find((entry) => entry.system === 'rf.feature.memory_tiles.post')
    assert.ok(loadedEntry, world)
    assert.deepEqual(loadedEntry.reads.map((id: number) => resolve(id)), MEMORY_TILES_READS, world)
    assert.deepEqual(loadedEntry.writes.map((id: number) => resolve(id)), MEMORY_TILES_WRITES, world)
    assert.deepEqual(loadedEntry.emits.map((id: number) => layout.events.find((event) => event.id === id)?.name), ['match'], world)
  }
  const round = source.world_kinds.find((kind) => kind.name === 'round')
  assert.deepEqual(round?.schedule.map((entry) => entry.system), SCHEDULE)
})

// The access probe calls the real recordShowEvent helper under each production memory tiles entry, copied
// verbatim into a probe world kind. It reports one correct match and one penalty match at tick zero.
const MEMORY_ACCESS_PROBE = `import { tick } from 'ege'
import { MatchEvent } from '../components.gen'
import { recordShowEvent } from '../lib/show_events.as'

function probe(): void {
  if (tick() != 0) return
  recordShowEvent(MatchEvent.ID, 0, 0, 1, 7)
  recordShowEvent(MatchEvent.ID, 0, 0, 0, 40)
}

export function rf_probe_memory_tiles_post(): void { probe() }
`

const MEMORY_SEAT_RESULT = {
  show_result_a: {
    seat: 0, status: 1, finish_tick: -1, finish_sub: -1, lap: 0, stage: -1,
    route_mm: 0, falls: 0, score: 0, last_score_tick: -1,
  },
  show_result_b: {
    hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 2, cross_ticks: 10,
    out_tick: -1, out_sub: -1, team: -1, opening_rank: 0,
  },
}

test('recordShowEvent runs under every production memory tiles access list and accumulates matches', async () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as AccessSchema
  const worlds: [string, string][] = []
  for (const world of MEMORY_TILES_WORLDS) {
    const kind = schema.world_kinds.find((candidate) => candidate.name === world)
    assert.ok(kind, world)
    const entry = kind.schedule.find((candidate) => candidate.system === 'rf.feature.memory_tiles.post')
    assert.ok(entry, world)
    const probeWorld = `memory_tiles_probe_${world}`
    worlds.push([world, probeWorld])
    schema.world_kinds.push({
      name: probeWorld,
      players: 8,
      schedule: [{ ...JSON.parse(JSON.stringify(entry)), system: 'rf.probe.memory_tiles_post' }],
    })
  }
  const files = [...collectRfScripts(), { name: 'probe/memory_tiles_access.as.ts', text: MEMORY_ACCESS_PROBE }]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
  const compiled = await (await rfCompiler()).compile(files, JSON.stringify(schema))
  assert.deepEqual(compiled.diagnostics.filter((d) => d.severity === 'error').map(formatRfDiagnostic), [])
  assert.ok(compiled.wasm)
  const engine = await loadEngine()
  engine.setSchema(JSON.stringify(schema))
  const module = await loadScript(engine, compiled.wasm, { name: 'rf-scripts' })
  const layout = schemaLayout(engine)
  for (const [world, probeWorld] of worlds) {
    const populated = engine.createWorld(JSON.stringify({
      format: 'ege.scene',
      version: 1,
      world_kind: probeWorld,
      seed: 1,
      entities: [{ components: MEMORY_SEAT_RESULT }],
    }))
    try {
      const host = new ScriptHost(module)
      host.stepTick(populated, Array(8).fill(0))
      assert.equal(module.faultCount, 0, module.faults.map((fault) => fault.message).join('; '))
      const events = decodeEvents(engine.events(populated, 0, engine.tick(populated)).records, layout)
        .filter((event) => event.kind === 'match')
      assert.deepEqual(events.map((event) => event.fields), [
        { seat: 0, a: 1, b: 7 },
        { seat: 0, a: 0, b: 40 },
      ], world)
      assert.deepEqual(events.map((event) => event.entity), [0, 0], world)
      const state = readWorldState(engine, populated, layout)
      const result = state.components.show_result_a[0]
      assert.equal(result.seat, 0)
      assert.equal(result.status, 1)
      assert.equal(result.finish_tick, -1)
      assert.equal(result.score, 0)
      const cumulative = state.components.show_result_b[0]
      assert.equal(cumulative.matches, 3, world)
      assert.equal(cumulative.cross_ticks, 57, world)
      assert.equal(cumulative.out_tick, -1, world)
    } finally {
      engine.freeWorld(populated)
    }
  }
  // The empty ShowResultA column is the existing G6 fallback: the match payloads are unchanged and
  // nothing is accumulated. Exercise it under the round entry, the G6 world's own access list.
  const [, roundProbe] = worlds.find(([world]) => world === 'round') ?? []
  assert.ok(roundProbe)
  const bare = engine.createWorld(JSON.stringify({
    format: 'ege.scene',
    version: 1,
    world_kind: roundProbe,
    seed: 1,
    entities: [{ components: {} }],
  }))
  try {
    const host = new ScriptHost(module)
    host.stepTick(bare, Array(8).fill(0))
    assert.equal(module.faultCount, 0, module.faults.map((fault) => fault.message).join('; '))
    const events = decodeEvents(engine.events(bare, 0, engine.tick(bare)).records, layout)
      .filter((event) => event.kind === 'match')
    assert.deepEqual(events.map((event) => event.fields), [
      { seat: 0, a: 1, b: 7 },
      { seat: 0, a: 0, b: 40 },
    ])
    const state = readWorldState(engine, bare, layout)
    assert.deepEqual(Object.keys(state.components.show_result_a), [])
    assert.deepEqual(Object.keys(state.components.show_result_b), [])
  } finally {
    engine.freeWorld(bare)
  }
})

/**
 * Handoff: G7.1 Identity, inputs and world construction: transfer carried objects and bank membership:
 * CARRY_ITEM_ACCESS pins the access lists ege.schema.json grants today to rf.feature.carry_item.pre in round,
 * show_seat, show_field and show_hub: the existing grants first, then reads of show_seat_identity and reads and
 * writes of show_feature_membership, show_character_ref (the carried entity reference) and ege.zone.id for the
 * dynamically created carry membership rows. BANK_ACCESS pins rf.feature.bank.post: the existing grants first,
 * then reads of feature, show_seat_identity and show_character_ref, and reads and writes of ege.zone.id for the
 * feature_bank_inside rows plus show_result_a, show_result_b and show_team_contribution, which recordShowEvent
 * reads and updates for team_score contributions. Schedule order and emitted events are unchanged.
 */
const CARRY_ITEM_ACCESS = {
  reads: [
    'course', 'feature', 'seat', 'character', 'feature_carry_item', 'feature_carry_item_item',
    'feature_carry_item_home', 'feature_carry_item_seat', 'ege.transform', 'ege.velocity',
    'show_seat_identity', 'show_feature_membership', 'show_character_ref', 'ege.zone.id',
  ],
  writes: [
    'feature_carry_item', 'feature_carry_item_item', 'feature_carry_item_seat', 'character', 'ege.transform',
    'ege.velocity', 'ege.body_props', 'show_feature_membership', 'show_character_ref', 'ege.zone.id',
  ],
  emits: [] as string[],
}
const BANK_ACCESS = {
  reads: [
    'round', 'feature_bank', 'feature_bank_inside', 'seat', 'character', 'ege.transform',
    'feature', 'show_seat_identity', 'show_character_ref', 'ege.zone.id',
    'show_result_a', 'show_result_b', 'show_team_contribution',
  ],
  writes: ['feature_bank_inside', 'ege.zone.id', 'show_result_a', 'show_result_b', 'show_team_contribution'],
  emits: ['team_score'],
}
const OBJECTIVE_ACCESS: Record<string, typeof BANK_ACCESS> = {
  'rf.feature.carry_item.pre': CARRY_ITEM_ACCESS,
  'rf.feature.bank.post': BANK_ACCESS,
}
const OBJECTIVE_WORLDS = ['round', 'show_seat', 'show_field', 'show_hub']

test('carry item and bank entries grant membership, zone identity, reference and result access in every world', async () => {
  const layout = await layoutOf()
  // Resource grants are encoded as resource id + 0x8000, component grants as component ids.
  const componentNames = new Map(layout.components.map((decl): [number, string] => [decl.id, decl.name]))
  const resourceNames = new Map(layout.resources.map((decl): [number, string] => [decl.id, decl.name]))
  const resolve = (id: number): string | undefined =>
    id >= 0x8000 ? resourceNames.get(id - 0x8000) : componentNames.get(id)
  const eventName = (id: number): string | undefined => layout.events.find((event) => event.id === id)?.name
  const source = JSON.parse(readFileSync(SCHEMA, 'utf8')) as AccessSchema
  for (const world of OBJECTIVE_WORLDS) {
    const authored = source.world_kinds.find((kind) => kind.name === world)
    const loaded = layout.world_kinds.find((kind) => kind.name === world)
    assert.ok(authored && loaded, world)
    for (const [system, access] of Object.entries(OBJECTIVE_ACCESS)) {
      const entries: AccessSchema['world_kinds'][number]['schedule'] =
        authored.schedule.filter((entry) => entry.system === system)
      assert.equal(entries.length, 1, `${world} ${system}`)
      assert.deepEqual(
        { reads: entries[0].reads, writes: entries[0].writes, emits: entries[0].emits }, access, `${world} ${system}`)
      const loadedEntry: Layout['world_kinds'][number]['schedule'][number] | undefined =
        loaded.schedule.find((entry) => entry.system === system)
      assert.ok(loadedEntry, `${world} ${system}`)
      assert.deepEqual(loadedEntry.reads.map((id: number) => resolve(id)), access.reads, `${world} ${system}`)
      assert.deepEqual(loadedEntry.writes.map((id: number) => resolve(id)), access.writes, `${world} ${system}`)
      assert.deepEqual(loadedEntry.emits.map((id: number) => eventName(id)), access.emits, `${world} ${system}`)
    }
  }
  const round = source.world_kinds.find((kind) => kind.name === 'round')
  assert.deepEqual(round?.schedule.map((entry) => entry.system), SCHEDULE)
})

// The objective access probe runs under each production carry item and bank entry, copied verbatim into a probe
// world kind. For every seat it creates one membership row per carry feature (show_feature_membership) and per
// bank and item (feature_bank_inside, with entity-typed owner and item), attaches an ege.zone.id taken from the
// seat's physical anchor at once and reuses existing rows on later ticks. The carry probe copies the carried
// item entity into show_character_ref.carry. The bank probe reads that reference back and reports a team_score
// contribution through the real recordShowEvent. The probe's zone ids only exercise access: the allocation
// itself belongs to the feature scripts.
const OBJECTIVE_ACCESS_PROBE = `import { getComponent, isNull, newRecord, readColumn, setComponent, spawn, tick } from 'ege'
import {
  EgeZoneId, Feature, FeatureBank, FeatureBankInside, FeatureCarryItemItem, ShowCharacterRef,
  ShowFeatureMembership, ShowSeatIdentity, TeamScoreEvent,
} from '../components.gen'
import { recordShowEvent } from '../lib/show_events.as'

function attach(entity: u32, index: u32, room: u32, anchor: EgeZoneId): void {
  const zone = newRecord<EgeZoneId>(EgeZoneId.SIZE)
  zone.id = <u32>(<u64>0x40000000 + <u64>index * 64 + <u64>room)
  zone.owner = anchor.owner
  zone.group = anchor.group
  setComponent<EgeZoneId>(entity, EgeZoneId.ID, EgeZoneId.SIZE, zone)
}

export function rf_probe_objective_carry_pre(): void {
  const seats = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)
  const items = readColumn<FeatureCarryItemItem>(FeatureCarryItemItem.ID, FeatureCarryItemItem.SIZE)
  const rows = readColumn<ShowFeatureMembership>(ShowFeatureMembership.ID, ShowFeatureMembership.SIZE)
  const refs = readColumn<ShowCharacterRef>(ShowCharacterRef.ID, ShowCharacterRef.SIZE)
  for (let s: u32 = 0; s < seats.count; s++) {
    const character = seats.entity(s)
    const room = seats.at(s).room_seat
    const anchor = getComponent<EgeZoneId>(character, EgeZoneId.ID, EgeZoneId.SIZE)
    if (isNull<EgeZoneId>(anchor)) continue
    for (let i: u32 = 0; i < items.count; i++) {
      const index = items.at(i).owner
      const feature = items.entity(i)
      let found = false
      for (let r: u32 = 0; r < rows.count; r++) {
        const row = rows.at(r)
        if (row.index != index || row.character != character) continue
        row.inside = row.inside + 1
        found = true
      }
      const ref = refs.find(character)
      if (ref >= 0) refs.at(<u32>ref).carry = feature
      if (found) continue
      const entity = spawn()
      const row = newRecord<ShowFeatureMembership>(ShowFeatureMembership.SIZE)
      row.owner = character
      row.feature = feature
      row.character = character
      row.index = index
      row.inside = 1
      setComponent<ShowFeatureMembership>(entity, ShowFeatureMembership.ID, ShowFeatureMembership.SIZE, row)
      attach(entity, index, room, anchor)
    }
  }
  rows.write()
  refs.write()
}

export function rf_probe_objective_bank_post(): void {
  const seats = readColumn<ShowSeatIdentity>(ShowSeatIdentity.ID, ShowSeatIdentity.SIZE)
  const banks = readColumn<FeatureBank>(FeatureBank.ID, FeatureBank.SIZE)
  const inside = readColumn<FeatureBankInside>(FeatureBankInside.ID, FeatureBankInside.SIZE)
  const refs = readColumn<ShowCharacterRef>(ShowCharacterRef.ID, ShowCharacterRef.SIZE)
  for (let s: u32 = 0; s < seats.count; s++) {
    const character = seats.entity(s)
    const room = seats.at(s).room_seat
    const anchor = getComponent<EgeZoneId>(character, EgeZoneId.ID, EgeZoneId.SIZE)
    const ref = refs.find(character)
    if (isNull<EgeZoneId>(anchor) || ref < 0) continue
    const item = refs.at(<u32>ref).carry
    for (let b: u32 = 0; b < banks.count; b++) {
      const owner = banks.entity(b)
      let found = false
      for (let i: u32 = 0; i < inside.count; i++) {
        const record = inside.at(i)
        if (record.owner == owner && record.item == item) found = true
      }
      if (found) continue
      const team = banks.at(b).team
      const entity = spawn()
      const record = newRecord<FeatureBankInside>(FeatureBankInside.SIZE)
      record.owner = owner
      record.item = item
      record.team = team
      setComponent<FeatureBankInside>(entity, FeatureBankInside.ID, FeatureBankInside.SIZE, record)
      attach(entity, getComponent<Feature>(owner, Feature.ID, Feature.SIZE).index, room, anchor)
      if (tick() == 0) recordShowEvent(TeamScoreEvent.ID, owner, <u32>team, 1, 0)
    }
  }
}
`

const OBJECTIVE_SEAT = {
  show_seat_identity: { room_seat: 59, round_seat: 1, input_slot: -1, bot: 1 },
  'ege.zone.id': { id: 60, owner: 1, group: 60 },
  show_character_ref: { owner: 0, target: NO_ENTITY, lever: NO_ENTITY, carry: NO_ENTITY },
  show_result_a: {
    seat: 59, status: 1, finish_tick: -1, finish_sub: -1, lap: 0, stage: -1,
    route_mm: 0, falls: 0, score: 0, last_score_tick: -1,
  },
  show_result_b: {
    hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 0,
    out_tick: -1, out_sub: -1, team: 1, opening_rank: 0,
  },
}

test('an objective probe creates zone-identified membership rows, syncs carry and contributes under each production access list', async () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as AccessSchema
  const probes: { world: string; system: string; probe: string; kind: string }[] = []
  for (const world of OBJECTIVE_WORLDS) {
    const kind = schema.world_kinds.find((candidate) => candidate.name === world)
    assert.ok(kind, world)
    for (const [system, probe] of [
      ['rf.feature.carry_item.pre', 'rf.probe.objective_carry_pre'],
      ['rf.feature.bank.post', 'rf.probe.objective_bank_post'],
    ]) {
      const entry = kind.schedule.find((candidate) => candidate.system === system)
      assert.ok(entry, `${world} ${system}`)
      const probeKind = `${probe.replace('rf.probe.', 'probe_')}_${world}`
      probes.push({ world, system, probe, kind: probeKind })
      schema.world_kinds.push({ name: probeKind, players: 8, schedule: [{ ...JSON.parse(JSON.stringify(entry)), system: probe }] })
    }
  }
  const files = [...collectRfScripts(), { name: 'probe/objective_access.as.ts', text: OBJECTIVE_ACCESS_PROBE }]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
  const compiled = await (await rfCompiler()).compile(files, JSON.stringify(schema))
  assert.deepEqual(compiled.diagnostics.filter((d) => d.severity === 'error').map(formatRfDiagnostic), [])
  assert.ok(compiled.wasm)
  const engine = await loadEngine()
  engine.setSchema(JSON.stringify(schema))
  const module = await loadScript(engine, compiled.wasm, { name: 'rf-scripts' })
  const layout = schemaLayout(engine)
  for (const { world, system, kind } of probes) {
    const label = `${world} ${system}`
    const carry = system === 'rf.feature.carry_item.pre'
    const entities = carry
      ? [
          // Entity 0: room seat 59 at round seat 1, its physical anchor identity {60, 1, 60}.
          { components: OBJECTIVE_SEAT },
          // Entity 1: an item of the carry feature with authored index 7, held by round seat 1.
          { components: { feature_carry_item_item: { owner: 7, index: 0, spawn: [0, 1, 0], holder: 1, last_touch_tick: -1, last_hand: [0, 0, 0] } } },
        ]
      : [
          // Entity 0: the same seat, already carrying entity 2.
          { components: { ...OBJECTIVE_SEAT, show_character_ref: { ...OBJECTIVE_SEAT.show_character_ref, carry: 2 } } },
          // Entity 1: a team-one bank with authored feature index 9.
          { components: { feature: { kind: 17, index: 9, salt: 0x109 }, feature_bank: { center: [0, 0, 0], half: [1, 1, 1], team: 1 } } },
          // Entity 2: the carried item.
          { components: {} },
        ]
    const created = engine.createWorld(JSON.stringify({ format: 'ege.scene', version: 1, world_kind: kind, seed: 1, entities }))
    try {
      const host = new ScriptHost(module)
      host.stepTick(created, Array(8).fill(0))
      host.stepTick(created, Array(8).fill(0))
      assert.equal(module.faultCount, 0, module.faults.map((fault) => fault.message).join('; '))
      const state = readWorldState(engine, created, layout)
      const zones = state.components['ege.zone.id']
      if (carry) {
        const rows = Object.entries(state.components.show_feature_membership)
        assert.equal(rows.length, 1, label)
        const [entity, row] = rows[0]
        assert.deepEqual(row, { owner: 0, feature: 1, character: 0, index: 7, inside: 2 }, label)
        assert.deepEqual(zones[entity], { id: 0x40000000 + 7 * 64 + 59, owner: 1, group: 60 }, label)
        assert.deepEqual(state.components.show_character_ref[0], { owner: 0, target: NO_ENTITY, lever: NO_ENTITY, carry: 1 }, label)
      } else {
        const rows = Object.entries(state.components.feature_bank_inside)
        assert.equal(rows.length, 1, label)
        const [entity, row] = rows[0]
        assert.deepEqual(row, { owner: 1, item: 2, team: 1 }, label)
        assert.deepEqual(zones[entity], { id: 0x40000000 + 9 * 64 + 59, owner: 1, group: 60 }, label)
        const events = decodeEvents(engine.events(created, 0, engine.tick(created)).records, layout)
          .filter((event) => event.kind === 'team_score')
        assert.deepEqual(events.map((event) => [event.entity, event.fields]), [[1, { team: 1, a: 1, b: 0 }]], label)
        assert.deepEqual(Object.values(state.components.show_team_contribution), [
          { owner: 1, feature: 9, team: 1, value: 1, tick: 0 },
        ], label)
      }
    } finally {
      engine.freeWorld(created)
    }
  }
})

// recordShowEvent reads ShowResultA unconditionally and updates the seat and team contribution rows.
const PUBLISHER_GRANTS = ['show_result_a', 'show_result_b', 'show_team_contribution']
/**
 * Handoff: G7.3 Bots and cumulative domain messages: publish objective scores cumulatively (card 9075):
 * OBJECTIVE_PUBLISHER_ACCESS pins the access lists ege.schema.json grants today to rf.feature.ball.post,
 * rf.feature.collectible.post and rf.feature.capture_zone.post in round, show_seat, show_field and show_hub:
 * the existing grants first, then (ball only) reads of feature, which recordShowEvent reads to name the authored
 * publisher of a team's first contribution, then reads and writes of show_result_a, show_result_b and
 * show_team_contribution, which recordShowEvent reads unconditionally and updates. Schedule order and emitted
 * events are unchanged; the feature scripts' recordShowEvent calls remain that card's work.
 * Handoff: G7.1 Identity, inputs and world construction: install complete show schedules (card 9087):
 * OBJECTIVE_PUBLISHER_ACCESS is the set of grants its complete show schedules keep.
 */
const OBJECTIVE_PUBLISHER_ACCESS: Record<string, { reads: string[]; writes: string[]; emits: string[] }> = {
  'rf.feature.ball.post': {
    reads: [
      'course', 'round', 'feature_ball', 'feature_goal', 'home', 'home_spawn', 'seat', 'character',
      'ege.transform', 'feature', ...PUBLISHER_GRANTS,
    ],
    writes: ['feature_ball', 'seat', 'character', 'ege.transform', 'ege.velocity', ...PUBLISHER_GRANTS],
    emits: ['team_score'],
  },
  'rf.feature.collectible.post': {
    reads: [
      'round', 'feature', 'feature_collectible', 'feature_collectible_spot', 'seat', 'character',
      'ege.transform', 'ege.render', ...PUBLISHER_GRANTS,
    ],
    writes: ['feature_collectible_spot', 'ege.render', ...PUBLISHER_GRANTS],
    emits: ['score'],
  },
  'rf.feature.capture_zone.post': {
    reads: [
      'round', 'feature', 'feature_capture_zone', 'feature_capture_zone_visual', 'seat', 'character',
      'ege.transform', 'ege.render', ...PUBLISHER_GRANTS,
    ],
    writes: ['feature_capture_zone', 'ege.render', ...PUBLISHER_GRANTS],
    emits: ['team_score'],
  },
}
const PUBLISHER_WORLDS = ['round', 'show_seat', 'show_field', 'show_hub']

test('ball, collectible and capture zone post entries grant cumulative publisher access in every world', async () => {
  const layout = await layoutOf()
  // Resource grants are encoded as resource id + 0x8000, component grants as component ids.
  const componentNames = new Map(layout.components.map((decl): [number, string] => [decl.id, decl.name]))
  const resourceNames = new Map(layout.resources.map((decl): [number, string] => [decl.id, decl.name]))
  const resolve = (id: number): string | undefined =>
    id >= 0x8000 ? resourceNames.get(id - 0x8000) : componentNames.get(id)
  const eventName = (id: number): string | undefined => layout.events.find((event) => event.id === id)?.name
  const source = JSON.parse(readFileSync(SCHEMA, 'utf8')) as AccessSchema
  for (const world of PUBLISHER_WORLDS) {
    const authored = source.world_kinds.find((kind) => kind.name === world)
    const loaded = layout.world_kinds.find((kind) => kind.name === world)
    assert.ok(authored && loaded, world)
    for (const [system, access] of Object.entries(OBJECTIVE_PUBLISHER_ACCESS)) {
      const label = `${world} ${system}`
      const entries: AccessSchema['world_kinds'][number]['schedule'] =
        authored.schedule.filter((entry) => entry.system === system)
      assert.equal(entries.length, 1, label)
      assert.deepEqual({ reads: entries[0].reads, writes: entries[0].writes, emits: entries[0].emits }, access, label)
      const loadedEntry: Layout['world_kinds'][number]['schedule'][number] | undefined =
        loaded.schedule.find((entry) => entry.system === system)
      assert.ok(loadedEntry, label)
      assert.deepEqual(loadedEntry.reads.map((id: number) => resolve(id)), access.reads, label)
      assert.deepEqual(loadedEntry.writes.map((id: number) => resolve(id)), access.writes, label)
      assert.deepEqual(loadedEntry.emits.map((id: number) => eventName(id)), access.emits, label)
    }
  }
  const round = source.world_kinds.find((kind) => kind.name === 'round')
  assert.deepEqual(round?.schedule.map((entry) => entry.system), SCHEDULE)
})

// The publisher probe calls the real recordShowEvent under each production ball, collectible and capture zone
// entry, copied verbatim into a probe world kind. Entities 0 and 1 are seats 3 and 59; entities 2 and 3 are
// objective features with authored indices 4 and 11. The team probe creates three contributions at tick 0
// (feature 4 for teams 0 and 1, feature 11 for team 1) and accumulates two of them at tick 1. The score probe
// scores seat 59 twice and seat 3 once.
const PUBLISHER_PROBE = `import { tick } from 'ege'
import { ScoreEvent, TeamScoreEvent } from '../components.gen'
import { recordShowEvent } from '../lib/show_events.as'

function teamProbe(): void {
  if (tick() == 0) {
    recordShowEvent(TeamScoreEvent.ID, 2, 0, 1, 0)
    recordShowEvent(TeamScoreEvent.ID, 3, 1, 1, 0)
    recordShowEvent(TeamScoreEvent.ID, 2, 1, 1, 0)
  } else if (tick() == 1) {
    recordShowEvent(TeamScoreEvent.ID, 2, 0, 1, 0)
    recordShowEvent(TeamScoreEvent.ID, 3, 1, 2, 0)
  }
}

function scoreProbe(): void {
  if (tick() == 0) {
    recordShowEvent(ScoreEvent.ID, 1, 59, 2, 0)
    recordShowEvent(ScoreEvent.ID, 0, 3, 1, 0)
  } else if (tick() == 1) {
    recordShowEvent(ScoreEvent.ID, 1, 59, 3, 0)
  }
}

export function rf_probe_publisher_ball_post(): void { teamProbe() }
export function rf_probe_publisher_collectible_post(): void { scoreProbe() }
export function rf_probe_publisher_capture_zone_post(): void { teamProbe() }
`

function publisherSeat(seat: number) {
  return {
    show_seat_identity: { room_seat: seat, round_seat: seat === 59 ? 1 : 0, input_slot: -1, bot: 1 },
    show_result_a: {
      seat, status: 1, finish_tick: -1, finish_sub: -1, lap: 0, stage: -1,
      route_mm: 0, falls: 0, score: 0, last_score_tick: -1,
    },
    show_result_b: {
      hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 0,
      out_tick: -1, out_sub: -1, team: seat === 59 ? 1 : 0, opening_rank: 0,
    },
  }
}
const PUBLISHER_FEATURES = [
  { components: { feature: { kind: 14, index: 4, salt: 0x104 } } },
  { components: { feature: { kind: 14, index: 11, salt: 0x10b } } },
]
const TEAM_EVENTS = [
  [2, { team: 0, a: 1, b: 0 }], [3, { team: 1, a: 1, b: 0 }], [2, { team: 1, a: 1, b: 0 }],
  [2, { team: 0, a: 1, b: 0 }], [3, { team: 1, a: 2, b: 0 }],
]
const SCORE_EVENTS = [[1, { seat: 59, a: 2, b: 0 }], [0, { seat: 3, a: 1, b: 0 }], [1, { seat: 59, a: 3, b: 0 }]]

test('recordShowEvent publishes scores and per-publisher team contributions under every production objective access list', async () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as AccessSchema
  const probes: { world: string; system: string; kind: string }[] = []
  for (const world of PUBLISHER_WORLDS) {
    const kind = schema.world_kinds.find((candidate) => candidate.name === world)
    assert.ok(kind, world)
    for (const system of Object.keys(OBJECTIVE_PUBLISHER_ACCESS)) {
      const entry = kind.schedule.find((candidate) => candidate.system === system)
      assert.ok(entry, `${world} ${system}`)
      const probe = system.replace('rf.feature.', 'rf.probe.publisher_')
      const probeKind = `${probe.replace(/[.]/g, '_')}_${world}`
      probes.push({ world, system, kind: probeKind })
      schema.world_kinds.push({ name: probeKind, players: 8, schedule: [{ ...JSON.parse(JSON.stringify(entry)), system: probe }] })
    }
  }
  const files = [...collectRfScripts(), { name: 'probe/publisher_access.as.ts', text: PUBLISHER_PROBE }]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
  const compiled = await (await rfCompiler()).compile(files, JSON.stringify(schema))
  assert.deepEqual(compiled.diagnostics.filter((d) => d.severity === 'error').map(formatRfDiagnostic), [])
  assert.ok(compiled.wasm)
  const engine = await loadEngine()
  engine.setSchema(JSON.stringify(schema))
  const module = await loadScript(engine, compiled.wasm, { name: 'rf-scripts' })
  const layout = schemaLayout(engine)
  for (const { world, system, kind } of probes) {
    const team = system !== 'rf.feature.collectible.post'
    const eventKind = team ? 'team_score' : 'score'
    const expectedEvents = team ? TEAM_EVENTS : SCORE_EVENTS
    for (const populated of [false, true]) {
      const label = `${world} ${system} ${populated ? 'populated' : 'empty'}`
      // The empty case keeps the seats without show records: the G6 fallback emits unchanged payloads only.
      const seats = populated ? [{ components: publisherSeat(3) }, { components: publisherSeat(59) }] : [{ components: {} }, { components: {} }]
      const created = engine.createWorld(JSON.stringify({
        format: 'ege.scene', version: 1, world_kind: kind, seed: 1, entities: [...seats, ...PUBLISHER_FEATURES],
      }))
      try {
        const host = new ScriptHost(module)
        host.stepTick(created, Array(8).fill(0))
        host.stepTick(created, Array(8).fill(0))
        assert.equal(module.faultCount, 0, module.faults.map((fault) => fault.message).join('; '))
        const events = decodeEvents(engine.events(created, 0, engine.tick(created)).records, layout)
          .filter((event) => event.kind === eventKind)
        assert.deepEqual(events.map((event) => [event.entity, event.fields]), expectedEvents, label)
        const state = readWorldState(engine, created, layout)
        const contributions = (Object.values(state.components.show_team_contribution) as { owner: number; team: number }[])
          .sort((a, b) => a.owner - b.owner || a.team - b.team)
        const results = Object.values(state.components.show_result_a)
        if (!populated) {
          assert.deepEqual(results, [], label)
          assert.deepEqual(Object.values(state.components.show_result_b), [], label)
          assert.deepEqual(contributions, [], label)
          continue
        }
        const bySeat = new Map(results.map((row) => [row.seat, row]))
        if (team) {
          // Each publisher/team pair owns one independent cumulative row; the seat counters stay untouched.
          assert.deepEqual(contributions, [
            { owner: 2, feature: 4, team: 0, value: 2, tick: 1 },
            { owner: 2, feature: 4, team: 1, value: 1, tick: 0 },
            { owner: 3, feature: 11, team: 1, value: 3, tick: 1 },
          ], label)
          assert.deepEqual(bySeat.get(3), publisherSeat(3).show_result_a, label)
          assert.deepEqual(bySeat.get(59), publisherSeat(59).show_result_a, label)
        } else {
          assert.deepEqual(contributions, [], label)
          assert.deepEqual(bySeat.get(59), { ...publisherSeat(59).show_result_a, score: 5, last_score_tick: 1 }, label)
          assert.deepEqual(bySeat.get(3), { ...publisherSeat(3).show_result_a, score: 1, last_score_tick: 0 }, label)
        }
        assert.deepEqual(state.components.show_result_b[0], publisherSeat(3).show_result_b, label)
        assert.deepEqual(state.components.show_result_b[1], publisherSeat(59).show_result_b, label)
      } finally {
        engine.freeWorld(created)
      }
    }
  }
})
