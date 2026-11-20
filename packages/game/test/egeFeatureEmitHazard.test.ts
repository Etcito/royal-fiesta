import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { FEATURE_EMITTERS } from '../src/ege/featureEmitters.ts'
import { emitEngineScene } from '../src/ege/sceneEmitter.ts'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'

const ROOT = new URL('../../../', import.meta.url)
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
const assets: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = readJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}
const engine = await loadEngine()
engine.setSchema(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))

async function inputWith(specs: FeatureSpec[]): Promise<{ input: import('../src/ege/sceneEmitter.ts').EmitInput; course: CourseV1 }> {
  const path = 'fixtures/ege/ege-strip.course.json'
  const loaded = await loadCourseV1(readJson(path), path, assets)
  const course = structuredClone(loaded)
  assert.ok(course.sim)
  course.sim.features = specs
  const resolved = new Map<string, ResolvedGameAsset>()
  for (const id of course.assetIds) resolved.set(id, await assets.resolve(id))
  return { input: { course, assets: resolved, setup: { profile: 'sprint', seed: 7 } }, course }
}

test('hexField emits an origin pool, source dimensions and floor-disc records', async () => {
  const spec: FeatureSpec = {
    id: 'hex-demo', kind: 'hexField', params: {
      origin: [2, 3, 4], layers: 2, layerSpacingM: 1.25, rings: 2,
      flatM: 5, pointM: 6, thickM: 0.4, warnS: 0.75, decayS: 2,
      scaleWithEntrants: true,
    },
  }
  const { input } = await inputWith([spec])
  const entities = FEATURE_EMITTERS.hexField(spec, {
    course: input.course.sim!, index: 3, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets,
  })
  assert.equal(entities.children.length, 38)
  assert.deepEqual(entities.root.components?.feature_hex_field, {
    origin: [2, 3, 4], layers: 2, layer_spacing_m: 1.25, rings: 2, flat_m: 5,
    point_m: 6, thick_m: 0.4, warn_s: 0.75, decay_s: 2, scale_with_entrants: 1, placed: 0,
  })
  assert.deepEqual(entities.children[0]?.components?.['ege.transform']?.pos, [2, 3, 4])
  assert.deepEqual(entities.children[37]?.components?.['ege.transform']?.pos, [2, 3, 4])
  for (let index = 0; index < entities.children.length; index++) {
    const child = entities.children[index]!
    assert.equal(child.name, `feature/hex-demo/hex/${index}`)
    assert.deepEqual(child.colliders?.[0]?.half_extents, [3, 0.2, 2.5])
    assert.deepEqual(child.components?.feature_hex_field_hex, {
      owner: 3, index, t: [2, 3, 4], state: 0, timer: 0,
    })
    assert.deepEqual(child.components?.['ege.render'], {
      shape: 4, color: 0xF2E6D0, visible: 1, params: [0.5, 0.2, 0, 0],
    })
  }
  const emitted = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(emitted.text) >= 1)
  assert.equal(emitted.index('feature/hex-demo/hex/0'), emitted.index('feature/hex-demo') + 1)
})

test('hexField refuses pools over 512 cells', async () => {
  const spec: FeatureSpec = { id: 'too-many', kind: 'hexField', params: {
    origin: [0, 0, 0], layers: 4, layerSpacingM: 1, rings: 8,
  } }
  const { input } = await inputWith([spec])
  assert.throws(() => FEATURE_EMITTERS.hexField(spec, {
    course: input.course.sim!, index: 0, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets,
  }), (error: unknown) => error instanceof RefusalError && error.message.includes('/rings: expected at most 512 cells'))
})

