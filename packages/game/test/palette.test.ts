import assert from 'node:assert/strict'
import test from 'node:test'
import { PALETTE, seatTint } from '../src/render/palette.ts'

// Zoned matches seat up to 16 players; SceneView tints every bean, so no seat may miss a colour.
test('seatTint gives every seat a palette colour and wraps beyond the palette', () => {
  for (let seat = 0; seat < 3 * PALETTE.length; seat++) {
    const tint = seatTint(seat)
    assert.equal(tint.length, 3)
    assert.ok(tint.every(Number.isFinite))
    assert.equal(tint, PALETTE[seat % PALETTE.length])
  }
})
