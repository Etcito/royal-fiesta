import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import type { WorldState } from '@etcito/game-engine/world-state'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { ShadowView } from '@gamesaloon/rollback/zones'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { createEngineShowFactory } from '@royal-fiesta/game/ege/showFactory'
import type { EngineShowFactory } from '@royal-fiesta/game/ege/showFactory'
import type { EngineShowConfig } from '@royal-fiesta/game/ege/showTypes'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

const engine = await loadEngine()
const schemaText = await readRepoText(RF_EGE_SCHEMA)
engine.setSchema(schemaText)
const layout = schemaLayout(engine)
const { course, assets } = await loadEgeCourse('s1-f-taffy-circuit')
const zones = new Map([[course.id, await loadZonesFile(course.id, course.sim!, readRepoText)]])
const humans = Array.from({ length: 60 }, (_, room) => room === 0 || room === 59)
const season = [
  { id: 'F', course: 0, kind: 'race', finalRule: null, stages: ['R1', 'R2', 'R3'], team: false, cut: false },
  { id: 'Q', course: 0, kind: 'final', finalRule: 'crown', stages: ['final'], team: false, cut: false },
] as const

async function preparedFactory(testMode = true): Promise<EngineShowFactory> {
  const config: EngineShowConfig = {
    engine, schemaText, scriptBytes: await rfScriptBytes(), seed: 7,
    identity: { backend: 'engine', schemaKey: layout.key, moduleKey: 'publication' },
    courses: [course], assets, zones, season, humans, testMode,
  }
  return createEngineShowFactory(config)
}

function seatsByRoom(state: WorldState): Map<number, number> {
  const seats = new Map<number, number>()
  for (const [entity, row] of Object.entries(state.components.show_seat_identity ?? {})) {
    seats.set(Number(row.room_seat), Number(entity))
  }
  return seats
}

function childByOwner(state: WorldState, name: string, owner: number): Record<string, unknown> | null {
  const rows = Object.entries(state.components[name] ?? {})
  const found = rows.find(([, row]) => Number(row.owner) === owner)
  if (!found) return null
  const record = { ...found[1] }
  // Entity references are remapped by EGZ; the live owner is never the template index.
  delete record.owner
  return record
}

function seatRecord(state: WorldState, seat: number) {
  const entity = String(seat)
  const character = { ...state.components.character[entity] }
  delete character.ground_entity
  return {
    identity: { ...state.components.show_seat_identity[entity] },
    character,
    transform: { ...state.components['ege.transform'][entity] },
    resultA: { ...state.components.show_result_a[entity] },
    resultB: { ...state.components.show_result_b[entity] },
    botMemory: childByOwner(state, 'bot_memory', seat),
    botRoute: childByOwner(state, 'bot_route', seat),
  }
}

function outboxPayload(entries: readonly { key: number; kind: number; value: number; tick: number }[]): Uint8Array {
  const bytes = new Uint8Array(2 + entries.length * 16)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, entries.length, true)
  entries.forEach((entry, index) => {
    const at = 2 + index * 16
    view.setUint32(at, entry.key, true)
    view.setUint32(at + 4, entry.kind, true)
    view.setUint32(at + 8, entry.value, true)
    view.setUint32(at + 12, entry.tick, true)
  })
  return bytes
}

function shadowsOf(from: number, payload: Uint8Array): ShadowView {
  return { count: 1, fromDomain: () => from, reader: () => new SnapReader(payload) }
}

const SEAT_ZONE_BASE = 65536
const SEAT_ZONE_STRIDE = 32

