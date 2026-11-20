import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'
import { showSceneOwnership } from '../src/ege/sceneEmitter.ts'
import { buildShowHubScene, buildShowPhysicsScenes, buildShowRulesScene } from '../src/ege/showScene.ts'
import { createEngineShowFactory } from '../src/ege/showFactory.ts'
import { readShowRoundResult, readShowState } from '../src/ege/showState.ts'
import type { EngineShowConfig } from '../src/ege/showTypes.ts'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'

const schemaText = readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8')
const engine = await loadEngine()
engine.setSchema(schemaText)
const config = {
  engine, schemaText, identity: { backend: 'engine', schemaKey: schemaLayout(engine).key, moduleKey: 'publication' },
  season: [{ id: 'map', course: 0 }], courses: [{ id: 'course' }],
} as unknown as EngineShowConfig
const entity = (name: string, fields: Record<string, number>) => ({ components: { [name]: fields } })
function scene(screen = 0, withResult = false) {
  const entities = [
    entity('show_season_cursor', { owner: 0, step: 0, alive: 2, team_rounds: 0, round_index: 0, rng_state: 1, final_map: -1, last_kind: -1, previous: -1 }),
    entity('show_presentation', { owner: 0, tick: 13, round_index: 0, screen, entered_tick: 0, result_index: withResult ? 0 : -1, seat_count: 2, alive_count: 1, vote_ticks: 1, results_ticks: 1, podium_ticks: 1 }),
    entity('show_roster_entry', { owner: 0, list: 0, position: 1, room_seat: 59 }),
    entity('show_roster_entry', { owner: 0, list: 0, position: 0, room_seat: 3 }),
    entity('show_roster_entry', { owner: 0, list: 1, position: 0, room_seat: 59 }),
    entity('show_candidate', { owner: 0, round_index: 0, index: 0, map: 0 }),
  ]
  if (withResult) entities.push(
    entity('show_round_result', { owner: 0, index: 0, map: 0, course: 0, kind: 6, final: 1, playoff: 0, end_tick: 12, reason: 7, champion: 59, ranking_count: 2, qualified_count: 1, eliminated_count: 1, team_count: 2 }),
    ...[[0, 1, 3, 0], [0, 0, 59, 2], [1, 0, 59, 0], [2, 0, 3, 0]].map(([list, position, seat, points]) => entity('show_result_seat', { owner: 0, result: 0, list, position, seat, points })),
    ...[5, 7].map((score, team) => entity('show_result_team', { owner: 0, result: 0, team, score })),
  )
  return { format: 'ege.scene', version: 1, world_kind: 'show_rules', seed: 1, entities }
}

test('copies authoritative show state and strictly confirms the current result', () => {
  for (const [screen, name] of ['vote', 'loading', 'intro', 'playing', 'overtime', 'results', 'podium', 'done'].entries()) {
    const world = engine.createWorld(JSON.stringify(scene(screen, true)))
    try {
      const pending = readShowState(config, world, 12, 2)
      assert.equal(pending.screen, name)
      assert.deepEqual(pending.seatOf, [3, 59])
      assert.deepEqual(pending.alive, [59])
      assert.deepEqual(pending.candidates, ['map'])
      assert.deepEqual(pending.results, [])
      assert.equal(pending.champion, null)
      assert.equal(readShowRoundResult(config, world, 12), null)
      const result = readShowRoundResult(config, world, 13)!
      assert.deepEqual(result, { index: 0, map: 'map', course: 'course', kind: 'final', final: true, playoff: false, endTick: 12, reason: 'crown', ranking: [59, 3], qualified: [59], eliminated: [3], points: [2, 0], teamScores: [5, 7], champion: 59 })
      assert.equal(readShowState(config, world, 13, 0).champion, 59)
      ;(result.ranking as number[]).push(2)
      assert.deepEqual(readShowRoundResult(config, world, 13)!.ranking, [59, 3])
    } finally { engine.freeWorld(world) }
  }
  const world = engine.createWorld(JSON.stringify(scene()))
  try {
    assert.equal(readShowRoundResult(config, world, 100), null)
    assert.deepEqual(readShowState(config, world, 100, 0).results, [])
    assert.throws(() => readShowState(config, world, -1, 0), RefusalError)
    assert.throws(() => readShowState({ ...config, season: [] }, world, 0, 0), RefusalError)
  } finally { engine.freeWorld(world) }
})

