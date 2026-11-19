import assert from 'node:assert/strict'
import test from 'node:test'
import type { EngineInstance } from '@etcito/game-engine/loader'
import { loadEngine } from '@etcito/game-engine'
import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { encodeInput } from '@royal-fiesta/sim/input'
import { createEngineRound } from '@royal-fiesta/game/ege/round'
import type { EngineRound } from '@royal-fiesta/game/ege/round'
import { emitEngineScene } from '@royal-fiesta/game/ege/sceneEmitter'
import type { EmittedScene } from '@royal-fiesta/game/ege/sceneEmitter'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import { loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

async function roundWith(id: string, specs: FeatureSpec[] | null, humans = [true, false, false, false, false, false, false, false]): Promise<{
  engine: EngineInstance; scene: EmittedScene; course: CourseV1; round: EngineRound
}> {
  const { course, assets } = await loadEgeCourse(id)
  const copy = structuredClone(course)
  if (specs !== null) copy.sim!.features = specs
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const round = await createEngineRound(engine, schema, await rfScriptBytes(), scene, copy, {
    profile: 'sprint', seed: 7, humans,
  })
  return { engine, scene, course: copy, round }
}

function rec(round: EngineRound, component: string, entity: number): any {
  return round.worldState().components[component][String(entity)]
}

function code(moveX = 0, moveZ = 0, jump = false, dive = false): number {
  return encodeInput({ moveX, moveZ, jump, dive, grab: false })
}

function stepUntil(round: EngineRound, maxTick: number, human: (seat: number) => number, done: () => boolean): void {
  while (round.tick < maxTick && !done()) {
    round.step(human)
    assert.equal(round.observe().faults, 0)
  }
}

test('marker counts touches', async () => {
  const { scene, round } = await roundWith('ege-strip', [
    { id: 'near', kind: 'marker', params: { t: [-3.5, 0.5, 0], radiusM: 1.5 } },
    { id: 'far', kind: 'marker', params: { t: [0, 0.5, 100] } },
  ])
  try {
    stepUntil(round, 10, () => code(), () => false)
    const near = rec(round, 'feature_marker', scene.index('feature/near'))
    const far = rec(round, 'feature_marker', scene.index('feature/far'))
    assert.ok(near.touches >= 1)
    assert.equal(near.last_touch_tick, round.tick - 1)
    assert.equal(rec(round, 'ege.render', scene.index('feature/near') + 1).color, 0x73D966)
    assert.equal(far.touches, 0)
    assert.equal(far.last_touch_tick, -1)
    assert.equal(rec(round, 'ege.render', scene.index('feature/far') + 1).color, 0xF2E6D0)
  } finally {
    round.dispose()
  }
})
