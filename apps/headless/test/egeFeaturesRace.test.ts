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

test('catchVolume respawns at its stage', async () => {
  const { scene, round } = await roundWith('ege-strip', [
    { id: 'catch', kind: 'catchVolume', params: { center: [-3.5, 1, 6], half: [1, 1.5, 0.5], respawnStage: 0 } },
  ])
  try {
    while (round.observe().phase === 'intro') round.step(() => code())
    const seat0 = round.observe().seats[0].entity
    const previousTeleport = rec(round, 'character', seat0).teleport_tick
    stepUntil(round, 400, () => code(0, 1), () => rec(round, 'character', seat0).teleport_tick > previousTeleport)
    const character = rec(round, 'character', seat0)
    assert.equal(character.teleport_tick, round.tick - 1)
    const [x, , z] = rec(round, 'ege.transform', seat0).pos as number[]
    assert.ok(Math.abs(x) <= 0.3)
    assert.ok(Math.abs(z - 15) <= 0.3)
    assert.equal(rec(round, 'feature_catch_volume', scene.index('feature/catch')).inside[0], 0)
    assert.equal(rec(round, 'seat', seat0).status, 1)
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

test('tileField warns, then decays a stepped tile', async () => {
  const { scene, round } = await roundWith('ege-strip', [
    {
      id: 'tiles',
      kind: 'tileField',
      params: {
        tiles: [
          { t: [-3.5, -0.04, 0], size: [2, 2, 0.1] },
          { t: [3.5, -0.04, 30], size: [2, 2, 0.1] },
        ],
        decayS: 0.5,
        warnS: 0.5,
        mode: 'permanent',
      },
    },
  ], Array(8).fill(true))
  try {
    const first = scene.index('feature/tiles/tile/0')
    const second = scene.index('feature/tiles/tile/1')
    const states: number[] = [rec(round, 'feature_tile_field_tile', first).state]
    let warningTicks = 0
    let warningColor = 0
    while (round.tick < 300 && rec(round, 'feature_tile_field_tile', first).state !== 3) {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
      const tile = rec(round, 'feature_tile_field_tile', first)
      if (tile.state !== states[states.length - 1]) states.push(tile.state)
      if (tile.state === 1) {
        warningTicks++
        warningColor = rec(round, 'ege.render', first).color
      }
    }
    const firstTile = rec(round, 'feature_tile_field_tile', first)
    assert.equal(firstTile.state, 3)
    const render = rec(round, 'ege.render', first)
    assert.equal(render.visible, 0)
    assert.equal(rec(round, 'ege.body_props', first).colliders_enabled, 0)
    assert.equal(rec(round, 'feature_tile_field_tile', second).state, 0)
    assert.equal(rec(round, 'ege.body_props', second).colliders_enabled, 1)
    assert.deepEqual(states, [0, 1, 2, 3])
    assert.equal(warningTicks, 30)
    assert.equal(warningColor, 0xFF6B9E)
  } finally {
    round.dispose()
  }
})

test('boostLane applies a bounded speed increase after character steering', async () => {
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'lane', kind: 'boostLane',
    params: {
      center: [-3.5, 1, 14], half: [1, 2, 13], yawDeg: 0, boost: 4,
      durationS: 2, rechargeS: 0, eligibility: 'all',
    },
  }])
  try {
    const intro = Number(round.worldState().resources.round.intro_ticks)
    while (round.observe().phase === 'intro') {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
    }
    const seat0 = round.observe().seats[0].entity
    let maxSpeed = 0
    while (round.tick < intro + 90) {
      round.step(seat => seat === 0 ? code(0, 1) : code())
      assert.equal(round.observe().faults, 0)
      const lin = rec(round, 'ege.velocity', seat0).lin as number[]
      maxSpeed = Math.max(maxSpeed, Math.hypot(lin[0], lin[2]))
    }
    const finalLin = rec(round, 'ege.velocity', seat0).lin as number[]
    const lane = scene.index('feature/lane')
    const boost = rec(round, 'feature_boost_lane', lane)
    const activeVisual = rec(round, 'ege.render', lane + 1)
    assert.ok(maxSpeed > 8.5)
    assert.ok(maxSpeed <= 12 + 1e-3)
    assert.ok(Math.abs(Math.hypot(finalLin[0], finalLin[2]) - 9) < 0.1, JSON.stringify({
      maxSpeed, finalSpeed: Math.hypot(finalLin[0], finalLin[2]), tick: round.tick,
      boost, character: rec(round, 'character', seat0),
    }))
    assert.ok(boost.boost_until[0] > 0)
    assert.ok(boost.boost_until[0] > round.tick - 1)
    assert.equal(activeVisual.color, 0x73D966)
  } finally {
    round.dispose()
  }
})

test('launchPad records stay inert before any script', async () => {
  const center = [-3.5, 0.25, 4]
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'pad', kind: 'launchPad',
    params: { center, half: [0.8, 0.25, 0.8], target: [-3.5, 0, 12], apexM: 2 },
  }])
  try {
    stepUntil(round, 30, () => code(), () => false)
    const root = scene.index('feature/pad')
    const pad = rec(round, 'feature_launch_pad', root)
    assert.equal(pad.placed, 0)
    assert.equal(pad.pad_stage, -1)
    assert.equal(rec(round, 'ege.render', root + 1).shape, 4)
    assert.deepEqual(rec(round, 'ege.transform', root + 1).pos, center)
    for (let seat = 0; seat < 8; seat++) {
      const state = rec(round, 'feature_launch_pad_seat', scene.index(`feature/pad/seat/${seat}`))
      assert.equal(state.launched, -1)
      assert.equal(state.inside, 0)
      assert.equal(state.flight, 0)
    }
  } finally {
    round.dispose()
  }
})