test('refuses wrong worlds and malformed stored roster positions', () => {
  const wrong = { ...scene(), world_kind: 'round' }
  const world = engine.createWorld(JSON.stringify(wrong))
  try { assert.throws(() => readShowState(config, world, 0, 0), RefusalError) } finally { engine.freeWorld(world) }
  const bad = scene()
  bad.entities[2].components.show_roster_entry.position = 0
  const malformed = engine.createWorld(JSON.stringify(bad))
  try { assert.throws(() => readShowState(config, malformed, 0, 0), RefusalError) } finally { engine.freeWorld(malformed) }
})

// ---- G7.1 show scene construction (this card) -----------------------------------------------------

const ROOT = new URL('../../../', import.meta.url)
const readRepoJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
const readRepoText = async (path: string): Promise<string> => readFileSync(new URL(path, ROOT), 'utf8')
const assetResolver: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = readRepoJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}

async function loadShowCourse(id: string): Promise<{ course: CourseV1; assets: Map<string, ResolvedGameAsset> }> {
  const path = `courses/${id}.course.json`
  const course = await loadCourseV1(readRepoJson(path), path, assetResolver)
  const assets = new Map<string, ResolvedGameAsset>()
  for (const assetId of course.assetIds) assets.set(assetId, await assetResolver.resolve(assetId))
  return { course, assets }
}

const raceLoaded = await loadShowCourse('s1-f-taffy-circuit')
const hubLoaded = await loadShowCourse('hub-plaza')
const race = raceLoaded.course
const hub = hubLoaded.course
const allAssets = new Map([...raceLoaded.assets, ...hubLoaded.assets])
const zones = new Map<string, ZonesFile>()
for (const course of [race, hub]) {
  zones.set(course.id, await loadZonesFile(course.id, course.sim!, readRepoText))
}
const season = [
  { id: 'F', course: 0, kind: 'race', finalRule: null, stages: ['R1', 'R2', 'R3'], team: false, cut: false },
  { id: 'Q', course: 0, kind: 'final', finalRule: 'crown', stages: ['final'], team: false, cut: false },
] as const

function showConfigWith(humans: readonly boolean[], over: Partial<EngineShowConfig> = {}): EngineShowConfig {
  return {
    engine, schemaText, scriptBytes: new Uint8Array(), seed: 7,
    identity: { backend: 'engine', schemaKey: schemaLayout(engine).key, moduleKey: 'publication' },
    courses: [race, hub], assets: allAssets, zones, season, humans,
    ...over,
  }
}

const sixty = Array.from({ length: 60 }, (_, room) => room)

function slotsOf(humans: readonly boolean[], humanSeats: readonly number[]): number[] {
  return sixty.map(room => {
    const slot = humanSeats.indexOf(room)
    return humans[room] ? (slot < 0 ? 0 : slot) : -1
  })
}

function checkShowScene(scene: ReturnType<typeof buildShowPhysicsScenes>['seat'], worldKind: 'show_seat' | 'show_field', slots: readonly number[]): void {
  const show = scene.show
  assert.ok(show)
  assert.equal(show.worldKind, worldKind)
  assert.equal(show.seats.length, 60)
  for (let roundSeat = 0; roundSeat < 60; roundSeat++) {
    assert.deepEqual(show.seats[roundSeat], { roomSeat: roundSeat, roundSeat, inputSlot: slots[roundSeat], entity: scene.seatEntities[roundSeat] })
  }
  const zoneRows = scene.scene.entities.flatMap((row, entity) => row.components?.['ege.zone.id'] ? [entity] : [])
  assert.deepEqual(show.ownership.map(row => row.entity), zoneRows)
  assert.equal(new Set(show.ownership.map(row => row.zoneId)).size, show.ownership.length)
  for (let roundSeat = 0; roundSeat < 60; roundSeat++) {
    assert.deepEqual(show.ownership[roundSeat], { entity: scene.seatEntities[roundSeat], zoneId: roundSeat + 1, owner: roundSeat, group: roundSeat + 1 })
    assert.deepEqual(show.ownership[60 + roundSeat], { entity: scene.index(`show/seat/${roundSeat}`), zoneId: 61 + roundSeat, owner: roundSeat, group: roundSeat + 1 })
  }
  assert.equal(show.ownership.length, 60 + 60 + 60 * 19)
  assert.deepEqual(show.ownership[120], { entity: scene.index('show/publish/0/0'), zoneId: 65536, owner: 0, group: 1 })
  assert.deepEqual(show.ownership.at(-1), { entity: scene.index('show/publish/59/18'), zoneId: 65536 + 59 * 32 + 18, owner: 59, group: 60 })
}

