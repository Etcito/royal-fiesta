import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadAnimBrick } from '../src/anim/brick.ts'

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
