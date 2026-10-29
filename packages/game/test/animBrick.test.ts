import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { loadAnimBrick } from '../src/anim/brick.ts'

test('game loader exposes the public graph API and steps the completed penguin', async () => {
  const read = (name: string) => readFileSync(new URL(`../../../assets/common/${name}`, import.meta.url), 'utf8')
  const node = JSON.parse(read('penguin.body.asset.json')).document.nodes.penguin
  const { bindings, smooth, ...preset } = node.rig
  const api = await loadAnimBrick(), rig = api.loadRig(JSON.stringify(preset))
  const clips = node.clips.map((c: unknown) => api.loadClip(rig, JSON.stringify(c)))
  try {
    const graph = api.loadGraph(read('penguin.animgraph.json'), rig, clips)
    try {
      const state = graph.newState()
      try {
        const pose = graph.step(state, { speed: 3, grounded: true })
        assert.equal(pose.skin.length, 12 * 16)
        assert(pose.skin.every(Number.isFinite))
      } finally { state.free() }
    } finally { graph.free() }
  } finally { for (const clip of clips) clip.free(); rig.free() }
})

test('loads the real animation wasm brick in Node and runs canonical cases in order', async () => {
  const brick = await loadAnimBrick()
  const info = brick.brickInfo()
  // These assignments also check the package's declared literal identity types.
  const name: 'raa-anim' = info.name
  const version: '0.5.0' = info.version
  assert.deepEqual(info, { name: 'raa-anim', version: '0.5.0' })
  assert.equal(name, 'raa-anim')
  assert.equal(version, '0.5.0')

  const cases = [[0, 0], [1, 60], [305419896, 600]] as const
  for (const [seed, ticks] of cases) {
    const record = brick.selftest('det-selftest', seed, ticks)
    assert.deepEqual(Object.keys(record).sort(), ['case', 'hash', 'seed', 'ticks'])
    assert.equal(record.case, 'det-selftest')
    assert.equal(record.seed, seed)
    assert.equal(record.ticks, ticks)
    for (const value of [record.seed, record.ticks]) {
      assert.equal(typeof value, 'number')
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
    }
    assert.equal(typeof record.hash, 'string')
    assert.match(record.hash, /^[0-9a-f]{8}$/)
  }
})
