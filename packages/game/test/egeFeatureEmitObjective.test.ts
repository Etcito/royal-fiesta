import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { FEATURE_KINDS } from '@royal-fiesta/sim/features/catalog'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { FEATURE_EMITTERS } from '../src/ege/featureEmitters.ts'
import { emitEngineScene } from '../src/ege/sceneEmitter.ts'
import { focusCamera } from '../src/ege/sceneSim.ts'
import type { EmitInput } from '../src/ege/sceneEmitter.ts'
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
const PATH = 'fixtures/ege/ege-strip.course.json'

async function inputWith(specs: FeatureSpec[]): Promise<EmitInput> {
  const loaded = await loadCourseV1(readJson(PATH), PATH, assets)
  const course: CourseV1 = structuredClone(loaded)
  assert.ok(course.sim)
  course.sim.features = specs
  const resolved = new Map<string, ResolvedGameAsset>()
  for (const id of course.assetIds) resolved.set(id, await assets.resolve(id))
  return { course, assets: resolved, setup: { profile: 'sprint', seed: 7 } }
}

const ctxOf = (input: EmitInput, index: number) => ({
  course: input.course.sim!, index, path: PATH, assets: input.assets,
})

const demo: FeatureSpec = {
  id: 'carry-demo', kind: 'carryItem', params: {
    asset: 'candy.floor-disc',
    spawns: [[1, 0.35, 2], [3, 0.35, 4]],
    resetS: 8,
    homes: [
      { center: [0, 1.5, 10], half: [2, 1, 2], team: null },
      { center: [0, 1.5, 20], half: [3, 1, 3], team: 1 },
    ],
  },
}

test('carryItem records carry their declared fields within 256 bytes', () => {
  const components = schemaLayout(engine).components
  const layout = (name: string) => {
    const component = components.find((entry) => entry.name === name)
    assert.ok(component, `${name} is declared`)
    return {
      size: component.size,
      fields: component.fields.map((field) => [field.name, field.type, field.count]),
    }
  }
  const root = layout('feature_carry_item')
  assert.deepEqual(root.fields, [['reset_s', 'f64', 1], ['placed', 'u32', 1]])
  assert.ok(root.size <= 256, `feature_carry_item is ${root.size} bytes`)
  const item = layout('feature_carry_item_item')
  assert.deepEqual(item.fields, [
    ['owner', 'u32', 1], ['index', 'u32', 1], ['spawn', 'f64', 3], ['holder', 'i32', 1],
    ['last_touch_tick', 'i32', 1], ['last_hand', 'f64', 3],
  ])
  assert.ok(item.size <= 256, `feature_carry_item_item is ${item.size} bytes`)
  const home = layout('feature_carry_item_home')
  assert.deepEqual(home.fields, [
    ['owner', 'u32', 1], ['index', 'u32', 1], ['center', 'f64', 3], ['half', 'f64', 3],
    ['team', 'i32', 1],
  ])
  assert.ok(home.size <= 256, `feature_carry_item_home is ${home.size} bytes`)
  const seat = layout('feature_carry_item_seat')
  assert.deepEqual(seat.fields, [['owner', 'u32', 1], ['seat', 'u32', 1], ['prev_grab', 'u32', 1]])
  assert.ok(seat.size <= 256, `feature_carry_item_seat is ${seat.size} bytes`)
})

test('carryItem emits spawn items, homes and eight seats at their authored values', async () => {
  const input = await inputWith([demo])
  const emitted = FEATURE_EMITTERS.carryItem(demo, ctxOf(input, 3))
  assert.equal(emitted.root.name, 'feature/carry-demo')
  assert.deepEqual(emitted.root.components?.feature, { kind: 7, index: 3, salt: 0x103 })
  assert.deepEqual(emitted.root.components?.feature_carry_item, { reset_s: 8, placed: 0 })
  assert.deepEqual(emitted.root.components?.['ege.transform'], { pos: [0, 0, 0], rot: [0, 0, 0, 1] })
  assert.deepEqual(emitted.children.map((child) => child.name), [
    'feature/carry-demo/item/0', 'feature/carry-demo/item/1',
    'feature/carry-demo/home/0', 'feature/carry-demo/home/1',
    'feature/carry-demo/seat/0', 'feature/carry-demo/seat/1', 'feature/carry-demo/seat/2',
    'feature/carry-demo/seat/3', 'feature/carry-demo/seat/4', 'feature/carry-demo/seat/5',
    'feature/carry-demo/seat/6', 'feature/carry-demo/seat/7',
  ])
  assert.equal(emitted.children.length, 12)
  const spawns = [[1, 0.35, 2], [3, 0.35, 4]]
  for (let index = 0; index < 2; index++) {
    const item = emitted.children[index]!
    assert.deepEqual(item.body, { type: 'dynamic' })
    assert.deepEqual(item.colliders, [{ shape: 'sphere', radius: 0.35, density: 0, group: 'debris' }])
    assert.deepEqual(item.components?.['ege.transform'], { pos: spawns[index], rot: [0, 0, 0, 1] })
    assert.equal(item.components?.['ege.body_props']?.additional_mass, 0)
    assert.deepEqual(item.components?.feature_carry_item_item, {
      owner: 3, index, spawn: spawns[index], holder: -1, last_touch_tick: 0, last_hand: spawns[index],
    })
  }
  assert.deepEqual(emitted.children[2]?.components?.feature_carry_item_home, {
    owner: 3, index: 0, center: [0, 1.5, 10], half: [2, 1, 2], team: -1,
  })
  assert.deepEqual(emitted.children[3]?.components?.feature_carry_item_home, {
    owner: 3, index: 1, center: [0, 1.5, 20], half: [3, 1, 3], team: 1,
  })
  for (let index = 0; index < 8; index++) {
    assert.deepEqual(emitted.children[4 + index]?.components?.feature_carry_item_seat, {
      owner: 3, seat: index, prev_grab: 0,
    })
  }
  const scene = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(scene.text) >= 1)
  assert.equal(scene.index('feature/carry-demo/item/0'), scene.index('feature/carry-demo') + 1)
  assert.ok(scene.index('feature/carry-demo/seat/0') > scene.index('feature/carry-demo/home/1'))
  const built = scene.scene.entities[scene.index('feature/carry-demo/item/0')]
  assert.equal(built?.colliders?.[0]?.shape, 'sphere')
  assert.equal(built?.colliders?.[0]?.density, 0)
  assert.equal(built?.colliders?.[0]?.radius, 0.35)
})

