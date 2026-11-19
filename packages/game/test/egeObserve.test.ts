import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorldState } from '@etcito/game-engine/world-state'
import { observeRound, charStateOf } from '../src/ege/observe.ts'

test('observeRound decodes the eight engine seats', () => {
  const statuses = [1, 1, 2, 3, 1, 1, 1, 3]
  const modes = [0, 1, 2, 3, 4, 5, 6, 7]
  const components: WorldState['components'] = {
    seat: {},
    character: {},
    'ege.transform': {},
    'ege.velocity': {},
  }
  for (let i = 0; i < 8; i++) {
    const key = String(i)
    components.seat![key] = { status: statuses[i] }
    components.character![key] = {
      mode: modes[i], facing: [i + 0.25, i + 0.75], grounded: i % 2,
      ground_obstacle: i + 10, knockbacks: i + 20, teleport_tick: i + 30,
    }
    components['ege.transform']![key] = { pos: [i, i + 1, i + 2] }
    components['ege.velocity']![key] = { lin: [i + 3, i + 4, i + 5] }
  }
  const scene = { seatEntities: [0, 1, 2, 3, 4, 5, 6, 7] } as never
  const phaseNames = ['intro', 'playing', 'overtime', 'ended']
  for (let phase = 0; phase < 4; phase++) {
    const state: WorldState = {
      tick: 123,
      entities: [],
      components,
      resources: { round: { phase } },
    }
    const observation = observeRound(state, scene, 2, { finish: 1 })
    assert.equal(observation.phase, phaseNames[phase])
    assert.deepEqual([observation.alive, observation.qualified, observation.eliminated], [5, 1, 2])
    assert.equal(observation.tick, 123)
    assert.deepEqual(observation.seats.map((seat) => seat.mode), modes)
    assert.deepEqual(observation.seats.map((seat) => seat.status), statuses)
    assert.deepEqual(observation.seats[3].facing, { x: 3.25, z: 3.75 })
    assert.deepEqual(charStateOf(observation.seats[3]), {
      pos: { x: 3, y: 4, z: 5 }, vel: { x: 6, y: 7, z: 8 },
      facing: { x: 3.25, z: 3.75 }, mode: 3, grounded: true,
      groundObstacle: 13, knockbacks: 23, teleportTick: 33,
    })
  }
})

test('observeRound defaults missing velocity and refuses a missing seat record', () => {
  const components: WorldState['components'] = { seat: {}, character: {}, 'ege.transform': {} }
  for (let i = 0; i < 8; i++) {
    const key = String(i)
    components.seat![key] = { status: 1 }
    components.character![key] = {
      mode: 1, facing: [0, 1], grounded: 0, ground_obstacle: -1,
      knockbacks: 0, teleport_tick: -1,
    }
    components['ege.transform']![key] = { pos: [0, 0, 0] }
  }
  const state: WorldState = { tick: 0, entities: [], components, resources: { round: { phase: 0 } } }
  const scene = { seatEntities: [0, 1, 2, 3, 4, 5, 6, 7] } as never
  assert.deepEqual(observeRound(state, scene, 0, {}).seats[0].vel, { x: 0, y: 0, z: 0 })
  delete components.seat!['4']
  assert.throws(() => observeRound(state, scene, 0, {}), /seat\/4.*entity 4 has no seat record/)
})