test('annulus emits a segment pool at the origin with placeholder box records', async () => {
  const spec: FeatureSpec = {
    id: 'ring-demo', kind: 'annulus', params: {
      center: [1, 2, 3], innerM: 2, outerM: 6, thickM: 0.4, speedDegS: 90, segments: 8,
    },
  }
  const { input } = await inputWith([spec])
  const entities = FEATURE_EMITTERS.annulus(spec, {
    course: input.course.sim!, index: 3, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets,
  })
  assert.equal(entities.children.length, 8)
  assert.deepEqual(entities.root.components?.feature_annulus, {
    center: [1, 2, 3], inner_m: 2, outer_m: 6, thick_m: 0.4,
    speed_deg_s: 90, segments: 8, overtime_ticks: 0, placed: 0,
  })
  for (let index = 0; index < entities.children.length; index++) {
    const child = entities.children[index]!
    assert.equal(child.name, `feature/ring-demo/segment/${index}`)
    assert.deepEqual(child.body, { type: 'kinematic_position' })
    assert.deepEqual(child.components?.['ege.transform']?.pos, [1, 2, 3])
    assert.deepEqual(child.colliders?.[0]?.half_extents, [1, 1, 1])
    assert.deepEqual(child.components?.['ege.box_collider'], { half_extents: [1, 1, 1] })
    assert.deepEqual(child.components?.['ege.render'], {
      shape: 1, color: 0xF5D0E0, visible: 1, params: [1, 1, 1, 0],
    })
    assert.deepEqual(child.components?.feature_annulus_segment, { owner: 3, index })
  }
  const emitted = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(emitted.text) >= 1)
  assert.equal(emitted.index('feature/ring-demo/segment/0'), emitted.index('feature/ring-demo') + 1)
})

test('annulus refuses a ring narrower than 0.5 m and an out-of-range segment count', async () => {
  const narrow: FeatureSpec = {
    id: 'narrow', kind: 'annulus', params: {
      center: [0, 0, 0], innerM: 2, outerM: 2.4, thickM: 0.4, speedDegS: 0, segments: 8,
    },
  }
  const { input } = await inputWith([narrow])
  assert.throws(() => FEATURE_EMITTERS.annulus(narrow, {
    course: input.course.sim!, index: 0, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets,
  }), (error: unknown) => error instanceof RefusalError && error.message.includes('/outerM: expected outerM > innerM + 0.5 m'))

  const few: FeatureSpec = {
    id: 'few', kind: 'annulus', params: {
      center: [0, 0, 0], innerM: 2, outerM: 6, thickM: 0.4, speedDegS: 0, segments: 5,
    },
  }
  assert.throws(() => FEATURE_EMITTERS.annulus(few, {
    course: input.course.sim!, index: 0, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets,
  }), (error: unknown) => error instanceof RefusalError && error.message.includes('/segments: expected segments'))
})

