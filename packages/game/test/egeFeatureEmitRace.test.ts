import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { FEATURE_EMITTERS } from '../src/ege/featureEmitters.ts'
import { emitEngineScene } from '../src/ege/sceneEmitter.ts'
import type { EmitInput, EmittedScene } from '../src/ege/sceneEmitter.ts'
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

async function inputWith(path: string, specs: FeatureSpec[] | null): Promise<EmitInput> {
  const course = await loadCourseV1(readJson(path), path, assets)
  assert.ok(course.sim)
  const copy: CourseV1 = structuredClone(course)
  if (specs !== null) copy.sim!.features = specs
  const resolved = new Map<string, ResolvedGameAsset>()
  for (const assetId of copy.assetIds) resolved.set(assetId, await assets.resolve(assetId))
  return { course: copy, assets: resolved, setup: { profile: 'sprint', seed: 7 } }
}

function emitBuilds(input: EmitInput): EmittedScene {
  const emitted = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(emitted.text) >= 1)
  return emitted
}

function refusedAt(input: EmitInput, spec: FeatureSpec, key: string): void {
  const path = `courses/${input.course.id}.course.json#/features/0`
  assert.throws(
    () => FEATURE_EMITTERS[spec.kind](spec, {
      course: input.course.sim!, index: 0, path: `courses/${input.course.id}.course.json`, assets: input.assets,
    }),
    (error: unknown) => error instanceof RefusalError &&
      error.message.startsWith(`[feature] ${path}${key ? `/${key}` : ''}:`),
  )
}

test('marker emits a root and a floor-disc visual that build', async () => {
  const spec: FeatureSpec = { id: 'm', kind: 'marker', params: { t: [0, 0.5, 4], radiusM: 1.5 } }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/m')
  const visualIndex = emitted.index('feature/m/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 0, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_marker?.t, [0, 0.5, 4])
  assert.equal(visual.components?.['ege.render']?.shape, 4)
  assert.deepEqual(visual.components?.['ege.render']?.params, [1.5, 0.05, 0, 0])
  refusedAt(input, { id: 'm', kind: 'marker', params: { t: [0, 0, 4], radiusM: 20 } }, 'radiusM')
})

test('swimVolume emits a root and a slime-pool visual that build', async () => {
  const spec: FeatureSpec = { id: 'pool', kind: 'swimVolume', params: { center: [-3.5, 0.75, 6], half: [1, 0.75, 2] } }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/pool')
  const visualIndex = emitted.index('feature/pool/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 6, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_swim_volume, {
    center: [-3.5, 0.75, 6], half: [1, 0.75, 2], drag: 2.5, buoyancy: 22,
    inside: [0, 0, 0, 0, 0, 0, 0, 0],
  })
  assert.equal(visual.components?.['ege.render']?.shape, 1)
  assert.deepEqual(visual.components?.['ege.render']?.params, [1, 0.75, 2, 0])
  const path = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  refusedAt(path, { id: 'pool', kind: 'swimVolume', params: { center: [0, 0, 0], half: [1, -1, 1] } }, 'half')
  refusedAt(path, { id: 'pool', kind: 'swimVolume', params: { center: [0, 0, 0], half: [1, 1, 1], drag: 30 } }, 'drag')
})

test('catchVolume emits a root resolved to its checkpoint', async () => {
  const spec: FeatureSpec = {
    id: 'catch', kind: 'catchVolume', params: { center: [-3.5, 1, 6], half: [1, 1.5, 0.5], respawnStage: 0 },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/catch')
  const visualIndex = emitted.index('feature/catch/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 3, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_catch_volume, {
    center: [-3.5, 1, 6], half: [1, 1.5, 0.5], respawn_stage: 0, checkpoint: 0,
    inside: [0, 0, 0, 0, 0, 0, 0, 0],
  })
  assert.equal(visual.components?.['ege.render']?.shape, 4)
  assert.equal(visual.components?.['ege.render']?.color, 0xF2E6D0)
  assert.equal(visual.components?.['ege.render']?.visible, 0)
  assert.deepEqual(visual.components?.['ege.render']?.params, [1, 1.5, 0, 0])
  refusedAt(input, { ...spec, params: { ...spec.params, respawnStage: 3 } }, 'respawnStage')
  assert.throws(
    () => FEATURE_EMITTERS.catchVolume({ ...spec, params: { ...spec.params, respawnStage: 3 } }, {
      course: input.course.sim!, index: 0, path: `courses/${input.course.id}.course.json`, assets: input.assets,
    }), /no checkpoint at route stage 3; add a checkpoint of that stage/,
  )
  refusedAt(input, { ...spec, params: { ...spec.params, respawnStage: 1.5 } }, 'respawnStage')
})

