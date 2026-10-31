import assert from 'node:assert/strict'
import test from 'node:test'
import { BUSES } from '../src/audio/catalog.ts'
import { BUS_GAIN_DB, LIMITER_CEILING_DB, dbToGain } from '../src/audio/mix/buses.ts'
import { DUCK_RULES, DuckState } from '../src/audio/mix/ducking.ts'
import { spatialFor, type ListenerPose } from '../src/audio/mix/listeners.ts'
import {
  AUDIO_SETTINGS_KEY, DEFAULT_BUS_VOLUMES, parseBusVolumes,
} from '../src/audio/mix/volumes.ts'

function close(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${label}: ${actual} != ${expected}`)
}

test('buses carry the S16 trims, limiter ceiling and a dB helper', () => {
  assert.deepEqual(BUS_GAIN_DB, { music: -8, sfx: 0, ui: -4, ambience: -14, crowd: -12 })
  assert.deepEqual(Object.keys(BUS_GAIN_DB).sort(), [...BUSES].sort())
  assert.equal(LIMITER_CEILING_DB, -1)
  assert.equal(dbToGain(0), 1)
  close(dbToGain(-6), 0.5011872336272722, 'dbToGain(-6)')
  close(dbToGain(LIMITER_CEILING_DB), 0.8912509381337456, 'limiter ceiling gain')
})

test('ducking envelope: attack to depth, release to 0, for both rules', () => {
  const cases = [
    { id: 'flow.count-go', bus: DUCK_RULES[0].bus, depth: 10, attack: 0.05, release: 0.6, at: 0 },
    { id: 'music.candy.lobby', bus: DUCK_RULES[1].bus, depth: 8, attack: 0.3, release: 1, at: 1 },
  ] as const
  for (const c of cases) {
    const state = new DuckState()
    state.trigger(c.id, c.at)
    close(state.gainDb(c.bus, c.at), 0, `${c.id} t=0`)
    close(state.gainDb(c.bus, c.at + c.attack / 2), -c.depth / 2, `${c.id} attack/2`)
    close(state.gainDb(c.bus, c.at + c.attack), -c.depth, `${c.id} attack`)
    close(state.gainDb(c.bus, c.at + c.attack + c.release / 2), -c.depth / 2, `${c.id} attack+release/2`)
    close(state.gainDb(c.bus, c.at + c.attack + c.release), 0, `${c.id} end`)
    close(state.gainDb(c.bus, c.at + c.attack + c.release + 2), 0, `${c.id} after end`)
  }
})

test('ducking routes flow stings to music and menu music to ambience only', () => {
  assert.deepEqual(DUCK_RULES.map((rule) => rule.bus), ['music', 'ambience'])
  close(new DuckState().gainDb('music', 0), 0, 'idle')

  const flow = new DuckState()
  flow.trigger('flow.qualify', 0)
  close(flow.gainDb('music', 0.05), -10, 'flow ducks music')
  close(flow.gainDb('ambience', 0.05), 0, 'flow leaves ambience')

  const menu = new DuckState()
  menu.trigger('music.jungle.results', 0)
  close(menu.gainDb('ambience', 0.3), -8, 'menu music ducks ambience')
  close(menu.gainDb('music', 0.3), 0, 'menu music leaves music')

  const race = new DuckState()
  race.trigger('music.ice.race', 0)
  race.trigger('move.jump', 0)
  close(race.gainDb('music', 0.1), 0, 'non-menu music does not duck')
  close(race.gainDb('ambience', 0.4), 0, 'non-menu music does not duck ambience')
})

test('overlapping triggers take the deepest value and re-triggers hold the duck', () => {
  const state = new DuckState()
  state.trigger('flow.win', 0)
  state.trigger('flow.win', 0.25)
  close(state.gainDb('music', 0.25), -10 * (2 / 3), 're-trigger restarts from current depth')
  close(state.gainDb('music', 0.3), -10, 'second attack reaches full depth')
  close(state.gainDb('music', 0.45), -7.5, 'newer envelope is deeper than the old')
  close(state.gainDb('music', 0.65), -10 * (5 / 12), 'newer envelope owns the tail')

  const held = new DuckState()
  for (let t = 0; t <= 1.5; t += 0.25) {
    held.trigger('flow.count-go', t)
    if (t < 0.5) continue
    const gain = held.gainDb('music', t)
    assert.ok(gain <= -10 * (2 / 3) + 1e-9, `held at t=${t}: ${gain}`)
    assert.ok(gain >= -10 - 1e-9, `held never exceeds depth at t=${t}: ${gain}`)
  }
  close(held.gainDb('music', 2.3), 0, 'held duck releases after the last trigger')
})

function pose(x: number, y: number, z: number, fx: number, fz: number): ListenerPose {
  return { pos: { x, y, z }, forward: { x: fx, y: 0, z: fz } }
}

test('spatialFor picks the nearest listener among 1, 2, 3 and 4', () => {
  const source = { x: 0, y: 0, z: 0 }
  const nearest = pose(4, 0, 0, 0, 1)
  const farther = [pose(-6, 0, 0, 0, 1), pose(0, 0, 10, 0, -1), pose(0, 9, 0, 0, 1)]
  for (let count = 1; count <= 4; count++) {
    const listeners = [...farther.slice(0, count - 1), nearest]
    assert.deepEqual(spatialFor(source, listeners, { ref: 2, max: 30 }), { gain: 0.5, pan: -1 }, `${count} listeners`)
  }
})

test('spatialFor pan follows haa: source right of +Z is +1, left is -1', () => {
  const listener = [pose(0, 0, 0, 0, 1)]
  assert.deepEqual(spatialFor({ x: 3, y: 0, z: 0 }, listener, { ref: 2, max: 30 }), { gain: 2 / 3, pan: 1 })
  assert.deepEqual(spatialFor({ x: -3, y: 0, z: 0 }, listener, { ref: 2, max: 30 }), { gain: 2 / 3, pan: -1 })
  assert.deepEqual(spatialFor({ x: 0, y: 0, z: 3 }, listener, { ref: 2, max: 30 }), { gain: 2 / 3, pan: 0 })
  assert.deepEqual(spatialFor({ x: 1, y: 0, z: 0 }, listener, { ref: 2, max: 30 }), { gain: 1, pan: 1 })
})

test('spatialFor gains 0 beyond max and 1 with no listener', () => {
  const listener = [pose(0, 0, 12, 0, 1)]
  assert.equal(spatialFor({ x: 0, y: 0, z: 0 }, listener, { ref: 2, max: 10 }).gain, 0)
  assert.equal(spatialFor({ x: 0, y: 0, z: 0 }, [pose(0, 15, 0, 0, 1)], { ref: 2, max: 10 }).gain, 0)
  close(spatialFor({ x: 0, y: 0, z: 0 }, [pose(0, 0, 10, 0, 1)], { ref: 2, max: 10 }).gain, 0.2, 'at max')
  assert.deepEqual(spatialFor({ x: 0, y: 0, z: 0 }, [], { ref: 2, max: 10 }), { gain: 1, pan: 0 })
})

test('parseBusVolumes: garbage falls back, partial objects fill defaults', () => {
  for (const v of [null, undefined, 42, 'x', true, []]) {
    assert.deepEqual(parseBusVolumes(v), DEFAULT_BUS_VOLUMES, String(v))
  }
  assert.equal(AUDIO_SETTINGS_KEY, 'royal-fiesta.audio')
  assert.deepEqual(parseBusVolumes({ music: 0.3 }), { ...DEFAULT_BUS_VOLUMES, music: 0.3 })
  assert.deepEqual(parseBusVolumes({ music: 5, sfx: -1, ui: 0, ambience: 1, crowd: 0.25 }), {
    music: 1, sfx: 0, ui: 0, ambience: 1, crowd: 0.25,
  })
  assert.deepEqual(parseBusVolumes({ music: NaN, sfx: Infinity, ui: -Infinity, ambience: '0.5', crowd: 0.25 }), {
    ...DEFAULT_BUS_VOLUMES, crowd: 0.25,
  })
})
