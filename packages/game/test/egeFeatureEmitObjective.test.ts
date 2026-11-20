import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { FEATURE_EMITTERS } from '../src/ege/featureEmitters.ts'
import { emitEngineScene } from '../src/ege/sceneEmitter.ts'
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