test('carryItem refuses spawn and home counts and teams outside the source ranges', async () => {
  const input = await inputWith([demo])
  const ctx = ctxOf(input, 0)
  const refused = (params: Record<string, unknown>, message: string) => {
    const bad = { ...demo, params } as FeatureSpec
    assert.throws(() => FEATURE_EMITTERS.carryItem(bad, ctx),
      (error: unknown) => error instanceof RefusalError && error.message.includes(message))
  }
  refused({ ...demo.params, spawns: [] }, '/spawns: expected 1..16 spawns entries, got 0')
  refused({ ...demo.params, spawns: Array.from({ length: 17 }, () => [0, 0.35, 0]) },
    '/spawns: expected 1..16 spawns entries, got 17')
  refused({ ...demo.params, homes: Array.from({ length: 5 }, () => ({ center: [0, 0, 0], half: [1, 1, 1], team: null })) },
    '/homes: expected 0..4 homes entries, got 5')
  refused({ ...demo.params, homes: [{ center: [0, 0, 0], half: [1, 1, 1], team: 2 }] },
    '/homes/0/team: expected team 0, 1 or null')
  refused({ ...demo.params, asset: 'Not An Asset' }, '/asset: expected asset matching')
})

test('carryItem accepts no homes and emits only items and seats', async () => {
  const spec: FeatureSpec = { ...demo, params: { ...demo.params, homes: [] } }
  const input = await inputWith([spec])
  const emitted = FEATURE_EMITTERS.carryItem(spec, ctxOf(input, 1))
  assert.equal(emitted.children.length, 2 + 8)
  assert.equal(emitted.children[2]?.name, 'feature/carry-demo/seat/0')
  assert.ok(engine.createWorld(emitEngineScene(engine, input).text) >= 1)
})

const goalDemo: FeatureSpec = {
  id: 'goal-demo', kind: 'goal', params: { team: 0, center: [0, 1.5, 40], half: [4, 1.5, 0.5] },
}

test('goal records carry team, centre and half extents within 256 bytes', () => {
  const component = schemaLayout(engine).components.find((entry) => entry.name === 'feature_goal')
  assert.ok(component, 'feature_goal is declared')
  assert.deepEqual(
    component.fields.map((field) => [field.name, field.type, field.count]),
    [['team', 'u32', 1], ['center', 'f64', 3], ['half', 'f64', 3]],
  )
  assert.ok(component.size <= 256, `feature_goal is ${component.size} bytes`)
})

test('goal emits a bodyless root with the source box and a tinted wall-block visual', async () => {
  const input = await inputWith([goalDemo])
  const emitted = FEATURE_EMITTERS.goal(goalDemo, ctxOf(input, 4))
  assert.equal(emitted.root.name, 'feature/goal-demo')
  assert.equal(emitted.root.body, undefined)
  assert.deepEqual(emitted.root.components?.feature, { kind: 15, index: 4, salt: 0x104 })
  assert.deepEqual(emitted.root.components?.feature_goal, { team: 0, center: [0, 1.5, 40], half: [4, 1.5, 0.5] })
  assert.deepEqual(emitted.root.components?.['ege.transform'], { pos: [0, 1.5, 40], rot: [0, 0, 0, 1] })
  assert.equal(emitted.children.length, 1)
  const visual = emitted.children[0]!
  assert.equal(visual.name, 'feature/goal-demo/visual/0')
  assert.equal(visual.body, undefined)
  assert.equal(visual.colliders, undefined)
  assert.deepEqual(visual.components?.['ege.transform'], { pos: [0, 1.5, 40], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.render'], {
    shape: 1, color: 0x54BAFF, visible: 1, params: [4, 1.5, 0.5, 0],
  })
})

test('goal tint follows the defending team: team 1 is the yellow tint', async () => {
  const spec: FeatureSpec = { ...goalDemo, params: { ...goalDemo.params, team: 1 } }
  const input = await inputWith([spec])
  const emitted = FEATURE_EMITTERS.goal(spec, ctxOf(input, 0))
  assert.deepEqual(emitted.root.components?.feature_goal, { team: 1, center: [0, 1.5, 40], half: [4, 1.5, 0.5] })
  assert.equal(emitted.children[0]?.components?.['ege.render']?.color, 0xFFD140)
})

test('goal refuses a defending team other than 0 or 1 and a non-positive half', async () => {
  const input = await inputWith([goalDemo])
  const ctx = ctxOf(input, 0)
  const refused = (params: Record<string, unknown>, message: string) => {
    const bad = { ...goalDemo, params } as FeatureSpec
    assert.throws(() => FEATURE_EMITTERS.goal(bad, ctx),
      (error: unknown) => error instanceof RefusalError && error.message.includes(message))
  }
  refused({ ...goalDemo.params, team: 2 }, '/team: expected team 0 or 1')
  refused({ ...goalDemo.params, team: '0' }, '/team: expected team 0 or 1')
  refused({ center: [0, 1.5, 40], half: [4, 1.5, 0.5] }, '/team: expected team 0 or 1')
  refused({ ...goalDemo.params, half: [4, 0, 0.5] }, '/half: expected half extents > 0')
})

test('goal scene builds a world with the goal root and visual as entities', async () => {
  const input = await inputWith([goalDemo])
  const scene = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(scene.text) >= 1)
  assert.equal(scene.index('feature/goal-demo/visual/0'), scene.index('feature/goal-demo') + 1)
})

