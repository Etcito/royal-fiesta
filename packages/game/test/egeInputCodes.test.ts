import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeInput, NEUTRAL_CODE, neutralInput } from '@royal-fiesta/sim/input'
import { ENGINE_NEUTRAL_CODE, engineCodeOfS1, s1CodeOfEngine } from '../src/ege/inputCodes.ts'

const BUTTONS = [0, 0x10000, 0x20000, 0x40000, 0x70000]

test('every S1 axis pair and button set round trips through the engine code', () => {
  const out = neutralInput()
  for (let qx = -127; qx <= 127; qx++) {
    for (let qz = -127; qz <= 127; qz++) {
      for (const b of BUTTONS) {
        const c = ((qx + 127) | ((qz + 127) << 8) | b) >>> 0
        const e = engineCodeOfS1(c)
        assert.equal(s1CodeOfEngine(e), c, `round trip of ${c}`)
        assert.equal(e & 0x70000, b, `button bits of ${c}`)
        decodeInput(c, out)
        assert.equal(((e << 24) >> 24) / 127, out.moveX, `moveX of ${c}`)
        assert.equal(((e << 16) >> 24) / 127, out.moveZ, `moveZ of ${c}`)
      }
    }
  }
})

test('the neutral codes map to each other', () => {
  assert.equal(engineCodeOfS1(NEUTRAL_CODE), ENGINE_NEUTRAL_CODE)
  assert.equal(s1CodeOfEngine(ENGINE_NEUTRAL_CODE), NEUTRAL_CODE)
})

test('an S1 byte of 255 maps like 254', () => {
  assert.equal(engineCodeOfS1(255), engineCodeOfS1(254))
  assert.equal(engineCodeOfS1(255 << 8), engineCodeOfS1(254 << 8))
  assert.equal(engineCodeOfS1(255 | (255 << 8) | 0x70000), engineCodeOfS1(254 | (254 << 8) | 0x70000))
  assert.equal(engineCodeOfS1(254 | (254 << 8)), 127 | (127 << 8))
})
