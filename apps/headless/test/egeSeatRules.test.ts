import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeEvents } from '@etcito/game-engine/world-state'
import { createEngineRound } from '@royal-fiesta/game/ege/round'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { emitEngineScene } from '@royal-fiesta/game/ege/sceneEmitter'
import { encodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { loadEngine } from '@etcito/game-engine'
import { harnessRound, loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

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
  assert.equal(fn.subTick(3, 3, 0), 0)
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