const ballDemo: FeatureSpec = {
  id: 'ball-demo', kind: 'ball', params: { spawn: [1, 2, 3], radius: 1.25, mass: 42, resetS: 9 },
}

test('ball record declares the source parameters and initial state in order', () => {
  const component = schemaLayout(engine).components.find((entry) => entry.name === 'feature_ball')
  assert.ok(component)
  assert.deepEqual(component.fields.map((field) => [field.name, field.type, field.count]), [
    ['spawn', 'f64', 3], ['radius', 'f64', 1], ['mass', 'f64', 1], ['reset_s', 'f64', 1],
    ['pending', 'i32', 1], ['anchor_tick', 'i32', 1], ['anchor', 'f64', 3], ['placed', 'u32', 1],
  ])
  assert.ok(component.size <= 256)
})

test('ball emits a CCD dynamic sphere with source mass, exact groups and initial state', async () => {
  const input = await inputWith([ballDemo])
  const emitted = FEATURE_EMITTERS.ball(ballDemo, ctxOf(input, 3))
  assert.equal(emitted.root.name, 'feature/ball-demo')
  assert.deepEqual(emitted.children, [])
  assert.deepEqual(emitted.root.body, { type: 'dynamic', ccd: true })
  assert.deepEqual(emitted.root.colliders, [{ shape: 'sphere', radius: 1.25, density: 0, group: 'moving' }])
  assert.deepEqual(emitted.root.components?.feature, { kind: 14, index: 3, salt: 0x103 })
  assert.deepEqual(emitted.root.components?.feature_ball, {
    spawn: [1, 2, 3], radius: 1.25, mass: 42, reset_s: 9,
    pending: -1, anchor_tick: 0, anchor: [1, 2, 3], placed: 0,
  })
  assert.deepEqual(emitted.root.components?.['ege.transform'], { pos: [1, 2, 3], rot: [0, 0, 0, 1] })
  assert.deepEqual(emitted.root.components?.['ege.render'], { shape: 0 })
  assert.deepEqual(emitted.root.components?.['ege.body_props'], {
    lock_rotations: 0, additional_mass: 42, friction_combine: 0,
    groups_override: 1, memberships: 2, filter: 15, colliders_enabled: 1,
  })
  const scene = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(scene.text) >= 1)
  const built = scene.scene.entities[scene.index('feature/ball-demo')]
  assert.equal(built?.body?.type, 'dynamic')
  assert.equal(built?.body?.ccd, true)
  assert.equal(built?.colliders?.[0]?.radius, 1.25)
  assert.equal(built?.colliders?.[0]?.density, 0)
})

test('ball accepts source range endpoints and refuses missing or out-of-range parameters', async () => {
  const input = await inputWith([ballDemo])
  const ctx = ctxOf(input, 0)
  for (const [key, min, max] of [['radius', 0.3, 3], ['mass', 0.1, 500], ['resetS', 1, 120]] as const) {
    for (const value of [min, max]) {
      const spec = { ...ballDemo, params: { ...ballDemo.params, [key]: value } }
      assert.doesNotThrow(() => FEATURE_EMITTERS.ball(spec, ctx))
    }
    for (const value of [min - 0.01, max + 0.01, undefined]) {
      const spec = { ...ballDemo, params: { ...ballDemo.params, [key]: value } } as FeatureSpec
      assert.throws(() => FEATURE_EMITTERS.ball(spec, ctx),
        (error: unknown) => error instanceof RefusalError && error.message.includes(`/${key}`))
    }
  }
  const missingSpawn = { ...ballDemo, params: { ...ballDemo.params, spawn: undefined } } as FeatureSpec
  assert.throws(() => FEATURE_EMITTERS.ball(missingSpawn, ctx),
    (error: unknown) => error instanceof RefusalError && error.message.includes('/spawn'))
})

function layoutOf(name: string): { size: number; fields: unknown[][] } {
  const component = schemaLayout(engine).components.find((entry) => entry.name === name)
  assert.ok(component, `${name} is declared`)
  return {
    size: component.size,
    fields: component.fields.map((field) => [field.name, field.type, field.count]),
  }
}

const collectibleDemo: FeatureSpec = {
  id: 'collectible-demo', kind: 'collectible', params: {
    spots: [[1, 1, 2], [3, 1, 4], [-2, 1.5, 9]],
    value: 5,
    regenS: 12,
  },
}

test('collectible records carry value, regen and spot fields within 256 bytes', () => {
  const root = layoutOf('feature_collectible')
  assert.deepEqual(root.fields, [['value', 'u32', 1], ['regen_s', 'f64', 1]])
  assert.ok(root.size <= 256, `feature_collectible is ${root.size} bytes`)
  const spot = layoutOf('feature_collectible_spot')
  assert.deepEqual(spot.fields, [
    ['owner', 'u32', 1], ['index', 'u32', 1], ['t', 'f64', 3], ['ready_tick', 'i32', 1],
  ])
  assert.ok(spot.size <= 256, `feature_collectible_spot is ${spot.size} bytes`)
})

test('collectible emits a bodyless root and one sphere spot child per authored position', async () => {
  const input = await inputWith([collectibleDemo])
  const emitted = FEATURE_EMITTERS.collectible(collectibleDemo, ctxOf(input, 5))
  assert.equal(emitted.root.name, 'feature/collectible-demo')
  assert.equal(emitted.root.body, undefined)
  assert.equal(emitted.root.colliders, undefined)
  assert.deepEqual(emitted.root.components?.feature, { kind: 16, index: 5, salt: 0x105 })
  assert.deepEqual(emitted.root.components?.feature_collectible, { value: 5, regen_s: 12 })
  assert.deepEqual(emitted.root.components?.['ege.transform'], { pos: [0, 0, 0], rot: [0, 0, 0, 1] })
  assert.deepEqual(emitted.children.map((child) => child.name), [
    'feature/collectible-demo/spot/0', 'feature/collectible-demo/spot/1', 'feature/collectible-demo/spot/2',
  ])
  const spots = [[1, 1, 2], [3, 1, 4], [-2, 1.5, 9]]
  for (let index = 0; index < spots.length; index++) {
    const child = emitted.children[index]!
    assert.equal(child.body, undefined)
    assert.equal(child.colliders, undefined)
    assert.deepEqual(child.components?.feature_collectible_spot, {
      owner: 5, index, t: spots[index], ready_tick: 0,
    })
    assert.deepEqual(child.components?.['ege.transform'], { pos: spots[index], rot: [0, 0, 0, 1] })
    assert.deepEqual(child.components?.['ege.render'], {
      shape: 2, color: 0xF2E6D0, visible: 1, params: [0.3, 0, 0, 0],
    })
  }
})

