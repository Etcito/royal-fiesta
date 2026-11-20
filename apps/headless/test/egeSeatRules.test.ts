import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeEvents, readWorldState } from '@etcito/game-engine/world-state'
import { loadScript, schemaLayout, ScriptHost } from '@etcito/game-engine/script'
import { createEngineRound } from '@royal-fiesta/game/ege/round'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { emitEngineScene } from '@royal-fiesta/game/ege/sceneEmitter'
import { encodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { loadEngine } from '@etcito/game-engine'
import { harnessRound, loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'

const code = (moveX = 0, moveZ = 0) => encodeInput({ moveX, moveZ, jump: false, dive: false, grab: false })

async function relocated(edit: (course: any) => void, humans = [true, false, false, false, false, false, false, false]) {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  edit(copy)
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const round = await createEngineRound(engine, schema, await rfScriptBytes(), scene, copy, { profile: 'sprint', seed: 7, humans })
  return { engine, scene, course: copy, round }
}

function events(round: import('@royal-fiesta/game/ege/round').EngineRound) {
  return (round as any).__eventLog as ReturnType<typeof decodeEvents>
}

function watchEvents(round: import('@royal-fiesta/game/ege/round').EngineRound) {
  const engine = round.engine as any
  const target = round as any
  target.__eventLog = []
  const read = engine.events.bind(engine)
  engine.events = (world: number, before: number, after: number) => {
    const result = read(world, before, after)
    if (world === round.world) target.__eventLog.push(...decodeEvents(result.records, round.layout))
    return result
  }
}

function seatRecords(round: import('@royal-fiesta/game/ege/round').EngineRound, entity: number) {
  const state = round.worldState()
  return {
    seat: state.components.seat[String(entity)] as any,
    character: state.components.character[String(entity)] as any,
    props: state.components['ege.body_props'][String(entity)] as any,
  }
}

test('seat route and respawn helpers match hand-derived values', async () => {
  const wasm = await rfScriptBytes()
  const module = await WebAssembly.compile(wasm)
  const imports: Record<string, Record<string, () => number>> = { engine: {} }
  for (const item of WebAssembly.Module.imports(module)) {
    imports[item.module] ??= {}
    imports[item.module][item.name] = () => 0
  }
  const instance = await WebAssembly.instantiate(module, imports)
  const fn = instance.exports as Record<string, (...args: number[]) => number>
  const near = (name: string, actual: number, expected: number) => {
    assert.ok(Math.abs(actual - expected) <= 1e-12, `${name}: ${actual} != ${expected}`)
  }

  assert.equal(fn.subTick(2, -2, 1), 16384)
  assert.equal(fn.subTick(1, 0, 0.5), 32768)
  assert.equal(fn.subTick(3, 3, 0), 0)
  assert.equal(fn.subTick(7, 7, 3), 0)
  assert.equal(fn.subTick(0, -1, 5), 0)
  assert.equal(fn.subTick(10, 0, -5), 65535)
  assert.equal(fn.respawnSlotCount(0), 1)
  assert.equal(fn.respawnSlotCount(8), 8)
  assert.equal(fn.respawnSlotCount(20), 12)
  assert.equal(fn.dueRespawn(-1, 100), 0)
  assert.equal(fn.dueRespawn(100, 99), 0)
  assert.equal(fn.dueRespawn(100, 100), 1)
  near('slot 0 x', fn.respawnSlotX(0, 15, 0, 1, 0, 8, 1.2), 1.8)
  near('slot 0 z', fn.respawnSlotZ(0, 15, 0, 1, 0, 8, 1.2), 16.2)
  near('slot 5 x', fn.respawnSlotX(0, 15, 0, 1, 5, 8, 1.2), 0.6)
  near('slot 5 z', fn.respawnSlotZ(0, 15, 0, 1, 5, 8, 1.2), 15)
  near('slot 9 x', fn.respawnSlotX(0, 15, 0, 1, 9, 8, 1.2), 0.6)
  near('slot 9 z', fn.respawnSlotZ(0, 15, 0, 1, 9, 8, 1.2), 16.2)
  near('rotated slot 0 x', fn.respawnSlotX(2, 3, 1, 0, 0, 12, 1), 3)
  near('rotated slot 0 z', fn.respawnSlotZ(2, 3, 1, 0, 0, 12, 1), 1.5)
  // Four columns by three rows: every one of the twelve spread slots, hand-derived.
  const spreadX = [1.8, 0.6, -0.6, -1.8, 1.8, 0.6, -0.6, -1.8, 1.8, 0.6, -0.6, -1.8]
  const spreadZ = [16.2, 16.2, 16.2, 16.2, 15, 15, 15, 15, 13.8, 13.8, 13.8, 13.8]
  for (let slot = 0; slot < 12; slot++) {
    near(`spread ${slot} x`, fn.respawnSlotX(0, 15, 0, 1, slot, 12, 1.2), spreadX[slot])
    near(`spread ${slot} z`, fn.respawnSlotZ(0, 15, 0, 1, slot, 12, 1.2), spreadZ[slot])
  }
  assert.equal(fn.nextSlot(9, 8), 1)
  assert.equal(fn.nextSlot(3, 0), 0)
  assert.equal(fn.nextCursor(7, 8), 0)
  assert.equal(fn.nextCursor(2, 8), 3)
  assert.equal(fn.gateCrossed(1, 1, 0, 0, -1), 0)
  assert.equal(fn.gateCrossed(1, 1, 0, 0, 0), -1)
  assert.equal(fn.gateCrossed(1, 1, 1, -1, -1), -1)
  assert.equal(fn.gateCrossed(0, 3, 2, 2, 0), 2)
  assert.equal(fn.gateCrossed(0, 3, 0, 0, 1), -1)
  assert.equal(fn.finishCrossed(1, 1, 0, 0, 0), 2)
  assert.equal(fn.finishCrossed(1, 1, 0, -1, 0), 0)
  assert.equal(fn.finishCrossed(1, 2, 0, 0, 0), 1)
  assert.equal(fn.finishCrossed(0, 1, 0, -1, 0), 2)
})

test('run: gate then finish, qualified and parked', async () => {
  const { round } = await harnessRound('ege-strip')
  watchEvents(round)
  const records = events(round)
  try {
    while (round.tick < 900 && !records.some(event => event.kind === 'finish' && event.fields.seat === 0)) {
      round.step(seat => seat === 0 ? code(0, 1) : NEUTRAL_CODE)
      assert.equal(round.observe().faults, 0)
    }
    const gate = records.find(event => event.kind === 'gate' && event.fields.seat === 0)
    const finish = records.find(event => event.kind === 'finish' && event.fields.seat === 0)
    assert.ok(gate && finish, JSON.stringify({ tick: round.tick, state: round.worldState().resources.round, pos: round.observe().seats[0].pos, records }))
    assert.equal(gate.fields.stage, 0)
    assert.equal(gate.fields.lap, 0)
    assert.ok(gate.tick < finish.tick)
    assert.equal(finish.fields.lap, 0)
    const crossing = Number(finish.fields.crossing)
    assert.ok(Number.isInteger(crossing) && crossing >= 0 && crossing <= 65535)
    const obs = round.observe()
    assert.equal(obs.seats[0].status, 2)
    assert.equal(obs.seats[0].mode, 7)
    const { character } = seatRecords(round, obs.seats[0].entity)
    assert.equal(character.parked, 1)
    assert.ok(obs.seats[0].pos.y < -400, JSON.stringify({ pos: obs.seats[0].pos, character }))
    assert.ok(obs.qualified >= 1)
  } finally { round.dispose() }
})

test('progress events report the hand-derived route distance', async () => {
  const { round } = await harnessRound('ege-strip')
  watchEvents(round)
  try {
    let progress: ReturnType<typeof events> = []
    while (round.tick < 300 && progress.length < 16) {
      round.step(() => NEUTRAL_CODE)
      assert.equal(round.observe().faults, 0)
      progress = events(round).filter(event => event.kind === 'progress')
    }
    assert.ok(progress.length >= 16, JSON.stringify({ tick: round.tick, obs: round.observe(), progress }))
    const firstTick = progress[0].tick
    const first = progress.filter(event => event.tick === firstTick)
    assert.equal(first.length, 8)
    assert.deepEqual(first.map(event => Number(event.fields.seat)).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7])
    for (const event of first) {
      const distance = Number(event.fields.distance_mm)
      assert.ok(distance >= 14500 && distance <= 15000)
    }
    const nextTick = progress.find(event => event.tick > firstTick)!.tick
    assert.equal(nextTick - firstTick, 30)
  } finally { round.dispose() }
})

test('sideways fall respawns at the checkpoint slot with protection', async () => {
  const { round } = await harnessRound('ege-strip')
  watchEvents(round)
  const intro = PROFILES.sprint.introTicks
  let fallTick = -1
  try {
    while (round.tick < 500 && (round.worldState().components.seat[String(round.observe().seats[0].entity)] as any).checkpoint !== 0) {
      round.step(seat => seat === 0 ? code(0, 1) : NEUTRAL_CODE)
      assert.equal(round.observe().faults, 0)
    }
    assert.equal((round.worldState().components.seat[String(round.observe().seats[0].entity)] as any).checkpoint, 0)
    while (round.tick < 900 && fallTick < 0) {
      round.step(seat => seat === 0 ? (round.tick >= intro ? code(1, 0) : NEUTRAL_CODE) : NEUTRAL_CODE)
      assert.equal(round.observe().faults, 0)
      fallTick = events(round).find(event => event.kind === 'fall' && event.fields.seat === 0)?.tick ?? -1
    }
    assert.ok(fallTick >= 0, JSON.stringify({ tick: round.tick, seat: seatRecords(round, round.observe().seats[0].entity), obs: round.observe(), events: events(round) }))
    const entity = round.observe().seats[0].entity
    while (round.tick < fallTick + 60) {
      round.step(() => NEUTRAL_CODE)
      assert.equal(round.observe().faults, 0)
    }
    assert.equal(round.observe().tick, fallTick + 60)
    assert.equal(seatRecords(round, entity).character.parked, 1)
    round.step(() => NEUTRAL_CODE)
    assert.equal(round.observe().faults, 0)
    assert.equal(round.observe().tick, fallTick + 61)
    assert.equal(round.observe().seats[0].status, 1)
    assert.equal(seatRecords(round, entity).character.parked, 0)
    const { seat, character } = seatRecords(round, entity)
    assert.ok(Math.hypot(round.observe().seats[0].pos.x - 0, round.observe().seats[0].pos.z - 15) <= 2.5, JSON.stringify({ tick: round.tick, pos: round.observe().seats[0].pos, records: seatRecords(round, entity) }))
    assert.equal(seat.wait_until, -1)
    assert.equal(seat.protect_until, fallTick + 180)
    assert.equal(character.protected_until, fallTick + 180)
    round.step(() => NEUTRAL_CODE)
    assert.equal(round.observe().faults, 0)
    const props = seatRecords(round, entity).props
    assert.equal(props.groups_override, 1)
    assert.equal(props.filter, 3)
    while (round.tick < fallTick + 190) {
      round.step(() => NEUTRAL_CODE)
      assert.equal(round.observe().faults, 0)
    }
    assert.equal(seatRecords(round, entity).props.filter, 7)
  } finally { round.dispose() }
})

test('respawn none eliminates and all seats out ends the round', async () => {
  const { round } = await relocated(course => {
    course.sim.level.respawn.mode = 'none'
    course.sim.level.kind = 'survival'
  }, Array(8).fill(true))
  watchEvents(round)
  try {
    while (round.tick < 600 && round.observe().phase !== 'ended') {
      round.step(seat => seat < 4 ? code(-1, 0) : code(1, 0))
      assert.equal(round.observe().faults, 0)
    }
    const eliminations = events(round).filter(event => event.kind === 'eliminate')
    assert.equal(eliminations.length, 8, JSON.stringify({ tick: round.tick, obs: round.observe(), events: events(round), state: round.worldState().resources.round }))
    assert.deepEqual(eliminations.map(event => Number(event.fields.seat)).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7])
    assert.ok(round.observe().seats.every(seat => seat.status === 3))
    assert.equal(round.observe().eliminated, 8)
    assert.equal(round.observe().alive, 0)
    assert.equal(round.observe().phase, 'ended')
    assert.equal(round.worldState().resources.round.ended_tick, Math.max(...eliminations.map(event => event.tick)))
    assert.equal(round.observe().events.fall ?? 0, 0)
    assert.equal(round.observe().events.progress ?? 0, 0)
    const count = events(round).length
    for (let i = 0; i < 10; i++) {
      round.step(() => NEUTRAL_CODE)
      assert.equal(round.observe().faults, 0)
    }
    assert.equal(events(round).length, count)
  } finally { round.dispose() }
})

