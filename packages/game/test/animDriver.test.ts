import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CharMode } from '@royal-fiesta/sim/character/constants'
import { AnimDriver, type CharacterObservation } from '../src/anim/driver.ts'
import { loadAnimBrick } from '../src/anim/brick.ts'
import { localPose } from '../src/anim/ik.ts'
import { WALK, WALK_LAYER } from '../src/anim/walkCycle.ts'
import { mapParams, newParamMemory } from '../src/anim/params.ts'

const read = (name: string) => readFileSync(new URL(`../../../assets/common/${name}`, import.meta.url), 'utf8')
const node = JSON.parse(read('penguin.body.asset.json')).document.nodes.penguin
const { bindings, smooth, ...preset } = node.rig
const rigJson = JSON.stringify(preset), graphJson = read('penguin.animgraph.json')
const clipsJson = node.clips.map((clip: unknown) => JSON.stringify(clip))
const observation = (id: number, mode: number = CharMode.ground, emote = 0): CharacterObservation => ({
  id, mode, emote, surface: 'normal', grounded: mode === CharMode.ground, vel: { x: 3, y: 0, z: 4 },
})

const near = (actual: Float32Array, expected: Float32Array) => {
  assert.equal(actual.length, expected.length)
  actual.forEach((v, i) => assert(Math.abs(v - expected[i]) < 0.00001, `component ${i}`))
}
// Keep graph-only comparisons at layer weight zero; ground locomotion is covered below.
const graphObservation = (id: number, mode: number = CharMode.ground, emote = 0): CharacterObservation =>
  ({ ...observation(id, mode, emote), grounded: false })

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
    const snapshots = [graphObservation(1), graphObservation(1, CharMode.air), graphObservation(1, CharMode.dive),
      graphObservation(1, CharMode.diveRecover), graphObservation(1, CharMode.grabbing), graphObservation(1)]
    snapshots[1].vel = { x: 3, y: 8, z: 4 }
    const ticks = [10, 11, 19, 20, 25, 26]
    for (let i = 0; i < ticks.length; i++) {
      const a = snapshots[i], b = graphObservation(2, CharMode.ground, 2)
      const before = structuredClone([a, b])
      driver.observeTick(ticks[i], [a, b])
      const expected = graph.step(state, { ...mapParams(a, mem) }), pose = driver.pose(1)!
      if (a.mode === CharMode.grabbing) {
        assert.notDeepEqual(pose.skin, expected.skin)
        assert(pose.skin.every(Number.isFinite))
      } else near(pose.skin, expected.skin)
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
    driver.observeTick(27, [graphObservation(2)])
    assert.equal(driver.pose(1), undefined)
    assert.deepEqual(retained.skin, saved, 'retained output survives other ticks and disposal')
    driver.observeTick(28, [graphObservation(1)])
    const fresh = graph.newState()
    try { near(driver.pose(1)!.skin, graph.step(fresh, { ...mapParams(graphObservation(1), newParamMemory()) }).skin) }
    finally { fresh.free() }
    assert.equal(driver.pose(2), undefined)
    assert.throws(() => driver.observeTick(29, [graphObservation(1), graphObservation(1)]), /duplicate/)
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

test('bone attachment models match layered sampled clip models for an unblended idle pose', async () => {
  const driver = await AnimDriver.load(graphJson, rigJson, clipsJson)
  const api = await loadAnimBrick(), rig = api.loadRig(rigJson)
  const clip = api.loadClip(rig, JSON.stringify(node.clips.find((c: { name: string }) => c.name === 'idle')))
  try {
    const names: string[] = preset.bones.map((b: { name: string }) => b.name)
    const parents = preset.bones.map((b: { parent: string | null }) => b.parent === null ? -1 : names.indexOf(b.parent))
    const layer = WALK_LAYER.create(names)
    const obs = observation(1); obs.vel = { x: 0, y: 0, z: 0 }
    for (let tick = 0; tick < 3; tick++) {
      driver.observeTick(tick, [obs])
      const local = localPose(api.sampleClip(clip, tick).model, parents)
      layer.observe(obs); layer.apply(local, obs)
      const expected = modelFromLocal(local, parents), actual = driver.pose(1)!.model
      expected.forEach((value, i) => assert(Math.abs(value - actual[i]) < 0.00001, `bone component ${i}`))
    }
  } finally { driver.dispose(); clip.free(); rig.free() }
})

test('QB10: walked path skins are exactly equal per sim tick at 60, 144 and 175 Hz', async () => {
  const path = Array.from({ length: 240 }, (_, tick): CharacterObservation => ({
    ...observation(1),
    vel: { x: tick < 30 ? 0 : tick < 100 ? 3 : tick < 180 ? 8 : 1, y: 0, z: tick < 100 ? 0 : 2 },
  }))
  const results: Float32Array[][] = []
  for (const hz of [60, 144, 175]) {
    const driver = await AnimDriver.load(graphJson, rigJson, clipsJson)
    const skins: Float32Array[] = []
    try {
      let observed = -1
      for (let frame = 0; observed < path.length - 1; frame++) {
        const tick = Math.min(path.length - 1, Math.floor(frame * 60 / hz))
        for (let next = observed + 1; next <= tick; next++) {
          driver.observeTick(next, [path[next]])
          skins.push(driver.pose(1)!.skin.slice())
        }
        observed = tick
        const pose = driver.pose(1), contact = driver.footDown(1)
        driver.observeTick(tick, [path[tick]])
        assert.strictEqual(driver.pose(1), pose)
        assert.equal(driver.footDown(1), contact)
      }
      results.push(skins)
    } finally { driver.dispose() }
  }
  for (const skins of results.slice(1)) {
    assert.equal(skins.length, path.length)
    skins.forEach((skin, tick) => skin.forEach((v, i) =>
      assert.strictEqual(v, results[0][tick][i], `tick ${tick}, component ${i}`)))
  }
})

test('QB10: idle, walk and run models keep both flippers below their shoulders', async () => {
  const names = preset.bones.map((b: { name: string }) => b.name)
  for (const speed of [0, WALK.walkSpeed, WALK.runSpeed]) {
    const driver = await AnimDriver.load(graphJson, rigJson, clipsJson)
    try {
      for (let tick = 0; tick < 120; tick++) {
        driver.observeTick(tick, [{ ...observation(1), vel: { x: 0, y: 0, z: speed } }])
        const model = driver.pose(1)!.model
        for (const side of ['l', 'r']) {
          assert(model[names.indexOf(`lower.${side}`) * 16 + 13] < model[names.indexOf(`upper.${side}`) * 16 + 13],
            `speed ${speed}, tick ${tick}, side ${side}`)
        }
      }
    } finally { driver.dispose() }
  }
})

test('walking footDown fires twice per stride and is cleared on removal', async () => {
  const driver = await AnimDriver.load(graphJson, rigJson, clipsJson)
  const obs = { ...observation(1), vel: { x: 0, y: 0, z: WALK.walkSpeed } }
  try {
    assert.equal(driver.footDown(1), 0)
    // At 3 m/s a 0.9 m stride takes 18 ticks.
    const strideTicks = Math.round(WALK.strideM / WALK.walkSpeed * 60)
    for (let stride = 0; stride < 5; stride++) {
      const contacts: number[] = []
      for (let i = 0; i < strideTicks; i++) {
        const tick = stride * strideTicks + i
        driver.observeTick(tick, [obs])
        const contact = driver.footDown(1)
        if (contact) contacts.push(contact)
        driver.observeTick(tick, [])
        assert.equal(driver.footDown(1), contact)
      }
      assert.deepEqual(contacts, [-1, 1])
    }
    driver.remove(1)
    assert.equal(driver.footDown(1), 0)
    driver.observeTick(100, [obs])
    assert.equal(driver.footDown(1), 0, 'rejoining starts a fresh walk state')
    driver.dispose()
    assert.equal(driver.footDown(1), 0)
  } finally { driver.dispose() }
})

function modelFromLocal(local: Float32Array, parents: number[]): Float32Array {
  const model = new Float32Array(parents.length * 16)
  parents.forEach((parent, bone) => {
    const o = bone * 10, [x, y, z, w] = local.subarray(o + 3, o + 7)
    const m = new Float64Array(16)
    for (let c = 0; c < 3; c++) {
      const v = [0, 0, 0]; v[c] = local[o + 7 + c]
      const cross = (a: number[], b: number[]) =>
        [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
      const uv = cross([x, y, z], v), uuv = cross([x, y, z], uv)
      for (let r = 0; r < 3; r++) m[c*4+r] = v[r] + 2*(w*uv[r] + uuv[r])
    }
    m.set(local.subarray(o, o + 3), 12); m[15] = 1
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let v = 0
      for (let k = 0; k < 4; k++) v += (parent < 0 ? Number(r === k) : model[parent*16+k*4+r]) * m[c*4+k]
      model[bone*16+c*4+r] = v
    }
  })
  return model
}