test('collectible pool size equals the authored spot count at both list endpoints', async () => {
  const input = await inputWith([collectibleDemo])
  const ctx = ctxOf(input, 0)
  const one: FeatureSpec = {
    ...collectibleDemo, params: { spots: [[0, 0, 0]], value: 1, regenS: 0.1 },
  }
  const oneEmitted = FEATURE_EMITTERS.collectible(one, ctx)
  assert.equal(oneEmitted.children.length, 1)
  assert.deepEqual(oneEmitted.root.components?.feature_collectible, { value: 1, regen_s: 0.1 })
  const full: FeatureSpec = {
    ...collectibleDemo,
    params: { spots: Array.from({ length: 64 }, (_, i) => [i, 1, 0]), value: 100, regenS: 600 },
  }
  const fullEmitted = FEATURE_EMITTERS.collectible(full, ctx)
  assert.equal(fullEmitted.children.length, 64)
  assert.equal(fullEmitted.children[63]?.name, 'feature/collectible-demo/spot/63')
  assert.deepEqual(fullEmitted.children[63]?.components?.feature_collectible_spot, {
    owner: 0, index: 63, t: [63, 1, 0], ready_tick: 0,
  })
  assert.deepEqual(fullEmitted.root.components?.feature_collectible, { value: 100, regen_s: 600 })
})

test('collectible refuses spot counts, positions, value and regen outside the source ranges', async () => {
  const input = await inputWith([collectibleDemo])
  const ctx = ctxOf(input, 0)
  const refused = (params: Record<string, unknown>, message: string) => {
    const bad = { ...collectibleDemo, params } as FeatureSpec
    assert.throws(() => FEATURE_EMITTERS.collectible(bad, ctx),
      (error: unknown) => error instanceof RefusalError && error.message.includes(message))
  }
  refused({ ...collectibleDemo.params, spots: [] }, '/spots: expected 1..64 spots entries, got 0')
  refused({ ...collectibleDemo.params, spots: Array.from({ length: 65 }, () => [0, 1, 0]) },
    '/spots: expected 1..64 spots entries, got 65')
  refused({ ...collectibleDemo.params, spots: [[1, 2]] }, '/spots/0: expected [x,y,z] in metres')
  refused({ ...collectibleDemo.params, value: 0 }, '/value: expected value as a finite number in 1..100')
  refused({ ...collectibleDemo.params, value: 101 }, '/value: expected value as a finite number in 1..100')
  refused({ ...collectibleDemo.params, value: 2.5 }, '/value: expected value as a whole number in 1..100')
  refused({ ...collectibleDemo.params, regenS: 0.05 }, '/regenS: expected regenS as a finite number in 0.1..600 s')
  refused({ ...collectibleDemo.params, regenS: 601 }, '/regenS: expected regenS as a finite number in 0.1..600 s')
  refused({ ...collectibleDemo.params, value: undefined }, '/value: missing value')
})

test('collectible scene builds a world with each spot visual after its root', async () => {
  const input = await inputWith([collectibleDemo])
  const scene = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(scene.text) >= 1)
  assert.equal(scene.index('feature/collectible-demo/spot/0'), scene.index('feature/collectible-demo') + 1)
  assert.equal(scene.index('feature/collectible-demo/spot/2'), scene.index('feature/collectible-demo') + 3)
})

const bankDemo: FeatureSpec = {
  id: 'bank-demo', kind: 'bank', params: { center: [2, 1.5, 30], half: [3, 1.5, 2], team: null },
}

test('bank records carry centre, half and i32 team within 256 bytes', () => {
  const root = layoutOf('feature_bank')
  assert.deepEqual(root.fields, [['center', 'f64', 3], ['half', 'f64', 3], ['team', 'i32', 1]])
  assert.ok(root.size <= 256, `feature_bank is ${root.size} bytes`)
  const inside = layoutOf('feature_bank_inside')
  assert.deepEqual(inside.fields, [['owner', 'entity', 1], ['item', 'entity', 1], ['team', 'i32', 1]])
  assert.ok(inside.size <= 256, `feature_bank_inside is ${inside.size} bytes`)
})

test('bank emits a bodyless root and a neutral wall-block visual with empty inside state', async () => {
  const input = await inputWith([bankDemo])
  const emitted = FEATURE_EMITTERS.bank(bankDemo, ctxOf(input, 2))
  assert.equal(emitted.root.name, 'feature/bank-demo')
  assert.equal(emitted.root.body, undefined)
  assert.equal(emitted.root.colliders, undefined)
  assert.deepEqual(emitted.root.components?.feature, { kind: 17, index: 2, salt: 0x102 })
  assert.deepEqual(emitted.root.components?.feature_bank, {
    center: [2, 1.5, 30], half: [3, 1.5, 2], team: -1,
  })
  assert.deepEqual(emitted.root.components?.['ege.transform'], { pos: [2, 1.5, 30], rot: [0, 0, 0, 1] })
  assert.equal(emitted.children.length, 1)
  const visual = emitted.children[0]!
  assert.equal(visual.name, 'feature/bank-demo/visual/0')
  assert.equal(visual.body, undefined)
  assert.equal(visual.colliders, undefined)
  assert.deepEqual(visual.components?.['ege.transform'], { pos: [2, 1.5, 30], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.render'], {
    shape: 1, color: 0xE8C39E, visible: 1, params: [3, 1.5, 2, 0],
  })
})