test('two worlds stepped with the same codes stay equal for 600 ticks', async () => {
  const { engine, scene, course, round: a } = await harnessRound('ege-strip', { humans: Array(8).fill(true) })
  let b: import('@royal-fiesta/game/ege/round').EngineRound | undefined
  try {
    const schema = await readRepoText(RF_EGE_SCHEMA)
    b = await createEngineRound(engine, schema, await rfScriptBytes(), scene, course, {
      profile: 'sprint', seed: 7, humans: Array(8).fill(true),
    })
    for (let i = 0; i < 600; i++) {
      const input = (tick: number) => tick >= PROFILES.sprint.introTicks ? code(1, 0) : NEUTRAL_CODE
      a.step(seat => seat === 0 ? input(a.tick) : NEUTRAL_CODE)
      b.step(seat => seat === 0 ? input(b!.tick) : NEUTRAL_CODE)
      assert.equal(a.observe().faults, 0)
      assert.equal(b.observe().faults, 0)
    }
    assert.equal(engine.worldEqual(a.world, b.world), true)
  } finally {
    b?.dispose()
    a.dispose()
  }
})

const SEAT_RULES_WORLD = 'seat_rules_probe'
const NEUTRAL_INPUTS = [0, 0, 0, 0, 0, 0, 0, 0]

