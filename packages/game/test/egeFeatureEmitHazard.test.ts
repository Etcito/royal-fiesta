import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
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