test('buildShowPhysicsScenes constructs sixty-seat templates with zero, one and sparse humans', () => {
  for (const humanSeats of [[], [3], [0, 31, 59]]) {
    const humans = sixty.map(room => humanSeats.includes(room))
    const slots = slotsOf(humans, humanSeats)
    const config = showConfigWith(humans)
    const scenes = buildShowPhysicsScenes(config, race, sixty, slots)
    assert.deepEqual(scenes.grid, { cols: 96, rows: 56, cellSize: 2, originX: -96, originZ: -56 })
    checkShowScene(scenes.seat, 'show_seat', slots)
    checkShowScene(scenes.field, 'show_field', slots)
    for (const scene of [scenes.seat, scenes.field]) {
      const world = engine.createWorld(scene.text)
      try { assert.ok(world > 0) } finally { engine.freeWorld(world) }
    }
    assert.deepEqual(buildShowPhysicsScenes(config, race, sixty, slots).seat.show, scenes.seat.show)
  }
})

test('buildShowRulesScene seeds the rules state G7-SHOW-STATE-API decodes', () => {
  const humans = sixty.map(room => room === 3 || room === 40)
  const config = showConfigWith(humans)
  const rules = buildShowRulesScene(config)
  assert.equal(rules.world_kind, 'show_rules')
  const cursor = rules.entities.findIndex(row => row.components?.show_season_cursor)
  assert.equal(cursor, 0)
  for (const row of rules.entities) {
    const components = row.components ?? {}
    for (const name of ['show_presentation', 'show_lifecycle_input', 'show_clock', 'show_plan_entry', 'show_catalog_entry', 'show_roster_entry']) {
      if (components[name]) assert.equal(components[name].owner, cursor, `${name} belongs to the cursor`)
    }
  }
  const presentation = rules.entities.find(row => row.components?.show_presentation)!.components!.show_presentation
  assert.deepEqual(presentation, {
    owner: 0, tick: 0, round_index: 0, screen: 0, entered_tick: 0, result_index: -1,
    seat_count: 60, alive_count: 60, vote_ticks: 300, results_ticks: 90, podium_ticks: 150,
  })
  const lifecycle = rules.entities.find(row => row.components?.show_lifecycle_input)!.components!.show_lifecycle_input
  assert.deepEqual(lifecycle, { owner: 0, ready_round: -1, confirmed_tick: 0 })
  const clock = rules.entities.find(row => row.components?.show_clock)!.components!.show_clock
  assert.equal(clock.round_ticks, race.sim!.level!.timeCapTicks)
  assert.equal(clock.intro_ticks, 60)
  assert.equal(clock.start_tick, -1)
  const world = engine.createWorld(JSON.stringify(rules))
  try {
    const state = readShowState(config, world, 0, 0)
    assert.equal(state.screen, 'vote')
    assert.equal(state.round, 0)
    assert.deepEqual(state.seatOf, sixty)
    assert.deepEqual(state.alive, sixty)
    assert.deepEqual(state.candidates, [])
    assert.deepEqual(state.results, [])
    assert.equal(state.champion, null)
    assert.equal(readShowRoundResult(config, world, 0), null)
  } finally { engine.freeWorld(world) }
  const fast = buildShowRulesScene(showConfigWith(humans, { testMode: true }))
  assert.deepEqual(
    fast.entities.find(row => row.components?.show_presentation)!.components!.show_presentation,
    { ...presentation, vote_ticks: 1, results_ticks: 1, podium_ticks: 1 },
  )
})