test('tileField emits one fixed box body per tile', async () => {
  const spec: FeatureSpec = {
    id: 'tiles', kind: 'tileField',
    params: {
      tiles: [
        { t: [-3.5, -0.04, 0], size: [2, 2, 0.1] },
        { t: [-3.5, -0.04, 2], size: [2, 2, 0.1] },
      ],
      decayS: 0.5, warnS: 0.5, mode: 'reset', resetS: 2,
    },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const root = emitted.scene.entities[emitted.index('feature/tiles')]
  assert.deepEqual(root.components?.feature, { kind: 8, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_tile_field, {
    warn_s: 0.5, decay_s: 0.5, mode: 0, reset_s: 2, tile_count: 2,
  })
  for (let index = 0; index < 2; index++) {
    const entity = emitted.scene.entities[emitted.index(`feature/tiles/tile/${index}`)]
    assert.deepEqual(entity.colliders?.[0]?.half_extents, [1, 0.05, 1])
    assert.deepEqual(entity.components?.feature_tile_field_tile, {
      owner: 0, index, t: [-3.5, -0.04, index * 2], half: [1, 0.05, 1], state: 0, timer: 0,
    })
    assert.equal(entity.body?.type, 'fixed')
  }
  const permanent = await inputWith('fixtures/ege/ege-strip.course.json', [{
    ...spec, params: { ...spec.params, mode: 'permanent', resetS: undefined },
  }])
  const permanentScene = emitBuilds(permanent)
  const permanentRoot = permanentScene.scene.entities[permanentScene.index('feature/tiles')]
  assert.deepEqual(permanentRoot.components?.feature_tile_field, {
    warn_s: 0.5, decay_s: 0.5, mode: 1, reset_s: 0, tile_count: 2,
  })
  refusedAt(input, { ...spec, params: { ...spec.params, tiles: [] } }, 'tiles')
  refusedAt(input, {
    ...spec, params: { ...spec.params, tiles: [{ t: [0, 0, 0], size: [2, 2, 0.01] }] },
  }, 'tiles/0/size/2')
  refusedAt(input, { ...spec, params: { ...spec.params, mode: 'sometimes' } }, 'mode')
})

test('boostLane emits a root and a conveyor visual', async () => {
  const spec: FeatureSpec = {
    id: 'lane', kind: 'boostLane',
    params: {
      center: [-3.5, 1, 14], half: [1, 2, 13], yawDeg: 0, boost: 4,
      durationS: 2, rechargeS: 0, eligibility: 'all',
    },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/lane')
  const visualIndex = emitted.index('feature/lane/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 1, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_boost_lane, {
    center: [-3.5, 1, 14], half: [1, 2, 13], yaw_deg: 0, boost: 4,
    duration_s: 2, recharge_s: 0, eligibility: 0, placed: 0,
    boost_until: Array(8).fill(0), ready_at: Array(8).fill(0),
  })
  assert.deepEqual(root.components?.['ege.transform'], { pos: [-3.5, 1, 14], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.transform'], { pos: [-3.5, 1, 14], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.render'], {
    shape: 1, color: 0x8C6BD9, visible: 1, params: [1, 2, 13, 0],
  })
  refusedAt(input, { ...spec, params: { ...spec.params, yawDeg: 200 } }, 'yawDeg')
  refusedAt(input, { ...spec, params: { ...spec.params, boost: 11 } }, 'boost')
  refusedAt(input, { ...spec, params: { ...spec.params, eligibility: 'some' } }, 'eligibility')
  refusedAt(input, { ...spec, params: { ...spec.params, durationS: 0 } }, 'durationS')
})

test('launchPad emits a pad visual and eight seat records', async () => {
  const spec: FeatureSpec = {
    id: 'pad', kind: 'launchPad',
    params: { center: [-3.5, 0.25, 4], half: [0.8, 0.25, 0.8], target: [-3.5, 0, 12], apexM: 2 },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/pad')
  const visualIndex = emitted.index('feature/pad/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 2, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_launch_pad, {
    center: [-3.5, 0.25, 4], half: [0.8, 0.25, 0.8], target: [-3.5, 0, 12],
    apex_m: 2, recover_only: 0, pad_stage: -1, placed: 0,
  })
  assert.deepEqual(root.components?.['ege.transform'], { pos: [-3.5, 0.25, 4], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.transform'], { pos: [-3.5, 0.25, 4], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.render'], {
    shape: 4, color: 0xFF8C42, visible: 1, params: [0.8, 0.25, 0, 0],
  })
  for (let seat = 0; seat < 8; seat++) {
    const index = emitted.index(`feature/pad/seat/${seat}`)
    assert.equal(index, visualIndex + 1 + seat)
    assert.deepEqual(emitted.scene.entities[index].components?.feature_launch_pad_seat, {
      owner: 0, seat, inside: 0, launched: -1, flight: 0, last_fall: -1, prev_protected: 0, alive: 1,
    })
  }
  const recoverInput = await inputWith('fixtures/ege/ege-strip.course.json', [
    { ...spec, params: { ...spec.params, recoverOnly: true } },
  ])
  const recover = emitBuilds(recoverInput)
  assert.equal(recover.scene.entities[recover.index('feature/pad')].components?.feature_launch_pad?.recover_only, 1)
  refusedAt(input, { ...spec, params: { ...spec.params, apexM: 0.1 } }, 'apexM')
  refusedAt(input, { ...spec, params: { ...spec.params, target: [1, 2] } }, 'target')
  refusedAt(input, { ...spec, params: { ...spec.params, recoverOnly: 'yes' } }, 'recoverOnly')
})
