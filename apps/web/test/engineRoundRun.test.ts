import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { createRoundRun, localCode, parseRunArgs } from '../src/engineRound/run.ts'

test('parseRunArgs defaults and refusals', () => {
  assert.deepEqual(parseRunArgs({ course: 'race-sprint' }), {
    course: 'race-sprint', profile: 'sprint', seed: 7, frames: 600, local: 'run', captureAt: 'end', focus: null,
  })
  for (const input of [{ course: 'race-sprint', frames: 0 }, { course: 'race-sprint', local: 'fly' }, { course: 'race-sprint', extra: 1 }]) {
    assert.throws(() => parseRunArgs(input), /\[engine-round\] args\./)
  }
})

test('localCode follows S1 patterns', () => {
  const neutral = encodeInput({ moveX: 0, moveZ: 0, jump: false, dive: false, grab: false })
  const run = (jump = false) => encodeInput({ moveX: 0, moveZ: 1, jump, dive: false, grab: false })
  assert.equal(localCode('idle', 70, 60), NEUTRAL_CODE)
  assert.equal(localCode('run', 59, 60), NEUTRAL_CODE)
  assert.equal(localCode('run', 60, 60), run(true))
  assert.equal(localCode('run', 105, 60), run(true))
  assert.equal(localCode('run', 61, 60), run())
  assert.equal(localCode('dive', 120, 60), encodeInput({ moveX: 0, moveZ: 1, jump: false, dive: true, grab: false }))
  assert.equal(localCode('sideways', 61, 60), encodeInput({ moveX: 1, moveZ: 0, jump: false, dive: false, grab: false }))
  assert.equal(localCode('grab', 61, 60), encodeInput({ moveX: 0, moveZ: 1, jump: false, dive: false, grab: true }))
  assert.equal(neutral, NEUTRAL_CODE)
})

function fakeRound() {
  let tick = 0
  let mode = 0
  const events: Record<string, number> = {}
  const seats = Array.from({ length: 8 }, (_, seat) => ({ seat, status: 1, mode: 0,
    pos: { x: seat * 2, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 }, grounded: true,
    groundObstacle: -1, knockbacks: 0, teleportTick: -1, entity: seat + 1 }))
  const observation = () => ({ tick, phase: 'playing' as const, alive: 8, qualified: 0, eliminated: 0, seats, faults: 0, events })
  const round = {
    get tick() { return tick },
    observe: observation,
    step(_input: (seat: number) => number) { tick++; if (tick >= 3) mode = 2; seats[0].mode = mode; seats[1].pos.z = tick * 0.5 },
    poses(ids: readonly number[]) { const values = new Float32Array(ids.length * 23); for (let i = 0; i < ids.length; i++) values[i * 23 + 6] = 1; return values },
    worldState() { return { components: { character: { '1': { parked: 0 } } } } },
    scene: { scene: { entities: [
      { name: 'seat/0', body: {}, components: { 'ege.transform': { pos: [0, 0, 0] } } },
      { name: 'seat/1', body: {} }, { name: 'floor' },
    ] }, seatEntities: Array.from({ length: 8 }, (_, i) => i + 1) },
  }
  return round
}

test('captureAt dive and end stop at the requested tick; facts count scene state', () => {
  const course = { kind: 'race', sim: { features: [{ kind: 'boostLane', id: 'boost-a' }] } } as never
  const diveRound = fakeRound()
  const dive = createRoundRun(diveRound as never, { ...parseRunArgs({ course: 'race-sprint', captureAt: 'dive' }), frames: 100 }, course)
  while (dive.step()) {}
  assert.equal(diveRound.tick, 13)
  const endRound = fakeRound()
  const end = createRoundRun(endRound as never, { ...parseRunArgs({ course: 'race-sprint', frames: 5 }), frames: 5 }, course)
  while (end.step()) {}
  const facts = end.facts()
  assert.equal(facts.tick, 5)
  assert.equal(facts.capturedAt, 5)
  assert.equal(facts.seats, 8)
  assert.equal(facts.entities, 3)
  assert.equal(facts.bodies, 2)
  assert.equal(facts.botsMoved, 1)
  assert.equal(facts.upright, true)
  assert.deepEqual(facts.features, { boostLane: 1 })
  assert.equal(facts.events.finish, 0)
})