test('buildShowHubScene maps the configured human to input slot 0 and keeps lobby bots at -1', () => {
  const humans = sixty.map(room => room === 21)
  const config = showConfigWith(humans)
  const emitted = buildShowHubScene(config, hub, 21)
  assert.equal(emitted.show?.worldKind, 'show_hub')
  assert.deepEqual(emitted.show?.seats[21], { roomSeat: 21, roundSeat: 21, inputSlot: 0, entity: emitted.seatEntities[21] })
  assert.equal(emitted.show?.seats.filter(seat => seat.inputSlot >= 0).length, 1)
  assert.equal(emitted.show?.seats.filter(seat => seat.inputSlot === -1).length, 59)
  assert.equal(emitted.show?.ownership.some(row => row.zoneId >= 65536), false)
  const world = engine.createWorld(emitted.text)
  try { assert.ok(world > 0) } finally { engine.freeWorld(world) }
  assert.throws(() => buildShowHubScene(config, hub, 22), RefusalError)
  assert.throws(() => buildShowHubScene(config, race, 21), RefusalError)
})

test('show construction refuses missing assets, missing zones, invalid rosters and invalid catalogs', () => {
  const humans = sixty.map(room => room === 3)
  const base = showConfigWith(humans)
  const slots = slotsOf(humans, [3])
  const noAsset = new Map(base.assets)
  noAsset.delete(race.assetIds[0])
  assert.throws(() => buildShowPhysicsScenes(showConfigWith(humans, { assets: noAsset }), race, sixty, slots), RefusalError)
  assert.throws(() => buildShowHubScene(showConfigWith(humans, { assets: noAsset }), hub, 3), RefusalError)
  const noZone = new Map(base.zones)
  noZone.delete(race.id)
  assert.throws(() => buildShowPhysicsScenes(showConfigWith(humans, { zones: noZone }), race, sixty, slots), RefusalError)
  assert.throws(() => buildShowPhysicsScenes(base, race, [], []), RefusalError)
  assert.throws(() => buildShowPhysicsScenes(base, race, [5, 3], [-1, -1]), RefusalError)
  assert.throws(() => buildShowPhysicsScenes(base, race, sixty, sixty.map(() => -1)), RefusalError)
  assert.throws(() => buildShowPhysicsScenes(base, race, sixty, sixty.map(() => 0)), RefusalError)
  assert.throws(() => buildShowRulesScene(showConfigWith(humans, { season: [] })), RefusalError)
  assert.throws(() => buildShowRulesScene(showConfigWith(humans, { season: [{ ...season[0], course: 99 }] })), RefusalError)
  assert.throws(() => buildShowRulesScene(showConfigWith(humans, { season: [season[0], season[0]] })), RefusalError)
  assert.throws(() => buildShowRulesScene(showConfigWith(humans, { plan: [0] })), RefusalError)
})

test('show ownership refuses colliding zone identities and failed construction leaks no worlds', () => {
  const humans = sixty.map(room => room === 3)
  const base = showConfigWith(humans)
  const slots = slotsOf(humans, [3])
  const seat = buildShowPhysicsScenes(base, race, sixty, slots).seat
  const duplicate = { ...seat.scene, entities: [
    { name: 'a', components: { 'ege.zone.id': { id: 200, owner: 0, group: 0 } } },
    { name: 'b', components: { 'ege.zone.id': { id: 200, owner: 0, group: 0 } } },
  ] }
  assert.throws(() => showSceneOwnership(duplicate, sixty, 0), RefusalError)
  const reserved = { ...seat.scene, entities: [
    { name: 'a', components: { 'ege.zone.id': { id: 0x40000000, owner: 0, group: 0 } } },
  ] }
  assert.throws(() => showSceneOwnership(reserved, sixty, 0), RefusalError)

  const probe = buildShowRulesScene(base)
  const nextWorld = (): number => { const world = engine.createWorld(JSON.stringify(probe)); engine.freeWorld(world); return world }
  const before = nextWorld()
  const noAsset = new Map(base.assets)
  noAsset.delete(race.assetIds[0])
  assert.throws(() => buildShowPhysicsScenes(showConfigWith(humans, { assets: noAsset }), race, sixty, slots), RefusalError)
  const noZone = new Map(base.zones)
  noZone.delete(race.id)
  assert.throws(() => buildShowPhysicsScenes(showConfigWith(humans, { zones: noZone }), race, sixty, slots), RefusalError)
  assert.throws(() => buildShowRulesScene(showConfigWith(humans, { season: [] })), RefusalError)
  assert.equal(nextWorld(), before + 1)
})