test('sweep root, phase and part records carry their declared fields within 256 bytes', () => {
  const components = schemaLayout(engine).components
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

test('sweep emits root-relative phases and a fixed placeholder pool', async () => {
  const spec: FeatureSpec = { id: 'sweep-demo', kind: 'sweep', params: {
    center: [2, 3, 4], lengthM: 8, telegraphS: 0.25, pattern: 'laser', heightM: 0.5,
    gapM: 2, speedDegS: 90, speedMps: 3,
    phases: [{ atS: 0, heightM: 0.7 }, { atS: 1.25, pattern: 'bars' }, { atS: 2, pattern: 'block' }],
  } }
  const { input } = await inputWith([spec])
  const ctx = { course: input.course.sim!, index: 3, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets }
  const entities = FEATURE_EMITTERS.sweep(spec, ctx)
  assert.deepEqual(entities.root.components?.feature_sweep, {
    center: [2, 3, 4], length_m: 8, telegraph_s: 0.25, phase_count: 3, part_count: 2,
    overtime_ticks: 0, active: 0, effective: 0, live: 0, just_live: 0, cos: 1, sin: 0, slide: 0, placed: 0,
  })
  for (const [index, child] of entities.children.slice(0, 3).entries()) {
    assert.equal(child.name, `feature/sweep-demo/phase/${index}`)
    assert.deepEqual(child.components?.feature_sweep_phase, {
      owner: 3, index, at_s: [0, 1.25, 2][index], pattern: [0, 2, 1][index],
      height_m: index === 0 ? 0.7 : 0.5, gap_m: 2, speed_deg_s: 90, speed_mps: 3,
    })
  }
  for (const [index, child] of entities.children.slice(3).entries()) {
    assert.equal(child.name, `feature/sweep-demo/part/${index}`)
    assert.deepEqual(child.body, { type: 'kinematic_position' })
    assert.deepEqual(child.components?.['ege.transform']?.pos, [2, 3, 4])
    assert.deepEqual(child.colliders, [{ shape: 'box', half_extents: [1, 1, 1], group: 'moving' }])
    assert.deepEqual(child.components?.['ege.box_collider'], { half_extents: [1, 1, 1] })
    assert.deepEqual(child.components?.feature_sweep_part, { owner: 3, index, half: [1, 1, 1] })
    assert.deepEqual(child.components?.['ege.render'], { shape: 1, color: 0xE04F5F, params: [1, 1, 1, 0], visible: 1 })
    assert.equal(child.components?.['ege.body_props']?.colliders_enabled, 1)
  }
  assert.equal(entities.children.length, 5)
  const emitted = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(emitted.text) >= 1)
  assert.ok(emitted.index('feature/sweep-demo/part/0') > emitted.index('feature/sweep-demo/phase/2'))
  const laser = { ...spec, params: { ...spec.params, phases: [{ atS: 0 }, { atS: 1 }] } }
  assert.equal(FEATURE_EMITTERS.sweep(laser, ctx).root.components?.feature_sweep.part_count, 1)
  assert.equal(FEATURE_EMITTERS.sweep(laser, ctx).children.length, 3)
})

test('sweep rejects invalid phase order and jump or walk gaps', async () => {
  const spec: FeatureSpec = { id: 'invalid', kind: 'sweep', params: {
    center: [0, 0, 0], lengthM: 8, telegraphS: 0, pattern: 'laser', heightM: 0.5,
    gapM: 2, speedDegS: 90, phases: [{ atS: 0 }],
  } }
  const { input } = await inputWith([spec])
  const ctx = { course: input.course.sim!, index: 0, path: 'course', assets: input.assets }
  const invalid = (phases: unknown[], message: string) => {
    const candidate = { ...spec, params: { ...spec.params, phases } }
    assert.throws(() => FEATURE_EMITTERS.sweep(candidate, ctx),
      (error: unknown) => error instanceof RefusalError && error.message.includes(message))
  }
  invalid([{ atS: 1 }], '/atS: expected phases starting at 0')
  invalid([{ atS: 0 }, { atS: 0 }], '/atS: expected phases starting at 0')
  invalid([{ atS: 0 }, { atS: 0.001 }, { atS: 0.002 }], '/atS: expected phases starting at 0')
  invalid([{ atS: 0, heightM: 0.8 }], '/heightM: expected low bar top')
  invalid([{ atS: 0, pattern: 'bars', gapM: 1 }], '/gapM: expected heightM + gapM')
  invalid([{ atS: 0, pattern: 'block', gapM: 1, speedMps: 1 }], '/gapM: expected a walk-through gap')
  invalid([{ atS: 0, pattern: 'block', gapM: 8, speedMps: 1 }], '/gapM: expected a walk-through gap')
})

test('memoryTiles emits a 4x4 cell pool with zero cycle symbols, eight seats and cells+1 markers', async () => {
  const spec: FeatureSpec = {
    id: 'memory-demo', kind: 'memoryTiles', params: {
      origin: [2, 3, 4], cols: 4, rows: 4, cellM: 2, symbols: 4, cycles: 3,
      revealS: 1, hideS: 0.5, choiceS: 2, penaltyS: 0.25,
    },
  }
  const { input } = await inputWith([spec])
  const ctx = { course: input.course.sim!, index: 3, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets }
  const entities = FEATURE_EMITTERS.memoryTiles(spec, ctx)
  assert.deepEqual(entities.root.components?.feature_memory_tiles, {
    origin: [2, 3, 4], cols: 4, rows: 4, cell_m: 2, symbols: 4, cycles: 3,
    reveal_s: 1, hide_s: 0.5, choice_s: 2, penalty_s: 0.25,
    target: 0, cycle: -1, phase: 0, choice_start_tick: 0, finalized: 0, placed: 0,
  })
  assert.equal(entities.children.length, 16 + 3 + 8 + 17)
  for (let index = 0; index < 16; index++) {
    const cell = entities.children[index]!
    assert.equal(cell.name, `feature/memory-demo/cell/${index}`)
    assert.deepEqual(cell.body, { type: 'fixed' })
    assert.deepEqual(cell.colliders, [{ shape: 'box', half_extents: [1, 1, 1], group: 'static' }])
    assert.deepEqual(cell.components?.['ege.transform'], { pos: [2, 3, 4], rot: [0, 0, 0, 1] })
    assert.deepEqual(cell.components?.['ege.box_collider'], { half_extents: [1, 1, 1] })
    assert.equal(cell.components?.['ege.body_props']?.colliders_enabled, 1)
    assert.deepEqual(cell.components?.feature_memory_tiles_cell, {
      owner: 3, index, t: [2, 3, 4], half: [1, 1, 1], state: 0, timer: 0, symbol: 0,
      cycle_symbols: Array(16).fill(0), cycle_symbols_tail: Array(4).fill(0),
    })
  }
  for (let index = 0; index < 3; index++) {
    const cycle = entities.children[16 + index]!
    assert.equal(cycle.name, `feature/memory-demo/cycle/${index}`)
    assert.deepEqual(cycle.components?.feature_memory_tiles_cycle, { owner: 3, index, target: 0 })
  }
  for (let index = 0; index < 8; index++) {
    const seat = entities.children[16 + 3 + index]!
    assert.equal(seat.name, `feature/memory-demo/seat/${index}`)
    assert.deepEqual(seat.components?.feature_memory_tiles_seat, {
      owner: 3, seat: index, first_correct_tick: -1,
    })
  }
  for (let index = 0; index < 17; index++) {
    const marker = entities.children[16 + 3 + 8 + index]!
    assert.equal(marker.name, `feature/memory-demo/marker/${index}`)
    assert.equal(marker.body, undefined)
    assert.equal(marker.colliders, undefined)
    assert.deepEqual(marker.components?.['ege.transform']?.pos, [2, 3, 4])
    assert.equal(marker.components?.['ege.render']?.visible, 0)
    assert.deepEqual(marker.components?.feature_memory_tiles_marker, { owner: 3, index })
  }
  const emitted = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(emitted.text) >= 1)
  assert.equal(emitted.index('feature/memory-demo/cell/0'), emitted.index('feature/memory-demo') + 1)
})

