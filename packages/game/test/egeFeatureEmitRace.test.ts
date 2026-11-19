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
