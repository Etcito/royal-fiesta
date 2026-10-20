import assert from 'node:assert/strict'
import test from 'node:test'
import { CROWD_BED } from '../src/audio/pack/crowd.ts'
import { CROWD_PARAMS } from '../src/audio/pack/crowdModel.ts'
import { CROWD_BED_ID } from '../src/audio/ids.ts'

test('the crowd bed renders finite, audible stereo from its default parameters', () => {
  assert.equal(CROWD_BED.id, CROWD_BED_ID)
  assert.deepEqual([...CROWD_PARAMS], ['size', 'excitement', 'swell', 'level'])
  const voice = CROWD_BED.create(48000, 1)
  const params = Float32Array.from(CROWD_BED.defaults)
  const left = new Float32Array(128)
  const right = new Float32Array(128)
  let peak = 0
  let finite = true
  for (let block = 0; block < 375; block++) {
    voice.process(params, 0, left, right, 128)
    for (let i = 0; i < 128; i++) {
      if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) finite = false
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
    }
  }
  assert.ok(finite, 'the bed output is finite')
  // Raw bed level: the game limits it in context.ts, so only audibility is checked here.
  assert.ok(peak > 0.001, `bed peak ${peak} is audible`)
})