test('memoryTiles emits a 256-cell pool with twenty cycle records and zero-filled split symbols', async () => {
  const spec: FeatureSpec = {
    id: 'memory-max', kind: 'memoryTiles', params: {
      origin: [0, 1, 0], cols: 16, rows: 16, cellM: 0.5, symbols: 6, cycles: 20,
      revealS: 2, hideS: 1, choiceS: 3,
    },
  }
  const { input } = await inputWith([spec])
  const ctx = { course: input.course.sim!, index: 0, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets }
  const entities = FEATURE_EMITTERS.memoryTiles(spec, ctx)
  assert.equal(entities.children.length, 256 + 20 + 8 + 257)
  assert.equal(entities.root.components?.feature_memory_tiles.penalty_s, 14)
  const cycles = entities.children.slice(256, 276)
  assert.equal(cycles.length, 20)
  assert.deepEqual(cycles.map(cycle => cycle.components?.feature_memory_tiles_cycle?.target), Array(20).fill(0))
  const cells = entities.children.slice(0, 256)
  for (const cell of cells) {
    const record = cell.components?.feature_memory_tiles_cell
    const cycleSymbols = record?.cycle_symbols as number[]
    const tail = record?.cycle_symbols_tail as number[]
    assert.equal(cycleSymbols.length, 16)
    assert.equal(tail.length, 4)
    assert.ok(cycleSymbols.every(value => value === 0))
    assert.ok(tail.every(value => value === 0))
  }
  assert.equal(cells[255]?.components?.feature_memory_tiles_cell?.index, 255)
  const markers = entities.children.slice(256 + 20 + 8)
  assert.equal(markers.length, 257)
  assert.equal(markers[256]?.name, 'feature/memory-max/marker/256')
  const emitted = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(emitted.text) >= 1)
})