async function seatRulesSchema(): Promise<string> {
  const schema = JSON.parse(await readRepoText(RF_EGE_SCHEMA))
  schema.world_kinds.push({
    name: SEAT_RULES_WORLD,
    players: 8,
    schedule: [{
      system: 'rf.seat.rules',
      kind: 'script',
      reads: ['course', 'home_spawn', 'path_node', 'show_seat_identity', 'show_result_a', 'show_result_b', 'feature'],
      writes: ['round', 'seat', 'character', 'gate', 'home', 'ege.transform', 'ege.velocity', 'ege.mech.grab', 'show_result_a', 'show_result_b', 'show_team_contribution'],
      emits: ['finish', 'fall', 'eliminate', 'gate', 'progress'],
    }],
  })
  return JSON.stringify(schema)
}

type Overrides = Record<string, any>

function seatEntity(room: number, over: Overrides = {}): any {
  const round = over.roundSeat ?? 0
  return {
    body: { type: 'dynamic', gravity_scale: 0, can_sleep: false },
    components: {
      seat: {
        seat: round, player: round, status: 1, team: 0, spawn: 0,
        spawn_t: [0, 0, 15], spawn_facing: [0, 1], checkpoint: -1,
        prev_y: 0.91, before: [0, 0.91, 0], stage: -1, lap: 0, finished: 0,
        wait_until: -1, protect_until: -1, cursor: 0, kill_request: 0,
        ...(over.seat ?? {}),
      },
      character: {
        mode: 1, facing: [0, 1], grounded: 0, ground_item: -1, ground_obstacle: -1, ground_body: -1,
        grab_target: -1, grab_lever: -1, protected_until: -1, parked: 0, placed: 1,
        stand: 0.9, radius: 0.4, half_height: 0.45, carry: 0, carry_id: -1,
      },
      'ege.transform': { pos: over.pos ?? [0, 0.91, 15], rot: [0, 0, 0, 1] },
      show_seat_identity: { room_seat: room, round_seat: round, input_slot: -1, bot: 1 },
      show_control: { code: 0 },
      show_result_a: {
        seat: over.resultSeat ?? room, status: 1, finish_tick: -1, finish_sub: -1, lap: 0,
        stage: -1, route_mm: 0, falls: 0, score: 0, last_score_tick: -1,
      },
      show_result_b: {
        hold_ticks: 0, possessing: 0, last_acquire_tick: -1, matches: 0, cross_ticks: 0,
        out_tick: -1, out_sub: -1, team: 0, opening_rank: 0,
      },
      ...(over.components ?? {}),
    },
  }
}