test('bank team banks use the source tint and keep the authored box dimensions', async () => {
  for (const [team, color] of [[0, 0x54BAFF], [1, 0xFFD140]] as const) {
    const spec: FeatureSpec = { ...bankDemo, params: { ...bankDemo.params, team } }
    const input = await inputWith([spec])
    const emitted = FEATURE_EMITTERS.bank(spec, ctxOf(input, 6))
    assert.deepEqual(emitted.root.components?.feature_bank, {
      center: [2, 1.5, 30], half: [3, 1.5, 2], team,
    })
    assert.equal(emitted.children[0]?.components?.['ege.render']?.color, color)
    assert.deepEqual(emitted.children[0]?.components?.['ege.render']?.params, [3, 1.5, 2, 0])
  }
})

test('bank refuses an invalid team and a non-positive half', async () => {
  const input = await inputWith([bankDemo])
  const ctx = ctxOf(input, 0)
  const refused = (params: Record<string, unknown>, message: string) => {
    const bad = { ...bankDemo, params } as FeatureSpec
    assert.throws(() => FEATURE_EMITTERS.bank(bad, ctx),
      (error: unknown) => error instanceof RefusalError && error.message.includes(message))
  }
  refused({ ...bankDemo.params, team: 2 }, '/team: expected team 0, 1 or null')
  refused({ ...bankDemo.params, team: '0' }, '/team: expected team 0, 1 or null')
  refused({ ...bankDemo.params, team: undefined }, '/team: expected team 0, 1 or null')
  refused({ ...bankDemo.params, half: [3, 0, 2] }, '/half: expected half extents > 0')
})

test('bank scene builds a world with only the root and visual entities', async () => {
  const input = await inputWith([bankDemo])
  const scene = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(scene.text) >= 1)
  assert.equal(scene.index('feature/bank-demo/visual/0'), scene.index('feature/bank-demo') + 1)
  const root = scene.scene.entities[scene.index('feature/bank-demo')]
  assert.equal(root?.body, undefined)
  const inside = scene.scene.entities.filter((entity) => {
    const name = entity.name ?? ''
    return name.startsWith('feature/bank-demo/') && name !== 'feature/bank-demo/visual/0'
  })
  assert.deepEqual(inside, [])
})

const captureDemo: FeatureSpec = {
  id: 'capture-demo', kind: 'captureZone', params: { center: [2, 1, 30], half: [4, 2, 4], captureS: 3 },
}

test('captureZone records carry the source box, capture seconds and initial state in order', () => {
  const root = layoutOf('feature_capture_zone')
  assert.deepEqual(root.fields, [
    ['center', 'f64', 3], ['half', 'f64', 3], ['capture_s', 'f64', 1], ['owner', 'i32', 1],
    ['progress_team', 'i32', 1], ['progress', 'u32', 1], ['owned_ticks', 'u32', 1],
  ])
  assert.ok(root.size <= 256, `feature_capture_zone is ${root.size} bytes`)
  const visual = layoutOf('feature_capture_zone_visual')
  assert.deepEqual(visual.fields, [['owner', 'u32', 1], ['index', 'u32', 1]])
  assert.ok(visual.size <= 256, `feature_capture_zone_visual is ${visual.size} bytes`)
})

test('captureZone emits a bodyless root with neutral ownership and one floor-disc visual child', async () => {
  const input = await inputWith([captureDemo])
  const emitted = FEATURE_EMITTERS.captureZone(captureDemo, ctxOf(input, 3))
  assert.equal(emitted.root.name, 'feature/capture-demo')
  assert.equal(emitted.root.body, undefined)
  assert.equal(emitted.root.colliders, undefined)
  assert.deepEqual(emitted.root.components?.feature, { kind: 18, index: 3, salt: 0x103 })
  assert.deepEqual(emitted.root.components?.feature_capture_zone, {
    center: [2, 1, 30], half: [4, 2, 4], capture_s: 3,
    owner: -1, progress_team: -1, progress: 0, owned_ticks: 0,
  })
  assert.deepEqual(emitted.root.components?.['ege.transform'], { pos: [2, 1, 30], rot: [0, 0, 0, 1] })
  assert.equal(emitted.children.length, 1)
  const visual = emitted.children[0]!
  assert.equal(visual.name, 'feature/capture-demo/visual/0')
  assert.equal(visual.body, undefined)
  assert.equal(visual.colliders, undefined)
  assert.deepEqual(visual.components?.feature_capture_zone_visual, { owner: 3, index: 0 })
  assert.deepEqual(visual.components?.['ege.transform'], { pos: [2, 1, 30], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.render'], {
    shape: 4, color: 0xF2E6D0, visible: 1, params: [8, 2, 0, 0],
  })
})

test('captureZone stores capture_s in seconds at both source range endpoints', async () => {
  const input = await inputWith([captureDemo])
  const ctx = ctxOf(input, 0)
  for (const captureS of [0.5, 60]) {
    const spec: FeatureSpec = { ...captureDemo, params: { ...captureDemo.params, captureS } }
    const emitted = FEATURE_EMITTERS.captureZone(spec, ctx)
    assert.equal(emitted.root.components?.feature_capture_zone?.capture_s, captureS)
  }
})