// ---- G7-SHOW-FACTORY: prepared factory (this card) -------------------------------------------------

let showScriptPromise: Promise<Uint8Array<ArrayBuffer>> | undefined

function showScriptBytes(): Promise<Uint8Array<ArrayBuffer>> {
  showScriptPromise ??= (async () => {
    const result = await (await rfCompiler()).compile(collectRfScripts(), schemaText)
    const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
    assert.equal(errors.length, 0, errors.map(formatRfDiagnostic).join('\n'))
    assert.ok(result.wasm)
    return result.wasm as Uint8Array<ArrayBuffer>
  })()
  return showScriptPromise
}

function factoryConfig(humans: readonly boolean[], over: Partial<EngineShowConfig> = {}): EngineShowConfig {
  return showConfigWith(humans, { testMode: true, ...over })
}

test('factory preparation stays pending until script admission and prepared domains are synchronous', async () => {
  const humans = sixty.map(room => room === 3 || room === 40)
  const preparing = createEngineShowFactory(factoryConfig(humans, { scriptBytes: await showScriptBytes() }))
  const gate = { state: 'loading' as 'loading' | 'ready' | 'failed', ready: false, warm: false, ranGatedAction: false }
  const gated = preparing.then(factory => {
    gate.state = 'ready'
    gate.ready = true
    gate.warm = true
    gate.ranGatedAction = true
    return factory
  })
  // The gate keeps its loading state and never reports ready or warm before admission completes.
  assert.equal(gate.state, 'loading')
  assert.equal(gate.ready, false)
  assert.equal(gate.warm, false)
  assert.equal(gate.ranGatedAction, false)
  const factory = await gated
  assert.equal(gate.state, 'ready')
  assert.equal(gate.warm, true)

  const global = factory.create({ id: 0, kind: 'global', cells: [], seats: [0, 3], replicas: [0] }, 0)
  const globalRef = factory.worldRef(global)
  assert.equal(globalRef.domain, 0)
  assert.equal(globalRef.kind, 'global')
  assert.equal(globalRef.world, global.world)
  assert.equal(globalRef.confirmedTick, 0)
  const initial = factory.rulesState(global)
  assert.equal(initial.screen, 'vote')
  assert.deepEqual(initial.seatOf, sixty)
  assert.deepEqual(initial.alive, sixty)
  assert.equal(initial.faults, 0)

  const seat = factory.create({ id: 1, kind: 'seat', cells: [], seats: sixty.slice(0, 8), replicas: [0] }, 0)
  assert.equal(typeof seat.world, 'number')
  assert.equal(seat instanceof Promise, false)
  const writer = new SnapWriter()
  seat.exportEntities(writer)
  const rebuilt = factory.rebuild({ id: 2, kind: 'field', cells: [], seats: [0, 3], replicas: [0] }, seat.tick, [new SnapReader(writer.bytes())])
  assert.equal(rebuilt instanceof Promise, false)
  const reset = factory.reset({ id: 3, kind: 'seat', cells: [], seats: [0], replicas: [0] }, 0)
  assert.equal(reset instanceof Promise, false)
  assert.equal(reset.tick, 0)
  assert.throws(() => factory.rulesState(seat), RefusalError)
  assert.throws(() => factory.create({ id: 9, kind: 'seat', cells: [], seats: [99], replicas: [0] }, 0), RefusalError)
  // The reset scratch replaces the rebuild scratch, which is already freed and no longer live.
  assert.deepEqual(factory.worlds().map(ref => ref.domain).sort((a, b) => a - b), [0, 1, 3])
  assert.throws(() => engine.tick(rebuilt.world))

  globalRef.binding.stepCodes([])
  globalRef.binding.stepCodes([])
  assert.equal(factory.rulesState(global).screen, 'loading')
  assert.equal(factory.rulesState(global).faults, 0)
  // Equal prepared inputs produce equal state: a twin rules world stepped identically decodes identically.
  const twin = factory.create({ id: 5, kind: 'global', cells: [], seats: [], replicas: [0] }, 0)
  const twinRef = factory.worldRef(twin)
  twinRef.binding.stepCodes([])
  twinRef.binding.stepCodes([])
  assert.deepEqual(factory.rulesState(twin), factory.rulesState(global))
  factory.release(twin)

  factory.release(seat)
  factory.release(global)
  factory.release(rebuilt)
  factory.release(reset)
  assert.deepEqual(factory.worlds(), [])
  factory.dispose()
  assert.throws(() => factory.create({ id: 4, kind: 'global', cells: [], seats: [], replicas: [0] }, 0))
})

