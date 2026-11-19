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

test('swimVolume sets swim', async () => {
  const { scene, round } = await roundWith('ege-strip', [
    { id: 'swim', kind: 'swimVolume', params: { center: [-3.5, 0.75, 6], half: [1, 0.75, 2] } },
  ])
  try {
    while (round.observe().phase === 'intro') round.step(() => code())
    const seat0 = round.observe().seats[0].entity
    const seat4 = round.observe().seats[4].entity
    stepUntil(round, 400, () => code(0, 1), () => rec(round, 'character', seat0).swim === 1)
    const swim = rec(round, 'feature_swim_volume', scene.index('feature/swim'))
    const character0 = rec(round, 'character', seat0)
    assert.equal(character0.mode, 9)
    assert.equal(character0.swim_drag, 2.5)
    assert.equal(character0.swim_buoyancy, 22)
    assert.equal(swim.inside[0], 1)
    assert.equal(rec(round, 'character', seat4).swim, 0)
    assert.equal(swim.inside[4], 0)
  } finally {
    round.dispose()
  }
})

test('ege-yard-a: the marker is touched and a seat swims in the pool', async () => {
  const { scene, round } = await roundWith('ege-yard-a', null)
  try {
    while (round.observe().phase === 'intro') {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
    }
    const markerEntity = scene.index('feature/yard-marker')
    const poolEntity = scene.index('feature/yard-pool')
    let maxTouches = rec(round, 'feature_marker', markerEntity).touches
    while (round.tick < 400) {
      round.step(seat => seat === 0 ? code(0, 1) : code())
      assert.equal(round.observe().faults, 0)
      maxTouches = Math.max(maxTouches, rec(round, 'feature_marker', markerEntity).touches)
    }
    assert.ok(maxTouches >= 1)
    assert.ok(rec(round, 'feature_marker', markerEntity).last_touch_tick >= 0)

    const pool = rec(round, 'feature_swim_volume', poolEntity)
    const swimmingInside = round.observe().seats.some(seat => {
      const character = rec(round, 'character', seat.entity)
      const [x, y, z] = rec(round, 'ege.transform', seat.entity).pos as number[]
      return character.swim === 1 && pool.inside[seat.seat] === 1 &&
        x >= pool.center[0] - pool.half[0] && x <= pool.center[0] + pool.half[0] &&
        y >= pool.center[1] - pool.half[1] && y <= pool.center[1] + pool.half[1] &&
        z >= pool.center[2] - pool.half[2] && z <= pool.center[2] + pool.half[2]
    })
    assert.ok(swimmingInside)
  } finally {
    round.dispose()
  }
})
