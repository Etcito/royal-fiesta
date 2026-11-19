import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngineRound } from '@royal-fiesta/game/ege/round'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { CAPSULE } from '@royal-fiesta/sim/character/capsule'
import { NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { seatSpawn } from '@royal-fiesta/sim/zones/seatSpawn'
import { harnessRound, rfScriptBytes, runTicks } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

const neutral = () => NEUTRAL_CODE

test('race round places seats, advances phases, and runs without faults', async () => {
  const { course, scene, round } = await harnessRound('race-sprint')
  try {
    assert.ok(course.sim)
    assert.equal(runTicks(round, 1, neutral).tick, 1)
    const poses = round.poses(scene.seatEntities)
    for (let i = 0; i < scene.seatEntities.length; i++) {
      const spawn = seatSpawn(course.sim, i).t
      const offset = i * 23
      assert.ok(Math.abs(poses[offset] - spawn.x) < 0.02, `seat ${i} x`)
      assert.ok(Math.abs(poses[offset + 1] - (spawn.y + CAPSULE.stand)) < 0.02, `seat ${i} y`)
      assert.ok(Math.abs(poses[offset + 2] - spawn.z) < 0.02, `seat ${i} z`)
      assert.ok(Math.abs(poses[offset + 3]) < 1e-3, `seat ${i} rotation x`)
      assert.ok(Math.abs(poses[offset + 5]) < 1e-3, `seat ${i} rotation z`)
    }
    const boundary = runTicks(round, PROFILES.sprint.introTicks - 1, neutral)
    assert.equal(boundary.tick, PROFILES.sprint.introTicks)
    assert.equal(boundary.phase, 'intro')
    const playing = runTicks(round, 1, neutral)
    assert.equal(playing.tick, PROFILES.sprint.introTicks + 1)
    assert.equal(playing.phase, 'playing')
    const observation = runTicks(round, 120 - (PROFILES.sprint.introTicks + 1), neutral)
    assert.equal(observation.tick, 120)
    assert.equal(observation.faults, 0)
  } finally {
    round.dispose()
  }
})

test('identical rounds in one engine remain equal', async () => {
  const { engine, scene, course, round: a } = await harnessRound('race-sprint')
  let b
  try {
    b = await createEngineRound(engine, await readRepoText(RF_EGE_SCHEMA), await rfScriptBytes(), scene, course, {
      profile: 'sprint', seed: 7, humans: [true, false, false, false, false, false, false, false],
    })
    for (let i = 0; i < 120; i++) {
      a.step(neutral)
      b.step(neutral)
    }
    assert.equal(engine.worldEqual(a.world, b.world), true)
  } finally {
    b?.dispose()
    a.dispose()
  }
})