function routeProbeResources(over: Overrides = {}): any {
  return {
    round: {
      intro_ticks: over.intro ?? 0, round_ticks: 600, overtime_ticks: 0, kind: over.kind ?? 0,
      final_rule: 0, phase: 1, frozen: 0, ended_tick: -1, entrants: over.entrants ?? 8,
      alive: 0, qualified: 0, eliminated: 0, trailing_team: -1,
    },
    course: {
      kill_plane_y: -10, has_finish: over.hasFinish ? 1 : 0,
      finish_center: over.finish ?? [0, 0, 0], finish_half: over.finishHalf ?? [1, 1, 1],
      checkpoint_count: over.checkpointCount ?? 0, spawn_count: 1, home_count: 0,
      path_count: over.pathCount ?? 0, respawn_mode: over.respawnMode ?? 0,
      wait_ticks: over.waitTicks ?? 0, protect_ticks: over.protectTicks ?? 120,
      slots: over.slots ?? 8, spacing_m: over.spacing ?? 1.2,
      ordered: over.ordered ? 1 : 0, laps: 1,
      stage_count: over.stageCount ?? 0, last_stage: over.lastStage ?? -1,
      grab_players: 0, grab_objects: 0,
    },
  }
}

function probeScene(over: Overrides = {}): any {
  const entities: any[] = over.entities ?? []
  return {
    format: 'ege.scene', version: 1, world_kind: SEAT_RULES_WORLD, seed: 1,
    resources: routeProbeResources(over.resources ?? {}),
    entities,
  }
}