test('captureZone refuses missing or out-of-range capture seconds, boxes and half extents', async () => {
  const input = await inputWith([captureDemo])
  const ctx = ctxOf(input, 0)
  const refused = (params: Record<string, unknown>, message: string) => {
    const bad = { ...captureDemo, params } as FeatureSpec
    assert.throws(() => FEATURE_EMITTERS.captureZone(bad, ctx),
      (error: unknown) => error instanceof RefusalError && error.message.includes(message))
  }
  refused({ center: [2, 1, 30], half: [4, 2, 4] }, '/captureS: missing captureS')
  refused({ ...captureDemo.params, captureS: 0.49 }, '/captureS: expected captureS as a finite number in 0.5..60 s')
  refused({ ...captureDemo.params, captureS: 61 }, '/captureS: expected captureS as a finite number in 0.5..60 s')
  refused({ ...captureDemo.params, center: undefined }, '/center: missing center')
  refused({ ...captureDemo.params, half: [4, 0, 4] }, '/half: expected half extents > 0')
})

test('captureZone scene builds a world with the root and its visual after it', async () => {
  const input = await inputWith([captureDemo])
  const scene = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(scene.text) >= 1)
  assert.equal(scene.index('feature/capture-demo/visual/0'), scene.index('feature/capture-demo') + 1)
  const root = scene.scene.entities[scene.index('feature/capture-demo')]
  assert.equal(root?.body, undefined)
  const visual = scene.scene.entities[scene.index('feature/capture-demo/visual/0')]
  assert.equal(visual?.body, undefined)
  assert.equal(visual?.colliders, undefined)
})

test('captureZone visual owner stays the course feature index while the root has no team owner', async () => {
  const input = await inputWith([captureDemo])
  const emitted = FEATURE_EMITTERS.captureZone(captureDemo, ctxOf(input, 0))
  assert.deepEqual(emitted.root.components?.feature, { kind: 18, index: 0, salt: 0x100 })
  assert.equal(emitted.root.components?.feature_capture_zone?.owner, -1)
  assert.equal(emitted.root.components?.feature_capture_zone?.progress_team, -1)
  assert.equal(emitted.children.length, 1)
  assert.deepEqual(emitted.children[0]?.components?.feature_capture_zone_visual, { owner: 0, index: 0 })
  assert.equal(emitted.children[0]?.components?.['ege.render']?.visible, 1)
})

const tailDemo: FeatureSpec = {
  id: 'tails-demo', kind: 'tailSet', params: { count: 'half', spawn: [0, 2, 0], immunityS: 2 },
}

test('tailSet records carry count, spawn, immunity and empty seat state in order', () => {
  const root = layoutOf('feature_tail_set')
  assert.deepEqual(root.fields, [
    ['count', 'i32', 1], ['spawn', 'f64', 3], ['immunity_s', 'f64', 1],
    ['assigned', 'u32', 1], ['free_tails', 'u32', 1],
  ])
  assert.ok(root.size <= 256, `feature_tail_set is ${root.size} bytes`)
  const seat = layoutOf('feature_tail_set_seat')
  assert.deepEqual(seat.fields, [
    ['owner', 'u32', 1], ['seat', 'u32', 1], ['has_tail', 'u32', 1],
    ['immune_until', 'i32', 1], ['prev_grab', 'u32', 1],
  ])
  assert.ok(seat.size <= 256, `feature_tail_set_seat is ${seat.size} bytes`)
})

test('tailSet emits half as -1, eight empty seats and a hidden floor-disc per seat', async () => {
  const input = await inputWith([tailDemo])
  const emitted = FEATURE_EMITTERS.tailSet(tailDemo, ctxOf(input, 3))
  assert.equal(emitted.root.name, 'feature/tails-demo')
  assert.equal(emitted.root.body, undefined)
  assert.equal(emitted.root.colliders, undefined)
  assert.deepEqual(emitted.root.components?.feature, { kind: 19, index: 3, salt: 0x103 })
  assert.deepEqual(emitted.root.components?.feature_tail_set, {
    count: -1, spawn: [0, 2, 0], immunity_s: 2, assigned: 0, free_tails: 0,
  })
  assert.deepEqual(emitted.root.components?.['ege.transform'], { pos: [0, 2, 0], rot: [0, 0, 0, 1] })
  assert.deepEqual(emitted.children.map((child) => child.name), [
    'feature/tails-demo/seat/0', 'feature/tails-demo/seat/1', 'feature/tails-demo/seat/2',
    'feature/tails-demo/seat/3', 'feature/tails-demo/seat/4', 'feature/tails-demo/seat/5',
    'feature/tails-demo/seat/6', 'feature/tails-demo/seat/7',
  ])
  for (let seat = 0; seat < 8; seat++) {
    const child = emitted.children[seat]!
    assert.equal(child.body, undefined)
    assert.equal(child.colliders, undefined)
    assert.deepEqual(child.components?.feature_tail_set_seat, {
      owner: 3, seat, has_tail: 0, immune_until: 0, prev_grab: 0,
    })
    assert.deepEqual(child.components?.['ege.transform'], { pos: [0, 2, 0], rot: [0, 0, 0, 1] })
    assert.deepEqual(child.components?.['ege.render'], {
      shape: 4, color: 0x73D966, visible: 0, params: [0.5, 0.06, 0, 0],
    })
  }
})

test('tailSet keeps an integer count 1..30 instead of half', async () => {
  const input = await inputWith([tailDemo])
  const ctx = ctxOf(input, 0)
  for (const count of [1, 30]) {
    const spec: FeatureSpec = { ...tailDemo, params: { ...tailDemo.params, count } }
    const emitted = FEATURE_EMITTERS.tailSet(spec, ctx)
    assert.equal(emitted.root.components?.feature_tail_set?.count, count)
    assert.equal(emitted.children.length, 8)
  }
})

test('tailSet refuses count values outside half or the 1..30 integer range', async () => {
  const input = await inputWith([tailDemo])
  const ctx = ctxOf(input, 0)
  const message = "/count: expected count as 'half' or an integer 1..30"
  const refused = (count: unknown) => {
    const spec = { ...tailDemo, params: { ...tailDemo.params, count } } as FeatureSpec
    assert.throws(() => FEATURE_EMITTERS.tailSet(spec, ctx),
      (error: unknown) => error instanceof RefusalError && error.message.includes(message))
  }
  refused(0)
  refused(31)
  refused(2.5)
  refused('all')
  refused(undefined)
})

