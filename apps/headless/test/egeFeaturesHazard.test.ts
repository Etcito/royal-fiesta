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

function closeTo(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

test('annulus writes first-step collider and render half sizes and its query edges', async () => {
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'ring',
    kind: 'annulus',
    params: { center: [-3.5, 0.1, -3], innerM: 2, outerM: 4, thickM: 0.4, speedDegS: 0, segments: 6 },
  }])
  try {
    const root = scene.index('feature/ring')
    const segment = scene.index('feature/ring/segment/0')
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    assert.equal(rec(round, 'feature_annulus', root).placed, 1)
    const half = rec(round, 'ege.box_collider', segment).half_extents as number[]
    closeTo(half[0], 1.52, 1e-5, 'collider half x')
    closeTo(half[1], 0.2, 1e-5, 'collider half y')
    closeTo(half[2], 1, 1e-5, 'collider half z')
    const render = rec(round, 'ege.render', segment)
    closeTo(render.params[0], half[0], 1e-6, 'render half x')
    closeTo(render.params[1], half[1], 1e-6, 'render half y')
    closeTo(render.params[2], half[2], 1e-6, 'render half z')
    assert.equal(render.color, 0xF5D0E0)
    assert.equal(render.visible, 1)

    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    const obs = round.observe()
    for (const seat of [0, 1]) {
      const ch = rec(round, 'character', obs.seats[seat].entity)
      assert.equal(ch.grounded, 1, `seat ${seat} grounded`)
      assert.equal(ch.ground_entity, segment, `seat ${seat} stands on segment 0`)
    }
    const outside = rec(round, 'character', obs.seats[2].entity)
    assert.notEqual(outside.ground_entity, segment, 'seat 2 is past the tangential half extent')

    const ids = [0, 1, 2, 3, 4, 5].map(index => scene.index(`feature/ring/segment/${index}`))
    for (let tick = 0; tick < 5; tick++) round.step(() => code())
    const state = round.worldState().components.feature_annulus_segment
    assert.deepEqual(Object.keys(state).map(Number).sort((a, b) => a - b), ids)
  } finally {
    round.dispose()
  }
})

test('annulus rotates at speedDegS and carries a grounded seat', async () => {
  const speedDegS = 30
  const rad = speedDegS * Math.PI / 180
  const intro = 60
  const theta0 = rad * (0 - intro) / 60
  const mid = 3
  const center = [-3.5 - mid * Math.sin(theta0), 0.1, 0 - mid * Math.cos(theta0)]
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'ring',
    kind: 'annulus',
    params: { center, innerM: 2, outerM: 4, thickM: 0.4, speedDegS, segments: 6 },
  }])
  try {
    const root = scene.index('feature/ring')
    const segment = scene.index('feature/ring/segment/0')
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    let transform = rec(round, 'ege.transform', segment)
    closeTo(transform.rot[1], Math.sin(theta0 / 2), 1e-5, 'rot y at tick 0')
    closeTo(transform.rot[3], Math.cos(theta0 / 2), 1e-5, 'rot w at tick 0')
    closeTo(transform.pos[0], center[0] + mid * Math.sin(theta0), 1e-4, 'pos x at tick 0')
    closeTo(transform.pos[2], center[2] + mid * Math.cos(theta0), 1e-4, 'pos z at tick 0')

    for (let tick = 0; tick < 3; tick++) round.step(() => code())
    assert.equal(round.observe().faults, 0)
    const seat0 = round.observe().seats[0]
    const ch = rec(round, 'character', seat0.entity)
    assert.equal(ch.grounded, 1, 'the carried seat stays grounded')
    assert.equal(ch.ground_entity, segment)
    transform = rec(round, 'ege.transform', seat0.entity)
    const velocity = rec(round, 'ege.velocity', seat0.entity).lin as number[]
    closeTo(velocity[0], rad * (transform.pos[2] - center[2]), 0.4, 'carried tangential x')

    while (round.tick < 90) round.step(() => code())
    const at = rec(round, 'ege.transform', segment)
    const theta = rad * (89 - intro) / 60
    closeTo(at.rot[1], Math.sin(theta / 2), 1e-4, 'rot y at tick 89')
    closeTo(at.rot[3], Math.cos(theta / 2), 1e-4, 'rot w at tick 89')
    closeTo(at.pos[0], center[0] + mid * Math.sin(theta), 1e-4, 'pos x at tick 89')
    closeTo(at.pos[2], center[2] + mid * Math.cos(theta), 1e-4, 'pos z at tick 89')
    assert.equal(rec(round, 'feature_annulus', root).overtime_ticks, 0)
  } finally {
    round.dispose()
  }
})
