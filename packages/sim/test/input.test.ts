import assert from 'node:assert/strict'
import test from 'node:test'
import { BTN, NEUTRAL_CODE, decodeInput, encodeInput, inputCode, inputCodec, neutralInput } from '../src/input.ts'
import { RefusalError, isRefusal } from '../src/refusal.ts'

const ALL_BITS = 1 << 19

test('decode(encode(decode(c))) is stable for every 19-bit code', () => {
  const d1 = neutralInput()
  const d2 = neutralInput()
  for (let c = 0; c < ALL_BITS; c++) {
    decodeInput(c, d1)
    const c2 = encodeInput(d1)
    decodeInput(c2, d2)
    const where = `code=${c} c2=${c2}`
    assert.equal(d2.moveX, d1.moveX, `${where} moveX`)
    assert.equal(d2.moveZ, d1.moveZ, `${where} moveZ`)
    assert.equal(d2.jump, d1.jump, `${where} jump`)
    assert.equal(d2.dive, d1.dive, `${where} dive`)
    assert.equal(d2.grab, d1.grab, `${where} grab`)
    assert.equal(encodeInput(d2), c2, `${where} re-encode`)
  }
})

test('neutral decodes to zero and encodes to NEUTRAL_CODE', () => {
  assert.equal(NEUTRAL_CODE, 32639)
  assert.equal(NEUTRAL_CODE, 127 | (127 << 8))
  const out = neutralInput()
  out.moveX = 9
  out.moveZ = -9
  out.jump = true
  out.dive = true
  out.grab = true
  const decoded = decodeInput(NEUTRAL_CODE, out)
  assert.deepEqual(decoded, { moveX: 0, moveZ: 0, jump: false, dive: false, grab: false })
  assert.equal(encodeInput(neutralInput()), NEUTRAL_CODE)
  assert.equal(inputCode({}), NEUTRAL_CODE)
})

test('clamps out-of-range sticks and maps q=255 to 1', () => {
  const base = neutralInput()
  assert.equal(encodeInput({ ...base, moveX: 5 }), encodeInput({ ...base, moveX: 1 }))
  assert.equal(encodeInput({ ...base, moveX: -3 }), encodeInput({ ...base, moveX: -1 }))
  const out = neutralInput()
  decodeInput(255 | (127 << 8), out)
  assert.equal(out.moveX, 1)
  assert.equal(out.moveZ, 0)
  decodeInput(127 | (255 << 8), out)
  assert.equal(out.moveX, 0)
  assert.equal(out.moveZ, 1)
  decodeInput(0, out)
  assert.equal(out.moveX, -1)
  assert.equal(out.moveZ, -1)
})

test('bits 19-31 are ignored on decode and zero after encode', () => {
  const expected = neutralInput()
  decodeInput(0x7ffff, expected)
  const masked = neutralInput()
  decodeInput(0xffffffff, masked)
  assert.deepEqual(masked, expected)
  assert.equal(inputCode({ moveX: 1, moveZ: -1, jump: true, dive: true, grab: true }) >>> 19, 0)
  assert.equal(inputCode({ moveX: -0.3, moveZ: 0.7 }) >>> 19, 0)
})

test('button bits and inputCode overlay', () => {
  assert.equal(BTN.JUMP, 65536)
  assert.equal(BTN.DIVE, 131072)
  assert.equal(BTN.GRAB, 262144)
  assert.equal(inputCode({ jump: true }), NEUTRAL_CODE | BTN.JUMP)
  assert.equal(inputCode({ dive: true }), NEUTRAL_CODE | BTN.DIVE)
  assert.equal(inputCode({ grab: true }), NEUTRAL_CODE | BTN.GRAB)
  assert.equal(
    inputCode({ moveX: 1, moveZ: -1, jump: true, dive: true, grab: true }),
    encodeInput({ moveX: 1, moveZ: -1, jump: true, dive: true, grab: true }),
  )
  const out = neutralInput()
  decodeInput(inputCode({ jump: true, grab: true }), out)
  assert.deepEqual(out, { moveX: 0, moveZ: 0, jump: true, dive: false, grab: true })
})

test('inputCodec is wired to the input module', () => {
  assert.equal(inputCodec.create, neutralInput)
  assert.equal(inputCodec.encode, encodeInput)
  assert.equal(inputCodec.decode, decodeInput)
  assert.equal(inputCodec.neutral, NEUTRAL_CODE)
  assert.notEqual(inputCodec.create(), inputCodec.create())
})

test('non-finite moveX and moveZ are refused', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (const value of bad) {
    assert.throws(
      () => encodeInput({ ...neutralInput(), moveX: value }),
      (e: unknown) => isRefusal(e) && e instanceof RefusalError
        && e.message === '[input] moveX: got NaN; pass a finite number in -1..1',
    )
    assert.throws(
      () => encodeInput({ ...neutralInput(), moveZ: value }),
      (e: unknown) => isRefusal(e) && e instanceof RefusalError
        && e.message === '[input] moveZ: got NaN; pass a finite number in -1..1',
    )
  }
})