let probeBytes: Promise<Uint8Array> | null = null

function probeScripts(schema: string): Promise<Uint8Array> {
  probeBytes ??= (async () => {
    const result = await (await rfCompiler()).compile(collectRfScripts(), schema)
    const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
    assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
    assert.ok(result.wasm)
    return result.wasm as Uint8Array
  })()
  return probeBytes
}

async function probeWorld(scene: any, schema: string) {
  const engine = await loadEngine()
  engine.setSchema(schema)
  const layout = schemaLayout(engine)
  const faults: string[] = []
  const module = await loadScript(engine, await probeScripts(schema), { name: 'rf-scripts', onFault: fault => faults.push(`${fault.system}: ${fault.message}`), onLog: line => faults.push(`log ${line}`) })
  const host = new ScriptHost(module)
  const world = engine.createWorld(scene)
  return { engine, layout, module, host, world, scene, faults }
}

test('show finishes report the stable room seat and terminal events apply once', async () => {
  const schema = await seatRulesSchema()
  const above = await probeWorld(probeScene({
    resources: { entrants: 60, hasFinish: true },
    entities: [seatEntity(59, { pos: [0, 0.91, 0] })],
  }), schema)
  try {
    above.host.stepTick(above.world, NEUTRAL_INPUTS)
    assert.equal(above.module.faultCount, 0, above.faults.join(' | '))
    const state = readWorldState(above.engine, above.world, above.layout)
    const entity = state.entities[0]
    assert.equal(state.components.seat[entity].status, 2)
    assert.equal(state.components.show_result_a[entity].seat, 59)
    assert.equal(state.components.show_result_a[entity].status, 2)
    assert.equal(state.components.show_result_a[entity].finish_tick, 0)
    const readFinish = () => decodeEvents(above.engine.events(above.world, 0, above.engine.tick(above.world)).records, above.layout)
      .filter(event => event.kind === 'finish')
    const first = readFinish()
    assert.equal(first.length, 1)
    assert.equal(Number(first[0].fields.seat), 59)
    let later = 0
    for (let i = 0; i < 6; i++) {
      above.host.stepTick(above.world, NEUTRAL_INPUTS)
      later += readFinish().length
    }
    assert.equal(above.module.faultCount, 0, above.faults.join(' | '))
    assert.equal(later, 0)
    const after = readWorldState(above.engine, above.world, above.layout)
    assert.equal(after.components.show_result_a[entity].status, 2)
    assert.equal(after.components.show_result_a[entity].finish_tick, 0)
    // The rules domain owns show closure, so the local world never ends the round.
    assert.equal(after.resources.round.phase, 1)
    assert.equal(after.resources.round.ended_tick, -1)
  } finally {
    above.engine.freeWorld(above.world)
    above.module.dispose()
  }
})

