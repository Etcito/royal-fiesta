import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AnimDriver, type CharacterObservation } from '../src/anim/driver.ts'
const read = (name: string) => readFileSync(new URL(`../../../assets/common/${name}`, import.meta.url), 'utf8')
const node = JSON.parse(read('penguin.body.asset.json')).document.nodes.penguin
const { bindings, smooth, ...rig } = node.rig
const load = (cache: boolean) => AnimDriver.load(read('penguin.animgraph.json'), JSON.stringify(rig), node.clips.map((c: unknown) => JSON.stringify(c)), { cache })
type MutableObservation = {
  -readonly [K in keyof CharacterObservation]: CharacterObservation[K]
}
const character = (id: number): MutableObservation => ({ id, mode: 0, emote: 0, surface: 'normal', grounded: true,
  vel: { x: 0, y: 0, z: 3 }, xf: { pos: { x: id * 2, y: 1, z: 0 }, facing: { x: 0, z: 1 } },
  ik: { mode: 0, ground: { point: { x: id * 2, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } },
    look: { x: id * 2, y: 1, z: 10 } } })
const near = (a: Float32Array, b: Float32Array) => {
  assert.equal(a.length, b.length)
  a.forEach((v, i) => assert(Math.abs(v - b[i]) <= 1e-5, `matrix component ${i}: ${v} vs ${b[i]}`))
}
test('60 identical histories share one graph/layer solve and model-space IK, retaining attachments', async () => {
  const driver = await load(true), reference = await load(false)
  const characters = Array.from({ length: 60 }, (_, id) => character(id))
  try {
    for (let tick = 0; tick < 32; tick++) {
      driver.observeTick(tick, characters)
      reference.observeTick(tick, characters)
      assert.deepEqual(driver.cacheStats, { evaluated: 1, shared: 59, ikEvaluated: 1, ikShared: 59 })
      for (const { id } of characters) {
        near(driver.pose(id)!.skin, reference.pose(id)!.skin)
        near(driver.pose(id)!.model, reference.pose(id)!.model)
        assert.equal(driver.footDown(id), reference.footDown(id))
        assert.deepEqual(driver.pose(id)!.events, reference.pose(id)!.events)
      }
    }
  }
  finally {
    driver.dispose()
    reference.dispose()
  }
})
test('cohorts split lazily without losing clip blends, layer memory, jump edges, or per-character IK', async () => {
  const driver = await load(true), reference = await load(false)
  let retained: Float32Array | undefined, saved: Float32Array | undefined
  try {
    for (let tick = 0; tick < 85; tick++) {
      const characters = [character(0), character(1), character(2)]
      // Diverge after sharing graph state for several ticks, then transition back together.
      if (tick >= 8 && tick < 35) {
        characters[1].mode = tick < 15 ? 1 : tick < 23 ? 2 : 3
        characters[1].grounded = tick >= 23
        characters[1].vel = { x: 0, y: tick < 12 ? 6 : -1, z: 5 }
        characters[1].ik = { mode: characters[1].mode, look: { x: 3, y: 2, z: 10 }, ground: null }
      }
      if (tick >= 16 && tick < 45) {
        characters[2].carry = 1
        characters[2].strokeTimer = 5
        characters[2].ik = { mode: 5, grab: { x: 4.1, y: 1, z: 0.5 }, look: null, ground: null }
      }
      if (tick >= 48 && tick < 55)
        characters.splice(0, 1); // remove original execution owner
      if (tick >= 60) {
        for (const c of characters)
          c.emote = 2
      }
      const frozen = structuredClone(characters)
      driver.observeTick(tick, characters)
      reference.observeTick(tick, characters)
      for (const c of characters) {
        near(driver.pose(c.id)!.skin, reference.pose(c.id)!.skin)
        near(driver.pose(c.id)!.model, reference.pose(c.id)!.model)
        assert.deepEqual(driver.pose(c.id)!.rootDelta, reference.pose(c.id)!.rootDelta)
        assert.deepEqual(driver.pose(c.id)!.events, reference.pose(c.id)!.events)
        assert.equal(driver.footDown(c.id), reference.footDown(c.id))
      }
      assert.deepEqual(characters, frozen, 'animation never mutates the observed simulation')
      const p = driver.pose(1)
      driver.observeTick(tick, [])
      driver.observeTick(Math.max(0, tick - 1), [])
      assert.strictEqual(driver.pose(1), p)
      if (tick === 7) {
        retained = driver.pose(0)!.skin
        saved = retained.slice()
      }
    }
    assert.deepEqual(retained, saved, 'shared outputs remain valid after a split/removal')
  }
  finally {
    driver.dispose()
    reference.dispose()
  }
})
test('different world targets do not share IK; translated/rotated equivalent targets do', async () => {
  const driver = await load(true)
  try {
    const a = character(0), b = character(1), c = character(2)
    b.ik = { mode: 0, look: { x: 4, y: 3, z: 2 }, ground: null }
    c.xf = { pos: { x: 4, y: 1, z: 0 }, facing: { x: 1, z: 0 } }
    c.ik = { mode: 0, ground: { point: { x: 4, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } }, look: { x: 14, y: 1, z: 0 } }
    driver.observeTick(0, [a, b, c])
    assert.deepEqual(driver.cacheStats, { evaluated: 1, shared: 2, ikEvaluated: 2, ikShared: 1 })
    near(driver.pose(0)!.model, driver.pose(2)!.model)
    assert.notDeepEqual(driver.pose(0)!.model, driver.pose(1)!.model)
  }
  finally {
    driver.dispose()
  }
})