test('seat domains hand off entity, result and bot state through the EGZ export', async () => {
  const factory = await preparedFactory()
  try {
    const source = factory.create({ id: 1, kind: 'seat', cells: [], seats: [0, 3, 59], replicas: [0] }, 0)
    const sourceRef = factory.worldRef(source)
    assert.equal(sourceRef.kind, 'seat')
    for (let i = 0; i < 4; i++) sourceRef.binding.stepCodes(new Array(8).fill(0))
    const before = readWorldState(engine, source.world, layout)
    const beforeSeats = seatsByRoom(before)
    const movedRooms = [0, 3, 59]
    const expected = new Map(movedRooms.map(room => [room, seatRecord(before, beforeSeats.get(room)!)]))
    assert.equal(expected.get(3)!.botMemory !== null, true)
    assert.equal(expected.get(3)!.botRoute !== null, true)
    assert.equal(expected.get(0)!.botMemory, null)

    const writer = new SnapWriter()
    source.exportEntities(writer)
    const target = factory.rebuild(
      { id: 2, kind: 'field', cells: [], seats: movedRooms, replicas: [0] },
      source.tick,
      [new SnapReader(writer.bytes())],
    )
    const after = readWorldState(engine, target.world, layout)
    const afterSeats = seatsByRoom(after)
    assert.deepEqual([...afterSeats.keys()].sort((a, b) => a - b), movedRooms)
    for (const room of movedRooms) {
      assert.deepEqual(seatRecord(after, afterSeats.get(room)!), expected.get(room))
    }

    // Stepping the rebuilt domain reuses the transferred child rows instead of duplicating them.
    factory.worldRef(target).binding.stepCodes(new Array(8).fill(0))
    const stepped = readWorldState(engine, target.world, layout)
    const steppedSeats = seatsByRoom(stepped)
    const botSeat = steppedSeats.get(3)!
    assert.equal(Object.entries(stepped.components.bot_memory).filter(([, row]) => Number(row.owner) === botSeat).length, 1)
    assert.deepEqual([...steppedSeats.keys()].sort((a, b) => a - b), movedRooms)

    const global = factory.create({ id: 0, kind: 'global', cells: [], seats: [], replicas: [0] }, 0)
    assert.equal(factory.rulesState(global).faults, 0)
    factory.release(global)
    factory.release(source)
    factory.release(target)
  } finally {
    factory.dispose()
  }
})

test('rules handoff keeps season and pending messages across release and full restore', async () => {
  const factory = await preparedFactory()
  try {
    const global = factory.create({ id: 0, kind: 'global', cells: [], seats: [], replicas: [0] }, 0)
    // One incomplete cumulative record for room seat 5 stays pending until the other fields arrive.
    global.step([], shadowsOf(7, outboxPayload([{ key: SEAT_ZONE_BASE + 5 * SEAT_ZONE_STRIDE + 1, kind: 1, value: 1, tick: 4 }])))
    const pendingState = readWorldState(engine, global.world, layout)
    const pendingRows = Object.entries(pendingState.components.show_pending ?? {})
    assert.equal(pendingRows.length, 1)
    assert.equal(Number(pendingRows[0]![1].key), SEAT_ZONE_BASE + 5 * SEAT_ZONE_STRIDE + 1)
    assert.equal(Object.keys(pendingState.components.show_result_a ?? {}).length, 0)

    global.step([], shadowsOf(7, new Uint8Array(0)))
    const before = factory.rulesState(global)
    const cursorBefore = { ...readWorldState(engine, global.world, layout).components.show_season_cursor['0'] }
    const writer = new SnapWriter()
    global.snapshot(writer)

    factory.release(global)
    assert.throws(() => factory.rulesState(global))
    assert.deepEqual([...before.seatOf], Array.from({ length: 60 }, (_, room) => room))
    assert.deepEqual(before.alive, before.seatOf)

    const replacement = factory.create({ id: 2, kind: 'global', cells: [], seats: [], replicas: [0] }, 0)
    replacement.restore(new SnapReader(writer.bytes()))
    assert.deepEqual(factory.rulesState(replacement), before)
    const restoredState = readWorldState(engine, replacement.world, layout)
    assert.deepEqual({ ...restoredState.components.show_season_cursor['0'] }, cursorBefore)
    assert.equal(Object.entries(restoredState.components.show_pending ?? {}).length, 1)

    // The completing fields of the same produced tick apply the retained fragment exactly once.
    const complete = outboxPayload(Array.from({ length: 19 }, (_, field) => ({
      key: SEAT_ZONE_BASE + 5 * SEAT_ZONE_STRIDE + field, kind: field, tick: 4,
      value: field === 1 ? 1 : field === 6 ? 77 : field === 8 ? 5 : 0,
    })))
    replacement.step([], shadowsOf(7, complete))
    const applied = readWorldState(engine, replacement.world, layout)
    assert.equal(Object.entries(applied.components.show_pending ?? {}).length, 0)
    const resultA = Object.values(applied.components.show_result_a ?? {}).find(row => Number(row.seat) === 5)
    assert.ok(resultA)
    assert.equal(Number(resultA.status), 1)
    assert.equal(Number(resultA.route_mm), 77)
    assert.equal(Number(resultA.score), 5)
    assert.equal(Object.entries(applied.components.show_publish).filter(([, row]) => Number(row.seat) === 5).length, 19)
    assert.equal(factory.rulesState(replacement).faults, 0)

    factory.release(replacement)
  } finally {
    factory.dispose()
  }
})