test('tailSet stores immunity in seconds at both endpoints and refuses a missing value', async () => {
  const input = await inputWith([tailDemo])
  const ctx = ctxOf(input, 0)
  for (const immunityS of [0, 30]) {
    const spec: FeatureSpec = { ...tailDemo, params: { ...tailDemo.params, immunityS } }
    const emitted = FEATURE_EMITTERS.tailSet(spec, ctx)
    assert.equal(emitted.root.components?.feature_tail_set?.immunity_s, immunityS)
  }
  const refused = (params: Record<string, unknown>, text: string) => {
    const spec = { ...tailDemo, params } as FeatureSpec
    assert.throws(() => FEATURE_EMITTERS.tailSet(spec, ctx),
      (error: unknown) => error instanceof RefusalError && error.message.includes(text))
  }
  refused({ count: 'half', spawn: [0, 2, 0] }, '/immunityS: missing immunityS')
  refused({ ...tailDemo.params, immunityS: -0.1 }, '/immunityS: expected immunityS as a finite number in 0..30 s')
  refused({ ...tailDemo.params, immunityS: 30.1 }, '/immunityS: expected immunityS as a finite number in 0..30 s')
  refused({ count: 'half', immunityS: 2 }, '/spawn: missing spawn')
  refused({ ...tailDemo.params, spawn: [0, 2] }, '/spawn: expected [x,y,z] in metres')
})

test('tailSet scene builds a world with the root and its eight seat children', async () => {
  const input = await inputWith([tailDemo])
  const scene = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(scene.text) >= 1)
  assert.equal(scene.index('feature/tails-demo/seat/0'), scene.index('feature/tails-demo') + 1)
  assert.equal(scene.index('feature/tails-demo/seat/7'), scene.index('feature/tails-demo') + 8)
  const root = scene.scene.entities[scene.index('feature/tails-demo')]
  assert.equal(root?.body, undefined)
  const seat = scene.scene.entities[scene.index('feature/tails-demo/seat/0')]
  assert.equal(seat?.body, undefined)
  assert.equal(seat?.colliders, undefined)
  assert.equal(seat?.components?.['ege.render']?.visible, 0)
})

const crownDemo: FeatureSpec = { id: 'crown-demo', kind: 'crown', params: { t: [1, 2, 3], grabRangeM: 2 } }

test('crown records declare the root, seat and visual state', () => {
  for (const [name, fields] of [
    ['feature_crown', [['t', 'f64', 3], ['grab_range_m', 'f64', 1], ['taken', 'u32', 1],
      ['next_reset_tick', 'i32', 1], ['placed', 'u32', 1]]],
    ['feature_crown_seat', [['owner', 'u32', 1], ['seat', 'u32', 1], ['prev_dist', 'f64', 1]]],
    ['feature_crown_visual', [['owner', 'u32', 1], ['index', 'u32', 1]]],
  ] as const) {
    const layout = layoutOf(name)
    assert.deepEqual(layout.fields, fields)
    assert.ok(layout.size <= 256)
  }
})

test('crown emits authored state, eight contender records and a gold sphere', async () => {
  const input = await inputWith([crownDemo])
  const emitted = FEATURE_EMITTERS.crown(crownDemo, ctxOf(input, 3))
  assert.equal(emitted.root.name, 'feature/crown-demo')
  assert.deepEqual(emitted.root.components?.feature, { kind: 20, index: 3, salt: 0x103 })
  assert.deepEqual(emitted.root.components?.feature_crown, {
    t: [1, 2, 3], grab_range_m: 2, taken: 0, next_reset_tick: 0, placed: 0,
  })
  assert.equal(emitted.children.length, 9)
  for (let seat = 0; seat < 8; seat++) {
    const child = emitted.children[seat]!
    assert.equal(child.name, `feature/crown-demo/seat/${seat}`)
    assert.deepEqual(child.components?.feature_crown_seat, { owner: 3, seat, prev_dist: 0 })
    assert.equal(child.body, undefined)
  }
  const visual = emitted.children[8]!
  assert.equal(visual.name, 'feature/crown-demo/visual/0')
  assert.deepEqual(visual.components?.feature_crown_visual, { owner: 3, index: 0 })
  assert.deepEqual(visual.components?.['ege.transform'], { pos: [1, 2, 3], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.render'], {
    shape: 2, color: 0xFFD140, visible: 1, params: [0.25, 0, 0, 0],
  })
  const scene = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(scene.text) >= 1)
  assert.ok(scene.index('feature/crown-demo/seat/7') >= 0)
  assert.ok(scene.index('feature/crown-demo/visual/0') >= 0)
})

test('crown defaults and validates grab range and requires checkpoint 1', async () => {
  const input = await inputWith([crownDemo])
  const ctx = ctxOf(input, 0)
  for (const [grabRangeM, expected] of [[undefined, 1], [0.25, 0.25], [3, 3]] as const) {
    const spec: FeatureSpec = { ...crownDemo, params: { t: [1, 2, 3], grabRangeM } }
    assert.equal(FEATURE_EMITTERS.crown(spec, ctx).root.components?.feature_crown?.grab_range_m, expected)
  }
  for (const grabRangeM of [0.24, 3.01]) {
    const spec: FeatureSpec = { ...crownDemo, params: { ...crownDemo.params, grabRangeM } }
    assert.throws(() => FEATURE_EMITTERS.crown(spec, ctx), RefusalError)
  }
  ctx.course.checkpoints = []
  assert.throws(() => FEATURE_EMITTERS.crown(crownDemo, ctx),
    (error: unknown) => error instanceof RefusalError && error.message.includes('crown needs CP1; add a checkpoint'))
})

