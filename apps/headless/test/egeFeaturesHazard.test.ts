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

function code(): number {
  return encodeInput({ moveX: 0, moveZ: 0, jump: false, dive: false, grab: false })
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-6, `${actual} != ${expected}`)
}

test('hexField places ring one and layers, then warns and falls under a standing seat', async () => {
  const origin = [-3.5, -0.04, 0]
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'hex',
    kind: 'hexField',
    params: {
      origin, layers: 2, layerSpacingM: 0.5, rings: 1, flatM: 2, pointM: 2,
      thickM: 0.1, warnS: 0.5, decayS: 0.5, scaleWithEntrants: false,
    },
  }])
  try {
    const root = scene.index('feature/hex')
    const rootX = origin[0]
    const rootY = origin[1]
    const rootZ = origin[2]
    const root3 = Math.sqrt(3)
    const layout = [
      [0, 0],
      [-root3, 1],
      [0, 2],
      [root3, 1],
      [root3, -1],
      [0, -2],
      [-root3, -1],
    ]
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    assert.equal(rec(round, 'feature_hex_field', root).placed, 1)
    for (let index = 0; index < layout.length; index++) {
      const transform = rec(round, 'ege.transform', scene.index(`feature/hex/hex/${index}`))
      near(transform.pos[0], rootX + layout[index][0])
      near(transform.pos[1], rootY)
      near(transform.pos[2], rootZ + layout[index][1])
    }
    for (let index = 7; index < 14; index++) {
      const transform = rec(round, 'ege.transform', scene.index(`feature/hex/hex/${index}`))
      near(transform.pos[1], rootY - 0.5)
    }

    const hexEntity = scene.index('feature/hex/hex/0')
    const neighbour = scene.index('feature/hex/hex/1')
    const states: number[] = [rec(round, 'feature_hex_field_hex', hexEntity).state]
    let warningTicks = 0
    let warningColor = 0
    let groundedOnHex = false
    let fallingDisabled = false
    let fallingY = rootY
    while (round.tick < 600 && rec(round, 'feature_hex_field_hex', hexEntity).state !== 3) {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
      const hex = rec(round, 'feature_hex_field_hex', hexEntity)
      if (hex.state !== states[states.length - 1]) states.push(hex.state)
      if (hex.state === 1) {
        warningTicks++
        warningColor = rec(round, 'ege.render', hexEntity).color
      }
      if (hex.state === 2) {
        if (rec(round, 'ege.body_props', hexEntity).colliders_enabled === 0) fallingDisabled = true
        fallingY = Math.min(fallingY, rec(round, 'ege.transform', hexEntity).pos[1])
      }
      for (const seat of round.observe().seats) {
        const ch = rec(round, 'character', seat.entity)
        if (ch.grounded !== 0 && ch.ground_entity === hexEntity) groundedOnHex = true
      }
    }
    assert.deepEqual(states, [0, 1, 2, 3])
    assert.ok(groundedOnHex, 'a seat stood on the hex before it warned')
    assert.equal(warningTicks, 30)
    assert.equal(warningColor, 0xFF6B9E)
    assert.ok(fallingDisabled, 'falling disables the collider')
    assert.ok(fallingY < rootY - 0.1, `falling displaced the hex to ${fallingY}`)
    assert.equal(rec(round, 'ege.render', hexEntity).visible, 0)
    assert.equal(rec(round, 'ege.body_props', hexEntity).colliders_enabled, 0)
    assert.equal(rec(round, 'feature_hex_field_hex', neighbour).state, 0)
    assert.equal(rec(round, 'ege.body_props', neighbour).colliders_enabled, 1)
  } finally {
    round.dispose()
  }
})