test('memoryTiles refuses a pool over 256 cells with the engine-pool message', async () => {
  const spec: FeatureSpec = {
    id: 'too-big', kind: 'memoryTiles', params: {
      origin: [0, 0, 0], cols: 17, rows: 16, cellM: 1, symbols: 4, cycles: 1,
      revealS: 1, hideS: 1, choiceS: 1,
    },
  }
  const { input } = await inputWith([spec])
  const path = 'fixtures/ege/ege-strip.course.json'
  const ctx = { course: input.course.sim!, index: 2, path, assets: input.assets }
  assert.throws(() => FEATURE_EMITTERS.memoryTiles(spec, ctx), (error: unknown) =>
    error instanceof RefusalError && error.message ===
      `[ege-scene] ${path}#/features/2/cols: memoryTiles of more than 256 cells has no engine pool in part 1; use at most 256 cells`)
})

test('risingKill emits a plane and clock visual pair with owner indices and source defaults', async () => {
  const spec: FeatureSpec = {
    id: 'rise-demo', kind: 'risingKill', params: {
      startY: -4, endY: 20, startS: 5, riseMps: 0.5, clock: { t: [3, 6, -2] },
    },
  }
  const { input } = await inputWith([spec])
  const entities = FEATURE_EMITTERS.risingKill(spec, {
    course: input.course.sim!, index: 4, path: 'fixtures/ege/ege-strip.course.json', assets: input.assets,
  })
  assert.equal(entities.root.name, 'feature/rise-demo')
  assert.deepEqual(entities.root.components?.feature, { kind: 13, index: 4, salt: 0x104 })
  assert.deepEqual(entities.root.components?.feature_rising_kill, {
    start_y: -4, end_y: 20, start_s: 5, rise_mps: 0.5, clock: [3, 6, -2], half_m: 30,
    overtime_ticks: 0, kill_y: -4, left_s: 0, fraction: 1, rising: 0, placed: 0,
  })
  assert.deepEqual(entities.root.components?.['ege.transform'], { pos: [3, 6, -2], rot: [0, 0, 0, 1] })
  assert.deepEqual(entities.children.map(child => child.name), ['feature/rise-demo/visual/0', 'feature/rise-demo/visual/1'])
  const [plane, clock] = entities.children
  assert.deepEqual(plane?.components?.['ege.transform'], { pos: [3, -4, -2], rot: [0, 0, 0, 1] })
  assert.deepEqual(plane?.components?.['ege.render'], { shape: 1, color: 0xF5D0E0, visible: 1, params: [15, 0.5, 15, 0] })
  assert.deepEqual(plane?.components?.feature_rising_kill_visual, { owner: 4, index: 0 })
  assert.deepEqual(clock?.components?.['ege.transform'], { pos: [3, 6, -2], rot: [0, 0, 0, 1] })
  assert.deepEqual(clock?.components?.['ege.render'], { shape: 4, color: 0xF2E6D0, visible: 1, params: [1, 0.05, 0, 0] })
  assert.deepEqual(clock?.components?.feature_rising_kill_visual, { owner: 4, index: 1 })
  const emitted = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(emitted.text) >= 1)
  assert.equal(emitted.index('feature/rise-demo/visual/0'), emitted.index('feature/rise-demo') + 1)
})

test('risingKill keeps an explicit halfM and refuses an end height at or below the start', async () => {
  const wide: FeatureSpec = {
    id: 'wide', kind: 'risingKill', params: { startY: 0, endY: 9, startS: 0, riseMps: 1, halfM: 12, clock: { t: [0, 0, 0] } },
  }
  const { input } = await inputWith([wide])
  const path = 'fixtures/ege/ege-strip.course.json'
  const entities = FEATURE_EMITTERS.risingKill(wide, { course: input.course.sim!, index: 0, path, assets: input.assets })
  assert.equal(entities.root.components?.feature_rising_kill?.half_m, 12)
  const flat: FeatureSpec = {
    id: 'flat', kind: 'risingKill', params: { startY: 5, endY: 5, startS: 0, riseMps: 1, clock: { t: [0, 0, 0] } },
  }
  assert.throws(() => FEATURE_EMITTERS.risingKill(flat, { course: input.course.sim!, index: 1, path, assets: input.assets }),
    (error: unknown) => error instanceof RefusalError && error.message.includes('/endY: expected endY > startY (5)'))
})