test('rejected preparation keeps the gate closed, propagates and frees its allocations', async () => {
  const humans = sixty.map(room => room === 3)
  const good = factoryConfig(humans, { scriptBytes: await showScriptBytes() })
  const probe = buildShowRulesScene(good)
  const nextWorld = (): number => { const world = engine.createWorld(JSON.stringify(probe)); engine.freeWorld(world); return world }
  const before = nextWorld()
  const gate = { state: 'loading' as 'loading' | 'ready' | 'failed', ready: false, warm: false, ranGatedAction: false }
  const broken = factoryConfig(humans, { scriptBytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) })
  const preparing = createEngineShowFactory(broken).then(
    factory => { gate.state = 'ready'; gate.ready = true; gate.warm = true; gate.ranGatedAction = true; return factory },
    error => { gate.state = 'failed'; throw error },
  )
  assert.equal(gate.state, 'loading')
  await assert.rejects(preparing)
  assert.equal(gate.state, 'failed')
  assert.equal(gate.ready, false)
  assert.equal(gate.warm, false)
  assert.equal(gate.ranGatedAction, false)
  await assert.rejects(createEngineShowFactory(factoryConfig(humans, { scriptBytes: new Uint8Array(), season: [] })), RefusalError)
  assert.equal(nextWorld(), before + 1)

  // The failed preparations leave the borrowed engine healthy and admit a later module.
  const factory = await createEngineShowFactory(good)
  const global = factory.create({ id: 0, kind: 'global', cells: [], seats: [0, 3], replicas: [0] }, 0)
  assert.equal(factory.rulesState(global).faults, 0)
  factory.release(global)
  factory.dispose()
})

test('factory releases each world once across scratch replacement and disposal', async () => {
  const humans = sixty.map(room => room === 3)
  const factory = await createEngineShowFactory(factoryConfig(humans, { scriptBytes: await showScriptBytes() }))
  const seat = factory.create({ id: 1, kind: 'seat', cells: [], seats: [0, 3], replicas: [0] }, 0)
  const writer = new SnapWriter()
  seat.exportEntities(writer)
  const first = factory.rebuild({ id: 2, kind: 'field', cells: [], seats: [0, 3], replicas: [0] }, 0, [new SnapReader(writer.bytes())])
  const second = factory.reset({ id: 3, kind: 'field', cells: [], seats: [0], replicas: [0] }, 0)
  // The second scratch frees the first; releasing the replaced world again changes nothing.
  assert.equal(factory.worlds().some(ref => ref.world === first.world), false)
  assert.throws(() => engine.tick(first.world))
  factory.release(first)
  factory.release(first)
  factory.release(seat)
  assert.throws(() => engine.tick(seat.world))
  factory.release(second)
  factory.release(second)
  assert.throws(() => engine.tick(second.world))
  assert.deepEqual(factory.worlds(), [])
  factory.dispose()
  factory.dispose()
})