test('show eliminations use the room seat and apply once', async () => {
  const schema = await seatRulesSchema()
  const probe = await probeWorld(probeScene({
    resources: { entrants: 60, respawnMode: 2 },
    entities: [seatEntity(40, { pos: [0, -20, 15], seat: { kill_request: 1 } })],
  }), schema)
  try {
    probe.host.stepTick(probe.world, NEUTRAL_INPUTS)
    assert.equal(probe.module.faultCount, 0, probe.faults.join(' | '))
    const state = readWorldState(probe.engine, probe.world, probe.layout)
    const entity = state.entities[0]
    assert.equal(state.components.seat[entity].status, 3)
    assert.equal(state.components.show_result_a[entity].seat, 40)
    assert.equal(state.components.show_result_a[entity].status, 3)
    assert.equal(state.components.show_result_b[entity].out_tick, 0)
    const readEliminated = () => decodeEvents(probe.engine.events(probe.world, 0, probe.engine.tick(probe.world)).records, probe.layout)
      .filter(event => event.kind === 'eliminate')
    const first = readEliminated()
    assert.equal(first.length, 1)
    assert.equal(Number(first[0].fields.seat), 40)
    let later = 0
    for (let i = 0; i < 4; i++) {
      probe.host.stepTick(probe.world, NEUTRAL_INPUTS)
      later += readEliminated().length
    }
    assert.equal(probe.module.faultCount, 0, probe.faults.join(' | '))
    assert.equal(later, 0)
  } finally {
    probe.engine.freeWorld(probe.world)
    probe.module.dispose()
  }
})

