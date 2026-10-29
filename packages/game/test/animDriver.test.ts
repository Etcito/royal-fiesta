import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { AnimDriver, type CharacterObservation } from '../src/anim/driver.ts'
import { loadAnimBrick } from '../src/anim/brick.ts'
import { mapParams, newParamMemory } from '../src/anim/params.ts'

const read = (name: string) => readFileSync(new URL(`../../../assets/common/${name}`, import.meta.url), 'utf8')
const node = JSON.parse(read('penguin.body.asset.json')).document.nodes.penguin
const { bindings, smooth, ...preset } = node.rig
const rigJson = JSON.stringify(preset), graphJson = read('penguin.animgraph.json')
const clipsJson = node.clips.map((clip: unknown) => JSON.stringify(clip))
const observation = (id: number, mode: number = CharMode.ground, emote = 0): CharacterObservation => ({
  id, mode, emote, grounded: mode === CharMode.ground, vel: { x: 3, y: 0, z: 4 },
})

test('maps every CharMode, horizontal units, vertical motion, emotes and jump edges', () => {
  const declared = JSON.parse(graphJson).params as { name: string; type: string }[]
  for (const [mode, expected] of [[0, 0], [1, 1], [2, 2], [3, 3], [4, 0], [5, 5], [6, 0], [7, 0]]) {
    for (let emote = 0; emote <= 4; emote++) {
      const obs = observation(1, mode, emote)
      obs.vel = Object.freeze({ x: 3, y: -12, z: 4 })
      Object.freeze(obs)
      const params = mapParams(obs, newParamMemory())
      assert.equal(params.mode, expected); assert.equal(params.emote, emote)
      assert.equal(params.speed, 5); assert.equal(params.vy, -12)
      assert.equal(params.grounded, obs.grounded)
      for (const p of declared) assert.equal(typeof params[p.name as keyof typeof params],
        p.type === 'trigger' || p.type === 'bool' ? 'boolean' : 'number')
    }
  }
  const mem = newParamMemory(), air = observation(1, CharMode.air)
  air.vel = { x: 0, y: 8, z: 0 }
  assert.equal(mapParams(air, mem).jump, false, 'joining in air is not an edge')
  mapParams(observation(1), mem)
  assert.equal(mapParams(air, mem).jump, true)
  assert.equal(mapParams(air, mem).jump, false)
  mapParams(observation(1), mem)
  air.vel = { x: 0, y: -8, z: 0 }
  assert.equal(mapParams(air, mem).jump, false, 'falling does not jump')
  for (const emote of [-1, 5, 1.5, NaN]) assert.equal(mapParams(observation(1, 0, emote), mem).emote, 0)
})

test('observed ticks step independent real graphs once; pose reads and tick gaps never catch up', async () => {
  const driver = await AnimDriver.load(graphJson, rigJson, clipsJson)
  const api = await loadAnimBrick(), rig = api.loadRig(rigJson)
  const clips = clipsJson.map((json: string) => api.loadClip(rig, json))
  const graph = api.loadGraph(graphJson, rig, clips), state = graph.newState(), mem = newParamMemory()
  try {
    assert.equal(driver.pose(1), undefined)
    const snapshots = [observation(1), observation(1, CharMode.air), observation(1, CharMode.dive),
      observation(1, CharMode.diveRecover), observation(1, CharMode.grabbing), observation(1)]
    snapshots[1].vel = { x: 3, y: 8, z: 4 }
    const ticks = [10, 11, 19, 20, 25, 26]
    for (let i = 0; i < ticks.length; i++) {
      const a = snapshots[i], b = observation(2, CharMode.ground, 2)
      const before = structuredClone([a, b])
      driver.observeTick(ticks[i], [a, b])
      const expected = graph.step(state, { ...mapParams(a, mem) }), pose = driver.pose(1)!
      assert.deepEqual(pose.skin, expected.skin)
      assert.deepEqual(pose.events, expected.events); assert.deepEqual(pose.rootDelta, expected.rootDelta)
      assert.equal(pose.model.length, 12 * 16); assert(pose.model.every(Number.isFinite))
      assert.deepEqual([a, b], before, 'view animation never writes simulation inputs')
      for (let render = 0; render < 4; render++) {
        driver.observeTick(ticks[i], [])
        assert.strictEqual(driver.pose(1), pose)
      }
      driver.observeTick(ticks[i] - 1, [])
      assert.strictEqual(driver.pose(1), pose)
      assert.notStrictEqual(driver.pose(2)!.skin, pose.skin)
    }
    assert.notDeepEqual(driver.pose(1)!.skin, driver.pose(2)!.skin)
    const retained = driver.pose(1)!, saved = retained.skin.slice()
    driver.observeTick(27, [observation(2)])
    assert.equal(driver.pose(1), undefined)
    assert.deepEqual(retained.skin, saved, 'retained output survives other ticks and disposal')
    driver.observeTick(28, [observation(1)])
    const fresh = graph.newState()
    try { assert.deepEqual(driver.pose(1)!.skin, graph.step(fresh, { ...mapParams(observation(1), newParamMemory()) }).skin) }
    finally { fresh.free() }
    assert.equal(driver.pose(2), undefined)
    assert.throws(() => driver.observeTick(29, [observation(1), observation(1)]), /duplicate/)
    assert.throws(() => driver.observeTick(1.5, []), /invalid/)
    driver.dispose(); driver.dispose()
    assert.equal(driver.pose(1), undefined)
    assert.throws(() => driver.observeTick(30, []), /disposed/)
  } finally {
    driver.dispose(); state.free(); graph.free()
    for (const clip of clips) clip.free()
    rig.free()
  }
})

test('bone attachment models match sampled clip models for an unblended idle pose', async () => {
  const driver = await AnimDriver.load(graphJson, rigJson, clipsJson)
  const api = await loadAnimBrick(), rig = api.loadRig(rigJson)
  const clip = api.loadClip(rig, JSON.stringify(node.clips.find((c: { name: string }) => c.name === 'idle')))
  try {
    const obs = observation(1); obs.vel = { x: 0, y: 0, z: 0 }
    for (let tick = 0; tick < 3; tick++) {
      driver.observeTick(tick, [obs])
      const expected = api.sampleClip(clip, tick).model, actual = driver.pose(1)!.model
      expected.forEach((value, i) => assert(Math.abs(value - actual[i]) < 0.00001, `bone component ${i}`))
    }
  } finally { driver.dispose(); clip.free(); rig.free() }
})