test('all 22 feature kinds are registered and the shipped crown course constructs', async () => {
  assert.equal(Object.keys(FEATURE_KINDS).length, 22)
  assert.deepEqual(Object.keys(FEATURE_EMITTERS).sort(), Object.keys(FEATURE_KINDS).sort())
  const path = 'courses/s1-q-crown-confection.course.json'
  const course = await loadCourseV1(readJson(path), path, assets)
  const resolved = new Map<string, ResolvedGameAsset>()
  for (const id of course.assetIds) resolved.set(id, await assets.resolve(id))
  const scene = emitEngineScene(engine, { course, assets: resolved, setup: { profile: 'sprint', seed: 7 } })
  assert.ok(engine.createWorld(scene.text) >= 1)
})

// ---- ege-yard-c: the complete objective yard, loaded through the real loader ----
type Box = { min: number[]; max: number[] }
const YARD = 'fixtures/ege/ege-yard-c.course.json'
const ASPECT = 16 / 9
const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i])
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: number[]) => a.map((v) => v / Math.hypot(a[0], a[1], a[2]))

// Frustum planes (inward normals) of a focusCamera pose; a box overlaps when no plane has it fully outside.
function frustumPlanes(cam: ReturnType<typeof focusCamera>): { n: number[]; d: number }[] {
  const f = unit(sub([...cam.target], [...cam.eye]))
  const r = unit(cross(f, [0, 1, 0]))
  const u = cross(r, f)
  const t = Math.tan((cam.fovYDeg * Math.PI) / 360)
  const planes = [
    { n: f, o: cam.eye.map((v, i) => v + f[i] * cam.near) },
    { n: f.map((v) => -v), o: cam.eye.map((v, i) => v + f[i] * cam.far) },
    { n: unit(cross(u, f.map((v, i) => f[i] + r[i] * t * ASPECT))), o: [...cam.eye] },
    { n: unit(cross(f.map((v, i) => f[i] - r[i] * t * ASPECT), u)), o: [...cam.eye] },
    { n: unit(cross(f.map((v, i) => f[i] + u[i] * t), r)), o: [...cam.eye] },
    { n: unit(cross(r, f.map((v, i) => f[i] - u[i] * t))), o: [...cam.eye] },
  ]
  return planes.map((p) => ({ n: p.n, d: -dot(p.n, p.o) }))
}

function overlapsView(box: Box, cam: ReturnType<typeof focusCamera>): boolean {
  return frustumPlanes(cam).every((p) => {
    const far = [0, 1, 2].map((i) => (p.n[i] >= 0 ? box.max[i] : box.min[i]))
    return dot(p.n, far) + p.d >= 0
  })
}

const around = (c: number[], h: number[]): Box => ({ min: c.map((v, i) => v - h[i]), max: c.map((v, i) => v + h[i]) })

test('ege-yard-c holds one of each objective kind and its objects overlap the ball focus camera', async () => {
  const loaded = await loadCourseV1(readJson(YARD), YARD, assets)
  assert.ok(loaded.sim)
  const specs = loaded.sim.features ?? []
  const ofKind = (kind: string) => specs.filter((spec) => spec.kind === kind)
  const counts = { carryItem: 1, ball: 1, collectible: 1, captureZone: 1, tailSet: 1, crown: 1, goal: 2, bank: 2 }
  for (const [kind, count] of Object.entries(counts)) assert.equal(ofKind(kind).length, count, kind)
  assert.deepEqual(ofKind('goal').map((spec) => spec.params.team), [0, 1])
  assert.deepEqual(ofKind('bank').map((spec) => spec.params.team), [0, 1])
  assert.equal(loaded.sim.spawns.length, 8)
  assert.ok(loaded.sim.checkpoints.length >= 1)
  const resolved = new Map<string, ResolvedGameAsset>()
  for (const id of loaded.assetIds) resolved.set(id, await assets.resolve(id))
  const scene = emitEngineScene(engine, { course: loaded, assets: resolved, setup: { profile: 'sprint', seed: 7 } })
  assert.ok(engine.createWorld(scene.text) >= 1)
  for (const name of ['feature/yard-ball', 'feature/yard-goal-0', 'feature/yard-goal-1', 'feature/yard-bank-0',
    'feature/yard-bank-1', 'feature/yard-carry/item/0', 'feature/yard-pickup/spot/2', 'feature/yard-capture/visual/0',
    'feature/yard-tails/seat/7', 'feature/yard-crown/visual/0']) assert.ok(scene.index(name) >= 0, name)
  assert.equal(scene.index('feature/yard-pickup/spot/3'), -1)

  const num = (v: unknown) => v as number[]
  const ball = num(ofKind('ball')[0].params.spawn)
  const cam = focusCamera({ x: ball[0], y: ball[1], z: ball[2] })
  const required: [string, Box][] = [
    ['ball', around(ball, [0.3, 0.3, 0.3])],
    ...ofKind('goal').map((s, i): [string, Box] => [`goal ${i}`, around(num(s.params.center), num(s.params.half))]),
    ...ofKind('bank').map((s, i): [string, Box] => [`bank ${i}`, around(num(s.params.center), num(s.params.half))]),
    ['capture', around(num(ofKind('captureZone')[0].params.center), num(ofKind('captureZone')[0].params.half))],
    ...(ofKind('collectible')[0].params.spots as number[][]).map((s, i): [string, Box] => [`spot ${i}`, around(s, [0.25, 0.25, 0.25])]),
    ['carry item', around(num((ofKind('carryItem')[0].params.spawns as number[][])[0]), [0.35, 0.35, 0.35])],
    ['tail seat', around(num(ofKind('tailSet')[0].params.spawn), [0.5, 0.5, 0.5])],
    ['crown', around(num(ofKind('crown')[0].params.t), [0.25, 0.25, 0.25])],
  ]
  for (const [label, box] of required) assert.ok(overlapsView(box, cam), `${label} overlaps the view volume`)
  // The check is real: an object behind the camera and one far to the side are outside.
  assert.equal(overlapsView(around([0, 1, -30], [1, 1, 1]), cam), false)
  assert.equal(overlapsView(around([300, 1, 20], [1, 1, 1]), cam), false)
})