test('the remaining route projection matches a hand-derived distance', async () => {
  const schema = await seatRulesSchema()
  const scene = probeScene({
    resources: { entrants: 8, pathCount: 4, checkpointCount: 1, stageCount: 1, lastStage: 0, ordered: true },
    entities: [
      seatEntity(0, { pos: [2, 0.91, 5] }),
      { components: { gate: { index: 0, stage: 0, center: [0, 0, 10], half: [1, 1, 1], respawn_t: [0, 0, 10], respawn_facing: [0, 1], cursor: 0 } } },
      ...[0, 1, 2, 3].map(i => ({ components: { path_node: { index: i, p: [0, 0, i * 10] } } })),
    ],
  })
  const probe = await probeWorld(scene, schema)
  try {
    probe.host.stepTick(probe.world, NEUTRAL_INPUTS)
    assert.equal(probe.module.faultCount, 0, probe.faults.join(' | '))
    const progress = decodeEvents(probe.engine.events(probe.world, 0, probe.engine.tick(probe.world)).records, probe.layout)
      .filter(event => event.kind === 'progress')
    assert.equal(progress.length, 1)
    // Path 0 -> 10 m; the seat sits at z = 5, half way along the first segment.
    assert.equal(Number(progress[0].fields.distance_mm), 5000)
  } finally {
    probe.engine.freeWorld(probe.world)
    probe.module.dispose()
  }
})

test('a transferred seat keeps its anchor cursor and respawns in its slot', async () => {
  const schema = await seatRulesSchema()
  const options = { entrants: 60, waitTicks: 1, protectTicks: 120, slots: 8, spacing: 1.2 }
  const from = await probeWorld(probeScene({
    resources: options,
    entities: [seatEntity(40, { pos: [1, -20, 5], seat: { cursor: 3, kill_request: 1 } })],
  }), schema)
  const to = await probeWorld(probeScene({ resources: options, entities: [{ body: { type: 'fixed' }, components: { 'ege.transform': { pos: [0, -1, 0] } } }] }), schema)
  try {
    const entity = readWorldState(from.engine, from.world, from.layout).entities[0]
    const bytes = from.engine.exportEntities(from.world, [entity], true)
    const ids = to.engine.importEntities(to.world, bytes)
    assert.equal(ids.length, 1)
    to.host.stepTick(to.world, NEUTRAL_INPUTS)
    to.host.stepTick(to.world, NEUTRAL_INPUTS)
    assert.equal(to.module.faultCount, 0, to.faults.join(' | '))
    const state = readWorldState(to.engine, to.world, to.layout)
    const moved = ids[0]
    const seat = state.components.seat[moved]
    assert.equal(seat.cursor, 4)
    assert.equal(seat.wait_until, -1)
    assert.equal(seat.protect_until, 121)
    assert.equal(state.components.character[moved].protected_until, 121)
    assert.equal(state.components.show_result_a[moved].falls, 1)
    const pos = state.components['ege.transform'][moved].pos as number[]
    assert.ok(Math.abs(pos[0] - -1.8) <= 1e-6, `x ${pos[0]}`)
    assert.ok(Math.abs(pos[2] - 16.2) <= 1e-6, `z ${pos[2]}`)
  } finally {
    from.engine.freeWorld(from.world)
    to.engine.freeWorld(to.world)
    from.module.dispose()
  }
})

test('equal show inputs produce equal state across two worlds', async () => {
  const schema = await seatRulesSchema()
  const scene = probeScene({
    resources: { entrants: 60, hasFinish: true },
    entities: [
      seatEntity(40, { pos: [0, 0.91, 0] }),
      seatEntity(59, { roundSeat: 1, pos: [2, 0.91, 5], seat: { cursor: 5 } }),
    ],
  })
  const a = await probeWorld(scene, schema)
  const bModule = await loadScript(a.engine, await probeScripts(schema), { name: 'rf-scripts-b' })
  const bHost = new ScriptHost(bModule)
  const worldB = a.engine.createWorld(scene)
  try {
    for (let i = 0; i < 30; i++) {
      a.host.stepTick(a.world, NEUTRAL_INPUTS)
      bHost.stepTick(worldB, NEUTRAL_INPUTS)
    }
    assert.equal(a.module.faultCount, 0, a.faults.join(' | '))
    assert.equal(bModule.faultCount, 0)
    assert.equal(a.engine.worldEqual(a.world, worldB), true)
  } finally {
    a.engine.freeWorld(worldB)
    a.engine.freeWorld(a.world)
    bModule.dispose()
    a.module.dispose()
  }
})
